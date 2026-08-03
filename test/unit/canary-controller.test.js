// test/unit/canary-controller.test.js
// Smart Router Mainline - Phase 2-C (Safety Sealed)
// Active Canary 控制器：确定性采样 / 合法候选过滤 / Active 指标 / 低风险资格 /
// 预算防御 / Fail Open / Kill Switch / 真连续错误 / 自动停止

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { CanaryController } from '../../src/intelligence/canary-controller.js';
import { IntelligenceLayer } from '../../src/intelligence/index.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

function candidates(ids) {
  return ids.map((id, i) => ({ modelId: id, provider: 'p', tier: 'tier' + (i + 1), paid: false, capability: ['chat'] }));
}

// decision helper：支持 blocked / task / estimatedCost / recommendation
function decision(rankedIds, recId, opts = {}) {
  const ranked = rankedIds.map((id) => {
    const blocked = Array.isArray(opts.blocked) && opts.blocked.includes(id) ? { reason: 'hard_capability' } : null;
    const est = (opts.estimatedCost && opts.estimatedCost[id]) ?? null;
    return { modelId: id, provider: 'p', blocked, estimatedCost: est, paid: false };
  });
  const rec = recId ? { modelId: recId, provider: 'p' } : null;
  return {
    ranked,
    recommendation: rec,
    task: opts.task || { taskType: 'general_chat', complexity: 0.2 },
  };
}

const BASE_TASK = { taskType: 'general_chat', complexity: 0.2 };

function applyArgs(over = {}) {
  return {
    decision: over.decision || decision(['a', 'b'], 'b'),
    candidates: over.candidates || candidates(['a', 'b']),
    requestId: over.requestId || 'req-1',
    agentId: over.agentId || 'claude-code',
    taskType: over.taskType || 'general_chat',
    task: over.task || BASE_TASK,
    protocol: over.protocol || 'chat',
    budget: over.budget || { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
    requestedModel: over.requestedModel ?? null,
  };
}

describe('Phase2-C Active Canary 控制器（Safety Sealed）', () => {
  test('S1 deterministic sampling: same requestId → same result, no Math.random', () => {
    const cc = new CanaryController({ percentage: 50 }, true);
    const r1 = cc.apply(applyArgs({ requestId: 'req-abc' }));
    const r2 = cc.apply(applyArgs({ requestId: 'req-abc' }));
    assert.deepStrictEqual(r1, r2, 'same requestId must sample identically');
    assert.ok([true, false].includes(r1.active));
  });

  test('S1 percentage=0 never samples; percentage=100 always samples', () => {
    const off = new CanaryController({ percentage: 0 }, true);
    const on = new CanaryController({ percentage: 100 }, true);
    assert.strictEqual(off.apply(applyArgs()).active, false);
    assert.strictEqual(off.apply(applyArgs()).reason, 'not_sampled');
    assert.strictEqual(on.apply(applyArgs()).active, true);
  });

  test('S1 allowedAgents filters (claude-code hits, others excluded)', () => {
    const cc = new CanaryController({ percentage: 100, allowedAgents: ['claude-code'] }, true);
    assert.strictEqual(cc.apply(applyArgs({ agentId: 'other-agent' })).reason, 'agent_not_allowed');
    assert.strictEqual(cc.apply(applyArgs({ agentId: 'claude-code' })).active, true);
  });

  test('S1 allowedTaskTypes filters', () => {
    const cc = new CanaryController({ percentage: 100, allowedTaskTypes: ['writing'] }, true);
    assert.strictEqual(cc.apply(applyArgs({ taskType: 'coding' })).reason, 'task_type_not_allowed');
    assert.strictEqual(cc.apply(applyArgs({ taskType: 'writing' })).active, true);
  });

  test('S1 reorder puts primary first, keeps others in Phase1 order (stable)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ decision: decision(['a', 'b', 'c'], 'c'), candidates: candidates(['a', 'b', 'c']) }));
    assert.strictEqual(r.active, true);
    assert.deepStrictEqual(r.orderedCandidates.map((x) => x.modelId), ['c', 'a', 'b'], 'rest keep Phase1 order');
  });

  test('S1 fail open on exception returns original candidates', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply({ decision: null, candidates: null, requestId: 'req-1', agentId: 'x', taskType: 'general_chat', task: null, protocol: 'chat' });
    assert.strictEqual(r.active, false);
    assert.deepStrictEqual(r.orderedCandidates, []);
    assert.ok(r.reason.startsWith('excluded:no_recommendation') || r.reason.startsWith('exception'), 'reason=' + r.reason);
  });

  test('S1 kill switch stops sampling immediately', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    cc.stop('kill_switch');
    const r = cc.apply(applyArgs());
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'killed');
    assert.strictEqual(cc.metrics.autoStop.reason, 'kill_switch');
  });

  test('S1 restoreKilled recovers persisted kill state (restart keeps Kill Switch)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    assert.strictEqual(cc.stopped, false);
    cc.restoreKilled({ reason: 'admin_kill_switch', at: '2026-08-03T00:00:00.000Z' });
    assert.strictEqual(cc.stopped, true);
    assert.strictEqual(cc.metrics.autoStop.reason, 'admin_kill_switch');
    assert.strictEqual(cc.metrics.autoStop.restored, true);
    assert.strictEqual(cc.apply(applyArgs()).reason, 'killed', 'restored kill must block sampling');
  });

  // ---- 收口 1：Fallback 链只保留合法候选 ----

  test('S1 blocked candidates NEVER enter Canary fallback chain', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    // b 被硬能力 blocked；a/c 合法。场景 A→B→C：b 绝不能出现在 orderedCandidates
    const args = applyArgs({
      decision: decision(['a', 'b', 'c'], 'c', { blocked: ['b'] }),
      candidates: candidates(['a', 'b', 'c']),
    });
    const r = cc.apply(args);
    assert.strictEqual(r.active, true);
    const ids = r.orderedCandidates.map((x) => x.modelId);
    assert.ok(!ids.includes('b'), 'blocked candidate must not be in fallback chain: ' + ids.join(','));
    assert.deepStrictEqual(ids, ['c', 'a'], 'primary first, legal candidates keep Phase1 order');
  });

  test('S1 all candidates blocked → no sampling (no_legal_candidate)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ decision: decision(['a', 'b'], 'a', { blocked: ['a', 'b'] }) }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:no_legal_candidate');
    assert.deepStrictEqual(r.orderedCandidates.map((x) => x.modelId), ['a', 'b'], 'fail open to Phase1 order');
  });

  test('S1 primary blocked (defensive) → no reorder', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ decision: decision(['a', 'b'], 'a', { blocked: ['a'] }) }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'primary_not_legal');
    assert.deepStrictEqual(r.orderedCandidates.map((x) => x.modelId), ['a', 'b'], 'fail open to Phase1 order');
  });

  // ---- 收口 2：指标只统计实际 Active 请求 ----

  test('S2 metrics only count Active requests; non-active ignored', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    // 采样命中 r1 → 创建 active 条目
    cc.apply(applyArgs({ requestId: 'r1' }));
    assert.strictEqual(cc.activeCount, 1);
    // 普通 Phase1 请求（从未采样）：3 次 provider_error 不得计入指标与停止
    for (let i = 0; i < 3; i++) {
      cc.recordFinalized({ requestId: 'phase1-' + i, outcome: 'provider_error', attempts: [{}, {}] });
    }
    assert.strictEqual(cc.metrics.failed, 0, 'non-active requests must not count into metrics');
    assert.strictEqual(cc.metrics.attempts, 0);
    assert.strictEqual(cc.stopped, false, 'non-active errors must not trigger auto-stop');
    // Active 请求（每个请求 Finalize 一次）：3 个 Active 请求连续 provider_error → 停止
    for (let i = 0; i < 3; i++) {
      cc.apply(applyArgs({ requestId: 'active-' + i }));
      cc.recordFinalized({ requestId: 'active-' + i, outcome: 'provider_error', attempts: [{}, {}] });
    }
    assert.strictEqual(cc.metrics.failed, 3);
    assert.ok(cc.stopped, 'active consecutive provider errors must auto-stop');
    assert.strictEqual(cc.metrics.autoStop.reason, 'consecutive_provider_errors');
  });

  test('S2 activeRequests cleaned up after Finalize (no memory growth)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    cc.apply(applyArgs({ requestId: 'r1' }));
    cc.apply(applyArgs({ requestId: 'r2' }));
    assert.strictEqual(cc.activeCount, 2);
    cc.recordFinalized({ requestId: 'r1', outcome: 'completed', attempts: [{}] });
    assert.strictEqual(cc.activeCount, 1, 'finalized request must be removed');
    cc.recordFinalized({ requestId: 'r2', outcome: 'completed', attempts: [{}] });
    assert.strictEqual(cc.activeCount, 0);
  });

  test('S2 percentage=0 never samples → never auto-stops', () => {
    const cc = new CanaryController({ percentage: 0 }, true);
    const r = cc.apply(applyArgs());
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'not_sampled');
    for (let i = 0; i < 10; i++) {
      cc.recordFinalized({ requestId: 'x' + i, outcome: 'provider_error', attempts: [{}] });
    }
    assert.strictEqual(cc.stopped, false, '0% sampling must never trigger auto-stop');
    assert.strictEqual(cc.metrics.failed, 0);
  });

  // ---- 收口 3：预算防御 ----

  test('S3 maxRequestCost defense: primary over budget → auto-stop', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const args = applyArgs({
      decision: decision(['a', 'b'], 'b', { estimatedCost: { a: 0.1, b: 5.0 } }),
      budget: { allowPaid: true, maxRequestCost: 1.0, allowedModels: [], allowedProviders: [], strictModel: false },
    });
    const r = cc.apply(args);
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'budget_violation');
    assert.strictEqual(cc.metrics.autoStop.reason, 'budget_violation');
  });

  test('S3 strictModel defense: strictModel task excluded from sampling; budget check still defensive', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    // 低风险资格：strictModel 任务第一批 5% 直接排除
    const args = applyArgs({
      decision: decision(['a', 'b'], 'b'),
      budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: true },
      requestedModel: 'a',
    });
    const r = cc.apply(args);
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:strict_model');
    // 防御纵深：_budgetViolation 对 strictModel + 具体模型不匹配仍返回 true
    assert.strictEqual(cc._budgetViolation(
      { modelId: 'b', provider: 'p', paid: false },
      { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: true },
      { model: 'a' }, 'a',
    ), true, 'strictModel mismatch must be a budget violation');
    assert.strictEqual(cc._budgetViolation(
      { modelId: 'a', provider: 'p', paid: false },
      { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: true },
      { model: 'a' }, 'a',
    ), false, 'strictModel match is allowed');
  });

  test('S3 allowPaid=false + paid primary → auto-stop', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const d = { ranked: [{ modelId: 'paid', provider: 'p', blocked: null, paid: true }], recommendation: { modelId: 'paid', provider: 'p', paid: true }, task: BASE_TASK };
    const r = cc.apply(applyArgs({ decision: d, candidates: [{ modelId: 'paid', provider: 'p', tier: 'tier1', paid: true, capability: ['chat'] }], budget: { allowPaid: false, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false } }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'budget_violation');
    assert.ok(cc.stopped);
  });

  // ---- 收口 3：低风险资格排除（第一批 5%） ----

  test('S3 low-risk exclusion: toolsRequired', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ task: { ...BASE_TASK, toolsRequired: true } }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:tools_required');
  });

  test('S3 low-risk exclusion: visionRequired', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ task: { ...BASE_TASK, needsVision: true } }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:vision_required');
  });

  test('S3 low-risk exclusion: structuredOutputRequired', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ task: { ...BASE_TASK, structuredOutputRequired: true } }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:structured_output_required');
  });

  test('S3 low-risk exclusion: needsLongContext', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ task: { ...BASE_TASK, needsLongContext: true } }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:long_context');
  });

  test('L1 streaming exclusion: needsStreaming + non-anthropic protocol excluded', () => {
    const cc = new CanaryController({ percentage: 100, allowedAgents: ['claude-code'], allowedProtocols: ['anthropic'] }, true);
    // chat 协议 + 流式 → 第一批只允许 anthropic
    const r = cc.apply(applyArgs({ task: { ...BASE_TASK, needsStreaming: true }, protocol: 'chat', agentId: 'claude-code' }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:streaming_protocol_not_allowed');
  });

  test('L1 streaming Claude Code (anthropic + claude-code + streaming candidates) can enter Canary', () => {
    const cc = new CanaryController({ percentage: 100, allowedAgents: ['claude-code'], allowedProtocols: ['anthropic'] }, true);
    const cands = [
      { modelId: 'a', provider: 'p', tier: 'tier1', paid: false, capability: ['chat', 'streaming'] },
      { modelId: 'b', provider: 'p', tier: 'tier2', paid: false, capability: ['chat', 'streaming'] },
    ];
    const r = cc.apply(applyArgs({
      candidates: cands,
      task: { ...BASE_TASK, needsStreaming: true },
      protocol: 'anthropic',
      agentId: 'claude-code',
    }));
    assert.strictEqual(r.active, true, 'streaming low-risk anthropic must sample: ' + r.reason);
  });

  test('L1 streaming request with candidates lacking streaming → excluded (defense)', () => {
    const cc = new CanaryController({ percentage: 100, allowedAgents: ['claude-code'], allowedProtocols: ['anthropic'] }, true);
    // 候选 capability 无 streaming（DecisionEngine 会将其 blocked；Canary 层最终防线拒绝采样）
    const r = cc.apply(applyArgs({ task: { ...BASE_TASK, needsStreaming: true }, protocol: 'anthropic', agentId: 'claude-code' }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:streaming_candidate_unsupported');
  });

  test('L1 non-streaming request still allowed under anthropic', () => {
    const cc = new CanaryController({ percentage: 100, allowedAgents: ['claude-code'], allowedProtocols: ['anthropic'] }, true);
    const r = cc.apply(applyArgs({ protocol: 'anthropic', agentId: 'claude-code', candidates: candidates(['a', 'b']) }));
    assert.strictEqual(r.active, true);
  });

  test('L1 streaming-blocked candidate never enters fallback chain', () => {
    const cc = new CanaryController({ percentage: 100, allowedAgents: ['claude-code'], allowedProtocols: ['anthropic'] }, true);
    // b 不支持 streaming → DecisionEngine 语义 blocked；a/c 支持 streaming 合法
    const d = decision(['a', 'b', 'c'], 'c', { blocked: ['b'] });
    const cands = [
      { modelId: 'a', provider: 'p', tier: 'tier1', paid: false, capability: ['chat', 'streaming'] },
      { modelId: 'b', provider: 'p', tier: 'tier2', paid: false, capability: ['chat'] },
      { modelId: 'c', provider: 'p', tier: 'tier3', paid: false, capability: ['chat', 'streaming'] },
    ];
    const r = cc.apply(applyArgs({
      decision: d, candidates: cands,
      task: { ...BASE_TASK, needsStreaming: true },
      protocol: 'anthropic', agentId: 'claude-code',
    }));
    assert.strictEqual(r.active, true, 'reason=' + r.reason);
    const ids = r.orderedCandidates.map((x) => x.modelId);
    assert.ok(!ids.includes('b'), 'streaming-blocked candidate must not enter fallback: ' + ids.join(','));
    assert.deepStrictEqual(ids, ['c', 'a']);
  });

  test('S3 low-risk exclusion: strictModel budget', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: true } }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:strict_model');
  });

  test('S3 low-risk exclusion: high-risk task types (coding/vision/analysis/...)', () => {
    for (const highRisk of ['coding', 'debugging', 'architecture', 'research', 'analysis', 'vision', 'tool_orchestration', 'structured_output']) {
      const cc = new CanaryController({ percentage: 100 }, true);
      const r = cc.apply(applyArgs({ task: { taskType: highRisk, complexity: 0.3 } }));
      assert.strictEqual(r.active, false, highRisk + ' must be excluded');
      assert.strictEqual(r.reason, 'excluded:high_risk_task', highRisk);
    }
  });

  test('S3 low-risk exclusion: high complexity', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ task: { taskType: 'general_chat', complexity: 0.7 } }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:high_complexity');
  });

  test('S3 low-risk exclusion: no recommendation (low confidence)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const r = cc.apply(applyArgs({ decision: decision(['a', 'b'], null) }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:no_recommendation');
  });

  test('S3 low-risk exclusion: protocol not allowed', () => {
    const cc = new CanaryController({ percentage: 100, allowedProtocols: ['chat'] }, true);
    const r = cc.apply(applyArgs({ protocol: 'anthropic' }));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'excluded:protocol_not_allowed');
  });

  test('S3 low-risk request (chat, no hard needs) passes eligibility and samples', () => {
    const cc = new CanaryController({ percentage: 100, allowedAgents: ['claude-code'] }, true);
    const r = cc.apply(applyArgs({ agentId: 'claude-code' }));
    assert.strictEqual(r.active, true);
    assert.strictEqual(r.reason, 'sampled');
  });

  // ---- 收口 6：真连续错误计数 ----

  test('S6 consecutive provider errors are TRULY consecutive: success resets', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    // 每个 Active 请求 Finalize 一次；连续错误跨请求计数，成功即清零
    const err = (id) => { cc.apply(applyArgs({ requestId: id })); cc.recordFinalized({ requestId: id, outcome: 'provider_error', attempts: [{}] }); };
    const ok = (id) => { cc.apply(applyArgs({ requestId: id })); cc.recordFinalized({ requestId: id, outcome: 'completed', attempts: [{}] }); };
    err('e1'); err('e2');
    assert.strictEqual(cc.stopped, false, '2 consecutive errors must not stop');
    ok('s1'); // 成功清零
    err('e3'); err('e4');
    assert.strictEqual(cc.stopped, false, '2 after reset must not stop');
    err('e5');
    assert.ok(cc.stopped, '3rd consecutive after reset must stop');
    assert.strictEqual(cc.metrics.autoStop.reason, 'consecutive_provider_errors');
  });

  test('S6 incomplete rise auto-stops on 3 consecutive (Active only)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    for (let i = 0; i < 3; i++) {
      cc.apply(applyArgs({ requestId: 'inc-' + i }));
      cc.recordFinalized({ requestId: 'inc-' + i, outcome: 'incomplete', attempts: [{}, {}], latencyMs: 10 });
    }
    assert.strictEqual(cc.metrics.incomplete, 3);
    assert.strictEqual(cc.metrics.attempts, 6);
    assert.strictEqual(cc.metrics.autoStop.reason, 'incomplete_rise');
  });

  test('S6 budget_exceeded stops immediately (single Active request)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    cc.apply(applyArgs({ requestId: 'r1' }));
    cc.recordFinalized({ requestId: 'r1', outcome: 'budget_exceeded', attempts: [{}] });
    assert.ok(cc.stopped);
    assert.strictEqual(cc.metrics.autoStop.reason, 'budget_exceeded');
  });

  test('S6 first-byte-then-switch stops immediately (Active only)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    cc.apply(applyArgs({ requestId: 'r1' }));
    cc.recordFinalized({
      requestId: 'r1', outcome: 'provider_error', attempts: [
        { attemptNumber: 1, firstByteSentToClient: true },
        { attemptNumber: 2, firstByteSentToClient: false },
      ],
    });
    assert.ok(cc.stopped);
    assert.strictEqual(cc.metrics.autoStop.reason, 'first_byte_switch');
  });

  test('S6 disabled controller (shadow mode) never samples', () => {
    const cc = new CanaryController({ percentage: 100 }, false);
    assert.strictEqual(cc.apply(applyArgs()).active, false);
    assert.strictEqual(cc.apply(applyArgs()).reason, 'disabled');
  });

  test('S6 default allowed task types include low-risk types only', () => {
    const cc = new CanaryController({}, true);
    assert.ok(cc.allowedTaskTypes.includes('general_chat'));
    assert.ok(!cc.allowedTaskTypes.includes('coding'));
    assert.ok(!cc.allowedTaskTypes.includes('vision'));
    assert.ok(!cc.allowedTaskTypes.includes('tool_orchestration'));
  });

  test('S6 snapshot exposes activeRequests size and consecutiveErrors', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    cc.apply(applyArgs({ requestId: 'r1' }));
    const snap = cc.snapshot();
    assert.strictEqual(snap.activeRequests, 1);
    assert.deepStrictEqual(snap.consecutiveErrors, { provider_error: 0, no_candidate: 0, incomplete: 0 });
  });
});

describe('Phase2-C IntelligenceLayer Canary 集成（Safety Sealed）', () => {
  const AC_CONFIG = {
    intelligence: {
      mode: 'active_canary',
      activeCanary: { percentage: 100, allowedAgents: ['claude-code'], allowedTaskTypes: ['general_chat', 'coding'] },
      shadow: { retentionDays: 30 },
    },
    models: [
      { id: 'm1', provider: 'p1', tier: 'tier1', paid: false, capabilities: { chat: 100 }, context_window: 32000 },
      { id: 'm2', provider: 'p2', tier: 'tier2', paid: false, capabilities: { chat: 100, reasoning: 100 }, context_window: 32000 },
    ],
    budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
    agent_bindings: {},
  };

  test('S3 active_canary mode: suggest passes full task; low-risk chat samples', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(AC_CONFIG, { store });
    assert.strictEqual(layer.mode, 'active_canary');
    const cands = [
      { modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat'] },
      { modelId: 'm2', provider: 'p2', tier: 'tier2', paid: false, capability: ['chat', 'reasoning'] },
    ];
    const d = await layer.suggest({
      requestId: 'canary-1', body: { messages: [{ role: 'user', content: 'Hello there' }] },
      agentId: 'claude-code', budget: AC_CONFIG.budget, candidates: cands, protocol: 'chat',
    });
    assert.ok(d, 'suggest must return decision');
    assert.ok(d.canary, 'canary field must exist');
    assert.strictEqual(d.canary.active, true, 'percentage=100 + allowed agent/task must sample');
    assert.strictEqual(d.canary.orderedCandidates.length, 2);
    // 完整 task 传递：decision.task 字段透传
    assert.strictEqual(d.canary.reason, 'sampled');
  });

  test('S3 coding task excluded from active canary (full task drives eligibility)', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(AC_CONFIG, { store });
    const d = await layer.suggest({
      requestId: 'canary-2', body: { messages: [{ role: 'user', content: 'Write a Python function to sort a list' }] },
      agentId: 'claude-code', budget: AC_CONFIG.budget, candidates: [{ modelId: 'm1', provider: 'p1', paid: false, capability: ['chat'] }], protocol: 'chat',
    });
    assert.ok(d.canary.active === false, 'coding must be excluded from first 5%');
    assert.strictEqual(d.canary.reason, 'excluded:high_risk_task', 'reason=' + d.canary.reason);
  });

  test('S4 shadow mode: canary disabled, no canary reorder', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer({ ...AC_CONFIG, intelligence: { mode: 'shadow', shadow: {} } }, { store });
    assert.strictEqual(layer.mode, 'shadow');
    const d = await layer.suggest({
      requestId: 'shadow-1', body: { messages: [{ role: 'user', content: 'Hello' }] },
      agentId: 'claude-code', budget: AC_CONFIG.budget, candidates: [{ modelId: 'm1', provider: 'p1', paid: false, capability: ['chat'] }], protocol: 'chat',
    });
    assert.ok(d);
    assert.ok(!d.canary || d.canary.active === false);
  });

  test('S4 killCanary stops sampling without code change', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(AC_CONFIG, { store });
    const st = layer.killCanary();
    assert.strictEqual(st.canary.stopped, true);
    assert.strictEqual(st.canary.autoStop.reason, 'kill_switch');
    const d = await layer.suggest({
      requestId: 'canary-2', body: { messages: [{ role: 'user', content: 'Hello' }] },
      agentId: 'claude-code', budget: AC_CONFIG.budget, candidates: [{ modelId: 'm1', provider: 'p1', paid: false, capability: ['chat'] }], protocol: 'chat',
    });
    assert.ok(d.canary.active === false, 'after kill, no sampling');
  });

  test('S4 killCanary persists killed state; new layer restores it', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer1 = new IntelligenceLayer(AC_CONFIG, { store });
    layer1.killCanary('admin_kill_switch');
    await layer1.persistCanaryState();
    const killedRaw = await store.getAppState('canary.killed');
    assert.ok(killedRaw, 'killed state must be persisted');
    // 模拟重启：新建 layer 使用同一 store
    const layer2 = new IntelligenceLayer(AC_CONFIG, { store });
    await layer2.restoreCanaryState();
    assert.strictEqual(layer2.status().canary.stopped, true, 'restart must keep Kill Switch');
    assert.strictEqual(layer2.status().canary.autoStop.reason, 'admin_kill_switch');
  });

  test('S4 resumeShadow only restores Shadow, never auto-resumes Active', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(AC_CONFIG, { store });
    layer.killCanary('admin_kill_switch');
    const st = layer.resumeShadow();
    assert.strictEqual(st.mode, 'shadow', 'resume-shadow downgrades mode to shadow');
    assert.strictEqual(st.canary.enabled ?? false, false);
    const d = await layer.suggest({
      requestId: 'canary-3', body: { messages: [{ role: 'user', content: 'Hello' }] },
      agentId: 'claude-code', budget: AC_CONFIG.budget, candidates: [{ modelId: 'm1', provider: 'p1', paid: false, capability: ['chat'] }], protocol: 'chat',
    });
    assert.ok(!d.canary || d.canary.active === false, 'shadow mode must not sample');
  });

  test('S4 off mode: suggest null, canary untouched', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer({ intelligence: { mode: 'off' }, models: [], budget: {}, agent_bindings: {} }, { store });
    assert.strictEqual(layer.mode, 'off');
    assert.strictEqual(await layer.suggest({ requestId: 'x', body: {}, agentId: 'g', budget: {}, candidates: [] }), null);
    assert.strictEqual(layer.status().canary.stopped, false);
  });
});
