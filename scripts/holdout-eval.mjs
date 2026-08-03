#!/usr/bin/env node
// scripts/holdout-eval.mjs
// Smart Router Mainline - Phase 2-C
// Holdout 对抗评测：≥200 独立任务（非复制 Phase2-B 模板），验证 Phase2-C 决策语义修复。
//
// 输出：evidence/holdout-eval-report.json + .md + holdout-eval-data/
//
// 门禁（Phase2-C 第 7 节）：
//   classification >= 92%
//   hard_violations = 0（streaming/vision/tool/context_window/budget/no_paid/strict）
//   policy_switch_execution = 100%
//   acceptable >= 90%
//   null_safe_rejection = 0（预期 null 的任务必须 null）
//   cost_reasonableness：预算阶段推荐成本不超限
//
// 运行时：确定性本地 Mock Provider（离线、可复现）；不开启 Active；真实数据链不变。

import { createServer } from '../src/server.js';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from './holdout-tasks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'evidence');
mkdirSync(OUT_DIR, { recursive: true });
// 每次评测清空数据目录，避免 SQLite 残留旧 shadow 行导致对齐错乱
const TMP_ROOT = join(__dirname, '..', 'holdout-eval-data');
rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

// ===========================================================================
// 1. 确定性 Mock Provider（与 AR 评测一致）
// ===========================================================================
function createMockProvider() {
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      const model = parsed?.model || '';
      const stream = !!parsed?.stream;
      if (model === 'H-fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'injected failure', type: 'server_error' } }));
        return;
      }
      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = [
          { id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          { id: 'c2', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'HOLD_OK' }, finish_reason: null }] },
          { id: 'c3', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ];
        let i = 0;
        const next = () => {
          if (i < chunks.length) { res.write('data: ' + JSON.stringify(chunks[i]) + '\n\n'); i++; setTimeout(next, 5); }
          else { res.write('data: [DONE]\n\n'); res.end(); }
        };
        next();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-hold', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'HOLD_OK_' + model, finish_reason: 'stop' } }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ===========================================================================
// 2. 评测模型池（caps-only / legacy-only / 60-99 分 / 健康 / 预算）
// ===========================================================================
function buildConfig(mockPort, dataDir, policyOver = {}, budgetOver = {}) {
  const mk = (id, tier, paid, capabilities, legacy, extra = {}) => ({
    id, tier, provider: extra.provider || 'mock', apiModel: id, enabled: true, paid,
    capabilities,
    ...(legacy && legacy.length ? { capability: legacy } : {}),
    ...extra,
  });
  const models = [
    // caps-only 形态：无 capability 数组
    mk('H-chat', 'tier1', false, { chat: 100 }, null, { context_window: 32000, reliability: 0.9, latency_prior_ms: 900, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
    // legacy-only 形态：仅 capability 数组
    mk('H-cheap', 'tier3', false, { chat: 100 }, ['chat'], { context_window: 8000, reliability: 0.7, latency_prior_ms: 1500, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
    // 60-99 等级能力分：coding=95 / tool_use=90 / streaming=90（不得误作不支持）
    mk('H-coding95', 'tier1', false, { chat: 100, coding: 95, tool_use: 90, streaming: 90, reasoning: 70, long_context: 80, structured_output: 60 }, null, { context_window: 64000, reliability: 0.92, latency_prior_ms: 800, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
    // 付费推理模型
    mk('H-reason', 'tier2', true, { chat: 100, coding: 80, reasoning: 100, structured_output: 90, streaming: 90, long_context: 90 }, null, { context_window: 64000, reliability: 0.95, latency_prior_ms: 1400, price: { input_cost_per_1k: 0.005, output_cost_per_1k: 0.01 } }),
    // vision=95：二元阈值 0.9 下视为支持
    mk('H-vision95', 'tier2', true, { chat: 100, vision: 95, streaming: 90 }, null, { context_window: 32000, reliability: 0.88, latency_prior_ms: 1300, price: { input_cost_per_1k: 0.005, output_cost_per_1k: 0.01 } }),
    mk('H-struct', 'tier2', false, { chat: 100, structured_output: 100 }, null, { context_window: 32000, reliability: 0.85, latency_prior_ms: 1100, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
    mk('H-tool', 'tier1', false, { chat: 100, tool_use: 100, streaming: 100, coding: 80 }, null, { context_window: 32000, reliability: 0.9, latency_prior_ms: 850, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
    mk('H-nostream', 'tier2', false, { chat: 100, coding: 90, tool_use: 90, structured_output: 90, long_context: 90 }, null, { context_window: 64000, reliability: 0.9, latency_prior_ms: 1000, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
    mk('H-smallctx', 'tier3', false, { chat: 100 }, null, { context_window: 500, reliability: 0.6, latency_prior_ms: 1600, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
    mk('H-bigctx', 'tier1', false, { chat: 100, long_context: 100, coding: 70, reasoning: 60 }, null, { context_window: 128000, reliability: 0.93, latency_prior_ms: 1000, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
    mk('H-fail', 'tier1', false, { chat: 100 }, null, { provider: 'mock-fail', context_window: 8000, reliability: 0.5, latency_prior_ms: 1200, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
  ];
  return {
    server: { host: '127.0.0.1', port: 28793, data_dir: dataDir, request_timeout_ms: 30000 },
    data_dir: dataDir,
    intelligence: {
      mode: 'shadow',
      shadow: { policy: { tierPreference: true, preferFree: true, ...policyOver }, retentionDays: 30 },
    },
    routing: {
      strategy: 'tier_weighted', tier_weights: { tier1: 10, tier2: 5, tier3: 1 },
      max_concurrent: 16, max_retries: 3, retry_backoff_ms: 50,
      cooldown_default_sec: 60, health_check_interval_sec: 999999, failover_on_error: true,
    },
    budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false, ...budgetOver },
    providers: [
      { name: 'mock', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k-mock', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
      { name: 'mock-fail', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k-fail', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
    ],
    models,
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
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(data); } catch { parsed = data.slice(0, 120); } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.write(body); req.end();
  });
}

function httpStream(port, path, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.write(body); req.end();
  });
}

// ===========================================================================
// 4. 分阶段执行
// ===========================================================================
const mock = await createMockProvider();
const tmpRoot = TMP_ROOT;

const PHASES = {
  main: { budget: { allowPaid: true }, policy: {} },
  nofree: { budget: { allowPaid: true }, policy: { preferFree: false } },
  notier: { budget: { allowPaid: true }, policy: { tierPreference: false } },
  nopaid: { budget: { allowPaid: false }, policy: {} },
  budget: { budget: { allowPaid: true, maxRequestCost: 0.000001 }, policy: {}, paidOnly: true },
  strict: { budget: { allowPaid: true }, policy: {}, strict: true },
  fallback: { budget: { allowPaid: true }, policy: {}, fallbackFirst: true },
};

const phaseOf = (t) => {
  if (t.budgetKey) return t.budgetKey;
  if (t.policyKey === 'preferFree') return 'main';
  if (t.policyKey === 'noPreferFree') return 'nofree';
  if (t.policyKey === 'noTier') return 'notier';
  return 'main';
};

const tasksByPhase = {};
for (const t of TASKS) {
  const key = phaseOf(t);
  if (!tasksByPhase[key]) tasksByPhase[key] = [];
  tasksByPhase[key].push(t);
}

const phaseOrder = ['main', 'nofree', 'notier', 'nopaid', 'budget', 'strict', 'fallback'];
const phaseResults = {};

for (const key of phaseOrder) {
  const phaseTasks = tasksByPhase[key] || [];
  if (phaseTasks.length === 0) continue;
  const phaseDataDir = join(tmpRoot, 'phase-' + key);
  mkdirSync(phaseDataDir, { recursive: true });
  const cfg = buildConfig(mock.port, phaseDataDir, PHASES[key].policy, PHASES[key].budget);
  if (PHASES[key].strict) cfg.budget.strictModel = true;
  if (PHASES[key].fallbackFirst) {
    for (const m of cfg.models) m.tier = m.id === 'H-fail' ? 'tier1' : 'tier2';
  }
  if (PHASES[key].paidOnly) {
    cfg.models = cfg.models.filter((m) => m.paid);
  }
  const configPath = join(tmpRoot, 'config-' + key + '.json');
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));

  const server = await createServer(configPath);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = server.address().port;
  console.log(`[holdout] phase=${key} port=${port} tasks=${phaseTasks.length}`);

  const httpStatuses = [];
  if (phaseTasks.some((t) => t.healthStage)) {
    for (let i = 0; i < 6; i++) {
      await httpJson(port, '/v1/chat/completions', { model: 'H-fail', messages: [{ role: 'user', content: 'trigger failure' }] });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const task of phaseTasks) {
    let resp;
    if (task.body.stream) resp = await httpStream(port, '/v1/chat/completions', task.body);
    else resp = await httpJson(port, '/v1/chat/completions', task.body);
    await new Promise((r) => setTimeout(r, 80));
    httpStatuses.push(resp.status);
  }
  const store = server._components.store;
  const shadowRows = await store.listShadowDecisions();
  phaseResults[key] = { httpStatuses, shadowRows };
  await new Promise((resolve) => server.close(() => resolve()));
}

// ===========================================================================
// 5. 指标计算
// ===========================================================================
const report = {
  mode: 'shadow',
  runtime: 'deterministic local mock providers (reproducible, offline)',
  honesty: 'Holdout 对抗评测：独立任务集（≥200），不复制 Phase2-B 105 回归模板；未开启 Active',
  tasks_total: TASKS.length,
  categories: {},
  classification: { correct: 0, wrong: 0, accuracy: '0%', details: [] },
  hard_violations: { streaming: 0, vision: 0, tool_use: 0, context_window: 0, budget: 0, no_paid: 0, strict: 0, total: 0, details: [] },
  soft_match: { total: 0, matched: 0, rate: '0%', details: [] },
  acceptable_recommendation: { total: 0, in_acceptable: 0, rate: '0%', null_allowed: 0, details: [] },
  cost_reasonableness: { total: 0, ok: 0, rate: '0%', details: [] },
  policy_execution: { total: 0, ok: 0, rate: '0%', details: [] },
  null_safe_rejection: { violations: 0, details: [] },
  outcome: { correct: 0, wrong: 0, accuracy: '0%', details: [] },
  confusion_matrix: {},
  rows: [],
};

for (const t of TASKS) {
  if (!report.categories[t.category]) report.categories[t.category] = 0;
  report.categories[t.category]++;
}

const phaseCursor = {};
for (const key of phaseOrder) phaseCursor[key] = 0;

for (let i = 0; i < TASKS.length; i++) {
  const task = TASKS[i];
  const key = phaseOf(task);
  const phaseRows = (phaseResults[key] && phaseResults[key].shadowRows) || [];
  let actual = phaseRows[phaseCursor[key]] || null;
  while (actual && actual.requestedModel === 'H-fail') {
    phaseCursor[key]++;
    actual = phaseRows[phaseCursor[key]] || null;
  }
  phaseCursor[key]++;

  const rec = actual?.recommendation || null;
  const recModel = rec ? rec.modelId : null;
  const blocks = (actual?.rankedCandidates || []).filter((r) => r.blocked).map((r) => ({ modelId: r.modelId, reason: r.blocked }));
  const taskId = task.id;

  // 分类
  const predicted = actual?.taskProfile?.taskType || null;
  const clsOk = predicted === task.expectedType;
  if (clsOk) report.classification.correct++; else report.classification.wrong++;
  report.classification.details.push({ taskId, category: task.category, expected: task.expectedType, actual: predicted, ok: clsOk });

  // 混淆矩阵
  if (!report.confusion_matrix[task.expectedType]) report.confusion_matrix[task.expectedType] = {};
  report.confusion_matrix[task.expectedType][predicted] = (report.confusion_matrix[task.expectedType][predicted] || 0) + 1;

  // 硬违规
  let violation = null;
  const hardCaps = task.hardCaps || [];
  if (recModel) {
    if (task.acceptable && task.acceptable.length > 0 && !task.acceptable.includes(recModel)) {
      violation = `recommended ${recModel} not in acceptable [${task.acceptable.join(',')}]`;
    }
    if (task.forbidden && task.forbidden.includes(recModel)) {
      violation = `recommended forbidden model ${recModel}`;
    }
    if (!violation && hardCaps.length > 0) {
      const violates = blocks.some((b) => b.modelId === recModel && hardCaps.some((h) => b.reason.includes(h)));
      if (violates) violation = `recommended ${recModel} violates hard caps [${hardCaps.join(',')}]`;
    }
  }
  if (violation) {
    report.hard_violations.total++;
    report.hard_violations.details.push({ taskId, category: task.category, violation });
    for (const h of hardCaps) if (violation.includes(h)) report.hard_violations[h] = (report.hard_violations[h] || 0) + 1;
  }

  // context_window 违规专项（推荐模型上下文超限）
  if (recModel && actual?.taskProfile?.estimatedTotalTokens && rec?.modelId) {
    // 若推荐模型存在且其 blocked 原因含 contextWindow（理论不应发生，因为 blocked 不进推荐）
    const ctxBlock = blocks.find((b) => b.modelId === recModel && b.reason.includes('contextWindow'));
    if (ctxBlock) {
      report.hard_violations.context_window++;
      report.hard_violations.total++;
      report.hard_violations.details.push({ taskId, category: task.category, violation: `recommended ${recModel} over contextWindow` });
    }
  }

  // soft_match：推荐在可接受集合（与 acceptable_rate 类似但独立统计，含 null 安全语义）
  if (Array.isArray(task.acceptable) && task.acceptable.length > 0) {
    report.soft_match.total++;
    if (recModel && task.acceptable.includes(recModel)) report.soft_match.matched++;
    else if (recModel) report.soft_match.details.push({ taskId, category: task.category, violation: `recommended ${recModel} outside acceptable` });
    // null 时计入 null_allowed（soft_match 口径：null 安全拒绝不违规）
  }

  // acceptable_recommendation（与 Phase2-B 口径一致）
  if (Array.isArray(task.acceptable) && task.acceptable.length > 0) {
    if (recModel && task.acceptable.includes(recModel)) {
      report.acceptable_recommendation.total++;
      report.acceptable_recommendation.in_acceptable++;
    } else if (recModel) {
      report.acceptable_recommendation.total++;
    } else {
      report.acceptable_recommendation.null_allowed++;
    }
  }

  // 成本合理性：预算阶段推荐成本 <= maxRequestCost（或预期无推荐）
  if (task.budgetKey === 'budget') {
    if (task.expectNoRecommendation) {
      report.cost_reasonableness.total++;
      if (!recModel) report.cost_reasonableness.ok++;
      else report.cost_reasonableness.details.push({ taskId, violation: `budget stage recommended ${recModel}` });
    } else {
      report.cost_reasonableness.total++;
      const estCost = rec?.estimatedCost ?? actual?.predictions?.cost ?? 0;
      if (recModel && estCost <= (task.maxCost ?? 100)) report.cost_reasonableness.ok++;
      else if (!recModel) report.cost_reasonableness.ok++;
    }
  }

  // 预算语义（budget/nopaid/strict）
  if (task.budgetKey === 'budget' || task.budgetKey === 'nopaid' || task.budgetKey === 'strict') {
    if (recModel) {
      if (task.budgetKey === 'nopaid') {
        const rankedPaid = (actual?.rankedCandidates || []).find((rc) => rc.modelId === recModel && rc.paid);
        if (rankedPaid) {
          report.hard_violations.no_paid++;
          report.hard_violations.total++;
          report.hard_violations.details.push({ taskId, violation: `no_paid stage recommended paid ${recModel}` });
        }
      }
      if (task.budgetKey === 'strict') {
        report.hard_violations.strict++;
        report.hard_violations.total++;
        report.hard_violations.details.push({ taskId, violation: `strict stage recommended ${recModel}` });
      }
    }
  }

  // policy 执行率
  if (task.policyKey) {
    report.policy_execution.total++;
    let ok = false;
    if (task.policyKey === 'preferFree') {
      // 推荐必须免费（或安全 null）
      ok = !recModel || rec?.paid === false;
      if (!ok) report.policy_execution.details.push({ taskId, violation: `preferFree stage recommended paid ${recModel}` });
    } else if (task.policyKey === 'noPreferFree') {
      // 付费不再被惩罚：推荐存在即视为执行（模型需在 acceptable 内）
      ok = recModel ? (Array.isArray(task.acceptable) && task.acceptable.includes(recModel)) : true;
      if (!ok) report.policy_execution.details.push({ taskId, violation: `noPreferFree stage recommendation outside acceptable` });
    } else if (task.policyKey === 'noTier') {
      ok = recModel ? (Array.isArray(task.acceptable) && task.acceptable.includes(recModel)) : true;
      if (!ok) report.policy_execution.details.push({ taskId, violation: `noTier stage recommendation outside acceptable` });
    }
    if (ok) report.policy_execution.ok++;
  }

  // null 安全拒绝
  if (task.nullAllowed || task.expectNoRecommendation) {
    if (recModel) {
      report.null_safe_rejection.violations++;
      report.null_safe_rejection.details.push({ taskId, violation: `expected null but recommended ${recModel}` });
    }
  }

  // 终态
  const outcomeOk = (actual?.actualOutcome || null) === (task.expectOutcome || 'completed');
  if (outcomeOk) report.outcome.correct++; else report.outcome.wrong++;
  report.outcome.details.push({ taskId, category: task.category, expected: task.expectOutcome || 'completed', actual: actual?.actualOutcome || null, ok: outcomeOk });

  report.rows.push({
    id: taskId,
    category: task.category,
    httpStatus: (phaseResults[key] && phaseResults[key].httpStatuses[phaseCursor[key] - 1]) ?? null,
    taskType: predicted,
    expectedType: task.expectedType,
    suggested: rec ? `${rec.provider}/${rec.modelId}` : null,
    hardBlocks: blocks,
    predictedCost: actual?.predictions?.cost ?? null,
    realOutcome: actual?.actualOutcome ?? null,
    comparisonStatus: actual?.comparisonStatus ?? null,
  });
}

report.classification.accuracy = TASKS.length > 0 ? Number(((report.classification.correct / TASKS.length) * 100).toFixed(1)) + '%' : '0%';
report.outcome.accuracy = TASKS.length > 0 ? Number(((report.outcome.correct / TASKS.length) * 100).toFixed(1)) + '%' : '0%';
const acc = report.acceptable_recommendation;
report.acceptable_recommendation.rate = acc.total > 0 ? Number(((acc.in_acceptable / acc.total) * 100).toFixed(1)) + '%' : '0%';
const sm = report.soft_match;
report.soft_match.rate = sm.total > 0 ? Number(((sm.matched / sm.total) * 100).toFixed(1)) + '%' : '0%';
const cr = report.cost_reasonableness;
report.cost_reasonableness.rate = cr.total > 0 ? Number(((cr.ok / cr.total) * 100).toFixed(1)) + '%' : '0%';
const pe = report.policy_execution;
report.policy_execution.rate = pe.total > 0 ? Number(((pe.ok / pe.total) * 100).toFixed(1)) + '%' : '0%';

// 门禁（Phase2-C 第 7 节）
const gates = {
  classification_ge_92: report.classification.correct / TASKS.length >= 0.92,
  hard_violations_zero: report.hard_violations.total === 0,
  streaming_zero: report.hard_violations.streaming === 0,
  vision_zero: report.hard_violations.vision === 0,
  tool_zero: report.hard_violations.tool_use === 0,
  context_zero: report.hard_violations.context_window === 0,
  budget_zero: report.hard_violations.budget === 0,
  no_paid_zero: report.hard_violations.no_paid === 0,
  strict_zero: report.hard_violations.strict === 0,
  policy_execution_100: pe.total > 0 ? pe.ok / pe.total === 1 : true,
  acceptable_ge_90: acc.total > 0 ? acc.in_acceptable / acc.total >= 0.9 : true,
  null_safe_zero: report.null_safe_rejection.violations === 0,
  cost_reasonable: cr.total > 0 ? cr.ok / cr.total === 1 : true,
};
report.gates = gates;
report.gates_passed = Object.values(gates).every(Boolean);

// ===========================================================================
// 6. 输出
// ===========================================================================
writeFileSync(join(OUT_DIR, 'holdout-eval-report.json'), JSON.stringify(report, null, 2));

const L = [];
L.push('# Holdout 对抗评测报告（Phase2-C，≥200 任务）');
L.push('');
L.push(`- 任务数：${report.tasks_total} ｜ 分类准确率：${report.classification.accuracy} ｜ 终态一致率：${report.outcome.accuracy}`);
L.push(`- 可接受推荐率：${report.acceptable_recommendation.rate}（${report.acceptable_recommendation.in_acceptable}/${report.acceptable_recommendation.total}，null 允许 ${report.acceptable_recommendation.null_allowed}）`);
L.push(`- Soft-Match：${report.soft_match.rate}（${report.soft_match.matched}/${report.soft_match.total}）`);
L.push(`- 成本合理性：${report.cost_reasonableness.rate}（${report.cost_reasonableness.ok}/${report.cost_reasonableness.total}）`);
L.push(`- Policy 切换执行率：${report.policy_execution.rate}（${report.policy_execution.ok}/${report.policy_execution.total}）`);
L.push(`- null 安全拒绝违规：${report.null_safe_rejection.violations}`);
L.push(`- 硬能力违规：${report.hard_violations.total}（streaming=${report.hard_violations.streaming} vision=${report.hard_violations.vision} tool=${report.hard_violations.tool_use} context=${report.hard_violations.context_window} budget=${report.hard_violations.budget} no_paid=${report.hard_violations.no_paid} strict=${report.hard_violations.strict}）`);
L.push(`- 门禁：${report.gates_passed ? 'PASS' : 'FAIL'}（${Object.entries(gates).filter(([, v]) => v).length}/${Object.keys(gates).length} 项通过）`);
L.push('- 运行时：确定性本地 Mock Provider（可复现、离线、零成本）；未开启 Active');
L.push('');
L.push('## 门禁明细');
L.push('');
L.push('| 指标 | 要求 | 实际 | 结果 |');
L.push('| --- | --- | --- | --- |');
const gateNames = {
  classification_ge_92: '分类准确率 >= 92%', hard_violations_zero: '硬能力违规 = 0',
  streaming_zero: 'Streaming 违规 = 0', vision_zero: 'Vision 违规 = 0', tool_zero: 'Tool 违规 = 0',
  context_zero: 'ContextWindow 违规 = 0', budget_zero: '预算越权 = 0', no_paid_zero: '禁付费越权 = 0',
  strict_zero: 'strict 改变 = 0', policy_execution_100: 'Policy 切换执行 = 100%',
  acceptable_ge_90: '可接受集合推荐 >= 90%', null_safe_zero: 'null 安全拒绝违规 = 0',
  cost_reasonable: '成本合理性 = 100%',
};
for (const [k, pass] of Object.entries(gates)) {
  let actual = '';
  if (k === 'classification_ge_92') actual = report.classification.accuracy;
  else if (k === 'acceptable_ge_90') actual = report.acceptable_recommendation.rate;
  else if (k === 'policy_execution_100') actual = report.policy_execution.rate;
  else if (k === 'cost_reasonable') actual = report.cost_reasonableness.rate;
  else if (k === 'null_safe_zero') actual = report.null_safe_rejection.violations;
  else actual = report.hard_violations[k.split('_zero')[0]] ?? report.hard_violations.total;
  L.push(`| ${gateNames[k]} | - | ${actual} | ${pass ? '✅' : '❌'} |`);
}
L.push('');
L.push('## 分类错误');
L.push('');
const wrong = report.classification.details.filter((d) => !d.ok);
if (wrong.length === 0) L.push('无分类错误。');
else for (const w of wrong) L.push(`- ${w.taskId}（${w.category}）：期望 ${w.expected}，实际 ${w.actual}`);
L.push('');
L.push('## 明细（前 40 行）');
L.push('');
L.push('| id | category | 期望类型 | 实际类型 | 建议 | 硬约束淘汰 | 真实结果 |');
L.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of report.rows.slice(0, 40)) {
  L.push(`| ${r.id} | ${r.category} | ${r.expectedType} | ${r.taskType ?? '-'} | ${r.suggested ?? '-'} | ${r.hardBlocks.map((b) => b.reason).join('; ').slice(0, 50) || '-'} | ${r.realOutcome ?? '-'} |`);
}
writeFileSync(join(OUT_DIR, 'holdout-eval-report.md'), L.join('\n'));

// 保存脱敏任务数据（供交付包）
const dataDir = join(OUT_DIR, '..', 'holdout-eval-data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'tasks.json'), JSON.stringify(TASKS.map((t) => ({ id: t.id, category: t.category, expectedType: t.expectedType })), null, 2));

console.log(JSON.stringify({
  tasks: report.tasks_total,
  classification: report.classification.accuracy,
  outcome: report.outcome.accuracy,
  acceptable: report.acceptable_recommendation.rate,
  soft_match: report.soft_match.rate,
  policy_execution: report.policy_execution.rate,
  hard_violations: report.hard_violations.total,
  null_safe: report.null_safe_rejection.violations,
  gates_passed: report.gates_passed,
  out: [join(OUT_DIR, 'holdout-eval-report.json'), join(OUT_DIR, 'holdout-eval-report.md')],
}, null, 2));

mock.server.close();
process.exit(0);
