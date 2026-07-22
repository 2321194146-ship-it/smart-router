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
    });
  }
  return keyState.get(sk);
}

function getActiveKey(provider, providerName) {
  if (provider.keys && Array.isArray(provider.keys) && provider.keys.length > 0) {
    const sorted = [...provider.keys]
      .filter(k => k.enabled !== false)
      .sort((a, b) => {
        const pa = (a.priority ?? 99) - (b.priority ?? 99);
        if (pa !== 0) return pa;
        return (a.id || '').localeCompare(b.id || '');
      });
    for (const k of sorted) {
      const state = ensureKeyState(providerName, k.id);
      if (state.invalid) continue;
      if (state.cooldownUntil && Date.now() < state.cooldownUntil) continue;
      return k;
    }
    return null;
  }
  if (provider.api_key) {
    const state = ensureKeyState(providerName, 'default');
    if (state.invalid) return null;
    if (state.cooldownUntil && Date.now() < state.cooldownUntil) return null;
    return { id: 'default', api_key: provider.api_key, priority: 0 };
  }
  return null;
}

function markKeyFailed(providerName, keyId, errorType = 'auth', forceInvalidate = false) {
  const state = ensureKeyState(providerName, keyId);
  state.consecutiveFailures++;
  state.failureCount++;
  state.lastStatus = 0;
  state.lastErrorType = errorType;
  state.lastUsed = Date.now();
  if (forceInvalidate || state.consecutiveFailures >= 3) {
    state.invalid = true;
    state.cooldownUntil = Date.now() + 60000;
  }
}

function markKeyRateLimited(providerName, keyId) {
  const state = ensureKeyState(providerName, keyId);
  state.consecutiveFailures++;
  state.failureCount++;
  state.lastStatus = 429;
  state.lastErrorType = 'rate_limited';
  state.cooldownUntil = Date.now() + 30000;
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
  // 403 means this key definitively lacks permission for the request. Invalidate it
  // IMMEDIATELY so the router skips to the next key on the same provider instead of
  // uselessly retrying the same 403 key. A second 403 must never hit an already
  // unauthorized key. Recovery is via the admin recover endpoint (recoverKey).
  state.invalid = true;
}

export function resetKeyState(providerName, keyId) {
  const sk = `${providerName}:${keyId}`;
  const state = keyState.get(sk);
  if (state) {
    state.invalid = false;
    state.consecutiveFailures = 0;
    state.cooldownUntil = null;
    state.lastErrorType = 'success';
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

export async function callProviderChat(provider, key, model, body, signal) {
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
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(bodyToSend), signal });
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
    if (idx >= 0) { const [p] = candidates.splice(idx, 1); candidates.unshift(p); }
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
  const { agent, requestId, maxAttemptsPerCandidate = 2, maxTotalAttempts: mta, timeoutMs = 20000, maxRetries } = context;
  const maxTotalAttempts = mta ?? maxRetries ?? 4;
  const isStream = body.stream === true;
  let totalAttempts = 0;
  const attemptLog = [];
  const routing = getConfig().routing || {};

  for (let ci = 0; ci < candidates.length; ci++) {
    const candidate = candidates[ci];
    let candidateDone = false; // flag: break inner loop → continue to next candidate (no ci++)

    for (let attempt = 0; attempt < maxAttemptsPerCandidate && !candidateDone; attempt++) {
      // Guarantee at least one attempt per candidate (provider) so a bad provider
      // can never exhaust the whole global budget and starve failover. Only RETRIES
      // (attempt > 0) are gated by the global cap.
      if (attempt > 0 && totalAttempts >= maxTotalAttempts) break;
      const attemptStart = Date.now();
      const entry = { model: candidate.model, provider: candidate.providerName };
      attemptLog.push(entry);

      try {
        const key = getActiveKey(candidate.provider, candidate.providerName);
        if (!key) {
          entry.status = 0;
          entry.error = 'No available key';
          candidateDone = true; // skip this candidate
          break;
        }
        entry.keyId = key.id;
        totalAttempts++;

        const controller = new AbortController();
        const timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);
        const response = await callProviderChat(candidate.provider, key, candidate.model, body, controller.signal);
        clearTimeout(timer);
        const latencyMs = Date.now() - attemptStart;
        entry.status = response.status;
        entry.latencyMs = latencyMs;

        const cls = classifyStatus(response.status);

        if (cls === 'client_error') {
          const errBody = await response.text().catch(() => '{"error":"Bad request"}');
          logRequest({ model: candidate.model, provider: candidate.providerName, status: response.status, latencyMs, agent, error: `Client error: ${response.status}` });
          log(`[${requestId}] ${candidate.model} → ${response.status} (client error, no fallback)`);
          return { error: true, status: response.status, body: errBody, provider: candidate.providerName, model: candidate.model, latencyMs, attemptLog };
        }

        if (cls === 'auth_error') {
          logRequest({ model: candidate.model, provider: candidate.providerName, status: response.status, latencyMs, agent, error: `Auth failure: ${response.status}` });
          log(`[${requestId}] ${candidate.model} (${key.id}) → ${response.status}`);
          if (response.status === 401) {
            markKeyFailed(candidate.providerName, key.id, 'auth', true);
          } else if (response.status === 403) {
            markKeyForbidden(candidate.providerName, key.id);
          }
          // Try another key for same candidate if available
          if (getActiveKey(candidate.provider, candidate.providerName)) {
            continue; // same candidate, different key
          }
          candidateDone = true; // skip this candidate, no more keys
          break;
        }

        if (cls === 'not_found') {
          logRequest({ model: candidate.model, provider: candidate.providerName, status: response.status, latencyMs, agent, error: 'Not found' });
          log(`[${requestId}] ${candidate.model} → ${response.status}`);
          candidateDone = true; // model not found on this provider
          break;
        }

        if (cls === 'retriable') {
          logRequest({ model: candidate.model, provider: candidate.providerName, status: response.status, latencyMs, agent, error: `Retriable: ${response.status}` });
          log(`[${requestId}] ${candidate.model} → ${response.status} (attempt ${attempt + 1}/${maxAttemptsPerCandidate})`);
          if (response.status === 429) {
            markKeyRateLimited(candidate.providerName, key.id);
            const current429 = provider429count.get(candidate.providerName) || 0;
            provider429count.set(candidate.providerName, current429 + 1);
            if (current429 >= (routing.failureThreshold || 2)) {
              providerCool.set(candidate.providerName, Date.now() + (routing.cooldownSeconds || 30) * 1000);
              provider429count.delete(candidate.providerName);
            }
            // Try another key for same candidate if available
            if (getActiveKey(candidate.provider, candidate.providerName)) {
              continue; // same candidate, different key
            }
          }
          if (response.status >= 500) {
            markKeyFailed(candidate.providerName, key.id, 'server_error');
            const fails = providerFailures.get(candidate.providerName) || { count: 0, lastFailure: 0 };
            fails.count++; fails.lastFailure = Date.now();
            providerFailures.set(candidate.providerName, fails);
            if (fails.count >= (routing.failureThreshold || 2)) {
              providerCool.set(candidate.providerName, Date.now() + (routing.cooldownSeconds || 30) * 1000);
              providerFailures.delete(candidate.providerName);
            }
          }
          continue; // retry same candidate (next attempt)
        }

        if (cls === 'success') {
          providerFailures.delete(candidate.providerName);
          provider429count.delete(candidate.providerName);
          markKeySucceeded(candidate.providerName, key.id);

          if (isStream) {
            const reader = response.body.getReader();
            const { done, value } = await reader.read();
            if (done) { log(`[${requestId}] ${candidate.model} → empty stream, retrying`); continue; }
            const ttft = Date.now() - attemptStart;
            const remainingStream = new ReadableStream({
              start(controller) { controller.enqueue(value); (async function pump() { try { while (true) { const { done, value } = await reader.read(); if (done) { try { controller.close(); } catch {} break; } controller.enqueue(value); } } catch (e) { try { controller.error(e); } catch {} } })(); },
              cancel() { try { reader.cancel(); } catch {} }
            });
            log(`[${requestId}] ${candidate.model} ✓ (stream, TTFT=${ttft}ms)`);
            logRequest({ model: candidate.model, provider: candidate.providerName, status: 200, latencyMs, agent });
            return { success: true, isStream: true, provider: candidate.providerName, model: candidate.model, latencyMs, ttft, remainingStream, response, attemptLog };
          } else {
            const cloneResp = response.clone();
            const text = await cloneResp.text();
            if (!text || text.includes('"choices":null') || text.includes('"choices":[]')) {
              log(`[${requestId}] ${candidate.model} → empty response, retrying`);
              logRequest({ model: candidate.model, provider: candidate.providerName, status: 0, latencyMs, agent, error: 'Empty response' });
              continue;
            }
            log(`[${requestId}] ${candidate.model} ✓ (${response.status})`);
            logRequest({ model: candidate.model, provider: candidate.providerName, status: response.status, latencyMs, agent });
            return { success: true, isStream: false, provider: candidate.providerName, model: candidate.model, latencyMs, body: text, status: response.status, attemptLog };
          }
        }

        // Unknown
        const errBody = await response.text().catch(() => '{}');
        return { error: true, status: response.status, body: errBody, provider: candidate.providerName, model: candidate.model, latencyMs, attemptLog };

      } catch (err) {
        const latencyMs = Date.now() - attemptStart;
        entry.status = 0;
        entry.latencyMs = latencyMs;
        entry.error = err.name === 'AbortError' ? 'timeout' : err.message;
        logRequest({ model: candidate.model, provider: candidate.providerName, status: 0, latencyMs, agent, error: sanitize(err.message) });
        log(`[${requestId}] ${candidate.model} ✗ ${sanitize(err.message)} (attempt ${attempt + 1}/${maxAttemptsPerCandidate})`);

        if (err.name === 'AbortError') {
          const fails = providerFailures.get(candidate.providerName) || { count: 0, lastFailure: 0 };
          fails.count++; fails.lastFailure = Date.now();
          providerFailures.set(candidate.providerName, fails);
          continue; // retry same candidate
        }
        // Network error → skip this candidate
        candidateDone = true;
        break;
      }
    }
    // End of inner loop → continue to next candidate naturally via outer loop
  }

  const lastEntry = attemptLog[attemptLog.length - 1];
  throw Object.assign(new Error(lastEntry?.error || 'All providers unavailable'), { attemptLog });
}

export async function routeChatCompletion(body, agent = '', overrides = {}) {
  const config = getConfig();
  const routing = config.routing || {};
  const candidates = buildCandidates(body, overrides, config);
  if (candidates.length === 0) throw new Error('No available candidates for the requested model');
  return executeCandidates(candidates, body, {
    agent,
    requestId: overrides.requestId || 'unknown',
    maxAttemptsPerCandidate: overrides.maxAttemptsPerCandidate || routing.maxAttemptsPerCandidate || 2,
    maxTotalAttempts: overrides.maxTotalAttempts || routing.maxRetries || 4,
    timeoutMs: routing.perModelTimeoutMs || 20000,
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
    const resp = await fetch(`${baseUrl}/models`, { headers: { 'Authorization': `Bearer ${provider.api_key}` }, signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
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
      } else if (k === 'adminToken' || k === 'admin_token') {
        result[k] = v ? '***' : '';
      } else {
        result[k] = walk(v);
      }
    }
    return result;
  }
  return walk(obj);
}

export default {
  logRequest, getRecentLogs, getStats,
  getModelLatency, getModelCounts, getStatusDistribution,
  callProviderChat, routeChatCompletion, executeCandidates, buildCandidates,
  getProviderHealth, checkProviderHealth, resetProviderState,
  sanitizeConfigForClient,
};
