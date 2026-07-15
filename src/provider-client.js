/**
 * provider-client.js — Makes API calls to downstream LLM providers
 * Supports OpenAI-compatible streaming and non-streaming chat completions
 */
import { getConfig } from './config.js';

// ── In-memory stats ──
const requestLog = [];
const MAX_LOG_ENTRIES = 5000;

// Track provider failures for circuit breaker
const providerFailures = new Map();   // providerName -> { count, lastFailure, cooldownUntil }
const provider429count = new Map();   // providerName -> count
const providerCool = new Map();       // providerName -> cooldown until (timestamp)

/**
 * Log a request
 */


// ── Structured JSON logging (observability) ──
export function structuredLog(event, data) {
  const entry = JSON.stringify({
    t: new Date().toISOString(),
    event,
    ...data,
  });
  process.stderr.write(entry + '\n');
}

export function logRequest({ model, provider, status, latencyMs, tokensIn, tokensOut, agent, error }) {
  const entry = {
    timestamp: Date.now() / 1000,
    model: model || 'unknown',
    provider: provider || '',
    status: status || 0,
    latency_ms: latencyMs || 0,
    tokens_in: tokensIn || 0,
    tokens_out: tokensOut || 0,
    agent: agent || '',
    error: error || '',
  };
  requestLog.unshift(entry);
  if (requestLog.length > MAX_LOG_ENTRIES) requestLog.length = MAX_LOG_ENTRIES;
  return entry;
}

/**
 * Get recent request logs
 */
export function getRecentLogs(limit = 20, agentFilter = '') {
  let logs = requestLog;
  if (agentFilter) logs = logs.filter(l => l.agent === agentFilter);
  return logs.slice(0, limit);
}

/**
 * Get stats overview
 */
export function getStats() {
  const now = Date.now() / 1000;
  const recent = requestLog.filter(l => l.timestamp > now - 3600);
  const today = requestLog.filter(l => l.timestamp > now - 86400);
  
  const totalReqs = requestLog.length;
  const successReqs = requestLog.filter(l => l.status >= 200 && l.status < 300).length;
  const errorReqs = requestLog.filter(l => l.status >= 400).length;
  
  return {
    overview: {
      total_requests: totalReqs,
      successful: successReqs,
      errors: errorReqs,
      success_rate: totalReqs > 0 ? (successReqs / totalReqs * 100) : 100,
      requests_1h: recent.length,
      requests_24h: today.length,
    },
    recent: getRecentLogs(20),
  };
}

/**
 * Calculate average latency per model
 */
export function getModelLatency() {
  const modelLat = {};
  for (const log of requestLog) {
    if (log.latency_ms > 0 && log.status >= 200 && log.status < 300) {
      if (!modelLat[log.model]) modelLat[log.model] = { total: 0, count: 0 };
      modelLat[log.model].total += log.latency_ms;
      modelLat[log.model].count++;
    }
  }
  const result = {};
  for (const [model, data] of Object.entries(modelLat)) {
    result[model] = data.total / data.count;
  }
  return result;
}

/**
 * Get request count per model
 */
export function getModelCounts() {
  const counts = {};
  for (const log of requestLog) {
    if (!counts[log.model]) counts[log.model] = { total: 0, success: 0, error: 0 };
    counts[log.model].total++;
    if (log.status >= 200 && log.status < 300) counts[log.model].success++;
    else if (log.status >= 400) counts[log.model].error++;
  }
  return counts;
}

/**
 * Get status code distribution
 */
export function getStatusDistribution() {
  const dist = {};
  for (const log of requestLog) {
    const key = String(log.status);
    dist[key] = (dist[key] || 0) + 1;
  }
  return dist;
}

/**
 * Call a provider's chat completion endpoint
 */
export async function callProviderChat(provider, model, body, signal) {
  const baseUrl = provider.base_url.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const isStream = body.stream === true;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.api_key}`,
  };
  if (provider.api_version) headers['api-version'] = provider.api_version;

  // ── Build messages with 4-layer prompt injection ──
  let messages = body.messages || [];
  const config = getConfig();
  const systemPrompt = config.system_prompt || '';
  const providerPrompts = config.provider_prompts || {};
  const modelPrompts = config.model_prompts || {};

  // Layer 1: Global system prompt
  let systemContent = '';
  if (systemPrompt) systemContent = systemPrompt;

  // Check if messages already have a system message
  const hasSystem = messages.some(m => m.role === 'system' || m.role === 'developer');

  if (!hasSystem && systemContent) {
    messages = [{ role: 'system', content: systemContent }, ...messages];
  }

  // Layer 2: Provider-specific prompt (injected into last user message)
  const providerName = provider.display || provider.base_url || '';
  const provPrompt = providerPrompts[providerName] || providerPrompts[model?.split('/')[0]];
  if (provPrompt && messages.length > 0) {
    const lastUserIdx = [...messages].reverse().findIndex(m => m.role === 'user');
    if (lastUserIdx >= 0) {
      const idx = messages.length - 1 - lastUserIdx;
      messages[idx] = { ...messages[idx], content: String(messages[idx].content || '') + '\n\n[Provider Context]: ' + provPrompt };
    }
  }

  // Layer 3: Model-specific prompt
  const modelPrompt = modelPrompts[model];
  if (modelPrompt && messages.length > 0) {
    const lastUserIdx = [...messages].reverse().findIndex(m => m.role === 'user');
    if (lastUserIdx >= 0) {
      const idx = messages.length - 1 - lastUserIdx;
      messages[idx] = { ...messages[idx], content: String(messages[idx].content || '') + '\n\n[Model Context]: ' + modelPrompt };
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model,
      messages: messages,
      temperature: body.temperature,
      top_p: body.top_p,
      max_tokens: body.max_tokens,
      stream: isStream,
      stop: body.stop,
    }),
    signal,
  });

  return response;
}

/**
 * Route a chat completion request to the best available provider/model
 * Implements tier-based routing with fallback
 */
export async function routeChatCompletion(body, agent = '') {
  const config = getConfig();
  const models = config.models || [];
  const providers = config.providers || {};
  const routing = config.routing;

  // Build tier list of (model, provider) pairs
  const tierOrder = Object.entries(routing.tierWeights || {})
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

  // Collect all models per tier
  const tierMap = {};
  for (const [tier] of tierOrder) {
    tierMap[tier] = [];
  }

  for (const m of models) {
    if (m.enabled === false || m.enabled === 'false') continue;
    const tier = String(m.tier ?? 0);
    const prov = providers[m.provider];
    if (!prov || prov.enabled === false) continue;

    // Check if provider is in cooldown
    if (providerCool.has(m.provider)) {
      if (Date.now() < providerCool.get(m.provider)) continue;
      providerCool.delete(m.provider);
    }

    if (!tierMap[tier]) tierMap[tier] = [];
    tierMap[tier].push({ model: m.id || m.name, provider: prov, providerName: m.provider });
  }

  // Try tiers in order
  const lastError = { message: '' };
  let attempts = 0;
  const maxRetries = routing.maxRetries || 4;

  // Flatten tiers into a single array, respecting weights for randomness within tiers
  const candidateList = [];
  for (const [tier] of tierOrder) {
    const candidates = tierMap[tier] || [];
    if (candidates.length === 0) continue;
    // Shuffle within tier for load balancing
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    candidateList.push(...candidates);
  }

  for (const candidate of candidateList) {
    if (attempts >= maxRetries) break;
    attempts++;

    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), routing.perModelTimeoutMs || 20000);

      const response = await callProviderChat(candidate.provider, candidate.model, body, controller.signal);
      clearTimeout(timeout);

      const latencyMs = Date.now() - startTime;

      // Handle rate limiting
      if (response.status === 429) {
        const current429 = provider429count.get(candidate.providerName) || 0;
        provider429count.set(candidate.providerName, current429 + 1);
        
        logRequest({
          model: candidate.model,
          provider: candidate.providerName,
          status: 429,
          latencyMs,
          agent,
          error: 'Rate limited',
        });

        // After 3 consecutive 429s, cooldown the provider
        if (current429 >= 2) {
          const cooldown = (routing.cooldownSeconds || 30) * 1000;
          providerCool.set(candidate.providerName, Date.now() + cooldown);
          provider429count.delete(candidate.providerName);
        }
        continue; // Try next candidate
      }

      // Handle server errors
      if (response.status >= 500) {
        logRequest({
          model: candidate.model,
          provider: candidate.providerName,
          status: response.status,
          latencyMs,
          agent,
          error: `Provider error: ${response.status}`,
        });

        // Track failure for circuit breaker
        const fails = providerFailures.get(candidate.providerName) || { count: 0, lastFailure: 0 };
        fails.count++;
        fails.lastFailure = Date.now();
        providerFailures.set(candidate.providerName, fails);

        if (fails.count >= (routing.failureThreshold || 2)) {
          const cooldown = (routing.cooldownSeconds || 30) * 1000;
          providerCool.set(candidate.providerName, Date.now() + cooldown);
          providerFailures.delete(candidate.providerName);
        }
        continue;
      }

      // Reset failure count on success
      providerFailures.delete(candidate.providerName);
      provider429count.delete(candidate.providerName);

      // Success! Return the raw response for streaming
      
      // Empty response retry: if body is empty (choices null/empty), retry
      const routingCfg = config.routing || {};
      if (routingCfg.empty_response_retry !== false) {
        try {
          const cloneResp = response.clone();
          const previewText = await cloneResp.text();
          const isEmpty = !previewText || previewText.includes('"choices":null') || previewText.includes('"choices":[]');
          if (isEmpty) {
            log(`⚠️ Empty response from ${candidate.model}, retrying...`);
            logRequest({
              model: candidate.model,
              provider: candidate.providerName,
              status: 0,
              latencyMs,
              agent,
              error: 'Empty response',
            });
            continue;
          }
        } catch {} // If clone fails, just proceed
      }
      
      logRequest({
        model: candidate.model,
        provider: candidate.providerName,
        status: response.status,
        latencyMs,
        agent,
      });

      return {
        response,
        provider: candidate.providerName,
        model: candidate.model,
        latencyMs,
      };

    } catch (err) {
      const latencyMs = Date.now() - startTime;
      lastError.message = err.message;
      
      logRequest({
        model: candidate.model,
        provider: candidate.providerName,
        status: 0,
        latencyMs,
        agent,
        error: err.message,
      });

      // Track failure
      const fails = providerFailures.get(candidate.providerName) || { count: 0, lastFailure: 0 };
      fails.count++;
      fails.lastFailure = Date.now();
      providerFailures.set(candidate.providerName, fails);
    }
  }

  // All providers failed
  throw new Error(lastError.message || 'All providers unavailable');
}

/**
 * Get provider health status
 */
export function getProviderHealth() {
  const health = {};
  for (const [name, fails] of providerFailures) {
    health[name] = { failures: fails.count, lastFailure: new Date(fails.lastFailure).toISOString() };
  }
  for (const [name, until] of providerCool) {
    health[name] = { ...health[name], cooldownUntil: new Date(until).toISOString() };
  }
  return health;
}

/**
 * Health check provider connectivity
 */
export async function checkProviderHealth(provider) {
  try {
    const baseUrl = provider.base_url.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${provider.api_key}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

export default {
  logRequest, getRecentLogs, getStats,
  getModelLatency, getModelCounts, getStatusDistribution,
  callProviderChat, routeChatCompletion,
  getProviderHealth, checkProviderHealth,
};
