/**
 * server.js — Smart Router HTTP server
 * Handles all API routes, proxy endpoints, WebSocket, and static file serving
 */
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getConfig, reloadConfig } from './config.js';
import { routeChatCompletion, getRecentLogs, getStats, getModelLatency, getModelCounts, getStatusDistribution, getProviderHealth } from './provider-client.js';
import { checkRateLimit, getRateLimitStats } from './rate-limit.js';
import { checkInput, checkOutput, logGuardrail, getGuardrailLogs } from './guardrails.js';
import { calculateCost, recordCost, getCostOverview, getCostDaily, getCostByModel } from './cost.js';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── MIME types ──
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

// ── Logger ──
const log = (...args) => console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}]`, ...args);

// ── Semantic Cache ──
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 3600;

function hashPrompt(messages) {
  const text = typeof messages === 'string' ? messages : JSON.stringify(messages);
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16);
}

function cacheGet(model, messages) {
  try {
    const key = model + ':' + hashPrompt(messages);
    const row = db.prepare('SELECT response, tokens_in, tokens_out FROM cache WHERE cache_key = ? AND expires_at > ?').get(key, Date.now() / 1000);
    if (row) {
      db.prepare('UPDATE cache SET hit_count = hit_count + 1 WHERE cache_key = ?').run(key);
      return { response: JSON.parse(row.response), tokens: (row.tokens_in || 0) + (row.tokens_out || 0) };
    }
  } catch {}
  return null;
}

function cacheSet(model, messages, response, tokensIn, tokensOut) {
  try {
    const key = model + ':' + hashPrompt(messages);
    const snippet = (typeof messages === 'string' ? messages : JSON.stringify(messages)).slice(0, 500);
    db.prepare('INSERT OR REPLACE INTO cache (cache_key, model, prompt_snippet, response, tokens_in, tokens_out, created_at, expires_at, hit_count) VALUES (?,?,?,?,?,?,?,?,1)').run(key, model, snippet, JSON.stringify(response), tokensIn || 0, tokensOut || 0, Date.now() / 1000, Date.now() / 1000 + CACHE_TTL);
  } catch {}
}

// Periodic cache cleanup
setInterval(() => {
  try {
    const n = db.prepare('DELETE FROM cache WHERE expires_at < ?').run(Date.now() / 1000);
    if (n.changes > 0) log(`🧹 Cleaned ${n.changes} expired cache entries`);
  } catch {}
}, 300000);


// ── Database setup ──
let db = null;

function initDatabase(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp REAL NOT NULL,
      model TEXT NOT NULL,
      provider TEXT DEFAULT '',
      status INTEGER NOT NULL,
      latency_ms INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      agent TEXT DEFAULT '',
      error TEXT DEFAULT '',
      prompt_hash TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(timestamp);

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
      PRIMARY KEY (date, model)
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
  
  // Prepared statements
  const stmts = {};
  stmts.dbLogGuardrail = db.prepare(
    'INSERT INTO guardrail_logs (timestamp, direction, rule, severity, ip, snippet, action, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  stmts.dbUpsertCost = db.prepare(
    'INSERT INTO cost_daily (date, model, provider, requests, tokens_in, tokens_out, cost_rmb) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(date, model) DO UPDATE SET requests = requests + 1, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_rmb = cost_rmb + ?'
  );
  
  return stmts;
}

// ── Utilities ──
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { 
        if (!body || !body.trim()) resolve({});
        else resolve(JSON.parse(body)); 
      } catch (e) { 
        reject(new Error('Invalid JSON: ' + body?.substring(0, 100))); 
      }
    });
    req.on('error', reject);
    // Timeout safety: if body never ends, reject after 30s
    setTimeout(() => { if (!req.complete) { req.destroy(); reject(new Error('Request timeout')); } }, 30000);
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

function authenticate(req, res) {
  const config = getConfig();
  if (!config.adminToken) return true;
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return token === config.adminToken;
}

// ── SSE streaming helper ──
async function pipeSSEStream(readable, writable, transformFn = null, stallTimeoutMs = 15000) {
  try {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastChunkTime = Date.now();
    let stallTimer = null;
    
    // Stall detection: if no data for stallTimeoutMs, abort
    const checkStall = () => {
      if (Date.now() - lastChunkTime > stallTimeoutMs) {
        log('[SSE] Stream stalled, aborting');
        try { reader.cancel(); } catch {}
      }
    };
    stallTimer = setInterval(checkStall, 2000);
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      lastChunkTime = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            writable.write('data: [DONE]\n\n');
            continue;
          }
          if (transformFn) {
            const transformed = transformFn(data);
            if (transformed) writable.write(transformed);
          } else {
            writable.write(line + '\n\n');
          }
        } else if (line.trim()) {
          writable.write(line + '\n');
        }
      }
    }
    
    clearInterval(stallTimer);
  } catch (err) {
    if (err.name !== 'AbortError') {
      log('[SSE] Stream error:', err.message);
    }
  }
}

// ── Static file serving ──
function serveStatic(res, filePath) {
  const normalizedPath = filePath.replace(/\.\./g, '');
  
  // Try frontend dist first
  const paths = [
    join(ROOT, 'frontend', 'dist', normalizedPath),
    join(ROOT, 'frontend', 'dist', 'index.html'),
  ];
  
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

// ── URL parsing ──
function parsePath(reqUrl) {
  const idx = reqUrl.indexOf('?');
  return idx === -1 ? reqUrl : reqUrl.slice(0, idx);
}

// ── Create server ──
export function createServer() {
  const config = getConfig();
  const stmts = initDatabase(config.dbPath);
  
  // WebSocket clients
  const wsClients = new Set();
  
  function wsBroadcast(data) {
    const msg = JSON.stringify(data);
    const frame = Buffer.alloc(2 + msg.length);
    frame[0] = 0x81;
    if (msg.length < 126) {
      frame[1] = msg.length;
      frame.set(Buffer.from(msg), 2);
    } else if (msg.length < 65536) {
      frame[1] = 126;
      frame.writeUInt16BE(msg.length, 2);
      frame.set(Buffer.from(msg), 4);
    }
    for (const ws of wsClients) {
      try { ws.write(frame); } catch { wsClients.delete(ws); }
    }
  }
  
  const srv = http.createServer(async (req, res) => {
    const method = req.method;
    const path = parsePath(req.url);
    const ip = getClientIP(req);
    const agent = getAgentFromReq(req);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    try {
      // ── Static & Dashboard ──
      if (path === '/dashboard' || path === '/dashboard/' || path === '/') {
        serveStatic(res, 'index.html');
        return;
      }
      
      // Serve static assets
      if (path.startsWith('/assets/') || path.startsWith('/src/') || path === '/favicon.svg' || path === '/icons.svg') {
        serveStatic(res, path);
        return;
      }
      
      // ── API routes ──
      
      // Health check
      if (path === '/health' && method === 'GET') {
        const cfg = getConfig();
        const providerCount = Object.keys(cfg.providers || {}).filter(k => cfg.providers[k].enabled !== false).length;
        const modelCount = (cfg.models || []).filter(m => m.enabled !== false).length;
        const providerHealth = getProviderHealth();
        
        jsonResponse(res, {
          status: 'ok',
          version: '6.0.0',
          uptime: process.uptime(),
          models_available: modelCount,
          providers_available: providerCount,
          upstream_healthy: Object.keys(providerHealth).length === 0,
          success_rate: 100,
        });
        return;
      }
      
      // Stats
      if (path === '/stats' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const stats = getStats();
        const modelLatency = getModelLatency();
        const modelCounts = getModelCounts();
        const statusDist = getStatusDistribution();
        const health = getProviderHealth();
        
        jsonResponse(res, {
          overview: {
            ...stats.overview,
            pool_size: (getConfig().models || []).filter(m => m.enabled !== false).length,
          },
          model_latency: modelLatency,
          model_counts: modelCounts,
          status_distribution: statusDist,
          provider_health: health,
        });
        return;
      }
      
      // Recent requests
      if (path === '/api/recent' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const params = getQueryParams(req.url);
        const limit = parseInt(params.limit) || 20;
        const agentFilter = params.agent || '';
        const logs = getRecentLogs(limit, agentFilter);
        jsonResponse(res, { recent: logs });
        return;
      }
      
      // Provider CRUD
      if (path === '/api/providers') {
        if (method === 'GET') {
          if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
          const cfg = getConfig();
          // Strip API keys from response
          const safeProviders = {};
          for (const [name, prov] of Object.entries(cfg.providers || {})) {
            safeProviders[name] = { ...prov, api_key: prov.api_key ? '***' + prov.api_key.slice(-4) : '' };
          }
          jsonResponse(res, safeProviders);
          return;
        }
        if (method === 'POST') {
          if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
          const body = await parseJsonBody(req);
          const cfg = getConfig();
          if (!cfg.providers) cfg.providers = {};
          cfg.providers[body.name || body.display] = body;
          if (body.api_key && body.api_key.startsWith('***')) {
            // Preserve existing key if masked
            log('[providers] Masked key preserved');
          }
          try {
            writeFileSync(cfg.configFile, JSON.stringify({
              providers: cfg.providers,
              models: cfg.models,
              api_keys: cfg.apiKeys,
              agents: cfg.agents,
              mcp_servers: cfg.mcpServers,
              guardrails: cfg.guardrails,
              admin_token: cfg.adminToken,
              routing: cfg.routing,
            }, null, 2));
          } catch (e) {
            sendError(res, 'Failed to save config: ' + e.message, 500);
            return;
          }
          jsonResponse(res, { success: true, message: 'Provider saved' });
          return;
        }
        sendError(res, 'Method not allowed', 405);
        return;
      }
      
      // Models CRUD
      if (path === '/api/models') {
        if (method === 'GET') {
          if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
          const cfg = getConfig();
          const modelLatency = getModelLatency();
          const modelCounts = getModelCounts();
          jsonResponse(res, {
            models: (cfg.models || []).map(m => ({
              ...m,
              avg_latency_ms: modelLatency[m.name] || null,
              request_count: modelCounts[m.name]?.total || 0,
            })),
          });
          return;
        }
        if (method === 'POST') {
          if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
          const body = await parseJsonBody(req);
          const cfg = getConfig();
          if (!cfg.models) cfg.models = [];
          const idx = cfg.models.findIndex(m => m.name === body.name);
          if (idx >= 0) cfg.models[idx] = body;
          else cfg.models.push(body);
          try {
            writeFileSync(cfg.configFile, JSON.stringify({
              providers: cfg.providers,
              models: cfg.models,
              api_keys: cfg.apiKeys,
              agents: cfg.agents,
              mcp_servers: cfg.mcpServers,
              guardrails: cfg.guardrails,
              admin_token: cfg.adminToken,
              routing: cfg.routing,
            }, null, 2));
          } catch (e) {
            sendError(res, 'Failed to save config: ' + e.message, 500);
            return;
          }
          jsonResponse(res, { success: true, message: 'Model saved' });
          return;
        }
        sendError(res, 'Method not allowed', 405);
        return;
      }
      
      // Delete model
      if (path.startsWith('/api/models/') && method === 'DELETE') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const modelName = decodeURIComponent(path.slice('/api/models/'.length));
        const cfg = getConfig();
        cfg.models = (cfg.models || []).filter(m => m.name !== modelName);
        try {
          writeFileSync(cfg.configFile, JSON.stringify({
            providers: cfg.providers,
            models: cfg.models,
            api_keys: cfg.apiKeys,
            agents: cfg.agents,
            mcp_servers: cfg.mcpServers,
            guardrails: cfg.guardrails,
            admin_token: cfg.adminToken,
            routing: cfg.routing,
          }, null, 2));
        } catch (e) {
          sendError(res, 'Failed to save config: ' + e.message, 500);
          return;
        }
        jsonResponse(res, { success: true });
        return;
      }
      
      // Routes
      if (path === '/api/routes') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const cfg = getConfig();
        if (method === 'GET') {
          jsonResponse(res, {
            tier_weights: cfg.routing.tierWeights || {},
            max_retries: cfg.routing.maxRetries || 4,
            max_concurrent: cfg.routing.maxConcurrent || 2,
            cooldown_seconds: cfg.routing.cooldownSeconds || 30,
            circuit_breaker: cfg.circuitBreaker || {},
          });
          return;
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req);
          if (body.tier_weights) cfg.routing.tierWeights = body.tier_weights;
          if (body.max_retries) cfg.routing.maxRetries = body.max_retries;
          try {
            writeFileSync(cfg.configFile, JSON.stringify({
              providers: cfg.providers,
              models: cfg.models,
              api_keys: cfg.apiKeys,
              agents: cfg.agents,
              mcp_servers: cfg.mcpServers,
              guardrails: cfg.guardrails,
              admin_token: cfg.adminToken,
              routing: cfg.routing,
            }, null, 2));
          } catch (e) {
            sendError(res, 'Failed to save config: ' + e.message, 500);
            return;
          }
          jsonResponse(res, { success: true });
          return;
        }
        sendError(res, 'Method not allowed', 405);
        return;
      }
      
      // API Keys
      if (path === '/api/keys') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const cfg = getConfig();
        if (method === 'GET') {
          jsonResponse(res, (cfg.apiKeys || []).map(k => ({ ...k, key: k.key ? '***' + k.key.slice(-4) : '' })));
          return;
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req);
          if (!cfg.apiKeys) cfg.apiKeys = [];
          const idx = cfg.apiKeys.findIndex(k => k.name === body.name);
          if (idx >= 0) cfg.apiKeys[idx] = body;
          else cfg.apiKeys.push(body);
          try {
            writeFileSync(cfg.configFile, JSON.stringify({
              providers: cfg.providers,
              models: cfg.models,
              api_keys: cfg.apiKeys,
              agents: cfg.agents,
              mcp_servers: cfg.mcpServers,
              guardrails: cfg.guardrails,
              admin_token: cfg.adminToken,
              routing: cfg.routing,
            }, null, 2));
          } catch (e) {
            sendError(res, 'Failed to save config: ' + e.message, 500);
            return;
          }
          jsonResponse(res, { success: true });
          return;
        }
        sendError(res, 'Method not allowed', 405);
        return;
      }
      
      // Delete key
      if (path.startsWith('/api/keys/') && method === 'DELETE') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const keyName = decodeURIComponent(path.slice('/api/keys/'.length));
        const cfg = getConfig();
        cfg.apiKeys = (cfg.apiKeys || []).filter(k => k.name !== keyName);
        try {
          writeFileSync(cfg.configFile, JSON.stringify({
            providers: cfg.providers,
            models: cfg.models,
            api_keys: cfg.apiKeys,
            agents: cfg.agents,
            mcp_servers: cfg.mcpServers,
            guardrails: cfg.guardrails,
            admin_token: cfg.adminToken,
            routing: cfg.routing,
          }, null, 2));
        } catch (e) {
          sendError(res, 'Failed to save config: ' + e.message, 500);
          return;
        }
        jsonResponse(res, { success: true });
        return;
      }
      
      // Cost
      if (path === '/api/cost' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const overview = getCostOverview(db);
        const daily = getCostDaily(db);
        const byModel = getCostByModel(db);
        jsonResponse(res, { ...overview, daily, top_models: byModel });
        return;
      }
      
      // Stats trend
      if (path === '/api/stats/trend' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const params = getQueryParams(req.url);
        const days = parseInt(params.days) || 7;
        const trend = db.prepare(
          `SELECT date, SUM(requests) as total, SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) as success, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out, ROUND(SUM(cost_rmb), 4) as cost_rmb
           FROM cost_daily WHERE date >= date('now', '-' || ? || ' days', '+8 hours')
           GROUP BY date ORDER BY date`
        ).all(days);
        jsonResponse(res, { trend });
        return;
      }
      
      // Errors distribution
      if (path === '/api/stats/errors' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const params = getQueryParams(req.url);
        const days = parseInt(params.days) || 1;
        const statusDist = getStatusDistribution();
        jsonResponse(res, { status_dist: statusDist });
        return;
      }
      
      // Latency stats
      if (path === '/api/stats/latency' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        jsonResponse(res, getModelLatency());
        return;
      }
      
      // Circuit breaker status
      if (path === '/api/circuit-breaker/status' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const health = getProviderHealth();
        jsonResponse(res, health);
        return;
      }
      
      // Agents overview
      if (path === '/api/agents-overview' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const cfg = getConfig();
        const agents = (cfg.agents || []).map(a => ({
          ...a,
          status: 'running',
        }));
        jsonResponse(res, {
          agents: agents.length > 0 ? agents : [
            { name: 'smart-router', label: 'Smart Router', emoji: '🔀', status: 'running', kind: 'system', skillCount: (cfg.models || []).length, system: 'AI Gateway' },
          ],
          summary: { onlineCount: agents.length || 1, totalMainAgents: agents.length || 1 },
        });
        return;
      }
      
      // Guardrails logs
      if (path === '/api/guardrails/logs' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const params = getQueryParams(req.url);
        const limit = parseInt(params.limit) || 50;
        jsonResponse(res, { logs: getGuardrailLogs(db, limit) });
        return;
      }
      
      // Guardrails config
      if (path === '/api/guardrails/config') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const cfg = getConfig();
        if (method === 'GET') {
          jsonResponse(res, cfg.guardrails || { enabled: true });
          return;
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req);
          cfg.guardrails = { ...cfg.guardrails, ...body };
          jsonResponse(res, { success: true });
          return;
        }
        sendError(res, 'Method not allowed', 405);
        return;
      }
      
      // MCP servers
      if (path === '/api/mcp/servers') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const cfg = getConfig();
        if (method === 'GET') {
          jsonResponse(res, cfg.mcpServers || []);
          return;
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req);
          if (!cfg.mcpServers) cfg.mcpServers = [];
          cfg.mcpServers.push(body);
          jsonResponse(res, { success: true });
          return;
        }
        sendError(res, 'Method not allowed', 405);
        return;
      }
      
      // Delete MCP server
      if (path.startsWith('/api/mcp/servers/') && method === 'DELETE') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const serverName = decodeURIComponent(path.slice('/api/mcp/servers/'.length));
        const cfg = getConfig();
        cfg.mcpServers = (cfg.mcpServers || []).filter(s => s.name !== serverName);
        jsonResponse(res, { success: true });
        return;
      }
      
      // System reload
      if (path === '/api/system/reload' && method === 'POST') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        reloadConfig();
        jsonResponse(res, { success: true, message: 'Config reloaded' });
        return;
      }
      
      // Get full config (redacted)
      if (path === '/api/config' && method === 'GET') {
        if (!authenticate(req, res)) { sendError(res, 'Unauthorized', 401); return; }
        const cfg = getConfig();
        // Deep clone and redact secrets
        const safe = JSON.parse(JSON.stringify(cfg));
        if (safe.providers) {
          for (const key of Object.keys(safe.providers)) {
            if (safe.providers[key].api_key) safe.providers[key].api_key = '***' + safe.providers[key].api_key.slice(-4);
          }
        }
        jsonResponse(res, safe);
        return;
      }
      
      // ── Chat Completions Proxy ──
      if ((path === '/v1/chat/completions' || path === '/chat/completions') && method === 'POST') {
        // Rate limit check
        const rlResult = checkRateLimit(ip, path);
        if (!rlResult.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rlResult.retryAfter || 1) });
          res.end(JSON.stringify({ error: 'Rate limited', retry_after: rlResult.retryAfter }));
          return;
        }
        
        const body = await parseJsonBody(req);
        
        // Guardrails check
        const lastMessage = body.messages?.[body.messages.length - 1]?.content || '';
        let guardResults = [];
        if (lastMessage) {
          guardResults = checkInput(lastMessage);
          if (guardResults.blocked) {
            logGuardrail(db, stmts.dbLogGuardrail, 'input', 'Critical block', 'critical', ip, lastMessage.slice(0, 100), 'block', agent);
            res.writeHead(451, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Content blocked by guardrails', guardrails: guardResults.rules }));
            return;
          }
          for (const r of guardResults.rules) {
            logGuardrail(db, stmts.dbLogGuardrail, 'input', r.rule, r.severity, ip, r.snippet || lastMessage.slice(0, 100), r.action, agent);
          }
        }
        
        const cfgCache = getConfig();
        // Semantic cache check
        const modelId = body.model || body.messages?.[0]?.model || '';
        const noCache = body.stream === true || body.headers?.['x-no-cache'] === 'true';
        if (!noCache && modelId && cfgCache.routing?.semantic_cache !== false) {
          const cached = cacheGet(modelId, body.messages);
          if (cached) {
            log(`💾 Cache hit [${modelId}], saved ${cached.tokens} tokens`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.response));
            return;
          }
        }

        try {
          const result = await routeChatCompletion(body, agent);
          const { response: upstream, model, provider: providerName, latencyMs } = result;
          
          // Record cost
          const usage = { prompt_tokens: 0, completion_tokens: 0 };
          
          if (body.stream) {
            // SSE streaming
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
              'X-Model': model,
              'X-Provider': providerName,
            });
            
            let totalIn = 0, totalOut = 0;
            const userAgent = agent;
            
            await pipeSSEStream(upstream.body, res, (data) => {
              try {
                const parsed = JSON.parse(data);
                totalIn = parsed.usage?.prompt_tokens || totalIn;
                totalOut = parsed.usage?.completion_tokens || totalOut;
                const choice = parsed.choices?.[0];
                if (choice?.delta?.content) {
                  return `data: ${data}\n\n`;
                }
              } catch {}
              return `data: ${data}\n\n`;
            });
            
            // End stream
            res.write('data: [DONE]\n\n');
            res.end();
            
            // Record cost
            if (totalIn > 0 || totalOut > 0) {
              recordCost(db, stmts.dbUpsertCost, model, providerName, totalIn, totalOut, userAgent);
            }
          } else {
            // Non-streaming - pass through
            const responseData = await upstream.json();
            const tokensIn = responseData.usage?.prompt_tokens || 0;
            const tokensOut = responseData.usage?.completion_tokens || 0;
            
            // Save to semantic cache
            if (cfgCache.routing?.semantic_cache !== false && tokensIn > 0) {
              cacheSet(model, body.messages, responseData, tokensIn, tokensOut);
            }
            
            recordCost(db, stmts.dbUpsertCost, model, providerName, tokensIn, tokensOut, agent);
            
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'X-Model': model,
              'X-Provider': providerName,
            });
            res.end(JSON.stringify(responseData));
          }
          
          log(`✅ ${model} (${providerName}) ${latencyMs}ms`);
          
        } catch (err) {
          log(`❌ Chat completion failed:`, err.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || 'All providers unavailable' }));
        }
        return;
      }
      
      // ── 404 ──
      sendError(res, 'Not found', 404);
      
    } catch (err) {
      log('💥 Request error:', err.message);
      sendError(res, 'Internal server error: ' + err.message, 500);
    }
  });
  
  // ── WebSocket support ──
  srv.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    
    wsClients.add(socket);
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
    
    // Send initial snapshot
    try {
      const stats = getStats();
      const cfg = getConfig();
      const msgBody = JSON.stringify({
        type: 'snapshot',
        data: {
          overview: stats.overview,
          provider_count: Object.keys(cfg.providers || {}).length,
          model_count: (cfg.models || []).length,
          uptime: process.uptime(),
          timestamp: Date.now() / 1000,
        }
      });
      const len = msgBody.length;
      const f = Buffer.alloc(len < 126 ? 2 : 4);
      f[0] = 0x81;
      if (len < 126) { f[1] = len; socket.write(Buffer.concat([f, Buffer.from(msgBody)])); }
      else { f[1] = 126; f.writeUInt16BE(len, 2); socket.write(Buffer.concat([f, Buffer.from(msgBody)])); }
    } catch {}
  });
  
  // Periodic WebSocket broadcast
  setInterval(() => {
    if (wsClients.size === 0) return;
    try {
      const stats = getStats();
      const msgBody = JSON.stringify({
        type: 'snapshot',
        data: {
          overview: stats.overview,
          recent: stats.recent.slice(0, 10),
          timestamp: Date.now() / 1000,
        }
      });
      const len = msgBody.length;
      const f = Buffer.alloc(len < 126 ? 2 : 4);
      f[0] = 0x81;
      if (len < 126) { f[1] = len; socket.write(Buffer.concat([f, Buffer.from(msgBody)])); }
      else { f[1] = 126; f.writeUInt16BE(len, 2); }
    } catch {}
  }, 5000);
  
  // ── Server timeouts ──
  srv.keepAliveTimeout = 120000;
  srv.headersTimeout = 121000;
  srv.timeout = 0;
  
  return srv;
}
