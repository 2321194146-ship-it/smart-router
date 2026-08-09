// Compatibility read-model for the former 7878 management API.
// This module intentionally exposes no credentials, prompt text, or response bodies.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, copyFile, rename, writeFile } from 'node:fs/promises';
import { validateConfig } from './config/validator.js';

const SUCCESS_OUTCOMES = new Set(['completed', 'success']);

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function tokenEqual(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function adminToken(config) {
  if (process.env.SMART_ROUTER_ADMIN_TOKEN) return process.env.SMART_ROUTER_ADMIN_TOKEN;
  const configured = config?.intelligence?.adminToken;
  return typeof configured === 'string' && configured.length > 0 ? configured : null;
}

function safeConfig(config) {
  const output = JSON.parse(JSON.stringify(config || {}));
  if (Array.isArray(output.providers)) {
    output.providers = output.providers.map((provider) => {
      const { api_key: _apiKey, api_keys: _apiKeys, headers: _headers, ...safeProvider } = provider || {};
      return { ...safeProvider, hasApiKey: Boolean(_apiKey || (_apiKeys && _apiKeys.length)) };
    });
  }
  if (output.mcp_servers && typeof output.mcp_servers === 'object') {
    output.mcp_servers = Object.fromEntries(Object.entries(output.mcp_servers).map(([name, server]) => [name, {
      url: server?.url || '',
      enabled: server?.enabled !== false,
    }]));
  }
  if (output.virtual_keys && typeof output.virtual_keys === 'object') {
    output.virtual_keys = { count: Object.keys(output.virtual_keys).length, configured: true };
  }
  if (output.intelligence) delete output.intelligence.adminToken;
  if (output.server?.auth) delete output.server.auth.token;
  return output;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
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
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.statusCode = 400;
    throw error;
  }
}

async function persistConfig(components, candidate) {
  const configPath = components.configPath;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const backupPath = `${configPath}.bak-${stamp}-${randomBytes(3).toString('hex')}`;
  const tempPath = `${configPath}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  await copyFile(configPath, backupPath);
  await chmod(backupPath, 0o600);
  try {
    await writeFile(tempPath, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, configPath);
  } catch (error) {
    try { await rename(tempPath, `${configPath}.failed-${process.pid}`); } catch { /* best effort */ }
    throw error;
  }
  components._legacyPendingConfig = candidate;
  return backupPath.split('/').pop();
}

function prepareCandidate(current, changes) {
  const candidate = clone(current);
  for (const section of ['routing', 'models', 'providers', 'agent_bindings', 'budget', 'circuit_breaker', 'intelligence', 'mcp_servers']) {
    if (Object.prototype.hasOwnProperty.call(changes, section)) candidate[section] = clone(changes[section]);
  }
  candidate.server = clone(current.server || {});
  if (current.intelligence?.adminToken !== undefined) {
    candidate.intelligence = candidate.intelligence || {};
    candidate.intelligence.adminToken = current.intelligence.adminToken;
  }
  return candidate;
}

function providerList(config) {
  return Array.isArray(config.providers) ? config.providers : [];
}

function validHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function assertMutationObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('invalid_body');
    error.statusCode = 400;
    throw error;
  }
}

async function handleLegacyMutation(req, res, components, pathname) {
  const body = await readJsonBody(req, Math.min(1024 * 1024, components.config.server?.max_request_body_bytes || 1024 * 1024));
  assertMutationObject(body);
  const current = components._legacyPendingConfig || components.config;
  let candidate = null;

  if (pathname === '/api/config/routing' && req.method === 'PUT') {
    candidate = prepareCandidate(current, { routing: { ...(current.routing || {}), ...body } });
  } else if (pathname === '/api/config/prompts' && req.method === 'PUT') {
    candidate = clone(current);
    if (body.system !== undefined) candidate.system_prompt = body.system;
    if (body.model_prompts !== undefined) candidate.model_prompts = clone(body.model_prompts);
    if (body.model_id && body.system !== undefined) candidate.model_prompts = { ...(candidate.model_prompts || {}), [body.model_id]: body.system };
  } else if (pathname === '/api/config/models' && req.method === 'POST') {
    if (typeof body.id !== 'string' || typeof body.provider !== 'string' || !body.id || !body.provider) {
      const error = new Error('id_and_provider_required'); error.statusCode = 400; throw error;
    }
    if ((current.models || []).some((model) => model.id === body.id && model.provider === body.provider)) {
      const error = new Error('model_exists'); error.statusCode = 409; throw error;
    }
    candidate = clone(current);
    candidate.models = [...(current.models || []), {
      id: body.id, provider: body.provider, apiModel: body.apiModel || body.id,
      tier: typeof body.tier === 'string' ? body.tier : 'tier3',
      capability: Array.isArray(body.capability) ? body.capability : [body.capability || 'general'], description: body.description || '',
      desc: body.description || '', enabled: body.enabled !== false, paid: body.paid === true,
    }];
  } else if (pathname.startsWith('/api/config/models/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    const id = decodeURIComponent(pathname.slice('/api/config/models/'.length));
    const models = clone(current.models || []);
    const index = models.findIndex((model) => model.id === id);
    if (index < 0) { const error = new Error('model_not_found'); error.statusCode = 404; throw error; }
    if (req.method === 'DELETE') models.splice(index, 1);
    else Object.assign(models[index], Object.fromEntries(Object.entries(body).filter(([key]) => ['tier', 'capability', 'description', 'enabled', 'paid'].includes(key))));
    candidate = prepareCandidate(current, { models });
  } else if (pathname === '/api/config/providers' && req.method === 'POST') {
    if (typeof body.name !== 'string' || typeof body.base_url !== 'string' || !body.name || !body.base_url) {
      const error = new Error('name_and_base_url_required'); error.statusCode = 400; throw error;
    }
    if (providerList(current).some((provider) => provider.name === body.name)) {
      const error = new Error('provider_exists'); error.statusCode = 409; throw error;
    }
    candidate = prepareCandidate(current, { providers: [...providerList(current), { ...body, enabled: body.enabled !== false }] });
  } else if (pathname.startsWith('/api/config/providers/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    const name = decodeURIComponent(pathname.slice('/api/config/providers/'.length));
    const providers = clone(providerList(current));
    const index = providers.findIndex((provider) => provider.name === name);
    if (index < 0) { const error = new Error('provider_not_found'); error.statusCode = 404; throw error; }
    if (req.method === 'DELETE') providers.splice(index, 1);
    else {
      const allowed = ['enabled', 'display', 'base_url', 'api_type', 'auth_header', 'auth_prefix', 'api_key', 'models'];
      const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
      providers[index] = { ...providers[index], ...patch };
      if (Object.prototype.hasOwnProperty.call(patch, 'api_key')) delete providers[index].api_keys;
    }
    candidate = prepareCandidate(current, { providers });
  } else if (pathname.startsWith('/api/agents/') && pathname.endsWith('/model') && req.method === 'PUT') {
    const name = decodeURIComponent(pathname.slice('/api/agents/'.length, -'/model'.length));
    const bindings = clone(current.agent_bindings || {});
    const mode = body.mode || 'single';
    bindings[name] = { mode, model_ids: mode === 'single' ? [body.model_id].filter(Boolean) : (body.model_ids || []) };
    if (body.description) bindings[name].description = body.description;
    candidate = prepareCandidate(current, { agent_bindings: bindings });
  } else if (pathname.startsWith('/api/agents/') && req.method === 'DELETE') {
    const name = decodeURIComponent(pathname.slice('/api/agents/'.length));
    const bindings = clone(current.agent_bindings || {});
    delete bindings[name];
    candidate = prepareCandidate(current, { agent_bindings: bindings });
  } else if (pathname === '/api/mcp-servers' && req.method === 'POST') {
    if (typeof body.name !== 'string' || !body.name.trim() || !validHttpUrl(body.url)) {
      const error = new Error('name_and_http_url_required'); error.statusCode = 400; throw error;
    }
    const servers = clone(current.mcp_servers || {});
    if (servers[body.name]) { const error = new Error('mcp_server_exists'); error.statusCode = 409; throw error; }
    servers[body.name] = { url: body.url, enabled: body.enabled !== false };
    candidate = prepareCandidate(current, { mcp_servers: servers });
  } else if (pathname.startsWith('/api/mcp-servers/') && req.method === 'DELETE') {
    const name = decodeURIComponent(pathname.slice('/api/mcp-servers/'.length));
    const servers = clone(current.mcp_servers || {});
    if (!servers[name]) { const error = new Error('mcp_server_not_found'); error.statusCode = 404; throw error; }
    delete servers[name];
    candidate = prepareCandidate(current, { mcp_servers: servers });
  } else if (pathname === '/config/reload' && req.method === 'POST') {
    writeJson(res, 200, { success: true, restartRequired: true, message: '配置已保留，重启 28788 后生效' });
    return true;
  } else {
    return false;
  }

  const validation = validateConfig(candidate);
  if (!validation.valid) {
    writeJson(res, 422, { success: false, valid: false, errors: validation.errors, warnings: validation.warnings });
    return true;
  }
  const backupName = await persistConfig(components, candidate);
  writeJson(res, 200, { success: true, applied: true, restartRequired: true, backupCreated: true, backupName, warnings: validation.warnings || [] });
  return true;
}

function attemptLatency(record) {
  return (Array.isArray(record?.attempts) ? record.attempts : [])
    .reduce((total, attempt) => total + Number(attempt?.latencyMs || 0), 0);
}

function normalizeRecord(record) {
  const latencyMs = attemptLatency(record);
  const lastAttempt = Array.isArray(record?.attempts) ? record.attempts.at(-1) : null;
  const usage = lastAttempt?.usage || null;
  return {
    requestId: record.requestId,
    outcome: record.outcome || 'unknown',
    finalModel: record.finalModel || null,
    finalProvider: record.finalProvider || null,
    attemptCount: record.attemptCount || 0,
    agentId: record.agentId || 'generic',
    protocol: record.protocol || null,
    responseSize: record.responseSize || 0,
    latencyMs,
    httpStatus: lastAttempt?.httpStatus || null,
    tenant: record.tenant || '',
    usage,
    timestamp: record.timestamp || null,
  };
}

async function recordsFor(components) {
  const records = await components.store.getAllAuditRecords();
  return records.map(normalizeRecord).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function modelStats(config, records) {
  const stats = new Map((config.models || []).map((model) => [model.id, {
    id: model.id,
    provider: model.provider,
    tier: model.tier,
    description: model.description || model.desc || '',
    capability: model.capability || model.capabilities || [],
    enabled: model.enabled !== false,
    paid: model.paid === true,
    requests: 0,
    success: 0,
    failures: 0,
    latencyMs: 0,
  }]));
  for (const record of records) {
    const model = stats.get(record.finalModel);
    if (!model) continue;
    model.requests += 1;
    model.success += SUCCESS_OUTCOMES.has(record.outcome) ? 1 : 0;
    model.failures += SUCCESS_OUTCOMES.has(record.outcome) ? 0 : 1;
    model.latencyMs += record.latencyMs;
  }
  return [...stats.values()].map((model) => ({
    ...model,
    avgLatencyMs: model.requests ? Math.round(model.latencyMs / model.requests) : 0,
    latency_ms: model.requests ? Math.round(model.latencyMs / model.requests) : 0,
    active: 0,
    cooling: false,
    degraded: false,
    warned: 0,
    score: model.requests ? Math.round((model.success / model.requests) * 1000) / 10 : 100,
  }));
}

function overview(config, records) {
  const successful = records.filter((record) => SUCCESS_OUTCOMES.has(record.outcome)).length;
  const totalLatency = records.reduce((sum, record) => sum + record.latencyMs, 0);
  return {
    total_requests: records.length,
    success_rate: records.length ? Math.round((successful / records.length) * 1000) / 10 : 100,
    avg_latency_ms: records.length ? Math.round(totalLatency / records.length) : 0,
    pool_size: (config.models || []).filter((model) => model.enabled !== false).length,
    total_tokens_in: 0,
    total_tokens_out: 0,
    cooling_count: 0,
    upstream_healthy: true,
  };
}

function providerSummary(config, health, records) {
  const healthSummary = health?.getHealthSummary?.() || {};
  return (config.providers || []).map((provider) => {
    const healthState = healthSummary[provider.name] || {};
    const providerRecords = records.filter((record) => record.finalProvider === provider.name);
    const successful = providerRecords.filter((record) => SUCCESS_OUTCOMES.has(record.outcome)).length;
    return {
      name: provider.name,
      display: provider.name,
      models: (config.models || []).filter((model) => model.provider === provider.name).length,
      requests: providerRecords.length,
      success: successful,
      healthy: healthState.status !== 'down',
      status: healthState.status || 'unknown',
      cooling: false,
      cool_remain: 0,
      fail_count: healthState.totalFailures || 0,
      avg_latency_ms: healthState.avgLatency || 0,
    };
  });
}

function groupByDay(records) {
  const grouped = new Map();
  for (const record of records) {
    const date = record.timestamp ? new Date(record.timestamp).toISOString().slice(0, 10) : 'unknown';
    const row = grouped.get(date) || { date, requests: 0, success: 0, fail: 0, tokens_in: 0, tokens_out: 0, avg_latency: 0 };
    row.requests += 1;
    row.success += SUCCESS_OUTCOMES.has(record.outcome) ? 1 : 0;
    row.fail += SUCCESS_OUTCOMES.has(record.outcome) ? 0 : 1;
    row.avg_latency += record.latencyMs;
    grouped.set(date, row);
  }
  return [...grouped.values()].map((row) => ({
    ...row,
    avg_latency: row.requests ? Math.round(row.avg_latency / row.requests) : 0,
    total_tokens: row.tokens_in + row.tokens_out,
  })).sort((a, b) => b.date.localeCompare(a.date));
}

function graph(config, health, records) {
  const providers = providerSummary(config, health, records);
  const stats = modelStats(config, records);
  const nodes = [];
  for (const provider of providers) {
    nodes.push({ id: provider.name, type: 'provider', label: provider.display, healthy: provider.healthy, requests: provider.requests, success: provider.success });
    for (const model of (config.models || []).filter((item) => item.provider === provider.name)) {
      nodes.push({ id: `${provider.name}/${model.id}`, type: 'model', label: model.id, provider: provider.name, score: stats.find((item) => item.id === model.id)?.score || 100, requests: records.filter((record) => record.finalModel === model.id).length });
    }
  }
  for (const name of Object.keys(config.agent_bindings || {})) {
    nodes.push({ id: name, type: 'agent', label: name, models: config.agent_bindings[name]?.model_ids?.length || 0, active: true });
  }
  return nodes;
}

function daysFromRequest(req, fallback) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const value = Number.parseInt(url.searchParams.get('days') || '', 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 366) : fallback;
}

function recordsInWindow(records, days) {
  const cutoff = Date.now() - days * 86_400_000;
  return records.filter((record) => {
    const timestamp = Date.parse(record.timestamp || '');
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
}

function statsTrend(records, days) {
  const buckets = new Map();
  for (const record of recordsInWindow(records, days)) {
    const timestamp = Date.parse(record.timestamp || '');
    const bucketDate = new Date(Math.floor(timestamp / 3_600_000) * 3_600_000);
    const bucket = bucketDate.toISOString().slice(0, 13).replace('T', ' ') + ':00';
    const row = buckets.get(bucket) || { bucket, requests: 0, success: 0, errors: 0, avg_lat: 0, tokens: 0 };
    row.requests += 1;
    row.success += SUCCESS_OUTCOMES.has(record.outcome) ? 1 : 0;
    row.errors += SUCCESS_OUTCOMES.has(record.outcome) ? 0 : 1;
    row.avg_lat += record.latencyMs;
    row.tokens += Number(record.usage?.total_tokens || record.usage?.input_tokens || 0) + Number(record.usage?.output_tokens || 0);
    buckets.set(bucket, row);
  }
  return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)).map((row) => ({
    ...row,
    avg_lat: row.requests ? Math.round(row.avg_lat / row.requests) : 0,
  }));
}

function statsLatency(records, days) {
  const values = recordsInWindow(records, days)
    .filter((record) => SUCCESS_OUTCOMES.has(record.outcome) && record.latencyMs > 0)
    .map((record) => record.latencyMs)
    .sort((a, b) => a - b);
  const percentile = (ratio) => values.length ? values[Math.min(Math.floor(values.length * ratio), values.length - 1)] : 0;
  const histogram = [];
  for (let index = 0; index < 10; index += 1) {
    const low = index * 500;
    const high = (index + 1) * 500;
    histogram.push({ range: `${low}-${high}ms`, count: values.filter((value) => value >= low && value < high).length });
  }
  return {
    samples: values.length,
    p50: percentile(0.5),
    p80: percentile(0.8),
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: values.at(-1) || 0,
    histogram,
  };
}

function statsErrors(records, days) {
  const statusCounts = new Map();
  const modelCounts = new Map();
  for (const record of recordsInWindow(records, days)) {
    const status = SUCCESS_OUTCOMES.has(record.outcome) ? 200 : Number(record.httpStatus || 500);
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    if (status >= 400) {
      const key = `${record.finalModel || 'unknown'}\u0000${status}`;
      modelCounts.set(key, (modelCounts.get(key) || 0) + 1);
    }
  }
  return {
    status_dist: [...statusCounts.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    model_errors: [...modelCounts.entries()].map(([key, count]) => {
      const [model, status] = key.split('\u0000');
      return { model, status: Number(status), count };
    }).sort((a, b) => b.count - a.count).slice(0, 15),
  };
}

function statsAgents(config, records, days) {
  const rows = new Map();
  for (const name of Object.keys(config.agent_bindings || {})) rows.set(name, { agent: name, agent_label: name, requests: 0, success: 0, avg_lat: 0, tokens: 0 });
  for (const record of recordsInWindow(records, days)) {
    const name = record.agentId || 'generic';
    const row = rows.get(name) || { agent: name, agent_label: name, requests: 0, success: 0, avg_lat: 0, tokens: 0 };
    row.requests += 1;
    row.success += SUCCESS_OUTCOMES.has(record.outcome) ? 1 : 0;
    row.avg_lat += record.latencyMs;
    row.tokens += Number(record.usage?.total_tokens || 0);
    rows.set(name, row);
  }
  return [...rows.values()].map((row) => ({ ...row, avg_lat: row.requests ? Math.round(row.avg_lat / row.requests) : 0 })).sort((a, b) => b.requests - a.requests);
}

function statsSnapshot(config, health, records) {
  const providers = providerSummary(config, health, records);
  return {
    overview: overview(config, records),
    providers: Object.fromEntries(providers.map((provider) => [provider.name, provider])),
    models: modelStats(config, records),
  };
}

async function authorize(req, res, config, publicHealth) {
  if (!isLoopback(req.socket?.remoteAddress || '')) {
    writeJson(res, 403, { ok: false, error: 'forbidden' });
    return false;
  }
  if (publicHealth) return true;
  const expected = adminToken(config);
  if (!expected) {
    writeJson(res, 503, { ok: false, error: 'admin_disabled' });
    return false;
  }
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tokenEqual(expected, provided)) {
    writeJson(res, 401, { ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

export async function handleLegacyApiRequest(req, res, components, pathname) {
  const isHealth = pathname === '/health' || pathname === '/api/health';
  const isLogin = pathname === '/api/login';
  const isLegacy = isHealth || isLogin || pathname === '/stats' || pathname === '/config' || pathname.startsWith('/api/');
  if (!isLegacy) return false;
  if (!(await authorize(req, res, components.config, isHealth || isLogin))) return true;
  if (isLogin) {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    const body = await readJsonBody(req, 16 * 1024);
    const valid = tokenEqual(adminToken(components.config), body.token);
    writeJson(res, valid ? 200 : 401, valid ? { ok: true } : { ok: false, error: 'invalid_token' });
    return true;
  }
  if (req.method !== 'GET') {
    try {
      if (await handleLegacyMutation(req, res, components, pathname)) return true;
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      writeJson(res, status, { success: false, error: status === 500 ? 'internal' : error.message });
    }
    if (!res.writableEnded) writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  const records = await recordsFor(components);
  const summary = overview(components.config, records);
  if (isHealth) {
    const providers = providerSummary(components.config, components.health, records);
    writeJson(res, 200, {
      status: 'ok',
      version: '1.0.0-smart-router',
      models_available: summary.pool_size,
      models_cooling: 0,
      providers_healthy: providers.filter((provider) => provider.healthy).length,
      providers_degraded: providers.filter((provider) => !provider.healthy).map((provider) => provider.name),
      upstream_healthy: providers.every((provider) => provider.healthy),
      success_rate: summary.success_rate,
      features: ['sqlite', 'health_check', 'fallback', 'cost_tracking', 'smart_routing'],
    });
    return true;
  }

  if (pathname === '/stats' || pathname === '/api/stats') {
    writeJson(res, 200, statsSnapshot(components.config, components.health, records));
    return true;
  }

  if (pathname === '/api/models' || pathname === '/api/config/models') {
    writeJson(res, 200, { success: true, models: modelStats(components.config, records), total: components.config.models?.length || 0 });
    return true;
  }
  if (pathname === '/api/providers' || pathname === '/providers') {
    writeJson(res, 200, providerSummary(components.config, components.health, records));
    return true;
  }
  if (pathname === '/api/stats' || pathname === '/api/stats/overview') {
    if (pathname === '/api/stats') {
      writeJson(res, 200, statsSnapshot(components.config, components.health, records));
    } else {
      writeJson(res, 200, { overview: summary, top_models: modelStats(components.config, records).sort((a, b) => b.requests - a.requests).slice(0, 10) });
    }
    return true;
  }
  if (pathname.startsWith('/api/stats/trend')) {
    writeJson(res, 200, { trend: statsTrend(records, daysFromRequest(req, 7)) });
    return true;
  }
  if (pathname.startsWith('/api/stats/latency')) {
    writeJson(res, 200, statsLatency(records, daysFromRequest(req, 1)));
    return true;
  }
  if (pathname.startsWith('/api/stats/errors')) {
    writeJson(res, 200, statsErrors(records, daysFromRequest(req, 1)));
    return true;
  }
  if (pathname.startsWith('/api/stats/agents')) {
    writeJson(res, 200, { agents: statsAgents(components.config, records, daysFromRequest(req, 7)) });
    return true;
  }
  if (pathname === '/api/tenants') {
    const tenantRows = new Map();
    for (const record of records) {
      const tenant = record.tenant || '';
      const row = tenantRows.get(tenant) || { tenant, requests: 0, success: 0, avg_lat: 0, tokens: 0 };
      row.requests += 1;
      row.success += SUCCESS_OUTCOMES.has(record.outcome) ? 1 : 0;
      row.avg_lat += record.latencyMs;
      row.tokens += Number(record.usage?.total_tokens || 0);
      tenantRows.set(tenant, row);
    }
    const tenants = [...tenantRows.values()].map((row) => ({ ...row, avg_lat: row.requests ? Math.round(row.avg_lat / row.requests) : 0 })).sort((a, b) => b.requests - a.requests);
    writeJson(res, 200, { tenants, key_counts: {} });
    return true;
  }
  if (pathname === '/api/circuit-breaker/status') {
    writeJson(res, 200, components.circuitBreaker?.getSummary?.() || {});
    return true;
  }
  if (pathname.startsWith('/api/recent')) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20));
    const model = url.searchParams.get('model') || '';
    const agent = url.searchParams.get('agent') || '';
    const recent = records.filter((record) => (!model || record.finalModel === model) && (!agent || record.agentId === agent)).slice(0, limit).map((record) => ({
      timestamp: record.timestamp,
      model: record.finalModel,
      provider: record.finalProvider,
      status: SUCCESS_OUTCOMES.has(record.outcome) ? 200 : 500,
      latency_ms: record.latencyMs,
      agent: record.agentId,
      tokens_in: 0,
      tokens_out: 0,
    }));
    writeJson(res, 200, { recent, total: records.length });
    return true;
  }
  if (pathname === '/api/daily') {
    writeJson(res, 200, { daily: groupByDay(records) });
    return true;
  }
  if (pathname === '/api/agents') {
    const agents = Object.entries(components.config.agent_bindings || {}).map(([name, binding]) => ({ name, label: name, bound: true, mode: binding.mode || 'group', bound_models: binding.model_ids || [], is_active: true, count: records.filter((record) => record.agentId === name).length }));
    writeJson(res, 200, { success: true, agents });
    return true;
  }
  if (pathname === '/api/agents-overview') {
    const agents = Object.keys(components.config.agent_bindings || {}).map((name) => ({ name, label: name, status: 'running', system: '已绑定模型池', skillCount: components.config.agent_bindings[name]?.model_ids?.length || 0 }));
    writeJson(res, 200, { agents, summary: { onlineCount: agents.length, totalMainAgents: agents.length, totalSubAgents: 0 }, dupSkills: [] });
    return true;
  }
  if (pathname === '/api/config') {
    writeJson(res, 200, safeConfig(components.config));
    return true;
  }
  if (pathname === '/config') {
    writeJson(res, 200, safeConfig(components.config));
    return true;
  }
  if (pathname === '/api/graph') {
    writeJson(res, 200, { nodes: graph(components.config, components.health, records) });
    return true;
  }
  if (pathname === '/api/cost') {
    writeJson(res, 200, { success: true, overview: { total_cost: 0, currency: 'USD', requests: records.length }, top_models: [] });
    return true;
  }
  if (pathname.startsWith('/api/cost/daily') || pathname.startsWith('/api/cost/by-model')) {
    writeJson(res, 200, { success: true, daily: [], by_model: [] });
    return true;
  }
  if (pathname === '/api/cache/stats') {
    writeJson(res, 200, { cache_entries: 0, total_hits: 0, cache_ttl: 0 });
    return true;
  }
  if (pathname === '/api/guardrails/logs') {
    writeJson(res, 200, { success: true, logs: [], total: 0 });
    return true;
  }
  if (pathname === '/api/rate-limit/status') {
    writeJson(res, 200, { success: true, rate_limits: [], total_ips: 0 });
    return true;
  }
  if (pathname === '/api/mcp-servers') {
    const servers = Object.entries(components.config.mcp_servers || {}).map(([name, server]) => ({ name, url: server.url, enabled: server.enabled !== false }));
    writeJson(res, 200, { servers });
    return true;
  }
  writeJson(res, 404, { ok: false, error: 'not_found' });
  return true;
}
