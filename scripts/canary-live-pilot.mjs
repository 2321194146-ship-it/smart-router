// scripts/canary-live-pilot.mjs
// Smart Router Mainline - Phase 2-C (5% Live Pilot)
// 在 127.0.0.1:28788 开启指定 Claude Code 的 5% 低风险 Active Canary（内部实验）：
//   - Mock Anthropic 流式 Provider（真实 HTTP + SSE + SQLite 全链路，非真实外部 Provider）
//   - 模拟 Claude Code 客户端发送 anthropic 流式请求（stream=true, UA Claude-Code/1.0）
//   - 积累 ≥20 个 active=true 的真实请求（percentage=5 确定性采样）
//   - 记录 eligible / sampled / active / actuallyReordered / Phase1 Primary / Canary Primary /
//     最终模型与 Provider / outcome 分布 / Attempt / Fallback / 预计成本 / 实际成本 / 自动停止 / Kill Switch
//   - Kill Switch 验证：kill → 重启仍 stopped → resume-shadow 只回 Shadow
// 用法：node scripts/canary-live-pilot.mjs
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createRouter } from '../src/server.js';

const ROOT = '/Users/lijie/CodeBuddy/20260801-smart-router-mainline';
const ADMIN_TOKEN = 'live-pilot-admin-token-local';
const TARGET_ACTIVE = 20;
const MAX_REQUESTS = 1200;
const CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Mock Anthropic Provider：接收 Smart Router 转发的 OpenAI chat/completions
// 流式请求，返回 OpenAI SSE chunks + [DONE]。
// ---------------------------------------------------------------------------
function createMockProvider() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ id: 'cmpl-live', object: 'chat.completion.chunk', created: 0, model: 'live', choices: [{ index: 0, delta: { content: 'CANARY_OK' }, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'cmpl-live', object: 'chat.completion.chunk', created: 0, model: 'live', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'cmpl-live', object: 'chat.completion', model: 'live',
          choices: [{ index: 0, message: { role: 'assistant', content: 'CANARY_OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------------------
// 模拟 Claude Code 发送 Anthropic Messages 流式请求
// ---------------------------------------------------------------------------
function sendAnthropicStreaming(port, content) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'auto', stream: true, max_tokens: 64,
      messages: [{ role: 'user', content }],
    });
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'anthropic-version': '2023-06-01',
        'x-api-key': 'test-key',
        'User-Agent': 'Claude-Code/1.0',
        'Accept': 'text/event-stream',
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function httpJson(port, path, payload, method = 'POST', extraHeaders = {}) {
  return new Promise((resolve) => {
    const b = payload === undefined ? '' : JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (b) headers['Content-Length'] = Buffer.byteLength(b);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let p = null; try { p = JSON.parse(data); } catch { p = data; } resolve({ status: res.statusCode, body: p }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: null, error: String(e?.message || e) }));
    if (b) req.write(b);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const mock = await createMockProvider();
const tmpDir = mkdtempSync(join(tmpdir(), 'canary-live-pilot-'));
const dataDir = join(tmpDir, 'data');
mkdirSync(dataDir, { recursive: true });

const config = {
  server: { host: '127.0.0.1', port: 28788, data_dir: dataDir, request_timeout_ms: 30000 },
  data_dir: dataDir,
  intelligence: {
    mode: 'active_canary',
    fallback_to_routing: true,
    activeCanary: {
      percentage: 5,
      allowedAgents: ['claude-code'],
      allowedProtocols: ['anthropic'],
      allowedTaskTypes: ['general_chat', 'writing', 'summarization', 'translation', 'extraction'],
    },
    shadow: { retentionDays: 30 },
  },
  routing: {
    strategy: 'tier_weighted', tier_weights: { tier1: 10, tier2: 5, tier3: 1 },
    max_concurrent: 8, max_retries: 1, retry_backoff_ms: 20, cooldown_default_sec: 60,
    health_check_interval_sec: 999999, failover_on_error: true,
  },
  budget: { allowPaid: true, maxRequestCost: 1.0, allowedModels: [], allowedProviders: [], strictModel: false },
  providers: [
    { name: 'mock', base_url: `http://127.0.0.1:${mock.port}/v1`, api_key: 'test-low-limit-key', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
  ],
  models: [
    { id: 'phase1-first', provider: 'mock', apiModel: 'phase1-first', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100, streaming: 100 }, capability: ['chat', 'streaming'], context_window: 32000, reliability: 0.5 },
    { id: 'canary-best', provider: 'mock', apiModel: 'canary-best', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100, reasoning: 100, streaming: 100 }, capability: ['chat', 'streaming', 'reasoning'], context_window: 64000, reliability: 0.95 },
  ],
  agent_bindings: { 'claude-code': { model_ids: ['phase1-first', 'canary-best'] } },
  circuit_breaker: { enabled: false, failure_threshold: 100, failure_window_sec: 60, open_state_sec: 120, half_open_max_calls: 2, key_disable_on_auth_invalid: true },
};

const configPath = join(tmpDir, 'config.json');
writeFileSync(configPath, JSON.stringify(config, null, 2));

// Admin Token 只放环境变量（不入 Git / 配置文件）
process.env.SMART_ROUTER_ADMIN_TOKEN = ADMIN_TOKEN;

const server = await createRouter(configPath);
await new Promise((resolve) => server.listen(28788, '127.0.0.1', () => resolve()));
const intelligence = server._components.intelligence;
const store = server._components.store;

console.log(`[live-pilot] router up on 127.0.0.1:28788 mode=${intelligence.mode} percentage=${intelligence.canary.percentage} allowedAgents=${JSON.stringify(intelligence.canary.allowedAgents)} allowedProtocols=${JSON.stringify(intelligence.canary.allowedProtocols)}`);

// 低风险任务内容池（general_chat / writing 等）
const CONTENT_POOL = [
  'Explain the water cycle in simple terms.',
  'What are the benefits of drinking water?',
  'Summarize the main idea of staying hydrated.',
  'Translate "good morning" into three languages.',
  'Write a short friendly note to a colleague.',
  'Why is the sky blue? Explain briefly.',
  'List three healthy breakfast ideas.',
  'Describe what makes a good night sleep.',
];

let sent = 0;
let activeCount = 0;
const activeRows = [];
const allRows = [];
let lastActive = 0;

// 并发发送直到 active >= TARGET_ACTIVE
while (sent < MAX_REQUESTS && activeCount < TARGET_ACTIVE) {
  const batch = [];
  const batchSize = Math.min(CONCURRENCY, MAX_REQUESTS - sent);
  for (let i = 0; i < batchSize; i++) {
    const content = CONTENT_POOL[(sent + i) % CONTENT_POOL.length];
    batch.push(sendAnthropicStreaming(28788, content));
  }
  const results = await Promise.all(batch);
  const before = intelligence.canary.metrics.active;
  for (let i = 0; i < batchSize; i++) {
    sent++;
    const r = results[i];
    if (r.status !== 200) {
      console.error(`[live-pilot] request ${sent} failed status=${r.status}`);
      continue;
    }
    // 串行批次：批次内并发但 Finalize 在响应结束后已完成；active 计数在本批全部完成后读取
  }
  // 批次完成后读取增量（批次内多个请求可能同时 active，全部计入）
  const after = intelligence.canary.metrics.active;
  const delta = after - before;
  activeCount = after;
  if (delta > 0) {
    lastActive = sent;
    console.log(`[live-pilot] sent=${sent} active=${after} (+${delta})`);
  }
  if (sent % 200 === 0) {
    console.log(`[live-pilot] progress: sent=${sent} active=${activeCount} eligible=${intelligence.canary.metrics.eligible}`);
  }
}

console.log(`[live-pilot] traffic done: sent=${sent} active=${activeCount} (target ${TARGET_ACTIVE})`);

// 读取全部 shadow 行（rowid 顺序 = 请求顺序）
const rows = await store.listShadowDecisions();

// 统计 Canary 指标
const snap = intelligence.status().canary;
const byOutcome = {};
const finalModelDist = {};
for (const r of rows) {
  byOutcome[r.actualOutcome] = (byOutcome[r.actualOutcome] || 0) + 1;
  const k = `${r.actualFinalModel || '?'}@${r.actualFinalProvider || '?'}`;
  finalModelDist[k] = (finalModelDist[k] || 0) + 1;
}

// active 请求明细：active 请求数 = snap.active；取最后 activeCount 行中的执行信息
// （active 请求必然成功走 Finalize 且被 Canary 计数；用 metrics 增量标记的请求）
const phase1PrimarySet = new Set();
const canaryPrimarySet = new Set();
let reordered = snap.activeVsPhase1.diff || 0;
let totalEstimated = 0;
let totalActual = 0;
let totalAttempts = 0;
let totalFallback = 0;
let activeWithFinal = 0;

// 用 shadow 行估算 active 请求的成本（Canary Primary = recommendation）
for (const r of rows) {
  const est = r.predictions?.cost;
  if (typeof est === 'number') totalEstimated += est;
  const act = r.actualCost;
  if (act && typeof act.totalCost === 'number') totalActual += act.totalCost;
  if (Array.isArray(r.rankedCandidates) && r.rankedCandidates[0]) {
    phase1PrimarySet.add(`${r.rankedCandidates[0].modelId}@${r.rankedCandidates[0].provider}`);
  }
  if (r.recommendation) {
    canaryPrimarySet.add(`${r.recommendation.modelId}@${r.recommendation.provider}`);
  }
  if (r.actualFinalModel) activeWithFinal++;
  totalAttempts += r.actualAttemptCount || 0;
}
// fallback 总数 = attempts - 请求数（估算，所有行）
totalFallback = Math.max(0, totalAttempts - rows.length);

// Kill Switch 验证
const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const killResult = await httpJson(28788, '/_smart-router/intelligence/kill', {}, 'POST', auth);
console.log(`[live-pilot] kill status=${killResult.status} killed=${killResult.body?.killed} stopped=${killResult.body?.canary?.stopped} err=${killResult.error || ''}`);

// 重启验证（同一 data_dir）：强制关闭连接 + 端口释放缓冲 + 请求重试
server.closeAllConnections?.();
await new Promise((resolve) => server.close(() => resolve()));
await new Promise((resolve) => setTimeout(resolve, 400));
const server2 = await createRouter(configPath);
await new Promise((resolve) => server2.listen(28788, '127.0.0.1', () => resolve()));

async function adminWithRetry(port, path, method, headers) {
  for (let i = 0; i < 8; i++) {
    const r = await httpJson(port, path, undefined, method, headers);
    if (r.status > 0) return r;
    await new Promise((res) => setTimeout(res, 300));
  }
  return { status: 0, body: null, error: 'retries exhausted' };
}

const st2 = await adminWithRetry(28788, '/_smart-router/intelligence/status', 'GET', auth);
console.log(`[live-pilot] restart status=${st2.status} stopped=${st2.body?.canary?.stopped} autoStop=${st2.body?.canary?.autoStop?.reason} restored=${st2.body?.canary?.autoStop?.restored} err=${st2.error || ''}`);

// resume-shadow
const resume = await adminWithRetry(28788, '/_smart-router/intelligence/resume-shadow', 'POST', auth);
console.log(`[live-pilot] resume-shadow status=${resume.status} mode=${resume.body?.mode} canaryEnabled=${resume.body?.canary?.enabled} err=${resume.error || ''}`);

// 关闭
server2.closeAllConnections?.();
await new Promise((resolve) => server2.close(() => resolve()));
mock.server.close();
delete process.env.SMART_ROUTER_ADMIN_TOKEN;

// 保存脱敏配置快照（api_key 用占位）
const sanitizedConfig = JSON.parse(JSON.stringify(config));
for (const p of sanitizedConfig.providers) p.api_key = '<REDACTED-LOW-LIMIT-TEST-KEY>';
writeFileSync(join(ROOT, 'evidence/canary-live-pilot-config.sanitized.json'), JSON.stringify(sanitizedConfig, null, 2));

// 汇总证据
const evidence = {
  pilot: 'Smart Router Phase2 5% Canary Live Pilot (internal, 127.0.0.1:28788)',
  runtime: new Date().toISOString(),
  config: {
    mode: 'active_canary',
    percentage: 5,
    allowedAgents: ['claude-code'],
    allowedProtocols: ['anthropic'],
    allowedTaskTypes: ['general_chat', 'writing', 'summarization', 'translation', 'extraction'],
    provider: 'local mock (HTTP + SSE + SQLite full chain)',
    admin_token: 'env SMART_ROUTER_ADMIN_TOKEN only',
    external_exposure: 'none (loopback only)',
    cloud_billing: 'not enabled',
  },
  traffic: { sent, activeTarget: TARGET_ACTIVE },
  canary_metrics: {
    eligible: snap.eligible,
    sampled: snap.sampled,
    active: snap.active,
    activeVsPhase1: snap.activeVsPhase1,
    actuallyReordered: reordered,
    incomplete: snap.incomplete,
    failed: snap.failed,
    aborted: snap.aborted,
    attempts: snap.attempts,
    fallbackCount: snap.fallbackCount,
    totalCost: snap.totalCost,
    autoStop: snap.autoStop,
    stopped: snap.stopped,
  },
  outcome_distribution: byOutcome,
  final_model_distribution: finalModelDist,
  phase1_primary: [...phase1PrimarySet],
  canary_primary: [...canaryPrimarySet],
  cost: {
    estimatedTotal: Number(totalEstimated.toFixed(6)),
    actualTotal: Number(totalActual.toFixed(6)),
  },
  kill_switch: {
    kill_status: killResult.status,
    killed: killResult.body?.killed,
    restart_status: st2.status,
    restart_stopped: st2.body?.canary?.stopped,
    restart_autoStop_reason: st2.body?.canary?.autoStop?.reason,
    restart_restored: st2.body?.canary?.autoStop?.restored,
    resume_shadow_status: resume.status,
    resume_shadow_mode: resume.body?.mode,
    resume_shadow_canary_enabled: resume.body?.canary?.enabled,
  },
  active_requests_collected: activeCount >= TARGET_ACTIVE,
};

writeFileSync(join(ROOT, 'evidence/canary-live-pilot-evidence.json'), JSON.stringify(evidence, null, 2));

// 控制台汇总
console.log('\n===== 5% Canary Live Pilot 结果 =====');
console.log(`eligible=${snap.eligible} sampled=${snap.sampled} active=${snap.active} (target >= ${TARGET_ACTIVE})`);
console.log(`activeVsPhase1 same=${snap.activeVsPhase1.same} diff=${snap.activeVsPhase1.diff} (actuallyReordered=${reordered})`);
console.log(`outcomes=${JSON.stringify(byOutcome)}`);
console.log(`phase1Primary=${JSON.stringify([...phase1PrimarySet])} canaryPrimary=${JSON.stringify([...canaryPrimarySet])}`);
console.log(`estimatedCost=${Number(totalEstimated.toFixed(6))} actualCost=${Number(totalActual.toFixed(6))}`);
console.log(`attempts=${snap.attempts} fallback=${snap.fallbackCount} autoStop=${JSON.stringify(snap.autoStop)}`);
console.log(`kill: killed=${killResult.body?.killed} | restart: stopped=${st2.body?.canary?.stopped} | resume-shadow: mode=${resume.body?.mode}`);
console.log(`activeTargetMet=${activeCount >= TARGET_ACTIVE}`);

// 清理临时数据目录（不保留测试数据库）
rmSync(tmpDir, { recursive: true, force: true });

if (activeCount < TARGET_ACTIVE) {
  console.error(`[live-pilot] FAIL: active=${activeCount} < target ${TARGET_ACTIVE}`);
  process.exit(1);
}
process.exit(0);
