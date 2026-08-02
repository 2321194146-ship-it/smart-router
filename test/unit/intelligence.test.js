// test/unit/intelligence.test.js
// Smart Router Mainline - Phase 2-A (Shadow) Sealed
// 智能层单元测试：Task Analyzer / Capability Registry / Policy 硬约束 / Budget /
// Decision Engine / Explainability / Shadow Recorder / off-shadow 模式

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { analyzeTask, TaskType } from '../../src/intelligence/task-analyzer.js';
import { CapabilityRegistry, hasCapability, deriveProtocols } from '../../src/intelligence/capability-registry.js';
import {
  normalizePolicy, scoreCandidate, hardConstraintBlock, estimateCost,
  predictQuality, predictLatency,
} from '../../src/intelligence/policy.js';
import { evaluateBudget } from '../../src/intelligence/budget.js';
import { DecisionEngine } from '../../src/intelligence/decision-engine.js';
import { explainDecision } from '../../src/intelligence/explainability.js';
import {
  ShadowRecorder, sanitizeTaskProfile, computeComparisonStatus,
} from '../../src/intelligence/shadow-recorder.js';
import { IntelligenceLayer } from '../../src/intelligence/index.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

const POLICY = normalizePolicy(null);

const TEST_CONFIG = {
  intelligence: { mode: 'shadow', shadow: { retentionDays: 30 } },
  models: [
    { id: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'tool_use', 'streaming'], max_tokens: 64000 },
    { id: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat', 'vision'], price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } },
    { id: 'm3', provider: 'p3', tier: 'tier3', paid: false, capability: ['chat'], max_tokens: 16000 },
    // 同 modelId 不同 Provider（价格/能力不同）
    { id: 'mx', provider: 'pA', tier: 'tier1', paid: false, capability: ['chat', 'tool_use', 'vision'], max_tokens: 32000, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } },
    { id: 'mx', provider: 'pB', tier: 'tier2', paid: true, capability: ['chat'], max_tokens: 8000, price: { input_cost_per_1k: 0.02, output_cost_per_1k: 0.04 } },
  ],
  budget: { allowPaid: false, maxRequestCost: 10, allowedModels: [], allowedProviders: [], strictModel: false },
  agent_bindings: {},
};

describe('Phase2-A Task Analyzer', () => {
  test('coding / tool / vision / analysis detection', () => {
    assert.strictEqual(analyzeTask({ messages: [{ role: 'user', content: 'Write a function to sort an array in JavaScript' }] }).taskType, TaskType.CODING);
    const t = analyzeTask({ messages: [{ role: 'user', content: 'Use the calculator tool' }], tools: [{ type: 'function' }] });
    assert.strictEqual(t.taskType, TaskType.TOOL_ORCHESTRATION);
    assert.ok(t.needsToolUse);
    const v = analyzeTask({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'describe' }] }] });
    assert.strictEqual(v.taskType, TaskType.VISION);
    assert.ok(v.needsVision);
  });

  test('complexity bounded 0-1', () => {
    const t = analyzeTask({ messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(t.complexity >= 0 && t.complexity <= 1);
  });
});

describe('Phase2-A Capability Registry (modelId + provider)', () => {
  const reg = new CapabilityRegistry(TEST_CONFIG);

  test('getProfile distinguishes same modelId across providers', () => {
    const pa = reg.getProfile('mx', 'pA');
    const pb = reg.getProfile('mx', 'pB');
    assert.ok(pa);
    assert.ok(pb);
    assert.strictEqual(pa.provider, 'pA');
    assert.strictEqual(pb.provider, 'pB');
    assert.ok(pa.capabilities.includes('vision'));
    assert.ok(!pb.capabilities.includes('vision'));
    assert.strictEqual(pa.paid, false);
    assert.strictEqual(pb.paid, true);
    assert.notStrictEqual(pa.contextWindow, pb.contextWindow);
    assert.strictEqual(pa.price.input_cost_per_1k, 0);
    assert.strictEqual(pb.price.input_cost_per_1k, 0.02);
  });

  test('contextWindow from max_tokens / context_window', () => {
    const prof = reg.getProfile('m1', 'p1');
    assert.strictEqual(prof.contextWindow, 64000);
  });

  test('deriveProtocols: chat-capable is adapter-compatible with all protocols', () => {
    // chat 能力经协议适配层可服务三协议（responses/anthropic 内部转 chat 执行）
    const p = deriveProtocols({ capability: ['chat'], provider: 'mock-a' });
    assert.ok(p.includes('chat') && p.includes('responses') && p.includes('anthropic'));
    // gateway 原生支持
    const gw = deriveProtocols({ capability: ['chat'], provider: 'gateway' });
    assert.ok(gw.includes('anthropic') && gw.includes('responses'));
    // 无 chat 能力且非 gateway → 无协议（硬约束将阻止）
    const none = deriveProtocols({ capability: ['vision_only'], provider: 'p' });
    assert.strictEqual(none.length, 0);
  });

  test('supports with provider', () => {
    const reg2 = new CapabilityRegistry(TEST_CONFIG);
    assert.ok(reg2.supports('mx', 'pA', 'vision'));
    assert.ok(!reg2.supports('mx', 'pB', 'vision'));
  });
});

describe('Phase2-A Policy 硬约束', () => {
  const base = { modelId: 'm', provider: 'p', tier: 'tier1', paid: false, capabilities: ['chat'], contextWindow: 1000, price: {}, protocols: ['chat'] };
  const BUDGET = { allowPaid: true, allowedModels: [], allowedProviders: [], maxRequestCost: 100 };

  test('missing tool_use → blocked, score 0', () => {
    const r = scoreCandidate(base, { needsToolUse: true, complexity: 0.5 }, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('tool_use'));
  });

  test('missing vision → blocked', () => {
    const r = scoreCandidate(base, { needsVision: true, complexity: 0.5 }, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('vision'));
  });

  test('context overflow → blocked', () => {
    const r = scoreCandidate({ ...base, contextWindow: 500 }, { estimatedInputTokens: 6000 }, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('contextWindow'));
  });

  test('protocol not supported → blocked', () => {
    const r = scoreCandidate(base, { complexity: 0.3 }, POLICY, BUDGET, 'responses');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('responses'));
  });

  test('hardConstraintBlock returns null when satisfied', () => {
    const ok = hardConstraintBlock(
      { capabilities: ['tool_use', 'vision'], contextWindow: 100000, protocols: ['chat'] },
      { needsToolUse: true, needsVision: true, estimatedInputTokens: 100 },
      'chat',
    );
    assert.strictEqual(ok, null);
  });

  test('paid blocked when allowPaid=false', () => {
    const r = scoreCandidate(
      { ...base, paid: true }, { complexity: 0.3 }, POLICY,
      { allowPaid: false, allowedModels: [], allowedProviders: [], maxRequestCost: 100 }, 'chat',
    );
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('allowPaid=false'));
  });

  test('deterministic latency (no Math.random)', () => {
    const c1 = { modelId: 'm1', provider: 'p1', tier: 'tier1' };
    assert.strictEqual(predictLatency(c1), predictLatency(c1));
    assert.ok(predictLatency(c1) > 0);
  });

  test('quality capped at 0.95, never 1.0', () => {
    const q = predictQuality({ tier: 'tier1' }, { complexity: 0.9 });
    assert.ok(q <= 0.95 && q >= 0.4);
  });

  test('estimateCost per candidate price', () => {
    const cheap = { price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } };
    const priced = { price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } };
    assert.strictEqual(estimateCost(cheap, { estimatedInputTokens: 1000, complexity: 0.5 }), 0);
    const c = estimateCost(priced, { estimatedInputTokens: 1000, complexity: 0.5 });
    assert.ok(c > 0, 'priced candidate must produce non-zero cost');
    assert.strictEqual(typeof c, 'number');
  });
});

describe('Phase2-A Budget', () => {
  test('wouldBlockAll for paid-only + allowPaid=false', () => {
    const r = evaluateBudget({
      agentId: 'g', task: { complexity: 0.5, estimatedInputTokens: 1000 },
      candidates: [{ modelId: 'm2', provider: 'p2', paid: true, price: {} }],
      config: { budget: { allowPaid: false }, agent_bindings: {} },
    });
    assert.strictEqual(r.wouldBlockAll, true);
  });
});

describe('Phase2-A Decision Engine（Registry 参与 + 硬约束）', () => {
  test('only non-tool_use candidate → recommendation=null', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'Use the calculator tool' }], tools: [{ type: 'function' }] },
      agentId: 'generic', budget: TEST_CONFIG.budget,
      candidates: [{ modelId: 'm3', provider: 'p3', tier: 'tier3', paid: false, capability: ['chat'] }],
      protocol: 'chat',
    });
    assert.strictEqual(d.recommendation, null);
    assert.ok(d.ranked[0].blocked.includes('tool_use'));
  });

  test('vision task: only valid vision candidate recommended (paid ok when allowPaid)', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'describe' }] }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true },
      candidates: [
        { modelId: 'm3', provider: 'p3', tier: 'tier3', paid: false, capability: ['chat'], model: { price: {} } },
        { modelId: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat', 'vision'], model: { price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } } },
      ],
      protocol: 'chat',
    });
    assert.ok(d.recommendation, 'must recommend the vision model');
    assert.strictEqual(d.recommendation.modelId, 'm2');
    assert.ok(d.ranked.find((r) => r.modelId === 'm3').blocked.includes('vision'));
  });

  test('same modelId different provider: per-provider recommendation & cost', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'Explain X in detail, long context needed' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true },
      candidates: [
        { modelId: 'mx', provider: 'pA', tier: 'tier1', paid: false, capability: ['chat', 'tool_use', 'vision'], model: { price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } } },
        { modelId: 'mx', provider: 'pB', tier: 'tier2', paid: true, capability: ['chat'], model: { price: { input_cost_per_1k: 0.02, output_cost_per_1k: 0.04 } } },
      ],
      protocol: 'chat',
    });
    // 两候选独立评分
    assert.strictEqual(d.ranked.length, 2);
    const a = d.ranked.find((r) => r.provider === 'pA');
    const b = d.ranked.find((r) => r.provider === 'pB');
    assert.ok(a && b, 'both providers ranked separately');
    // 推荐应为免费 pA
    assert.strictEqual(d.recommendation.provider, 'pA');
    // 预测成本 = 推荐候选（pA 免费 → 0）
    assert.strictEqual(d.predictions.cost, 0);
  });

  test('cost prediction non-null when recommendation priced', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'Summarize a long document' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true, allowedModels: ['m2'] },
      candidates: [
        { modelId: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat', 'vision'], model: { price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } } },
      ],
      protocol: 'chat',
    });
    assert.ok(d.recommendation);
    assert.ok(typeof d.predictions.cost === 'number', 'priced recommendation must have numeric cost');
    assert.ok(d.predictions.cost > 0);
  });
});

describe('Phase2-A Explainability', () => {
  test('eliminated reasons include hard blocks', () => {
    const ex = explainDecision({
      recommendation: { modelId: 'm1', provider: 'p1', score: 0.9 },
      ranked: [
        { modelId: 'm1', provider: 'p1', score: 0.9 },
        { modelId: 'm3', provider: 'p3', score: 0, blocked: 'missing tool_use (required)' },
      ],
      predictions: { cost: 0, quality: 0.9, latency: 1200 },
    });
    assert.ok(ex.eliminated[0].reason.includes('tool_use'));
  });
});

describe('Phase2-A Shadow Recorder（脱敏 + 对照状态 + 持久化）', () => {
  test('sanitizeTaskProfile excludes lastUserText', () => {
    const sanitized = sanitizeTaskProfile({
      taskType: 'coding', complexity: 0.7, estimatedInputTokens: 100,
      lastUserText: 'SECRET PROMPT CONTENT', messageCount: 3, signals: ['coding'],
    });
    assert.ok(!('lastUserText' in sanitized), 'lastUserText must NOT be persisted');
    assert.strictEqual(sanitized.taskType, 'coding');
  });

  test('comparison statuses', () => {
    const sug = { recommendation: { modelId: 'm1', provider: 'p1' } };
    assert.strictEqual(computeComparisonStatus(sug, { outcome: 'completed', finalModel: 'm1', finalProvider: 'p1' }), 'exact_match');
    assert.strictEqual(computeComparisonStatus(sug, { outcome: 'completed', finalModel: 'm1', finalProvider: 'p9' }), 'model_match_provider_diff');
    assert.strictEqual(computeComparisonStatus(sug, { outcome: 'completed', finalModel: 'm9', finalProvider: 'p9' }), 'different');
    assert.strictEqual(computeComparisonStatus(null, { outcome: 'budget_exceeded' }), 'policy_agreement');
    assert.strictEqual(computeComparisonStatus(null, { outcome: 'no_candidate' }), 'policy_agreement');
    assert.strictEqual(computeComparisonStatus(sug, { outcome: 'client_aborted' }), 'not_comparable');
    assert.strictEqual(computeComparisonStatus(null, { outcome: 'internal_error' }), 'not_comparable');
  });

  test('persists suggestion + final via MemoryStore mirror', async () => {
    const store = new MemoryStore();
    await store.init();
    const rec = new ShadowRecorder({ enabled: true, store });
    await rec.recordSuggestion({
      requestId: 'r1', protocol: 'chat', agentId: 'g', requestedModel: 'auto',
      taskProfile: { taskType: 'coding', lastUserText: 'secret' },
      recommendation: { modelId: 'm1', provider: 'p1', score: 0.9 },
      ranked: [{ modelId: 'm1', score: 0.9 }],
      predictions: { cost: 0, quality: 0.9, latency: 1200 },
      explanation: { summary: 'x' },
    });
    await rec.recordFinalized({
      requestId: 'r1', outcome: 'completed', finalModel: 'm1', finalProvider: 'p1',
      attemptCount: 1,
      attempts: [{ transportOutcome: 'success', usage: { prompt_tokens: 5, completion_tokens: 3 }, cost: { totalCost: 0 }, latencyMs: 100 }],
    });
    const row = await rec.get('r1');
    assert.strictEqual(row.actualOutcome, 'completed');
    assert.strictEqual(row.actualFinalModel, 'm1');
    assert.strictEqual(row.comparisonStatus, 'exact_match');
    assert.ok(!('lastUserText' in row.taskProfile));
    // 持久化到 store
    const stored = await store.getShadowDecision('r1');
    assert.ok(stored);
    assert.strictEqual(stored.actualOutcome, 'completed');
  });
});

describe('Phase2-A IntelligenceLayer off/shadow', () => {
  test('off mode: suggest null, no records', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer({ intelligence: { mode: 'off' }, models: [], budget: {}, agent_bindings: {} }, store);
    assert.strictEqual(layer.isShadow(), false);
    const d = await layer.suggest({ requestId: 'r1', body: {}, agentId: 'g', budget: {}, candidates: [] });
    assert.strictEqual(d, null);
    await layer.recordFinalized({ requestId: 'r1', outcome: 'completed' });
    assert.strictEqual((await layer.getRecords()).length, 0);
    assert.strictEqual((await store.listShadowDecisions()).length, 0, 'off mode must not persist shadow rows');
  });

  test('shadow mode: suggest + recordFinalized produce complete row', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(TEST_CONFIG, store);
    const d = await layer.suggest({
      requestId: 'r1', body: { messages: [{ role: 'user', content: 'Write a JS function' }] },
      agentId: 'generic', budget: TEST_CONFIG.budget,
      candidates: [{ modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'tool_use'] }],
      protocol: 'chat',
    });
    assert.ok(d);
    await layer.recordFinalized({
      requestId: 'r1', outcome: 'completed', finalModel: 'm1', finalProvider: 'p1', attemptCount: 1,
      attempts: [{ transportOutcome: 'success', usage: { prompt_tokens: 1, completion_tokens: 1 }, cost: { totalCost: 0 }, latencyMs: 50 }],
    });
    const row = await store.getShadowDecision('r1');
    assert.ok(row);
    assert.strictEqual(row.actualOutcome, 'completed');
    assert.strictEqual(row.comparisonStatus, 'exact_match');
    assert.ok(row.createdAt <= row.finalizedAt);
  });

  test('attachTo finalizer observer (post-commit)', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(TEST_CONFIG, store);
    const { Finalizer } = await import('../../src/runtime/finalization.js');
    const { CostTracker } = await import('../../src/cost/tracker.js');
    const finalizer = new Finalizer(new CostTracker(TEST_CONFIG, store), store);
    layer.attachTo(finalizer);
    // 模拟：先 suggest（执行前），再 finalize（事务成功后观察者触发）
    await layer.suggest({
      requestId: 'r2', body: { messages: [{ role: 'user', content: 'hi' }] },
      agentId: 'g', budget: TEST_CONFIG.budget,
      candidates: [{ modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat'] }],
      protocol: 'chat',
    });
    const { AttemptLog } = await import('../../src/runtime/attempts.js');
    const { Outcome } = await import('../../src/runtime/outcomes.js');
    const al = new AttemptLog('r2');
    const att = al.add({ attemptNumber: 1, model: 'm1', provider: 'p1', keyId: 'k', transportOutcome: 'success', validatedOutcome: 'completed', latencyMs: 10, usage: { prompt_tokens: 1, completion_tokens: 1 }, cost: { totalCost: 0 }, timestamp: new Date().toISOString() });
    att.setUsage({ prompt_tokens: 1, completion_tokens: 1 }, { totalCost: 0 });
    await store.saveRequest({ requestId: 'r2', agentId: 'g', protocol: 'chat', model: 'm1', provider: 'p1', timestamp: new Date().toISOString() });
    const res = await finalizer.finalizeRequestTransaction('r2', al, Outcome.COMPLETED, { agentId: 'g', protocol: 'chat' });
    assert.ok(res.finalized);
    const row = await store.getShadowDecision('r2');
    assert.ok(row, 'observer must create shadow row after commit');
    assert.strictEqual(row.actualOutcome, 'completed');
    assert.strictEqual(row.comparisonStatus, 'exact_match');
  });

  test('observer failure does not affect finalize result', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(TEST_CONFIG, store);
    const { Finalizer } = await import('../../src/runtime/finalization.js');
    const { CostTracker } = await import('../../src/cost/tracker.js');
    const finalizer = new Finalizer(new CostTracker(TEST_CONFIG, store), store);
    // 注入抛异常的观察者
    finalizer.addObserver(async () => { throw new Error('observer boom'); });
    layer.attachTo(finalizer);
    const { AttemptLog } = await import('../../src/runtime/attempts.js');
    const { Outcome } = await import('../../src/runtime/outcomes.js');
    const al = new AttemptLog('r3');
    const att = al.add({ attemptNumber: 1, model: 'm1', provider: 'p1', keyId: 'k', transportOutcome: 'success', validatedOutcome: 'completed', latencyMs: 10, usage: { prompt_tokens: 1, completion_tokens: 1 }, timestamp: new Date().toISOString() });
    att.setUsage({ prompt_tokens: 1, completion_tokens: 1 }, { totalCost: 0 });
    await store.saveRequest({ requestId: 'r3', agentId: 'g', protocol: 'chat', model: 'm1', provider: 'p1', timestamp: new Date().toISOString() });
    const res = await finalizer.finalizeRequestTransaction('r3', al, Outcome.COMPLETED, { agentId: 'g', protocol: 'chat' });
    assert.ok(res.finalized, 'finalize must succeed despite observer error');
  });
});
