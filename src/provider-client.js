/**
 * provider-client.js — Makes API calls to downstream LLM providers
 * Supports OpenAI-compatible streaming and non-streaming chat completions
 */
import { getConfig } from './config.js';

const requestLog = [];
const MAX_LOG_ENTRIES = 5000;

// Per-provider state
const providerFailures = new Map();
const provider429count = new Map();
const providerCool = new Map();
const providerPermanentFail = new Set();

// Per-key state — `${providerName}:${keyId}` → KeyState
const keyState = new Map();

const log = (...args) => console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}]`, ...args);

function sanitize(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/(sk-|nvapi-|ms-|ak_)[a-zA-Z0-9_-]{10,}/g, '$1***');
}

function applySafeInjection(messages, systemPrompt, providerPrompt, modelPrompt, disabled) {
  if (disabled || !systemPrompt && !providerPrompt && !modelPrompt) return messages;
  const result = messages.slice();
  if (systemPrompt && !result.some(m => m.role === 'system' || m.role === 'developer')) {
    result.unshift({ role: 'system', content: systemPrompt });
  }
  const lastUserIdx = (() => { for (let i = result.length - 1; i >= 0; i--) { if (result[i].role === 'user') return i; } return -1; })();
  if (lastUserIdx < 0) return result;
  const append = (msg, text) => {
    if (!text) return msg;
    if (typeof msg.content === 'string') return { ...msg, content: msg.content + '\n\n' + text };
    if (Array.isArray(msg.content)) return { ...msg, content: [...msg.content, { type: 'text', text }] };
    return msg;
  };
  if (providerPrompt) result[lastUserIdx] = append(result[lastUserIdx], '[Provider Context]: ' + providerPrompt);
  if (modelPrompt) result[lastUserIdx] = append(result[lastUserIdx], '[Model Context]: ' + modelPrompt);
  return result;
}

// ── Key State Management ──

function ensureKeyState(providerName, keyId) {
  const sk = `${providerName}:${keyId}`;
  if (!keyState.has(sk)) {
    keyState.set(sk, {
      id: keyId,
      enabled: true,
      invalid: false,
      cooldownUntil: null,
      consecutiveFailures: 0,
      lastStatus: 0,
      lastErrorType: 'success',
      lastUsed: 0,
      successCount: 0,
      failureCount: 0,
      forbiddenModels: new Set(),
    });
  }
  return keyState.get(sk);
}

function getActiveKey(provider, providerName, model) {
  const keys = getAvailableKeys(provider, providerName, model, 1);
  return keys.length ? keys[0] : null;
}

// Returns all currently-usable keys for a provider (respecting enabled / invalid /
// cooldown and per-key model bans), optionally capped at maxKeys (0 = no cap).
function getAvailableKeys(provider, providerName, model, maxKeys = 0) {
  if (provider.keys && Array.isArray(provider.keys) && provider.keys.length > 0) {
    const sorted = [...provider.keys]
      .filter(k => k.enabled !== false)
      .sort((a, b) => {
        const pa = (a.priority ?? 99) - (b.priority ?? 99);
        if (pa !== 0) return pa;
        return (a.id || '').localeCompare(b.id || '');
      });
    const out = [];
    for (const k of sorted) {
      const state = ensureKeyState(providerName, k.id);
      if (state.invalid) continue;
      if (state.cooldownUntil && Date.now() < state.cooldownUntil) continue;
      if (model && state.forbiddenModels && state.forbiddenModels.has(model)) continue;
      out.push(k);
      if (maxKeys > 0 && out.length >= maxKeys) break;
    }
    return out;
  }
  if (provider.api_key) {
    const state = ensureKeyState(providerName, 'default');
    if (state.invalid) return [];
    if (state.cooldownUntil && Date.now() < state.cooldownUntil) return [];
    if (model && state.forbiddenModels && state.forbiddenModels.has(model)) return [];
    return [{ id: 'default', api_key: provider.api_key, priority: 0 }];
  }
  return [];
}

// Permanent key invalidation: 401, key-level 403, manual disable.
// A healthy key must NEVER reach here for provider-level errors (5xx/network/timeout).
function markKeyInvalid(providerName, keyId, reason = 'auth') {
  const state = ensureKeyState(providerName, keyId);
  state.consecutiveFailures++;
  state.failureCount++;
  state.lastStatus = reason === 'forbidden' ? 403 : 401;
  state.lastErrorType = 'auth_invalid';
  state.invalid = true;
  state.lastUsed = Date.now();
}

// Provider-level / network / timeout errors affect key health but NEVER permanently
// invalidate a good key. A healthy key must stay usable (phase-1: 5xx/timeout/network must
// never disable OR impede a key), so we only update its failure counters here and deliberately
// do NOT set cooldownUntil. Provider-level backoff is handled separately via providerCool.
function markKeyTempFailure(providerName, keyId, category = 'server_error') {
  const state = ensureKeyState(providerName, keyId);
  state.consecutiveFailures++;
  state.failureCount++;
  if (category !== 'network') state.lastStatus = state.lastStatus || 500;
  state.lastErrorType = category;
  state.lastUsed = Date.now();
}

function markProviderCooldown(providerName) {
  const routing = getConfig().routing || {};
  providerCool.set(providerName, Date.now() + (routing.cooldownSeconds || 30) * 1000);
}

function markKeyRateLimited(providerName, keyId, quotaExhausted = false) {
  const state = ensureKeyState(providerName, keyId);
  state.consecutiveFailures++;
  state.failureCount++;
  state.lastStatus = 429;
  state.lastErrorType = quotaExhausted ? 'quota_exhausted' : 'rate_limited';
  // Quota exhaustion → longer cooldown; transient 429 → shorter cooldown. Key stays valid.
  state.cooldownUntil = Date.now() + (quotaExhausted ? 600000 : 30000);
  state.lastUsed = Date.now();
}

function markKeySucceeded(providerName, keyId) {
  const state = ensureKeyState(providerName, keyId);
  state.consecutiveFailures = 0;
  state.successCount++;
  state.lastStatus = 200;
  state.lastErrorType = 'success';
  state.cooldownUntil = null;
  state.invalid = false;
  state.lastUsed = Date.now();
}

function markKeyForbidden(providerName, keyId) {
  const state = ensureKeyState(providerName, keyId);
  state.consecutiveFailures++;
  state.failureCount++;
  state.lastStatus = 403;
  state.lastErrorType = 'forbidden';
  state.lastUsed = Date.now();
  // Key-level 403 (account / API key has no permission) → invalidate the key IMMEDIATELY
  // so the router skips to the next key on the same provider. Recovery is via the admin
  // recover endpoint (recoverKey).
  state.invalid = true;
}

// Model-level 403: this key lacks permission for THIS model only. The key is NOT
// invalidated — it may still serve other models. Only this key+model pair is skipped.
function markKeyModelForbidden(providerName, keyId, model) {
  const state = ensureKeyState(providerName, keyId);
  if (!state.forbiddenModels) state.forbiddenModels = new Set();
  if (model) state.forbiddenModels.add(model);
  state.lastErrorType = 'model_forbidden';
  state.lastUsed = Date.now();
}

export function resetKeyState(providerName, keyId) {
  const sk = `${providerName}:${keyId}`;
  const state = keyState.get(sk);
  if (state) {
    state.invalid = false;
    state.consecutiveFailures = 0;
    state.cooldownUntil = null;
    state.lastErrorType = 'success';
    state.forbiddenModels = new Set();
  }
}

// Read-only snapshot of a single key's runtime state (returns a copy so callers
// cannot mutate internal state). Used by tests/observability to verify behaviour
// such as "success does not increase failureCount".
export function getKeyState(providerName, keyId) {
  const state = keyState.get(`${providerName}:${keyId}`);
  return state ? { ...state } : null;
}

// Clears ALL in-memory key/provider runtime state. Intended for test isolation.
export function resetAllKeyStates() {
  keyState.clear();
  providerPermanentFail.clear();
  providerFailures.clear();
  provider429count.clear();
  providerCool.clear();
}

export function structuredLog(event, data) {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n');
}

export function logRequest({ model, provider, status, latencyMs, tokensIn, tokensOut, agent, error }) {
  const entry = { timestamp: Date.now() / 1000, model: model || 'unknown', provider: provider || '', status: status || 0, latency_ms: latencyMs || 0, tokens_in: tokensIn || 0, tokens_out: tokensOut || 0, agent: agent || '', error: error || '' };
  requestLog.unshift(entry);
  if (requestLog.length > MAX_LOG_ENTRIES) requestLog.length = MAX_LOG_ENTRIES;
  return entry;
}

export function getRecentLogs(limit = 20, agentFilter = '') {
  let logs = requestLog;
  if (agentFilter) logs = logs.filter(l => l.agent === agentFilter);
  return logs.slice(0, limit);
}

export function getStats() {
  const now = Date.now() / 1000;
  const recent = requestLog.filter(l => l.timestamp > now - 3600);
  const totalReqs = requestLog.length;
  const successReqs = requestLog.filter(l => l.status >= 200 && l.status < 300).length;
  const errorReqs = requestLog.filter(l => l.status >= 400).length;
  return { overview: { total_requests: totalReqs, successful: successReqs, errors: errorReqs, success_rate: totalReqs > 0 ? (successReqs / totalReqs * 100) : 100, requests_1h: recent.length }, recent: getRecentLogs(20) };
}

export function getModelLatency() {
  const ml = {};
  for (const e of requestLog) { if (e.latency_ms > 0 && e.status >= 200 && e.status < 300) { if (!ml[e.model]) ml[e.model] = { total: 0, count: 0 }; ml[e.model].total += e.latency_ms; ml[e.model].count++; } }
  const r = {}; for (const [m, d] of Object.entries(ml)) r[m] = d.total / d.count; return r;
}

export function getModelCounts() {
  const c = {}; for (const e of requestLog) { if (!c[e.model]) c[e.model] = { total: 0, success: 0, error: 0 }; c[e.model].total++; if (e.status >= 200 && e.status < 300) c[e.model].success++; else if (e.status >= 400) c[e.model].error++; } return c;
}

export function getStatusDistribution() {
  const d = {}; for (const e of requestLog) { const k = String(e.status); d[k] = (d[k] || 0) + 1; } return d;
}

export async function callProviderChat(provider, key, model, body, timeoutMs = 20000, externalSignal) {
  const baseUrl = provider.base_url.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const isStream = body.stream === true;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key.api_key}` };
  if (provider.api_version) headers['api-version'] = provider.api_version;
  if (provider.custom_headers) { for (const [k, v] of Object.entries(provider.custom_headers)) headers[k] = v; }
  const config = getConfig();
  const messages = applySafeInjection(body.messages || [], config.system_prompt || '', config.provider_prompts?.[provider.display || provider.base_url], config.model_prompts?.[model], config.disable_prompt_injection === true);
  const bodyToSend = { ...body, model, messages };
  delete bodyToSend.stream;
  const apiType = provider.api_type || 'openai';
  const removeFields = PROVIDER_UNSUPPORTED[apiType] || [];
  for (const field of removeFields) { if (field in bodyToSend) { log(`[passthrough] ${sanitize(provider.display || provider.base_url)} does not support '${field}', removing`); delete bodyToSend[field]; } }
  bodyToSend.stream = isStream;
  const controller = new AbortController();
  if (externalSignal) { try { externalSignal.addEventListener('abort', () => controller.abort()); } catch {} }
  // The timeout timer MUST be cleared even when fetch throws (network error / abort),
  // otherwise the timer leaks and keeps the event loop / test process alive.
  const timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);
  try {
    return await fetch(url, { method: 'POST', headers, body: JSON.stringify(bodyToSend), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDER_UNSUPPORTED = { openai: [], azure: ['stream_options'], deepseek: ['stream_options'], ollama: ['stream_options', 'tool_choice', 'response_format'] };

/**
 * Classify HTTP status code for routing decisions
 */
function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'success';
  if (status === 400 || status === 422) return 'client_error';
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 408 || status === 429 || status === 425 || (status >= 500 && status < 600)) return 'retriable';
  return 'client_error';
}

// Distinguish 403 flavours so we never permanently kill a key for a model-level
// permission issue or a transient provider restriction.
function classifyForbidden(bodyText) {
  const t = (bodyText || '').toLowerCase();
  // 1) key / account itself lacks permission → invalidate the key
  if (/(api[_ ]?key|token).*(invalid|expired|incorrect|not valid|wrong|revoked|deactivat)/i.test(t)) return 'key_forbidden';
  if (/(authentication|unauthor|permission denied|access denied|not authorized|invalid.*(credential|api)|api key.{0,20}(not|invalid|missing))/i.test(t)) return 'key_forbidden';
  // 2) provider region / geo / policy / compliance restriction → provider-level cooldown (NOT a key ban).
  //    Checked BEFORE the model rule: a region-restricted model ("model X not supported in your
  //    region") is a provider-level issue, not a per-model key ban.
  if (/region|country|geo|location|policy|compliance|not available in your (region|country)|rate.?limit|quota/i.test(t)) return 'provider_cooldown';
  // 3) this key cannot call THIS model → skip only this key+model, keep key alive
  if (/model.*(not|unauthor|access|permission|allowed|support|found|available)|(does not|don't|do not).*(access|support).*model|no access to (the )?model|model.*forbidden|you (do not|don't) have access/i.test(t)) return 'model_forbidden';
  // 3b) temporary restriction (overloaded / maintenance / try again later) → provider cooldown, NOT a key ban
  if (/temporarily|overload|maintenance|try again later|currently unavailable|service (is )?unavailable|temporarily (blocked|restricted)/i.test(t)) return 'temp_restricted';
  // 4) unknown 403 → conservative cooldown, never invalidate the key
  return 'conservative_cooldown';
}

function isQuotaExhausted(bodyText) {
  const t = (bodyText || '').toLowerCase();
  return /quota|exceeded|insufficient|capacity|out of (credit|token)|rate.?limit.*exceed/i.test(t);
}

export function buildCandidates(body, overrides = {}, config) {
  const { preferredModel, excludedModels = [], preferredProvider, excludedProviders = [] } = overrides;
  const models = config.models || [];
  const providers = config.providers || {};
  const roles = config.roles || {};
  let selected = [];
  const isAuto = !body.model || body.model === 'auto';

  if (!isAuto && roles[body.model]) {
    selected = models.filter(m => roles[body.model].includes(m.id) && m.enabled !== false && m.enabled !== 'false');
  } else if (!isAuto) {
    selected = models.filter(m => (m.id === body.model || m.name === body.model) && m.enabled !== false && m.enabled !== 'false');
  } else {
    selected = models.filter(m => m.enabled !== false && m.enabled !== 'false');
  }

  if (excludedModels.length > 0) selected = selected.filter(m => !excludedModels.includes(m.id) && !excludedModels.includes(m.name));
  if (excludedProviders.length > 0) selected = selected.filter(m => !excludedProviders.includes(m.provider));

  const candidates = [];
  for (const m of selected) {
    const prov = providers[m.provider];
    if (!prov || prov.enabled === false) continue;
    if (providerPermanentFail.has(m.provider)) continue;
    if (providerCool.has(m.provider) && Date.now() < providerCool.get(m.provider)) continue;
    const key = getActiveKey(prov, m.provider);
    if (!key) continue;

    candidates.push({
      model: m.id || m.name,
      provider: prov,
      providerName: m.provider,
      tier: m.tier ?? 0,
      strict: !isAuto && !roles[body.model],
    });
  }

  candidates.sort((a, b) => (a.tier || 0) - (b.tier || 0));
  if (preferredProvider) {
    const pref = candidates.filter(c => c.providerName === preferredProvider);
    const rest = candidates.filter(c => c.providerName !== preferredProvider);
    candidates.splice(0, candidates.length, ...pref, ...rest);
  }
  if (preferredModel) {
    const idx = candidates.findIndex(c => c.model === preferredModel || c.model.includes(preferredModel));
    if (idx >= 0) {
      const [p] = candidates.splice(idx, 1);
      candidates.unshift(p);
    } else {
      // Preferred model was not part of the originally selected set (e.g. a strict
      // model request that also names a preferred alternative). Add a candidate for
      // it at the front so it is attempted first, then the request falls through to
      // the normal candidates on failure.
      const pm = models.find(m => (m.id === preferredModel || m.name === preferredModel) && m.enabled !== false && m.enabled !== 'false');
      const prov = pm && providers[pm.provider];
      if (pm && prov && prov.enabled !== false && prov.enabled !== 'false' && getActiveKey(prov, pm.provider)) {
        candidates.unshift({ model: pm.id || pm.name, provider: prov, providerName: pm.provider, tier: pm.tier ?? 0, strict: false });
      }
    }
  }
  return candidates;
}

/**
 * Execute candidates with proper two-layer loop:
 *   outer: iterate candidates (providers)
 *   inner: iterate attempts within same candidate (same model, same provider)
 * 
 * Never modifies ci directly — uses `break` for "skip this candidate",
 * `continue` for "retry this candidate", `return` for final result.
 */
export async function executeCandidates(candidates, body, context) {
  const cfg = getConfig();
  const routing = cfg.routing || {};
  const threshold = routing.failureThreshold || 2;
  const providerCooldownMs = (routing.cooldownSeconds || 30) * 1000;
  const isStream = body.stream === true;

  // Four DISTINCT attempt caps. Backwards-compatible fallbacks keep anthropic.js /
  // older callers working; the new explicit fields take precedence.
  //   maxAttemptsPerKey      — retries for a SINGLE key before moving on
  //   maxKeysPerProvider     — how many keys of one provider may be tried (0 = all)
  //   maxProvidersPerRequest — how many candidates may be attempted (0 = all)
  //   maxTotalUpstreamCalls  — the HARD global cap on upstream HTTP requests
  // maxRetries / maxAttemptsPerCandidate are PER-KEY retry counts (NOT a global cap),
  // so a small retry budget never starves cross-provider failover. The HARD global cap
  // is maxTotalUpstreamCalls and defaults to 20.
  const maxAttemptsPerKey = context.maxAttemptsPerKey ?? context.max_attempts_per_key ?? context.maxAttemptsPerCandidate ?? context.maxRetries ?? routing.maxAttemptsPerKey ?? 2;
  const maxKeysPerProvider = context.max_keys_per_provider ?? context.maxKeysPerProvider ?? routing.maxKeysPerProvider ?? 0;
  const maxProvidersPerRequest = context.max_providers_per_request ?? context.maxProvidersPerRequest ?? routing.maxProvidersPerRequest ?? 0;
  const maxTotalUpstreamCalls = context.max_total_upstream_calls ?? context.maxTotalUpstreamCalls ?? context.maxTotalAttempts ?? routing.maxTotalUpstreamCalls ?? 20;
  const timeoutMs = context.timeoutMs ?? routing.perModelTimeoutMs ?? 20000;
  // Single request ID, generated once at the HTTP entry (server.js / anthropic.js)
  // and threaded through every provider/key attempt for this request. Never a bare
  // global — falls back to 'unknown' only when no caller-supplied ID is present.
  const requestId = context?.requestId || 'unknown';

  let totalCalls = 0;
  const attemptLog = [];

  // Execute ONE upstream call for (candidate, key) and classify the outcome.
  async function tryOnce(candidate, key) {
    const attemptStart = Date.now();
    const entry = { model: candidate.model, provider: candidate.providerName, keyId: key.id };
    attemptLog.push(entry);
    try {
      const response = await callProviderChat(candidate.provider, key, candidate.model, body, timeoutMs);
      const latencyMs = Date.now() - attemptStart;
      entry.status = response.status;
      entry.latencyMs = latencyMs;
      const cls = classifyStatus(response.status);

      if (cls === 'success') {
        providerFailures.delete(candidate.providerName);
        provider429count.delete(candidate.providerName);
        providerPermanentFail.delete(candidate.providerName);
        markKeySucceeded(candidate.providerName, key.id);
        if (isStream) {
          const reader = response.body.getReader();
          const { done, value } = await reader.read();
          if (done) { log(`[${requestId}] ${candidate.model} → empty stream, retrying`); entry.error = 'empty_stream'; return { type: 'server_error' }; }
          const ttft = Date.now() - attemptStart;
          const remainingStream = new ReadableStream({
            start(controller) { controller.enqueue(value); (async function pump() { try { while (true) { const { done, value } = await reader.read(); if (done) { try { controller.close(); } catch {} break; } controller.enqueue(value); } } catch (e) { try { controller.error(e); } catch {} } })(); },
            cancel() { try { reader.cancel(); } catch {} }
          });
          log(`[${requestId}] ${candidate.model} ✓ (stream, TTFT=${ttft}ms)`);
          logRequest({ model: candidate.model, provider: candidate.providerName, status: 200, latencyMs, agent: context.agent });
          return { type: 'success', value: { success: true, isStream: true, provider: candidate.providerName, model: candidate.model, latencyMs, ttft, remainingStream, response, attemptLog } };
        }
        const cloneResp = response.clone();
        const text = await cloneResp.text();
        if (!text || text.includes('"choices":null') || text.includes('"choices":[]')) {
          log(`[${requestId}] ${candidate.model} → empty response, retrying`);
          logRequest({ model: candidate.model, provider: candidate.providerName, status: 0, latencyMs, agent: context.agent, error: 'Empty response' });
          entry.error = 'empty_response';
          return { type: 'server_error' };
        }
        log(`[${requestId}] ${candidate.model} ✓ (${response.status})`);
        logRequest({ model: candidate.model, provider: candidate.providerName, status: response.status, latencyMs, agent: context.agent });
        return { type: 'success', value: { success: true, isStream: false, provider: candidate.providerName, model: candidate.model, latencyMs, body: text, status: response.status, attemptLog } };
      }

      if (cls === 'client_error') {
        const errBody = await response.text().catch(() => '{"error":"Bad request"}');
        logRequest({ model: candidate.model, provider: candidate.providerName, status: response.status, latencyMs, agent: context.agent, error: `Client error: ${response.status}` });
        log(`[${requestId}] ${candidate.model} → ${response.status} (client error, no fallback)`);
        entry.error = `client_error:${response.status}`;
        return { type: 'stop', value: { error: true, status: response.status, body: errBody, provider: candidate.providerName, model: candidate.model, latencyMs, attemptLog } };
      }

      if (cls === 'auth_error') {
        const errBody = await response.text().catch(() => '');
        if (response.status === 401) {
          markKeyInvalid(candidate.providerName, key.id, 'auth');
          logRequest({ model: candidate.model, provider: candidate.providerName, status: 401, latencyMs, agent: context.agent, error: 'Auth failure (401)' });
          log(`[${requestId}] ${candidate.model} (${key.id}) → 401, key invalidated`);
          entry.error = '401';
          return { type: 'auth_invalid' };
        }
        const cat = classifyForbidden(errBody);
        logRequest({ model: candidate.model, provider: candidate.providerName, status: 403, latencyMs, agent: context.agent, error: `Forbidden (403): ${cat}` });
        log(`[${requestId}] ${candidate.model} (${key.id}) → 403 (${cat})`);
        entry.error = `403:${cat}`;
        if (cat === 'key_forbidden' || cat === 'conservative_cooldown') {
          // Key-level or unknown 403 → invalidate the key immediately (phase-1 Bug B: a 403
          // must never be retried on the same key). Model-level 403 (model_forbidden) keeps the
          // key alive for other models.
          markKeyForbidden(candidate.providerName, key.id);
          return { type: cat };
        }
        if (cat === 'model_forbidden') { markKeyModelForbidden(candidate.providerName, key.id, candidate.model); return { type: 'model_forbidden' }; }
        // provider_cooldown / temp_restricted → provider-level cooldown plus a temporary key
        // cooldown. These do NOT permanently invalidate the key.
        providerCool.set(candidate.providerName, Date.now() + providerCooldownMs);
        markKeyTempFailure(candidate.providerName, key.id, 'forbidden_' + cat, candidate.model);
        return { type: cat };
      }

      if (cls === 'not_found') {
        logRequest({ model: candidate.model, provider: candidate.providerName, status: response.status, latencyMs, agent: context.agent, error: 'Not found' });
        log(`[${requestId}] ${candidate.model} → ${response.status}`);
        entry.error = `not_found:${response.status}`;
        return { type: 'stop', value: { error: true, status: response.status, body: await response.text().catch(() => ''), provider: candidate.providerName, model: candidate.model, latencyMs, attemptLog } };
      }

      if (cls === 'retriable') {
        if (response.status === 429) {
          const errBody = await response.text().catch(() => '');
          const quota = isQuotaExhausted(errBody);
          markKeyRateLimited(candidate.providerName, key.id, quota);
          const current429 = provider429count.get(candidate.providerName) || 0;
          provider429count.set(candidate.providerName, current429 + 1);
          if (current429 >= threshold) {
            providerCool.set(candidate.providerName, Date.now() + providerCooldownMs);
            provider429count.delete(candidate.providerName);
          }
          logRequest({ model: candidate.model, provider: candidate.providerName, status: 429, latencyMs, agent: context.agent, error: quota ? 'Quota exhausted' : 'Rate limited' });
          log(`[${requestId}] ${candidate.model} (${key.id}) → 429 (${quota ? 'quota' : 'rate'}), key cooled`);
          entry.error = quota ? '429:quota' : '429';
          return { type: 'rate_limited' };
        }
        const errType = response.status === 408 ? 'timeout' : 'server_error';
        markKeyTempFailure(candidate.providerName, key.id, errType);
        const fails = providerFailures.get(candidate.providerName) || { count: 0, lastFailure: 0 };
        fails.count++; fails.lastFailure = Date.now();
        providerFailures.set(candidate.providerName, fails);
        if (fails.count >= threshold) {
          providerCool.set(candidate.providerName, Date.now() + providerCooldownMs);
          providerFailures.delete(candidate.providerName);
        }
        logRequest({ model: candidate.model, provider: candidate.providerName, status: response.status, latencyMs, agent: context.agent, error: `Retriable: ${response.status}` });
        log(`[${requestId}] ${candidate.model} → ${response.status} (provider error, key kept)`);
        entry.error = String(response.status);
        return { type: errType };
      }

      const errBody = await response.text().catch(() => '{}');
      return { type: 'stop', value: { error: true, status: response.status, body: errBody, provider: candidate.providerName, model: candidate.model, latencyMs, attemptLog } };
    } catch (err) {
      const latencyMs = Date.now() - attemptStart;
      entry.status = 0;
      entry.latencyMs = latencyMs;
      entry.error = err.name === 'AbortError' ? 'timeout' : sanitize(err.message);
      logRequest({ model: candidate.model, provider: candidate.providerName, status: 0, latencyMs, agent: context.agent, error: sanitize(err.message) });
      log(`[${requestId}] ${candidate.model} ✗ ${sanitize(err.message)}`);
      if (err.name === 'AbortError') {
        markKeyTempFailure(candidate.providerName, key.id, 'timeout');
        providerCool.set(candidate.providerName, Date.now() + providerCooldownMs);
        return { type: 'timeout' };
      }
      // Network error → provider-level, key is NOT invalidated
      markKeyTempFailure(candidate.providerName, key.id, 'network');
      providerCool.set(candidate.providerName, Date.now() + providerCooldownMs);
      return { type: 'network' };
    }
  }

  // Loop hierarchy: candidates (providers) → keys → per-key retries
  for (let ci = 0; ci < candidates.length; ci++) {
    const candidate = candidates[ci];
    if (maxProvidersPerRequest > 0 && ci >= maxProvidersPerRequest) break;
    if (totalCalls >= maxTotalUpstreamCalls) break;

    const keys = getAvailableKeys(candidate.provider, candidate.providerName, candidate.model, maxKeysPerProvider);
    if (keys.length === 0) continue; // no usable key on this provider → next provider

    for (const key of keys) {
      if (totalCalls >= maxTotalUpstreamCalls) break;
      let keyAttempt = 0;
      while (keyAttempt < maxAttemptsPerKey && totalCalls < maxTotalUpstreamCalls) {
        totalCalls++;
        keyAttempt++;
        const r = await tryOnce(candidate, key);
        if (r.type === 'success') return r.value;
        if (r.type === 'stop') return r.value;
        // auth_invalid / key_forbidden / model_forbidden / rate_limited /
        // provider_cooldown / conservative → move to the NEXT KEY (no retry of this key)
        if (r.type !== 'server_error' && r.type !== 'timeout' && r.type !== 'network') break;
        // server_error / timeout / network → retry SAME key (key stays valid)
      }
    }
  }

  const lastEntry = attemptLog[attemptLog.length - 1];
  const msg = lastEntry ? `All providers unavailable (last error: ${lastEntry.error})` : 'All providers unavailable';
  throw Object.assign(new Error(msg), { attemptLog });
}

export async function routeChatCompletion(body, agent = '', overrides = {}) {
  const config = getConfig();
  const routing = config.routing || {};
  const candidates = buildCandidates(body, overrides, config);
  if (candidates.length === 0) throw new Error('No available candidates for the requested model');
  return executeCandidates(candidates, body, {
    agent,
    requestId: overrides.requestId || 'unknown',
    // Explicit distinct caps (preferred). Backwards-compatible aliases are still
    // honoured by executeCandidates' fallback chain.
    maxAttemptsPerKey: overrides.maxAttemptsPerKey ?? routing.maxAttemptsPerKey ?? 2,
    maxKeysPerProvider: overrides.max_keys_per_provider ?? routing.maxKeysPerProvider ?? 0,
    maxProvidersPerRequest: overrides.max_providers_per_request ?? routing.maxProvidersPerRequest ?? 0,
    maxTotalUpstreamCalls: overrides.max_total_upstream_calls ?? routing.maxTotalUpstreamCalls ?? 20,
    timeoutMs: routing.perModelTimeoutMs ?? 20000,
  });
}

export function getProviderHealth() {
  const health = {};
  for (const [name] of providerPermanentFail) health[name] = { status: 'disabled', reason: 'Auth failure' };
  for (const [name, fails] of providerFailures) health[name] = { status: 'failing', failures: fails.count, lastFailure: new Date(fails.lastFailure).toISOString() };
  for (const [name, until] of providerCool) {
    const cooled = Date.now() < until;
    health[name] = { ...health[name], status: cooled ? 'cooled' : 'half-open', cooldownUntil: new Date(until).toISOString() };
  }
  for (const [sk, st] of keyState) {
    const [pname, kid] = sk.split(':');
    if (!health[pname]) health[pname] = {};
    if (!health[pname].keys) health[pname].keys = {};
    health[pname].keys[kid] = {
      failures: st.consecutiveFailures,
      cooldown: st.cooldownUntil ? Date.now() < st.cooldownUntil : false,
      invalid: st.invalid,
      lastStatus: st.lastStatus,
      lastErrorType: st.lastErrorType,
      lastUsed: st.lastUsed ? new Date(st.lastUsed).toISOString() : null,
      successCount: st.successCount,
      failureCount: st.failureCount,
    };
  }
  return health;
}

export async function checkProviderHealth(provider) {
  try {
    const baseUrl = provider.base_url.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(`${baseUrl}/models`, { headers: { 'Authorization': `Bearer ${provider.api_key}` }, signal: controller.signal });
      return resp.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch { return false; }
}

export function resetProviderState(providerName) {
  providerPermanentFail.delete(providerName);
  providerFailures.delete(providerName);
  provider429count.delete(providerName);
  providerCool.delete(providerName);
  for (const [sk] of keyState) {
    if (sk.startsWith(providerName + ':')) keyState.delete(sk);
  }
}

export function sanitizeConfigForClient(obj) {
  const seen = new WeakSet();
  function walk(val) {
    if (val === null || typeof val !== 'object') return val;
    if (seen.has(val)) return val;
    seen.add(val);
    if (Array.isArray(val)) return val.map(walk);
    const result = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === 'api_key' || k === 'x-api-key' || k === 'x_key') {
        result[k] = typeof v === 'string' ? v.slice(-4).padStart(v.length, '*') : v;
      } else if (k === 'custom_headers' && typeof v === 'object' && v !== null) {
        const sanitized = {};
        for (const [hk, hv] of Object.entries(v)) {
          sanitized[hk] = typeof hv === 'string' && (hk.toLowerCase().includes('key') || hk.toLowerCase().includes('auth') || hk.toLowerCase().includes('token')) ? hv.slice(-4).padStart(hv.length, '*') : hv;
        }
        result[k] = sanitized;
      } else if (k === 'adminToken' || k === 'admin_token' || k === 'routerToken' || k === 'router_token') {
        result[k] = v ? '***' : '';
      } else {
        result[k] = walk(v);
      }
    }
    return result;
  }
  return walk(obj);
}

export {
  markKeyInvalid, markKeyForbidden, markKeyModelForbidden, markKeyTempFailure,
  markKeyRateLimited, markKeySucceeded, markProviderCooldown,
  getActiveKey, getAvailableKeys, classifyForbidden, isQuotaExhausted,
};

export default {
  logRequest, getRecentLogs, getStats,
  getModelLatency, getModelCounts, getStatusDistribution,
  callProviderChat, routeChatCompletion, executeCandidates, buildCandidates,
  getProviderHealth, checkProviderHealth, resetProviderState,
  sanitizeConfigForClient,
  markKeyInvalid, markKeyForbidden, markKeyModelForbidden, markKeyTempFailure,
  markKeyRateLimited, markKeySucceeded, markProviderCooldown,
  getActiveKey, getAvailableKeys, classifyForbidden, isQuotaExhausted,
};
