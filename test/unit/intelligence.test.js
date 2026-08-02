// test/unit/intelligence.test.js
// Smart Router Mainline - Phase 2-A (Shadow)
// 智能层单元测试：Task Analyzer / Capability Registry / Policy / Budget /
// Decision Engine / Explainability / Shadow Recorder / off-shadow 模式

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { analyzeTask, TaskType } from '../../src/intelligence/task-analyzer.js';
import { CapabilityRegistry, hasCapability } from '../../src/intelligence/capability-registry.js';
import { normalizePolicy, scoreCandidate, estimateCost, predictQuality, predictLatency } from '../../src/intelligence/policy.js';
import { evaluateBudget } from '../../src/intelligence/budget.js';
import { DecisionEngine } from '../../src/intelligence/decision-engine.js';
import { explainDecision } from '../../src/intelligence/explainability.js';
import { ShadowRecorder } from '../../src/intelligence/shadow-recorder.js';
import { IntelligenceLayer } from '../../src/intelligence/index.js';

const TEST_CONFIG = {
  intelligence: { mode: 'shadow' },
  models: [
    { id: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'tool_use', 'streaming'], max_tokens: 64000 },
    { id: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat', 'vision'], price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } },
    { id: 'm3', provider: 'p3', tier: 'tier3', paid: false, capability: ['chat'], max_tokens: 16000 },
  ],
  budget: { allowPaid: false, maxRequestCost: 10, allowedModels: [], allowedProviders: [], strictModel: false },
  agent_bindings: {},
};

describe('Phase2-A Task Analyzer', () => {
  test('coding task detection', () => {
    const t = analyzeTask({ model: 'auto', messages: [{ role: 'user', content: 'Write a function to sort an array in JavaScript' }] });
    assert.strictEqual(t.taskType, TaskType.CODING);
    assert.ok(t.codeRelated);
    assert.strictEqual(t.needsToolUse, false);
  });

  test('tool orchestration detection', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'What is 2+3? Use the calculator tool.' }],
      tools: [{ type: 'function', function: { name: 'calculator' } }],
    });
    assert.strictEqual(t.taskType, TaskType.TOOL_ORCHESTRATION);
    assert.ok(t.needsToolUse);
  });

  test('vision detection via image block', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'describe this' }] }],
    });
    assert.strictEqual(t.taskType, TaskType.VISION);
    assert.ok(t.needsVision);
  });

  test('responses format input string', () => {
    const t = analyzeTask({ model: 'auto', input: 'Explain why the sky is blue' });
    assert.strictEqual(t.taskType, TaskType.ANALYSIS);
  });

  test('complexity bounds 0-1', () => {
    const t = analyzeTask({ messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(t.complexity >= 0 && t.complexity <= 1);
    assert.ok(t.estimatedInputTokens >= 1);
  });
});

describe('Phase2-A Capability Registry', () => {
  const reg = new CapabilityRegistry(TEST_CONFIG);

  test('query by model id (multi-provider)', () => {
    assert.strictEqual(reg.getByModelId('m1').length, 1);
    assert.strictEqual(reg.getByModelId('nope').length, 0);
  });

  test('supports capability', () => {
    assert.ok(reg.supports('m1', 'tool_use'));
    assert.ok(reg.supports('m2', 'vision'));
    assert.ok(!reg.supports('m3', 'tool_use'));
    assert.ok(reg.supports('m1', null));
  });

  test('summarize', () => {
    const s = reg.summarize('m2');
    assert.ok(s.capabilities.includes('vision'));
    assert.strictEqual(s.paid, true);
    assert.ok(s.providers.includes('p2'));
  });

  test('match filters by task capability + paid', () => {
    const matches = reg.match({ needsToolUse: true }, { allowPaid: false });
    assert.ok(matches.every((m) => m.capability.includes('tool_use')));
    assert.ok(matches.every((m) => !m.paid));
    assert.ok(matches.some((m) => m.modelId === 'm1'));
  });

  test('hasCapability helper', () => {
    assert.ok(hasCapability({ capability: ['chat', 'vision'] }, 'VISION'));
    assert.ok(!hasCapability({ capability: ['chat'] }, 'tool_use'));
  });
});

describe('Phase2-A Policy', () => {
  const policy = normalizePolicy(TEST_CONFIG.intelligence.shadow?.policy);

  test('normalizePolicy defaults', () => {
    const p = normalizePolicy(null);
    assert.strictEqual(p.tierPreference, true);
    assert.strictEqual(p.preferFree, true);
  });

  test('paid blocked when allowPaid=false', () => {
    const r = scoreCandidate(
      { modelId: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat'], price: {} },
      { complexity: 0.5, estimatedInputTokens: 1000 },
      policy,
      { allowPaid: false, allowedModels: [], allowedProviders: [], maxRequestCost: 10 },
    );
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('allowPaid=false'));
  });

  test('allowedModels block', () => {
    const r = scoreCandidate(
      { modelId: 'm3', provider: 'p3', tier: 'tier3', paid: false, capability: ['chat'] },
      { complexity: 0.3, estimatedInputTokens: 500 },
      policy,
      { allowPaid: true, allowedModels: ['m1'], allowedProviders: [], maxRequestCost: 10 },
    );
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('allowedModels'));
  });

  test('free + tier1 scores higher than paid + tier2', () => {
    const free = scoreCandidate(
      { modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat'], price: {} },
      { needsToolUse: false, complexity: 0.3, estimatedInputTokens: 500 },
      policy,
      { allowPaid: true, allowedModels: [], allowedProviders: [], maxRequestCost: 10 },
    );
    const paid = scoreCandidate(
      { modelId: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat'], price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } },
      { needsToolUse: false, complexity: 0.3, estimatedInputTokens: 500 },
      policy,
      { allowPaid: true, allowedModels: [], allowedProviders: [], maxRequestCost: 10 },
    );
    assert.ok(free.score > paid.score, `free=${free.score} should exceed paid=${paid.score}`);
  });

  test('predictions bounded', () => {
    const q = predictQuality({ tier: 'tier1' }, { complexity: 0.5 });
    const l = predictLatency({ tier: 'tier1' });
    assert.ok(q >= 0 && q <= 1);
    assert.ok(l > 0);
  });
});

describe('Phase2-A Budget', () => {
  test('wouldBlockAll when only paid candidates and allowPaid=false', () => {
    const r = evaluateBudget({
      agentId: 'generic',
      task: { complexity: 0.5, estimatedInputTokens: 1000 },
      candidates: [
        { modelId: 'm2', provider: 'p2', paid: true, price: {} },
      ],
      config: { budget: { allowPaid: false }, agent_bindings: {} },
    });
    assert.strictEqual(r.wouldBlockAll, true);
    assert.ok(r.reasons.some((x) => x.includes('allowPaid=false')));
  });

  test('estimatedCost from priced candidates', () => {
    const r = evaluateBudget({
      agentId: 'generic',
      task: { complexity: 0.5, estimatedInputTokens: 1000 },
      candidates: [
        { modelId: 'm2', provider: 'p2', paid: true, price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } },
      ],
      config: { budget: { allowPaid: true }, agent_bindings: {} },
    });
    assert.ok(r.estimatedCost > 0);
  });

  test('agent budget overrides global', () => {
    const r = evaluateBudget({
      agentId: 'claude-code',
      task: { complexity: 0.3, estimatedInputTokens: 100 },
      candidates: [{ modelId: 'm1', provider: 'p1', paid: false, price: {} }],
      config: {
        budget: { allowPaid: true },
        agent_bindings: { 'claude-code': { budget: { allowPaid: false } } },
      },
    });
    assert.strictEqual(r.allowPaid, false);
  });
});

describe('Phase2-A Decision Engine', () => {
  test('produces recommendation + ranked + predictions + explanation', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { model: 'auto', messages: [{ role: 'user', content: 'Write a quick function in JS' }] },
      agentId: 'generic',
      budget: TEST_CONFIG.budget,
      candidates: [
        { modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'tool_use'], model: { price: {} } },
        { modelId: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat', 'vision'], model: { price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } } },
        { modelId: 'm3', provider: 'p3', tier: 'tier3', paid: false, capability: ['chat'], model: { price: {} } },
      ],
      protocol: 'chat',
    });
    assert.strictEqual(d.mode, 'shadow');
    assert.ok(d.task);
    assert.ok(d.recommendation);
    assert.strictEqual(d.ranked.length, 3);
    assert.ok(d.predictions.quality !== null);
    assert.ok(d.explanation.summary.length > 0);
    // 推荐应为 free + 能力匹配的 m1
    assert.strictEqual(d.recommendation.modelId, 'm1');
  });

  test('no recommendation when all blocked', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: false, allowedModels: ['nope'] },
      candidates: [{ modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat'], model: { price: {} } }],
      protocol: 'chat',
    });
    assert.strictEqual(d.recommendation, null);
    assert.ok(d.ranked[0].blocked);
  });
});

describe('Phase2-A Explainability', () => {
  test('explainDecision produces eliminated reasons', () => {
    const ex = explainDecision({
      recommendation: { modelId: 'm1', provider: 'p1', score: 0.9 },
      ranked: [
        { modelId: 'm1', provider: 'p1', score: 0.9, reasons: ['tier=tier1'] },
        { modelId: 'm3', provider: 'p3', score: 0.4, blocked: 'missing tool_use (required)' },
      ],
      predictions: { cost: 0, quality: 0.9, latency: 1200 },
    });
    assert.ok(ex.summary.includes('推荐 p1/m1'));
    assert.ok(ex.summary.includes('淘汰 1 个候选'));
    assert.strictEqual(ex.eliminated.length, 1);
    assert.ok(ex.eliminated[0].reason.includes('tool_use'));
  });
});

describe('Phase2-A Shadow Recorder', () => {
  test('records and summarizes comparison', () => {
    const rec = new ShadowRecorder({ enabled: true });
    rec.record({
      requestId: 'r1', protocol: 'chat', agentId: 'generic',
      intelligence: { recommendation: { modelId: 'm1', score: 0.9 }, predictions: { cost: 0, latency: 1000 } },
    });
    rec.recordTraditional('r1', { finalModel: 'm1', finalProvider: 'p1', outcome: 'completed', latencyMs: 800 });
    const s = rec.summarizeComparison();
    assert.strictEqual(s.total, 1);
    assert.strictEqual(s.agree, 1);
    assert.strictEqual(s.comparison[0].suggested, 'm1');
    assert.strictEqual(s.comparison[0].real, 'p1/m1');
  });

  test('disabled recorder ignores', () => {
    const rec = new ShadowRecorder({ enabled: false });
    rec.record({ requestId: 'x', intelligence: {} });
    assert.strictEqual(rec.size, 0);
  });
});

describe('Phase2-A IntelligenceLayer off/shadow', () => {
  test('off mode: suggest returns null, no records', () => {
    const layer = new IntelligenceLayer({ intelligence: { mode: 'off' }, models: [], budget: {}, agent_bindings: {} });
    assert.strictEqual(layer.isShadow(), false);
    const d = layer.suggest({ requestId: 'r1', body: {}, agentId: 'g', budget: {}, candidates: [] });
    assert.strictEqual(d, null);
    layer.recordTraditional('r1', {});
    assert.strictEqual(layer.getRecords().length, 0);
    assert.strictEqual(layer.status().mode, 'off');
  });

  test('shadow mode: suggest returns decision and records', () => {
    const layer = new IntelligenceLayer(TEST_CONFIG);
    assert.strictEqual(layer.isShadow(), true);
    const d = layer.suggest({
      requestId: 'r1', body: { messages: [{ role: 'user', content: 'hi' }] },
      agentId: 'generic', budget: TEST_CONFIG.budget,
      candidates: [{ modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat'] }],
      protocol: 'chat',
    });
    assert.ok(d);
    layer.recordTraditional('r1', { finalModel: 'm1', finalProvider: 'p1', outcome: 'completed' });
    assert.strictEqual(layer.getRecords().length, 1);
    const comp = layer.getComparison();
    assert.strictEqual(comp.total, 1);
  });
});
