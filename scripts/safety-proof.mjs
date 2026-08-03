// scripts/safety-proof.mjs
// Smart Router Mainline - Phase 2-C (Safety Sealed)
// 10 项安全收口证明（全部 PASS 时退出码 0）。
// 用法：node scripts/safety-proof.mjs
//
// 证明清单：
//   P1  blocked 候选绝不进入 Canary Fallback 链
//   P2  未采样请求不进指标（普通 Phase1 请求不触发自动停止）
//   P3  0% 采样永不停止
//   P4  maxRequestCost 预算防御（Primary 超限 → 自动停止）
//   P5  非低风险任务不参与（第一批 5% 排除）
//   P6  Kill Switch 可操作（管理接口语义：kill → 立即停止采样）
//   P7  重启后 Kill Switch 仍保持（SQLite app_state 持久化）
//   P8  allowedAgents=["claude-code"] 命中（其余 Agent 排除）
//   P9  Shadow/Off 模式行为不变（Canary 禁用，不重排）
//   P10 7878/17878 未受影响（本服务仍绑定 28788，管理接口仅挂在本服务）

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanaryController } from '../src/intelligence/canary-controller.js';
import { IntelligenceLayer } from '../src/intelligence/index.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { SQLiteStore } from '../src/storage/sqlite-store.js';

const results = [];

function prove(id, name, ok, detail = '') {
  results.push({ id, name, ok: !!ok, detail });
  if (!ok) {
    console.error(`FAIL ${id} ${name} ${detail}`);
  }
}

const BASE_TASK = { taskType: 'general_chat', complexity: 0.2 };

function mkDecision(ids, recId, opts = {}) {
  const ranked = ids.map((id) => ({
    modelId: id, provider: 'p',
    blocked: Array.isArray(opts.blocked) && opts.blocked.includes(id) ? { reason: 'hard_capability' } : null,
    estimatedCost: (opts.estimatedCost && opts.estimatedCost[id]) ?? null,
    paid: false,
  }));
  return { ranked, recommendation: recId ? { modelId: recId, provider: 'p' } : null, task: opts.task || BASE_TASK };
}

function mkCands(ids) {
  return ids.map((id) => ({ modelId: id, provider: 'p', tier: 'tier1', paid: false, capability: ['chat'] }));
}

const DEFAULT_BUDGET = { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false };

// ---------- P1：blocked 不进 Fallback 链 ----------
{
  const cc = new CanaryController({ percentage: 100 }, true);
  const r = cc.apply({
    decision: mkDecision(['a', 'b', 'c'], 'c', { blocked: ['b'] }),
    candidates: mkCands(['a', 'b', 'c']),
    requestId: 'p1', agentId: 'claude-code', taskType: 'general_chat', task: BASE_TASK,
    protocol: 'chat', budget: DEFAULT_BUDGET,
  });
  const ids = r.orderedCandidates.map((x) => x.modelId);
  prove('P1', 'blocked 候选绝不进入 Canary Fallback 链',
    r.active === true && !ids.includes('b') && ids.join() === 'c,a',
    `ordered=[${ids.join(',')}]`);
}

// ---------- P2：未采样请求不进指标 ----------
{
  const cc = new CanaryController({ percentage: 100 }, true);
  for (let i = 0; i < 5; i++) {
    cc.recordFinalized({ requestId: 'phase1-' + i, outcome: 'provider_error', attempts: [{}, {}] });
  }
  prove('P2', '未采样请求不进指标（不触发自动停止）',
    cc.metrics.failed === 0 && cc.metrics.attempts === 0 && cc.stopped === false,
    `failed=${cc.metrics.failed} attempts=${cc.metrics.attempts} stopped=${cc.stopped}`);
}

// ---------- P3：0% 采样永不停止 ----------
{
  const cc = new CanaryController({ percentage: 0 }, true);
  const r = cc.apply({ decision: mkDecision(['a', 'b'], 'b'), candidates: mkCands(['a', 'b']), requestId: 'p3', agentId: 'claude-code', taskType: 'general_chat', task: BASE_TASK, protocol: 'chat', budget: DEFAULT_BUDGET });
  for (let i = 0; i < 10; i++) {
    cc.recordFinalized({ requestId: 'x' + i, outcome: 'provider_error', attempts: [{}] });
  }
  prove('P3', '0% 采样永不停止', r.active === false && r.reason === 'not_sampled' && cc.stopped === false,
    `reason=${r.reason} stopped=${cc.stopped}`);
}

// ---------- P4：maxRequestCost 防御 ----------
{
  const cc = new CanaryController({ percentage: 100 }, true);
  const r = cc.apply({
    decision: mkDecision(['a', 'b'], 'b', { estimatedCost: { a: 0.1, b: 5.0 } }),
    candidates: mkCands(['a', 'b']),
    requestId: 'p4', agentId: 'claude-code', taskType: 'general_chat', task: BASE_TASK,
    protocol: 'chat', budget: { ...DEFAULT_BUDGET, maxRequestCost: 1.0 },
  });
  prove('P4', 'maxRequestCost 预算防御（Primary 超限 → 自动停止）',
    r.active === false && r.reason === 'budget_violation' && cc.metrics.autoStop?.reason === 'budget_violation',
    `reason=${r.reason} autoStop=${cc.metrics.autoStop?.reason}`);
}

// ---------- P5：非低风险任务不参与 ----------
{
  const cc = new CanaryController({ percentage: 100, allowedTaskTypes: ['general_chat', 'coding'] }, true);
  const r = cc.apply({
    decision: mkDecision(['a', 'b'], 'b', { task: { taskType: 'coding', complexity: 0.4 } }),
    candidates: mkCands(['a', 'b']),
    requestId: 'p5', agentId: 'claude-code', taskType: 'coding', task: { taskType: 'coding', complexity: 0.4 },
    protocol: 'chat', budget: DEFAULT_BUDGET,
  });
  prove('P5', '非低风险任务不参与（第一批 5% 排除）',
    r.active === false && r.reason === 'excluded:high_risk_task',
    `reason=${r.reason}`);
}

// ---------- P6/P7：Kill Switch 可操作 + 重启后保留（SQLite） ----------
{
  const tmp = mkdtempSync(join(tmpdir(), 'safety-proof-'));
  const dbPath = join(tmp, 'smart-router.db');
  const AC_CONFIG = {
    intelligence: { mode: 'active_canary', activeCanary: { percentage: 100, allowedAgents: ['claude-code'], allowedTaskTypes: ['general_chat'] }, shadow: { retentionDays: 30 } },
    models: [{ id: 'm1', provider: 'p1', tier: 'tier1', paid: false, capabilities: { chat: 100 }, context_window: 32000 }],
    budget: DEFAULT_BUDGET,
    agent_bindings: {},
  };
  try {
    const store1 = new SQLiteStore(dbPath);
    await store1.init();
    const layer1 = new IntelligenceLayer(AC_CONFIG, { store: store1 });
    const st = layer1.killCanary('admin_kill_switch');
    await layer1.persistCanaryState();
    prove('P6', 'Kill Switch 可操作（kill → 立即停止采样）',
      st.canary.stopped === true && st.canary.autoStop?.reason === 'admin_kill_switch',
      `stopped=${st.canary.stopped} autoStop=${st.canary.autoStop?.reason}`);
    const d = await layer1.suggest({
      requestId: 'p6', body: { messages: [{ role: 'user', content: 'hi' }] },
      agentId: 'claude-code', budget: DEFAULT_BUDGET,
      candidates: [{ modelId: 'm1', provider: 'p1', paid: false, capability: ['chat'] }], protocol: 'chat',
    });
    prove('P6b', 'Kill 后不再采样', d.canary.active === false && d.canary.reason === 'killed', `reason=${d.canary?.reason}`);
    await store1.close();

    // 模拟重启：同一 db 文件重新打开
    const store2 = new SQLiteStore(dbPath);
    await store2.init();
    const layer2 = new IntelligenceLayer(AC_CONFIG, { store: store2 });
    await layer2.restoreCanaryState();
    prove('P7', '重启后 Kill Switch 仍保持（SQLite 持久化）',
      layer2.status().canary.stopped === true && layer2.status().canary.autoStop?.reason === 'admin_kill_switch',
      `stopped=${layer2.status().canary.stopped} autoStop=${layer2.status().canary.autoStop?.reason} restored=${layer2.status().canary.autoStop?.restored}`);
    await store2.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- P8：allowedAgents=["claude-code"] 命中 ----------
{
  const cc = new CanaryController({ percentage: 100, allowedAgents: ['claude-code'] }, true);
  const hit = cc.apply({ decision: mkDecision(['a', 'b'], 'b'), candidates: mkCands(['a', 'b']), requestId: 'p8a', agentId: 'claude-code', taskType: 'general_chat', task: BASE_TASK, protocol: 'chat', budget: DEFAULT_BUDGET });
  const miss = cc.apply({ decision: mkDecision(['a', 'b'], 'b'), candidates: mkCands(['a', 'b']), requestId: 'p8b', agentId: 'other-agent', taskType: 'general_chat', task: BASE_TASK, protocol: 'chat', budget: DEFAULT_BUDGET });
  prove('P8', 'allowedAgents=["claude-code"] 命中（其余 Agent 排除）',
    hit.active === true && miss.reason === 'agent_not_allowed',
    `claude-code=${hit.active} other=${miss.reason}`);
}

// ---------- P9：Shadow/Off 行为不变 ----------
{
  const store = new MemoryStore();
  await store.init();
  const layer = new IntelligenceLayer({
    intelligence: { mode: 'shadow', shadow: { retentionDays: 30 } },
    models: [{ id: 'm1', provider: 'p1', tier: 'tier1', paid: false, capabilities: { chat: 100 }, context_window: 32000 }],
    budget: DEFAULT_BUDGET, agent_bindings: {},
  }, { store });
  const d = await layer.suggest({
    requestId: 'p9', body: { messages: [{ role: 'user', content: 'hi' }] },
    agentId: 'claude-code', budget: DEFAULT_BUDGET,
    candidates: [{ modelId: 'm1', provider: 'p1', paid: false, capability: ['chat'] }], protocol: 'chat',
  });
  const offLayer = new IntelligenceLayer({ intelligence: { mode: 'off' }, models: [], budget: {}, agent_bindings: {} }, { store });
  const offSuggest = await offLayer.suggest({ requestId: 'x', body: {}, agentId: 'g', budget: {}, candidates: [] });
  prove('P9', 'Shadow/Off 模式行为不变（Canary 禁用，不重排）',
    layer.status().canary.enabled === false && (!d.canary || d.canary.active === false) && offSuggest === null,
    `shadowCanaryEnabled=${layer.status().canary.enabled} offSuggest=${String(offSuggest)}`);
}

// ---------- P10：7878/17878 未受影响 ----------
{
  const serverSrc = readFileSync('/Users/lijie/CodeBuddy/20260801-smart-router-mainline/src/server.js', 'utf8');
  const portOk = serverSrc.includes('const DEFAULT_PORT = 28788;');
  // 本服务没有新增监听 7878 / 17878 的代码
  const no7878 = !/listen\(\s*7878\b/.test(serverSrc) && !/port:\s*7878\b/.test(serverSrc);
  const no17878 = !/listen\(\s*17878\b/.test(serverSrc) && !/port:\s*17878\b/.test(serverSrc);
  prove('P10', '7878/17878 未受影响（本服务仍绑定 28788）',
    portOk && no7878 && no17878,
    `DEFAULT_PORT=28788:${portOk} no7878:${no7878} no17878:${no17878}`);
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log('\n===== Safety Sealed 10 项证明 =====');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
}
console.log(`\n结果: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.error(`未通过: ${failed.map((f) => f.id).join(', ')}`);
  process.exit(1);
}
process.exit(0);
