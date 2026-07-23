/**
 * server.js — Smart Router HTTP server
 */
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getConfig, reloadConfig, loadRawConfig, saveRawConfigAtomic } from './config.js';
import { routeChatCompletion, getRecentLogs, getStats, getModelLatency, getModelCounts, getStatusDistribution, getProviderHealth, sanitizeConfigForClient } from './provider-client.js';
import { handleAnthropicMessage, pipeAnthropicSSE } from './anthropic.js';
import { checkRateLimit } from './rate-limit.js';
import { checkInput, logGuardrail } from './guardrails.js';
import { recordCost, getCostOverview, getCostDaily, getCostByModel } from './cost.js';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const log = (...args) => console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}]`, ...args);

const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 3600;

function hashPrompt(messages) {
  const text = typeof messages === 'string' ? messages : JSON.stringify(messages);
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16);
}

function exactCacheKey(model, _provider, messages, tools, toolChoice, responseFormat, temperature) {
  const parts = [model, hashPrompt(messages)];
  if (tools) parts.push('tools:' + hashPrompt(tools));
  if (toolChoice) parts.push('tc:' + JSON.stringify(toolChoice));
  if (responseFormat) parts.push('rf:' + JSON.stringify(responseFormat));
  if (temperature !== undefined) parts.push('t:' + temperature);
  return createHash('sha256').update(parts.join('|'), 'utf-8').digest('hex');
}

function shouldSkipCache(body, model, tools, agent) {
  if (body.stream === true) return true;
  if (tools && tools.length > 0) return true;
  if (body.tool_choice) return true;
  if (!model || model === 'auto') return true;
  if (agent && agent !== '') return true;
  return false;
}

function cacheGet(model, provider, messages, tools, toolChoice, responseFormat, temperature) {
  try {
    const key = exactCacheKey(model, provider, messages, tools, toolChoice, responseFormat, temperature);
    const row = db.prepare('SELECT response, tokens_in, tokens_out FROM cache WHERE cache_key = ? AND expires_at > ?').get(key, Date.now() / 1000);
    if (row) {
      db.prepare('UPDATE cache SET hit_count = hit_count + 1 WHERE cache_key = ?').run(key);
      return { response: JSON.parse(row.response), tokens: (row.tokens_in || 0) + (row.tokens_out || 0) };
    }
  } catch (e) { console.error('[cache] get error:', e.message); }
  return null;
}

function cacheSet(model, provider, messages, response, tokensIn, tokensOut, tools, toolChoice, responseFormat, temperature) {
  try {
    const key = exactCacheKey(model, provider, messages, tools, toolChoice, responseFormat, temperature);
    const snippet = JSON.stringify(messages).slice(0, 500);
    db.prepare('INSERT OR REPLACE INTO cache (cache_key, model, prompt_snippet, response, tokens_in, tokens_out, created_at, expires_at, hit_count) VALUES (?,?,?,?,?,?,?,?,1)').run(
      key, model, snippet, JSON.stringify(response), tokensIn || 0, tokensOut || 0, Date.now() / 1000, Date.now() / 1000 + CACHE_TTL
    );
  } catch (e) { console.error('[cache] set error:', e.message); }
}

let db = null;

/**
 * Idempotent, rollback-safe migration of `cost_daily` from the legacy primary key
 * (date, model) — which has no `provider` column — to the current primary key
 * (date, model, provider).
 *
 * Steps:
 *   1. Detect old schema (no `provider` column / table missing). If already current, return early.
 *   2. Create `cost_daily_new` with the new schema.
 *   3. Copy aggregated rows from the old table (duplicates are summed so the new PK cannot collide).
 *   4. Validate row counts match (throw if not — the original table is left untouched).
 *   5. Atomically swap inside a transaction: rename old → cost_daily_backup, new → cost_daily.
 *      A backup of the original rows is retained as cost_daily_backup.
 *
 * Idempotent: on a fresh / already-migrated DB the `provider` column exists and we
 * return early, so repeated starts never re-migrate or error.
 */
export function migrateCostDaily(db) {
  if (!db) return { migrated: false, reason: 'no-db' };
  let info = [];
  try {
    info = db.pragma('table_info(cost_daily)');
  } catch {
    return { migrated: false, reason: 'no-table' };
  }
  const cols = info.map((r) => r.name);
  // Determine the actual primary-key columns (table_info().pk > 0 marks key columns).
  const pkCols = info.filter((r) => r.pk > 0).map((r) => r.name).sort().join(',');
  const targetPk = 'date,model,provider';
  // Migration is required when EITHER the provider column is missing OR the primary key is
  // not exactly (date, model, provider). A table that has a provider column but an outdated
  // PK (e.g. (date, model)) must still be rebuilt, otherwise the upsert's
  // `ON CONFLICT(date, model, provider)` references a non-unique column and the server crashes
  // at startup. (This is what pure "provider column present?" checks got wrong.)
  const needsMigration = !cols.includes('provider') || pkCols !== targetPk;
  if (!needsMigration) return { migrated: false, reason: 'already-current' };

  // Clean up any leftover temp table from a previously aborted run.
  db.exec('DROP TABLE IF EXISTS cost_daily_new');
  db.exec('DROP TABLE IF EXISTS cost_daily_backup');

  db.exec(`
    CREATE TABLE cost_daily_new (
      date TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT DEFAULT '',
      requests INTEGER DEFAULT 1,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_rmb REAL DEFAULT 0,
      PRIMARY KEY (date, model, provider)
    );
  `);

  // Aggregate to avoid PK collisions. Preserve provider when the source table already has it.
  if (cols.includes('provider')) {
    db.prepare(
      `INSERT INTO cost_daily_new (date, model, provider, requests, tokens_in, tokens_out, cost_rmb)
       SELECT date, model, COALESCE(provider, ''), SUM(requests), SUM(tokens_in), SUM(tokens_out), SUM(cost_rmb)
       FROM cost_daily GROUP BY date, model, provider`
    ).run();
  } else {
    db.prepare(
      `INSERT INTO cost_daily_new (date, model, provider, requests, tokens_in, tokens_out, cost_rmb)
       SELECT date, model, '', SUM(requests), SUM(tokens_in), SUM(tokens_out), SUM(cost_rmb)
       FROM cost_daily GROUP BY date, model`
    ).run();
  }

  const before = db.prepare('SELECT COUNT(*) AS c FROM cost_daily').get().c;
  const after = db.prepare('SELECT COUNT(*) AS c FROM cost_daily_new').get().c;
  if (before !== after) {
    db.exec('DROP TABLE IF EXISTS cost_daily_new');
    throw new Error(`cost_daily migration aborted: row count mismatch (before=${before}, after=${after}). Original table untouched.`);
  }

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cost_daily RENAME TO cost_daily_backup');
    db.exec('ALTER TABLE cost_daily_new RENAME TO cost_daily');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
    throw new Error('cost_daily migration failed during atomic swap: ' + e.message);
  }

  return { migrated: true, rows: after };
}

export function initDatabase(dbPath) {
  db = new Database(dbPath);
  // Cache cleanup timer. Started only once the DB is initialised (i.e. when the
  // server actually starts), NOT at module load — a module-load timer kept the
  // event loop alive and prevented `node --test` from exiting after tests ran.
  setInterval(() => {
    try {
      const n = db.prepare('DELETE FROM cache WHERE expires_at < ?').run(Date.now() / 1000);
      if (n.changes > 0) log(`Cleaned ${n.changes} expired cache entries`);
    } catch (e) { console.error('[cache] cleanup error:', e.message); }
  }, 300000);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT DEFAULT '',
      timestamp REAL NOT NULL,
      model TEXT NOT NULL,
      provider TEXT DEFAULT '',
      status INTEGER NOT NULL,
      latency_ms INTEGER DEFAULT 0,
      ttft_ms INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      agent TEXT DEFAULT '',
      error TEXT DEFAULT '',
      protocol TEXT DEFAULT 'openai',
      requested_model TEXT DEFAULT '',
      final_model TEXT DEFAULT '',
      attempts TEXT DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(timestamp);
    CREATE INDEX IF NOT EXISTS idx_req_id ON requests(request_id);

    CREATE TABLE IF NOT EXISTS cache (
      cache_key TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      prompt_snippet TEXT,
      response TEXT NOT NULL,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      created_at REAL NOT NULL,
      expires_at REAL NOT NULL,
      hit_count INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

    CREATE TABLE IF NOT EXISTS cost_daily (
      date TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT DEFAULT '',
      requests INTEGER DEFAULT 1,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_rmb REAL DEFAULT 0,
      PRIMARY KEY (date, model, provider)
    );

    CREATE TABLE IF NOT EXISTS guardrail_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp REAL NOT NULL,
      direction TEXT NOT NULL,
      rule TEXT NOT NULL,
      severity TEXT DEFAULT 'medium',
      ip TEXT DEFAULT '',
      snippet TEXT DEFAULT '',
      action TEXT DEFAULT 'block',
      agent TEXT DEFAULT ''
    );
  `);

  // ── Migration: legacy cost_daily (PK date,model) → (date,model,provider) ──
  try {
    const m = migrateCostDaily(db);
    if (m.migrated) log(`[db-migrate] cost_daily migrated: ${m.rows} rows (backup retained as cost_daily_backup)`);
  } catch (e) {
    // Database migration failure must surface loudly — never silently continue.
    throw new Error('Database migration failed: ' + e.message);
  }

  try { db.exec('ALTER TABLE requests ADD COLUMN request_id TEXT DEFAULT \'\''); } catch (e) { log('[db] ensure column skipped (idempotent): ' + e.message); }
  try { db.exec('ALTER TABLE requests ADD COLUMN ttft_ms INTEGER DEFAULT 0'); } catch (e) { log('[db] ensure column skipped (idempotent): ' + e.message); }
  try { db.exec('ALTER TABLE requests ADD COLUMN protocol TEXT DEFAULT \'openai\''); } catch (e) { log('[db] ensure column skipped (idempotent): ' + e.message); }
  try { db.exec('ALTER TABLE requests ADD COLUMN requested_model TEXT DEFAULT \'\''); } catch (e) { log('[db] ensure column skipped (idempotent): ' + e.message); }
  try { db.exec('ALTER TABLE requests ADD COLUMN final_model TEXT DEFAULT \'\''); } catch (e) { log('[db] ensure column skipped (idempotent): ' + e.message); }
  try { db.exec('ALTER TABLE requests ADD COLUMN attempts TEXT DEFAULT \'[]\''); } catch (e) { log('[db] ensure column skipped (idempotent): ' + e.message); }

  const stmts = {};
  stmts.dbLogGuardrail = db.prepare(
    'INSERT INTO guardrail_logs (timestamp, direction, rule, severity, ip, snippet, action, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  stmts.dbUpsertCost = db.prepare(
    'INSERT INTO cost_daily (date, model, provider, requests, tokens_in, tokens_out, cost_rmb) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(date, model, provider) DO UPDATE SET requests = requests + 1, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_rmb = cost_rmb + ?'
  );
  stmts.dbLogRequest = db.prepare(
    `INSERT INTO requests (request_id, timestamp, model, provider, status, latency_ms, ttft_ms, tokens_in, tokens_out, agent, error, protocol, requested_model, final_model, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  return stmts;
}

const MAX_BODY_SIZE = 100 * 1024 * 1024;

function sanitizeLog(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/(sk-|nvapi-|ms-|ak_)[a-zA-Z0-9_-]{10,}/g, '$1***');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(new Error('Request body too large')); return; }
      body += chunk;
    });
    req.on('end', () => {
      try {
        if (!body || !body.trim()) resolve({});
        else resolve(JSON.parse(body));
      } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
    setTimeout(() => { if (!req.complete) { req.destroy(); reject(new Error('Request timeout')); } }, 60000);
  });
}

function getQueryParams(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = {};
  new URLSearchParams(url.slice(idx)).forEach((v, k) => params[k] = v);
  return params;
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendError(res, message, status = 400) {
  jsonResponse(res, { error: message }, status);
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
}

function getAgentFromReq(req) {
  return req.headers['x-agent-name'] || req.headers['user-agent']?.split('/')[0] || '';
}

function generateId() {
  const ts = Date.now().toString(36);
  const r = Math.random().toString(36).substring(2, 8);
  return `req_${ts}_${r}`;
}

function persistRequest(db, stmts, data) {
  if (!db || !stmts?.dbLogRequest) return;
  try {
    stmts.dbLogRequest.run(
      data.requestId || '',
      data.timestamp || Date.now() / 1000,
      data.model || '',
      data.provider || '',
      data.status || 0,
      data.latencyMs || 0,
      data.ttft || 0,
      data.tokensIn || 0,
      data.tokensOut || 0,
      data.agent || '',
      data.error || '',
      data.protocol || 'openai',
      data.requestedModel || '',
      data.finalModel || '',
      JSON.stringify(data.attemptLog || [])
    );
  } catch (e) { console.error('[persist] request error:', e.message); }
}

function checkConfigSecurity(cfg) {
  const warnings = [];
  if (cfg.host === '0.0.0.0' && !cfg.adminToken) warnings.push('Listening on 0.0.0.0 without admin token');
  if (cfg.host !== '127.0.0.1' && !cfg.adminToken) warnings.push('Non-loopback binding without admin token');
  try {
    const cfgPath = cfg.configFile || join(ROOT, 'config', 'config.json');
    if (existsSync(cfgPath)) {
      const mode = statSync(cfgPath).mode;
      if (mode & 0o004) warnings.push('Config file is world-readable');
    }
  } catch { /* stat may fail */ }
  return warnings;
}

export const CORS_ALLOWED_HEADERS = 'Content-Type, Authorization, X-Api-Key, X-Request-Id, X-Agent-Name, X-Preferred-Model, X-Excluded-Models, X-Preferred-Provider, X-Excluded-Providers';

// Determine whether a request is allowed. Localhost detection must be based on the
// CLIENT (remote) address — never req.socket.localAddress, which is the server's own
// bind address and is always 127.0.0.1 for loopback listeners (a bug that wrongly
// authenticated every request as "local").
export function authenticate(req, res) {
  const config = getConfig();
  const clientAddr = req.socket.remoteAddress || '127.0.0.1';
  const localAddrs = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  if (!config.adminToken) return localAddrs.has(clientAddr);
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (token === config.adminToken) return true;
  }
  const xKey = req.headers['x-api-key'];
  if (xKey && xKey === config.adminToken) return true;
  return false;
}

function encodeWebSocketTextFrame(text) {
  const data = Buffer.from(text, 'utf-8');
  const len = data.length;
  let frame;
  if (len < 126) {
    frame = Buffer.alloc(2 + len);
    frame[0] = 0x81; frame[1] = len; data.copy(frame, 2);
  } else if (len < 65536) {
    frame = Buffer.alloc(4 + len);
    frame[0] = 0x81; frame[1] = 126; frame.writeUInt16BE(len, 2); data.copy(frame, 4);
  } else {
    frame = Buffer.alloc(10 + len);
    frame[0] = 0x81; frame[1] = 127; frame.writeBigUInt64BE(BigInt(len), 2); data.copy(frame, 10);
  }
  return frame;
}

async function pipeSSEStream(stream, writable, transformFn, options = {}) {
  const { requestId, onFirstChunk } = options;
  let doneSent = false;
  function sendDone() {
    if (!doneSent) {
      try { writable.write('data: [DONE]\n\n'); } catch {}
      doneSent = true;
    }
  }
  function emitError(msg) {
    if (!doneSent) {
      try { writable.write(`data: ${JSON.stringify({ error: msg })}\n\n`); } catch {}
      doneSent = true;
    }
  }
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let hasSentFirst = false;
    let stallTimer = null;
    let lastChunkTime = Date.now();
    const stallTimeoutMs = options.stallTimeoutMs || 15000;
    const checkStall = () => {
      if (hasSentFirst && Date.now() - lastChunkTime > stallTimeoutMs) {
        log(`[${requestId}] SSE stream stalled`);
        try { reader.cancel(); } catch {}
      }
    };
    stallTimer = setInterval(checkStall, 2000);
    while (true) {
      let result;
      try { result = await reader.read(); } catch { break; }
      const { done, value } = result;
      if (done) break;
      lastChunkTime = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') { sendDone(); continue; }
          if (transformFn) {
            try { const t = transformFn(data); if (t) writable.write(t); } catch {}
          } else { writable.write(line + '\n\n'); }
          if (!hasSentFirst) { hasSentFirst = true; onFirstChunk?.(); }
        } else if (line.trim()) { writable.write(line + '\n'); }
      }
    }
    clearInterval(stallTimer);
    sendDone();
  } catch (err) {
    if (err.name !== 'AbortError') log(`[${requestId}] SSE stream error:`, sanitizeLog(err.message));
    emitError(err.message);
    sendDone();
  }
}

function serveStatic(res, filePath) {
  const normalizedPath = filePath.replace(/\.\./g, '');
  const paths = [join(ROOT, 'frontend', 'dist', normalizedPath), join(ROOT, 'frontend', 'dist', 'index.html')];
  for (const p of paths) {
    if (existsSync(p) && statSync(p).isFile()) {
      const ext = extname(p);
      const data = readFileSync(p);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=31536000',
      });
      res.end(data);
      return true;
    }
  }
  return false;
}

function parsePath(reqUrl) {
  const idx = reqUrl.indexOf('?');
  return idx === -1 ? reqUrl : reqUrl.slice(0, idx);
}

function buildSavePayload(body, action) {
  const raw = loadRawConfig();
  if (action === 'upsert-provider') {
    const providers = raw.providers || {};
    providers[body.name || body.display] = { api_type: 'openai', ...body };
    raw.providers = providers;
  } else if (action === 'upsert-model') {
    const models = raw.models || [];
    const idx = models.findIndex(m => m.name === body.name || m.id === body.id);
    if (idx >= 0) models[idx] = body;
    else models.push(body);
    raw.models = models;
  } else if (action === 'delete-model') {
    raw.models = (raw.models || []).filter(m => m.name !== body.name && m.id !== body.id);
  }
  return raw;
}

export function createServer() {
  const config = getConfig();
  const stmts = initDatabase(config.dbPath);

  for (const w of checkConfigSecurity(config)) log(`[security] ${w}`);

  const wsClients = new Set();

  function wsBroadcast(data) {
    const msg = JSON.stringify(data);
    const frame = encodeWebSocketTextFrame(msg);
    for (const ws of wsClients) { try { ws.write(frame); } catch { wsClients.delete(ws); } }
  }

  const allowedHeaders = CORS_ALLOWED_HEADERS;

  const srv = http.createServer(async (req, res) => {
    const method = req.method;
    const path = parsePath(req.url);
    const ip = getClientIP(req);
    const agent = getAgentFromReq(req);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders);

    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      if (path === '/dashboard' || path === '/dashboard/' || path === '/') {
        serveStatic(res, 'index.html');
        return;
      }
      if (path.startsWith('/assets/') || path.startsWith('/src/') || path === '/favicon.svg' || path === '/icons.svg') {
        serveStatic(res, path);
        return;
      }

      if (path === '/health' && method === 'GET') {
        const cfg = getConfig();
        jsonResponse(res, {
          status: 'ok', version: '6.1.0', uptime: process.uptime(),
          models_available: (cfg.models || []).filter(m => m.enabled !== false).length,
          providers_available: Object.keys(cfg.providers || {}).filter(k => cfg.providers[k].enabled !== false).length,
        });
        return;
      }

      if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }

      if (path === '/stats' && method === 'GET') {
        const stats = getStats();
        jsonResponse(res, {
          overview: { ...stats.overview, pool_size: (getConfig().models || []).filter(m => m.enabled !== false).length },
          model_latency: getModelLatency(),
          model_counts: getModelCounts(),
          status_distribution: getStatusDistribution(),
          provider_health: getProviderHealth(),
        });
        return;
      }

      if (path === '/api/recent' && method === 'GET') {
        const params = getQueryParams(req.url);
        jsonResponse(res, { recent: getRecentLogs(parseInt(params.limit) || 20, params.agent || '') });
        return;
      }

      if (path === '/api/providers') {
        if (method === 'GET') {
          jsonResponse(res, sanitizeConfigForClient(getConfig().providers || {}));
          return;
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req);
          const payload = buildSavePayload(body, 'upsert-provider');
          try {
            saveRawConfigAtomic(payload);
            jsonResponse(res, { success: true });
          } catch (e) { sendError(res, 'Failed to save: ' + e.message, 500); }
          return;
        }
        sendError(res, 'Method not allowed', 405);
        return;
      }

      if (path === '/api/models') {
        if (method === 'GET') {
          jsonResponse(res, { models: (getConfig().models || []) });
          return;
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req);
          const payload = buildSavePayload(body, 'upsert-model');
          try {
            saveRawConfigAtomic(payload);
            jsonResponse(res, { success: true });
          } catch (e) { sendError(res, 'Failed to save: ' + e.message, 500); }
          return;
        }
        sendError(res, 'Method not allowed', 405);
        return;
      }

      // OpenAI-compatible model listing. Same source as /api/models, reshaped to the
      // OpenAI `{ object: 'list', data: [...] }` contract so standard clients work.
      if (path === '/v1/models' && method === 'GET') {
        const cfg = getConfig();
        const data = (cfg.models || [])
          .filter((m) => m.enabled !== false)
          .map((m) => ({
            id: m.id || m.name,
            object: 'model',
            created: m.created || 0,
            owned_by: m.owned_by || m.provider || 'smart-router',
          }));
        jsonResponse(res, { object: 'list', data });
        return;
      }

      if (path.startsWith('/api/models/') && method === 'DELETE') {
        const modelName = decodeURIComponent(path.slice('/api/models/'.length));
        const payload = buildSavePayload({ name: modelName, id: modelName }, 'delete-model');
        try {
          saveRawConfigAtomic(payload);
          jsonResponse(res, { success: true });
        } catch (e) { sendError(res, 'Failed to save', 500); }
        return;
      }

      if (path === '/api/routes') {
        if (method === 'GET') {
          const cfg = getConfig();
          jsonResponse(res, {
            tier_weights: cfg.routing?.tierWeights || {},
            max_retries: cfg.routing?.maxRetries || 4,
            cooldown_seconds: cfg.routing?.cooldownSeconds || 30,
          });
          return;
        }
        sendError(res, 'Method not allowed', 405);
        return;
      }

      if (path === '/api/cost' && method === 'GET') {
        jsonResponse(res, { ...getCostOverview(db), daily: getCostDaily(db), top_models: getCostByModel(db) });
        return;
      }

      if (path === '/api/config' && method === 'GET') {
        jsonResponse(res, sanitizeConfigForClient(getConfig()));
        return;
      }

      if (path === '/api/system/reload' && method === 'POST') {
        reloadConfig();
        jsonResponse(res, { success: true, message: 'Config reloaded' });
        return;
      }

      // ── Chat Completions Proxy ──
      if ((path === '/v1/chat/completions' || path === '/chat/completions') && method === 'POST') {
        const requestId = generateId();

        const rlResult = checkRateLimit(ip, path);
        if (!rlResult.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rlResult.retryAfter || 1) });
          res.end(JSON.stringify({ error: 'Rate limited', retry_after: rlResult.retryAfter }));
          return;
        }

        const body = await parseJsonBody(req);

        const lastMsg = body.messages?.[body.messages.length - 1]?.content || '';
        if (lastMsg) {
          const guardResults = checkInput(lastMsg);
          if (guardResults.blocked) {
            logGuardrail(db, stmts.dbLogGuardrail, 'input', 'Critical block', 'critical', ip, lastMsg.slice(0, 100), 'block', agent);
            res.writeHead(451, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Content blocked by guardrails' }));
            return;
          }
          for (const r of guardResults.rules) {
            logGuardrail(db, stmts.dbLogGuardrail, 'input', r.rule, r.severity, ip, r.snippet || lastMsg.slice(0, 100), r.action, agent);
          }
        }

        const cacheEnabled = getConfig().routing?.exact_response_cache !== false;

        if (cacheEnabled && !shouldSkipCache(body, body.model, body.tools, agent)) {
          const cached = cacheGet(body.model, null, body.messages, body.tools, body.tool_choice, body.response_format, body.temperature);
          if (cached) {
            log(`[${requestId}] Cache hit`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.response));
            return;
          }
        }

        const preferredModel = req.headers['x-preferred-model'] || '';
        const excludedModels = (req.headers['x-excluded-models'] || '').split(',').map(s => s.trim()).filter(Boolean);
        const preferredProvider = req.headers['x-preferred-provider'] || '';
        const excludedProviders = (req.headers['x-excluded-providers'] || '').split(',').map(s => s.trim()).filter(Boolean);

        try {
          const result = await routeChatCompletion(body, agent, {
            requestId, preferredModel, excludedModels, preferredProvider, excludedProviders,
          });

          if (result.error) {
            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(result.body);
            persistRequest(db, stmts, {
              requestId, status: result.status, model: result.model, provider: result.provider,
              latencyMs: result.latencyMs, agent, error: result.status === 400 ? 'Bad request' : 'Unprocessable',
              requestedModel: body.model, finalModel: result.model, protocol: 'openai', attemptLog: result.attemptLog,
            });
            return;
          }

          const { provider: providerName, model, latencyMs, isStream } = result;

          if (isStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no', 'X-Model': model, 'X-Provider': providerName, 'X-Request-Id': requestId,
            });
            let totalIn = 0, totalOut = 0;
            await pipeSSEStream(result.remainingStream, res, (data) => {
              try { const p = JSON.parse(data); totalIn = p.usage?.prompt_tokens || totalIn; totalOut = p.usage?.completion_tokens || totalOut; } catch {}
              return `data: ${data}\n\n`;
            }, { requestId, onFirstChunk: () => {} });
            log(`[${requestId}] ${model} (${providerName}) stream ${latencyMs}ms`);
            if (totalIn > 0 || totalOut > 0) recordCost(db, stmts.dbUpsertCost, model, providerName, totalIn, totalOut, agent);
            persistRequest(db, stmts, {
              requestId, status: 200, model, provider: providerName,
              latencyMs, ttft: result.ttft || 0, tokensIn: totalIn, tokensOut: totalOut,
              agent, requestedModel: body.model, finalModel: model, protocol: 'openai', attemptLog: result.attemptLog,
            });
          } else {
            const responseData = JSON.parse(result.body);
            const tokensIn = responseData.usage?.prompt_tokens || 0;
            const tokensOut = responseData.usage?.completion_tokens || 0;
            if (cacheEnabled && !shouldSkipCache(body, body.model, body.tools, agent) && tokensIn > 0) {
              cacheSet(body.model, null, body.messages, responseData, tokensIn, tokensOut,
                body.tools, body.tool_choice, body.response_format, body.temperature);
            }
            recordCost(db, stmts.dbUpsertCost, model, providerName, tokensIn, tokensOut, agent);
            res.writeHead(200, {
              'Content-Type': 'application/json', 'X-Model': model, 'X-Provider': providerName, 'X-Request-Id': requestId,
            });
            res.end(result.body);
            log(`[${requestId}] ${model} (${providerName}) ${latencyMs}ms`);
            persistRequest(db, stmts, {
              requestId, status: 200, model, provider: providerName,
              latencyMs, tokensIn, tokensOut,
              agent, requestedModel: body.model, finalModel: model, protocol: 'openai', attemptLog: result.attemptLog,
            });
          }
        } catch (err) {
          log(`[${requestId}] Failed:`, sanitizeLog(err.message));
          persistRequest(db, stmts, {
            requestId, status: 502, model: body.model || 'unknown', provider: '',
            latencyMs: 0, agent, error: sanitizeLog(err.message),
            requestedModel: body.model, finalModel: '', protocol: 'openai',
            attemptLog: err.attemptLog || [],
          });
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: sanitizeLog(err.message) || 'All providers unavailable' }));
        }
        return;
      }

      // ── Anthropic Messages API ──
      if ((path === '/v1/messages' || path === '/messages') && method === 'POST') {
        const requestId = generateId();
        const rlResult = checkRateLimit(ip, path);
        if (!rlResult.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rlResult.retryAfter || 1) });
          res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }));
          return;
        }
        const body = await parseJsonBody(req);
        const result = await handleAnthropicMessage(body, agent, { requestId });

        if (result.error) {
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(result.body);
          persistRequest(db, stmts, {
            requestId, status: result.status, model: body.model || 'unknown', provider: result.provider || '',
            latencyMs: result.latencyMs || 0, agent, error: 'Anthropic error',
            requestedModel: body.model, finalModel: result.model || '', protocol: 'anthropic',
          });
          return;
        }

        if (result.isStream) {
          const providerName = result.provider;
          const model = result.model;
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no', 'X-Model': model, 'X-Provider': providerName, 'X-Request-Id': requestId,
          });
          await pipeAnthropicSSE(result.response, res, {
            requestId, nativeAnthropic: result.nativeAnthropic,
            reader: result.reader, firstChunk: result.firstChunk,
          });
          log(`[${requestId}] Anthropic stream: ${model} (${providerName})`);
          persistRequest(db, stmts, {
            requestId, status: 200, model, provider: providerName,
            latencyMs: result.latencyMs || 0, agent,
            requestedModel: body.model, finalModel: model, protocol: 'anthropic',
          });
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/json', 'X-Model': result.model, 'X-Provider': result.provider, 'X-Request-Id': requestId,
          });
          res.end(result.body);
          log(`[${requestId}] Anthropic: ${result.model} (${result.provider})`);
          persistRequest(db, stmts, {
            requestId, status: 200, model: result.model, provider: result.provider,
            latencyMs: result.latencyMs || 0, agent,
            requestedModel: body.model, finalModel: result.model, protocol: 'anthropic',
          });
        }
        return;
      }

      sendError(res, 'Not found', 404);

    } catch (err) {
      log('Request error:', sanitizeLog(err.message));
      sendError(res, 'Internal server error', 500);
    }
  });

  srv.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    const wsAddr = req.socket.remoteAddress || '127.0.0.1';
    const localAddrs = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
    const cfg = getConfig();
    if (cfg.adminToken) {
      const wsAuth = req.headers['authorization'] || req.headers['sec-websocket-protocol'] || '';
      const wsKey = req.headers['x-api-key'] || '';
      const authed = wsAuth.startsWith('Bearer ') ? wsAuth.slice(7) === cfg.adminToken : wsAuth === cfg.adminToken;
      if (!authed && wsKey !== cfg.adminToken && !localAddrs.has(wsAddr)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    wsClients.add(socket);
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
    try {
      const stats = getStats();
      const cfg = getConfig();
      socket.write(encodeWebSocketTextFrame(JSON.stringify({
        type: 'snapshot',
        data: { overview: stats.overview, provider_count: Object.keys(cfg.providers || {}).length, model_count: (cfg.models || []).length, uptime: process.uptime(), timestamp: Date.now() / 1000 }
      })));
    } catch { /* ws write may fail */ }
  });

  setInterval(() => {
    if (wsClients.size === 0) return;
    try {
      const stats = getStats();
      wsBroadcast({ type: 'snapshot', data: { overview: stats.overview, recent: stats.recent.slice(0, 10), timestamp: Date.now() / 1000 } });
    } catch { /* broadcast error */ }
  }, 5000);

  srv.keepAliveTimeout = 120000;
  srv.headersTimeout = 121000;
  srv.timeout = 0;

  return srv;
}
