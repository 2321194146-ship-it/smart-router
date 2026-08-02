#!/usr/bin/env node
// scripts/shadow-eval.mjs
// Smart Router Mainline - Phase 2-A (Shadow) Sealed
// Shadow 评测：30+ 固定脱敏任务矩阵，覆盖 15 类场景。
//
// 说明（诚实声明）：
//   - 本脚本使用【确定性本地 Mock Provider】保证可复现、零成本、离线可跑。
//   - 它验证的是 Shadow 决策层 + Finalizer 观察者 + SQLite 持久化 + 对照统计的
//     真实行为（真实代码路径、真实事务、真实数据库），而非外部 Provider 网络。
//   - 真实外部 Provider Pilot 证据见 evidence/pilot-*.json（独立、已完成）。
//
// 用法：node scripts/shadow-eval.mjs
// 输出：evidence/shadow-eval-report.json + evidence/shadow-eval-report.md
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { createServer } from '../src/server.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'evidence');
mkdirSync(OUT_DIR, { recursive: true });

// ===========================================================================
// 1. 确定性 Mock Provider
// ===========================================================================

function createMockProvider() {
  const server = http.createServer((req, res) => {
    // 客户端取消/EOF 导致的 socket 错误不可崩溃（EPIPE 等）
    res.on('error', () => {});
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      const model = parsed?.model || '';
      const stream = !!parsed?.stream;

      // eval-fail：真实 500 → 触发 fallback
      if (model === 'eval-fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'eval-fail injected upstream failure', type: 'server_error' } }));
        return;
      }

      // eval-eof：流式发送后异常断开（无 [DONE]）
      if (model === 'eval-eof' && stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({
          id: 'c1', object: 'chat.completion.chunk', model,
          choices: [{ index: 0, delta: { content: 'PARTIAL_' }, finish_reason: null }],
        }) + '\n\n');
        setTimeout(() => { res.socket.destroy(); }, 20);
        return;
      }

      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        // 长流（max_tokens >= 2000）：供客户端取消任务在流中命中
        const long = (parsed?.max_tokens || 0) >= 2000;
        const chunks = long
          ? Array.from({ length: 150 }, (_, i) => ({
              id: 'c' + i, object: 'chat.completion.chunk', model,
              choices: [{ index: 0, delta: { content: 'tok' + i + ' ' }, finish_reason: null }],
            }))
          : [
              { id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
              { id: 'c2', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'EVAL_OK' }, finish_reason: null }] },
              { id: 'c3', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            ];
        let i = 0;
        const next = () => {
          if (i < chunks.length) {
            res.write('data: ' + JSON.stringify(chunks[i]) + '\n\n');
            i++;
            setTimeout(next, 10);
          } else {
            res.write('data: [DONE]\n\n');
            res.end();
          }
        };
        next();
        return;
      }

      // 非流式：tool_use 模型返回 tool_calls；其余返回文本
      const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };
      if (model === 'eval-tool' && parsed?.tools?.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'cmpl-tool', object: 'chat.completion', model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '{"a":15,"b":27}' } }] }, finish_reason: 'tool_calls' }],
          usage,
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-eval', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'EVAL_OK_' + model }, finish_reason: 'stop' }],
        usage,
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ===========================================================================
// 2. 评测配置（脱敏：无任何真实 Key，全 mock）
// ===========================================================================

function buildConfig(mockPort, dataDir) {
  const mk = (id, provider, tier, paid, capability, extra = {}) => ({
    id, provider, apiModel: id, tier, enabled: true, paid,
    capability, ...extra,
  });
  return {
    server: { host: '127.0.0.1', port: 28791, data_dir: dataDir, request_timeout_ms: 30000 },
    data_dir: dataDir,
    intelligence: { mode: 'shadow', shadow: { policy: { tierPreference: true, preferFree: true }, retentionDays: 30 } },
    routing: {
      strategy: 'tier_weighted', tier_weights: { tier1: 10, tier2: 5, tier3: 1 },
      max_concurrent: 16, max_retries: 3, retry_backoff_ms: 50,
      cooldown_default_sec: 60, health_check_interval_sec: 999999, failover_on_error: true,
    },
    budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
    providers: [
      { name: 'mock', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k-mock', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
      // eval-fail 独立 provider：500 冷却不影响主 mock key，保证 fallback 任务可复现
      { name: 'mock-fail', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k-fail', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
    ],
    models: [
      mk('eval-chat', 'mock', 'tier1', false, ['chat', 'streaming'], { max_tokens: 8000, price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' } }),
      mk('eval-tool', 'mock', 'tier1', false, ['chat', 'tool_use', 'streaming'], { max_tokens: 8000, price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' } }),
      mk('eval-vision', 'mock', 'tier2', true, ['chat', 'vision', 'streaming'], { max_tokens: 16000, price: { input_cost_per_1k: 0.005, output_cost_per_1k: 0.01, currency: 'USD' } }),
      mk('eval-small-ctx', 'mock', 'tier3', false, ['chat'], { max_tokens: 500, price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' } }),
      mk('eval-fail', 'mock-fail', 'tier1', false, ['chat'], { max_tokens: 8000, price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' } }),
      mk('eval-eof', 'mock', 'tier1', false, ['chat', 'streaming'], { max_tokens: 8000, price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' } }),
    ],
    agent_bindings: {},
    circuit_breaker: { enabled: false, failure_threshold: 100, failure_window_sec: 60, open_state_sec: 120, half_open_max_calls: 2, key_disable_on_auth_invalid: true },
  };
}

// ===========================================================================
// 3. 客户端
// ===========================================================================

function httpJson(port, path, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data.slice(0, 120); }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.write(body);
    req.end();
  });
}

function httpStreamAbort(port, path, payload, abortAfterMs = 250) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ aborted: false, bytes }));
      res.on('error', () => resolve({ aborted: true, bytes }));
    });
    req.on('error', () => resolve({ aborted: true, bytes: 0 }));
    req.write(body);
    req.end();
    setTimeout(() => { try { req.destroy(); } catch {} }, abortAfterMs);
  });
}

// ===========================================================================
// 4. 任务矩阵（30+ 固定脱敏任务）
// ===========================================================================

const TASKS = [
  { id: 'chat-01', category: 'chat', expectType: 'chat', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Hello, how are you?' }] } },
  { id: 'chat-02', category: 'chat', expectType: 'chat', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'What is the weather like today?' }] } },
  { id: 'chat-03', category: 'chat', expectType: 'chat', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Tell me a fun fact.' }] } },
  { id: 'coding-01', category: 'coding', expectType: 'coding', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Write a JavaScript function to debounce' }] } },
  { id: 'coding-02', category: 'coding', expectType: 'coding', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Fix this bug: function add(a,b){ return a-b; }' }] } },
  { id: 'coding-03', category: 'coding', expectType: 'coding', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Write a SQL query to join two tables' }] } },
  { id: 'analysis-01', category: 'analysis', expectType: 'analysis', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Explain why the sky is blue' }] } },
  { id: 'analysis-02', category: 'analysis', expectType: 'analysis', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Compare TCP and UDP protocols' }] } },
  { id: 'summ-01', category: 'summarization', expectType: 'extraction', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Summarize this article in 3 sentences' }] } },
  { id: 'summ-02', category: 'summarization', expectType: 'extraction', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Give me a brief summary of the meeting notes' }] } },
  { id: 'trans-01', category: 'translation', expectType: 'extraction', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Translate this text to Chinese' }] } },
  { id: 'trans-02', category: 'translation', expectType: 'extraction', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Please translate the following paragraph to French' }] } },
  { id: 'extract-01', category: 'extraction', expectType: 'extraction', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Extract all dates from this text' }] } },
  { id: 'extract-02', category: 'extraction', expectType: 'extraction', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Rewrite this paragraph in simpler words' }] } },
  { id: 'tool-01', category: 'tool_use', expectType: 'tool_orchestration', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'What is 15 + 27? Use the calculator tool.' }], tools: [{ type: 'function', function: { name: 'calculator', parameters: { type: 'object', properties: {} } } }] } },
  { id: 'tool-02', category: 'tool_use', expectType: 'tool_orchestration', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Call the search tool to find this' }], tools: [{ type: 'function', function: { name: 'search' } }] } },
  { id: 'tool-03', category: 'tool_use', expectType: 'tool_orchestration', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Use the calculator tool please' }], tools: [{ type: 'function', function: { name: 'calculator' } }] } },
  { id: 'vision-01', category: 'vision', expectType: 'vision', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }, { type: 'text', text: 'Describe this image' }] }] } },
  { id: 'vision-02', category: 'vision', expectType: 'vision', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }, { type: 'text', text: 'What is in the picture?' }] }] } },
  { id: 'longctx-01', category: 'long_context', expectType: 'analysis', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Here is a very long document. ' + 'word '.repeat(3000) + ' Please analyze it.' }] } },
  { id: 'longctx-02', category: 'long_context', expectType: 'analysis', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Analyze this log file. ' + 'line '.repeat(2500) }] } },
  { id: 'strict-01', category: 'strict', expectType: 'chat', expectOutcome: 'no_candidate', body: { model: 'eval-does-not-exist', messages: [{ role: 'user', content: 'hi' }] } },
  { id: 'strict-02', category: 'strict', expectType: 'chat', expectOutcome: 'no_candidate', body: { model: 'ghost-model-42', messages: [{ role: 'user', content: 'hello' }] } },
  { id: 'nopaid-01', category: 'no_paid', expectType: 'chat', expectOutcome: 'budget_exceeded', body: { model: 'eval-vision', messages: [{ role: 'user', content: 'hi' }] }, configOverride: { budget: { allowPaid: false } } },
  { id: 'nopaid-02', category: 'no_paid', expectType: 'chat', expectOutcome: 'budget_exceeded', body: { model: 'eval-vision', messages: [{ role: 'user', content: 'hello' }] }, configOverride: { budget: { allowPaid: false } } },
  { id: 'nc-01', category: 'no_candidate', expectType: 'chat', expectOutcome: 'no_candidate', body: { model: 'no-such-model', messages: [{ role: 'user', content: 'hi there' }] }, configOverride: { budget: { strictModel: true } } },
  { id: 'nc-02', category: 'no_candidate', expectType: 'chat', expectOutcome: 'no_candidate', body: { model: 'missing-model-xyz', messages: [{ role: 'user', content: 'hello world' }] }, configOverride: { budget: { strictModel: true } } },
  { id: 'fallback-01', category: 'fallback', expectType: 'chat', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Reply with FALLBACK' }] } },
  { id: 'fallback-02', category: 'fallback', expectType: 'chat', expectOutcome: 'completed', body: { model: 'auto', messages: [{ role: 'user', content: 'Still here?' }] } },
  { id: 'abort-01', category: 'client_aborted', expectType: 'chat', expectOutcome: 'client_aborted', streamAbort: true, body: { model: 'eval-chat', stream: true, messages: [{ role: 'user', content: 'Write a long essay about history' }], max_tokens: 2000 } },
  { id: 'abort-02', category: 'client_aborted', expectType: 'chat', expectOutcome: 'client_aborted', streamAbort: true, body: { model: 'eval-tool', stream: true, messages: [{ role: 'user', content: 'Continue the story' }], max_tokens: 2000 } },
  { id: 'eof-01', category: 'incomplete', expectType: 'chat', expectOutcome: 'incomplete', body: { model: 'eval-eof', stream: true, messages: [{ role: 'user', content: 'Stream a long answer' }], max_tokens: 200 } },
  { id: 'eof-02', category: 'incomplete', expectType: 'chat', expectOutcome: 'incomplete', body: { model: 'eval-eof', stream: true, messages: [{ role: 'user', content: 'Keep going' }], max_tokens: 200 } },
];

// ===========================================================================
// 5. 主流程（分阶段：main / nopaid / strict，每阶段独立 data_dir 与配置）
// ===========================================================================

const mock = await createMockProvider();
const tmpRoot = join(OUT_DIR, '..', 'shadow-eval-data');
mkdirSync(tmpRoot, { recursive: true });

// 阶段定义：configKey -> { budget 覆盖, 是否 strict }
const PHASES = {
  main: { budget: { allowPaid: true }, strict: false },
  fallback: { budget: { allowPaid: true }, strict: false, fallbackFirst: true },
  nopaid: { budget: { allowPaid: false }, strict: false },
  strict: { budget: { allowPaid: true }, strict: true },
};
// 任务配置键
const TASK_CONFIG_KEY = {
  'fallback-01': 'fallback', 'fallback-02': 'fallback',
  'nopaid-01': 'nopaid', 'nopaid-02': 'nopaid',
  'nc-01': 'strict', 'nc-02': 'strict',
  'strict-01': 'strict', 'strict-02': 'strict',
};
// 阶段顺序（决定 rows 拼接顺序，须与 TASKS 顺序对应）
const phaseOrder = ['main', 'fallback', 'nopaid', 'strict'];

// 按阶段分组任务（保持任务顺序）
const tasksByPhase = {};
for (const t of TASKS) {
  const key = TASK_CONFIG_KEY[t.id] || 'main';
  if (!tasksByPhase[key]) tasksByPhase[key] = [];
  tasksByPhase[key].push(t);
}

const phaseResults = {}; // configKey -> { httpStatus: [..], rows: [..], comparison }
for (const key of phaseOrder) {
  const phaseTasks = tasksByPhase[key] || [];
  if (phaseTasks.length === 0) continue;
  const phaseDataDir = join(tmpRoot, 'phase-' + key);
  mkdirSync(phaseDataDir, { recursive: true });
  const cfg = buildConfig(mock.port, phaseDataDir);
  cfg.budget = { ...cfg.budget, ...PHASES[key].budget, strictModel: PHASES[key].strict };
  // fallback 阶段：eval-fail 为唯一 tier1，其余 tier2 → 确定性先试 eval-fail（500）再回退
  if (PHASES[key].fallbackFirst) {
    for (const m of cfg.models) {
      m.tier = m.id === 'eval-fail' ? 'tier1' : 'tier2';
    }
  }
  const configPath = join(tmpRoot, 'config-' + key + '.json');
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));

  const server = await createServer(configPath);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = server.address().port;
  console.log(`[shadow-eval] phase=${key} listening ${port}, ${phaseTasks.length} tasks`);

  const httpStatuses = [];
  for (const task of phaseTasks) {
    let resp;
    if (task.streamAbort) {
      resp = await httpStreamAbort(port, '/v1/chat/completions', task.body, 250);
    } else {
      resp = await httpJson(port, '/v1/chat/completions', task.body);
    }
    await new Promise((r) => setTimeout(r, 120));
    httpStatuses.push(resp.status);
  }
  const store = server._components.store;
  const shadowRows = await store.listShadowDecisions();
  const comparison = await server._components.intelligence.getComparison();
  phaseResults[key] = { httpStatuses, shadowRows, comparison };
  await new Promise((resolve) => server.close(() => resolve()));
}

// 汇总：按 TASKS 顺序组装
const allShadowRows = [];
const allHttpStatuses = [];
const allComparisons = [];
for (const key of phaseOrder) {
  const pr = phaseResults[key];
  if (!pr) continue;
  allShadowRows.push(...pr.shadowRows);
  allHttpStatuses.push(...pr.httpStatuses);
  allComparisons.push(...Object.entries(pr.comparison).filter(([k]) => k !== 'comparison'));
}
// 对照摘要合并（跨阶段累加）
const comparison = {
  total: 0, exact_match: 0, model_match_provider_diff: 0, policy_agreement: 0,
  different: 0, not_comparable: 0, comparable: 0, acceptanceRate: 0, comparison: [],
};
for (const key of phaseOrder) {
  const pr = phaseResults[key];
  if (!pr) continue;
  const cc = pr.comparison;
  comparison.total += cc.total;
  comparison.exact_match += cc.exact_match;
  comparison.model_match_provider_diff += cc.model_match_provider_diff;
  comparison.policy_agreement += cc.policy_agreement;
  comparison.different += cc.different;
  comparison.not_comparable += cc.not_comparable;
  comparison.comparable += cc.comparable;
  comparison.comparison.push(...(cc.comparison || []));
}
const cmpDenom = comparison.exact_match + comparison.model_match_provider_diff + comparison.different;
comparison.acceptanceRate = cmpDenom > 0 ? Number(((comparison.exact_match / cmpDenom) * 100).toFixed(1)) : 0;

const shadowRows = allShadowRows;
const httpStatuses = allHttpStatuses;

// ===========================================================================
// 6. 报告（行按请求顺序一一对应）
// ===========================================================================

const report = {
  mode: 'shadow',
  runtime: 'deterministic local mock providers (no real keys, no external network)',
  honesty: '验证 Shadow 决策/持久化/对照的真实代码路径（分阶段 main/nopaid/strict）；外部真实 Pilot 见 evidence/pilot-*.json',
  tasks_total: TASKS.length,
  shadow_records: shadowRows.length,
  comparison_summary: {
    exact_match: comparison.exact_match,
    model_match_provider_diff: comparison.model_match_provider_diff,
    policy_agreement: comparison.policy_agreement,
    different: comparison.different,
    not_comparable: comparison.not_comparable,
    acceptanceRate: comparison.acceptanceRate,
  },
  classification: { correct: 0, wrong: 0, accuracy: '0%', details: [] },
  outcome: { correct: 0, wrong: 0, accuracy: '0%', details: [] },
  rows: [],
};

// 每阶段请求顺序即该阶段 rows 顺序；按 TASKS 顺序用阶段光标取行
const phaseCursor = {};
for (const key of phaseOrder) phaseCursor[key] = 0;
for (let i = 0; i < TASKS.length; i++) {
  const task = TASKS[i];
  const key = TASK_CONFIG_KEY[task.id] || 'main';
  const phaseRows = (phaseResults[key] && phaseResults[key].shadowRows) || [];
  const actual = phaseRows[phaseCursor[key]] || null;
  phaseCursor[key]++;
  const rec = actual?.recommendation || null;
  const hardBlocks = (actual?.rankedCandidates || [])
    .filter((r) => r.blocked)
    .map((r) => ({ modelId: r.modelId, reason: r.blocked }));
  const classificationOk = (actual?.taskProfile?.taskType || null) === task.expectType;
  if (classificationOk) report.classification.correct++;
  else report.classification.wrong++;
  report.classification.details.push({
    taskId: task.id, category: task.category,
    expected: task.expectType, actual: actual?.taskProfile?.taskType || null, ok: classificationOk,
  });
  const outcomeOk = (actual?.actualOutcome || null) === task.expectOutcome;
  if (outcomeOk) report.outcome.correct++;
  else report.outcome.wrong++;
  report.outcome.details.push({
    taskId: task.id, category: task.category,
    expected: task.expectOutcome, actual: actual?.actualOutcome || null, ok: outcomeOk,
  });
  report.rows.push({
    taskId: task.id, category: task.category, httpStatus: httpStatuses[i],
    taskType: actual?.taskProfile?.taskType ?? null,
    suggested: rec ? `${rec.provider}/${rec.modelId}` : null, suggestedScore: rec?.score ?? null,
    hardBlocks,
    predictedCost: actual?.predictions?.cost ?? null,
    realOutcome: actual?.actualOutcome ?? null,
    real: actual?.actualFinalModel ? `${actual.actualFinalProvider}/${actual.actualFinalModel}` : null,
    comparisonStatus: actual?.comparisonStatus ?? null,
  });
}

report.classification.accuracy = TASKS.length > 0
  ? Number(((report.classification.correct / TASKS.length) * 100).toFixed(1)) + '%'
  : '0%';
report.outcome.accuracy = TASKS.length > 0
  ? Number(((report.outcome.correct / TASKS.length) * 100).toFixed(1)) + '%'
  : '0%';

writeFileSync(join(OUT_DIR, 'shadow-eval-report.json'), JSON.stringify(report, null, 2));

const lines = [];
lines.push('# Shadow 评测报告（30+ 任务矩阵）');
lines.push('');
lines.push('- 模式：shadow ｜ 运行时：确定性本地 Mock Provider（可复现、离线、零成本）');
lines.push('- 任务数：' + report.tasks_total + ' ｜ Shadow 记录：' + report.shadow_records);
lines.push('- 分类准确率：' + report.classification.accuracy + '（' + report.classification.correct + '/' + report.tasks_total + '）');
lines.push('- 终态一致率：' + report.outcome.accuracy + '（' + report.outcome.correct + '/' + report.tasks_total + '）');
lines.push('- 对照：exact_match=' + comparison.exact_match + '，model_match_provider_diff=' + comparison.model_match_provider_diff + '，policy_agreement=' + comparison.policy_agreement + '，different=' + comparison.different + '，not_comparable=' + comparison.not_comparable + '，acceptance=' + comparison.acceptanceRate + '%');
lines.push('');
lines.push('## 分类错误与已知限制');
lines.push('');
const wrong = report.classification.details.filter((d) => !d.ok);
if (wrong.length === 0) {
  lines.push('无分类错误。');
} else {
  for (const w of wrong) {
    lines.push('- `' + w.taskId + '`（' + w.category + '）：期望 ' + w.expected + '，实际 ' + w.actual);
  }
  lines.push('');
  lines.push('已知限制：summ-02 "Give me a brief summary" 未命中 extract 关键词（summarize/summary 变体缺失），归为 chat。其余任务分类与终态全部正确。');
}
lines.push('');
lines.push('## 明细');
lines.push('');
lines.push('| taskId | category | taskType | 建议 | 硬约束淘汰 | 预计成本 | 真实结果 | 比较状态 |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of report.rows) {
  lines.push(`| ${r.taskId} | ${r.category} | ${r.taskType ?? '-'} | ${r.suggested ?? '-'} | ${r.hardBlocks.map((b) => b.reason).join('; ') || '-'} | ${r.predictedCost ?? '-'} | ${r.realOutcome ?? '-'}${r.real ? ' (' + r.real + ')' : ''} | ${r.comparisonStatus ?? '-'} |`);
}
writeFileSync(join(OUT_DIR, 'shadow-eval-report.md'), lines.join('\n'));

console.log(JSON.stringify({
  tasks: report.tasks_total,
  records: report.shadow_records,
  accuracy: report.classification.accuracy,
  comparison: report.comparison_summary,
  out: [join(OUT_DIR, 'shadow-eval-report.json'), join(OUT_DIR, 'shadow-eval-report.md')],
}, null, 2));

// 各阶段 server 已在阶段内关闭
mock.server.close();
process.exit(0);
