// OpenAI-compatible image/video generation proxy.
// Uses the same provider key rotation, health and fallback primitives as chat.

import { randomUUID } from 'node:crypto';
import { buildCandidates } from './router/candidates.js';
import { getAgentBudget, getAgentModels, resolveAgent } from './agent/identity.js';
import { AttemptLog } from './runtime/attempts.js';

const MEDIA_ENDPOINTS = new Map([
  ['/v1/images/generations', { capability: 'image', endpoint: '/v1/images/generations', label: 'image' }],
  ['/v1/video/generations', { capability: 'video', endpoint: '/v1/video/generations', label: 'video' }],
]);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('request_too_large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body_object_required');
    return body;
  } catch (error) {
    const invalid = new Error(error.message === 'body_object_required' ? error.message : 'invalid_json');
    invalid.statusCode = 400;
    throw invalid;
  }
}

function declaredMediaCapability(model, kind) {
  const values = [
    ...(Array.isArray(model?.capability) ? model.capability : []),
    ...(model?.capabilities && typeof model.capabilities === 'object' ? Object.keys(model.capabilities).filter((key) => Number(model.capabilities[key]) >= 0.9) : []),
  ].map((value) => String(value).toLowerCase());
  return values.includes(`${kind}_generation`) || values.includes(`${kind}_generations`) || values.includes(kind) || values.includes('media_generation');
}

function finalizerFor(components, requestId, attemptLog, outcome, candidate) {
  const finalize = components.finalizer?.finalizeRequestTransaction || components.finalizer?.finalize;
  if (typeof finalize !== 'function') return Promise.resolve();
  return finalize.call(components.finalizer, requestId, attemptLog, outcome, {
    model: candidate?.modelId || null,
    provider: candidate?.provider || null,
    agentId: 'media-api',
    protocol: 'media',
  }).catch(() => {});
}

export async function handleMediaRequest(req, res, components, pathname) {
  const media = MEDIA_ENDPOINTS.get(pathname);
  if (!media) return false;
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  const maxBytes = components.config.server?.max_request_body_bytes || 10 * 1024 * 1024;
  const body = await readJson(req, maxBytes);
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    json(res, 400, { error: 'prompt_required' });
    return true;
  }

  const virtualKeyDecision = components.virtualKeys?.authorize(req, body.model || null);
  if (virtualKeyDecision && !virtualKeyDecision.allowed) {
    json(res, virtualKeyDecision.status || 403, { error: virtualKeyDecision.reason });
    return true;
  }
  const releaseVirtualKey = virtualKeyDecision?.release || (() => {});

  try {
    const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const agentId = resolveAgent(req.headers, body, { path: pathname }).agentId || 'media-api';
  const budget = getAgentBudget(agentId, components.config);
  const candidates = buildCandidates(requestedModel, components.config, {
    agentId,
    agentModels: getAgentModels(agentId, components.config),
    budget,
    health: components.health,
    circuitBreaker: components.circuitBreaker,
    keyPool: components.keyPool,
  }).filter((candidate) => requestedModel !== 'auto' || declaredMediaCapability(candidate.model, media.capability));

  if (candidates.length === 0) {
    json(res, 503, { error: 'no_media_model_available', media: media.label });
    return true;
  }

  const requestId = `media_${randomUUID()}`;
  const attemptLog = new AttemptLog(requestId);
  try {
    await components.store?.saveRequest?.({
      requestId, agentId: 'media-api', protocol: 'media', model: requestedModel, provider: null,
      timestamp: new Date().toISOString(),
    });
  } catch { /* audit persistence must not block the provider request */ }

  for (const candidate of candidates) {
    const attempt = attemptLog.addAttempt(candidate.modelId, candidate.provider, null);
    const startedAt = Date.now();
    try {
      const result = await components.providerClient.callRaw(candidate.model, body, media.endpoint, {
        abortSignal: req.signal,
        timeoutMs: components.config.server?.request_timeout_ms,
      });
      const responseText = await result.response.text();
      const latencyMs = Date.now() - startedAt;
      attempt.setTransportResult('success', result.response.status, latencyMs, latencyMs);
      attempt.setValidatedResult(responseText.trim() ? 'completed' : 'incomplete');
      await finalizerFor(components, requestId, attemptLog, attempt.validatedOutcome === 'completed' ? 'completed' : 'incomplete', candidate);
      res.writeHead(result.response.status, {
        'Content-Type': result.response.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(responseText);
      return true;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      attempt.setTransportResult('error', error.details?.httpStatus || null, latencyMs, null);
      attempt.setError(error.code || 'provider_error', 'media provider request failed');
    }
  }

  await finalizerFor(components, requestId, attemptLog, 'provider_error', null);
  json(res, 502, { error: 'media_provider_unavailable', media: media.label });
  return true;
  } finally {
    releaseVirtualKey();
  }
}
