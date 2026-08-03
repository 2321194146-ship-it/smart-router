// test/unit/canary-controller.test.js
// Smart Router Mainline - Phase 2-C
// Active Canary 控制器：确定性采样 / 重排安全 / Fail Open / Kill Switch / 自动停止

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { CanaryController } from '../../src/intelligence/canary-controller.js';
import { IntelligenceLayer } from '../../src/intelligence/index.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

function candidates(ids) {
  return ids.map((id, i) => ({ modelId: id, provider: 'p', tier: 'tier' + (i + 1), paid: false, capability: ['chat'] }));
}

function decision(rankedIds, recId) {
  return {
    ranked: rankedIds.map((id) => ({ modelId: id, provider: 'p', blocked: null })),
    recommendation: recId ? { modelId: recId, provider: 'p' } : null,
    task: { taskType: 'general_chat' },
  };
}

describe('Phase2-C Active Canary 控制器', () => {
  test('C8 deterministic sampling: same requestId → same result, no Math.random', () => {
    const cc = new CanaryController({ percentage: 50 }, true);
    const r1 = cc.apply({ decision: decision(['a', 'b'], 'b'), candidates: candidates(['a', 'b']), requestId: 'req-abc', agentId: 'agent-x', taskType: 'general_chat', protocol: 'chat' });
    const r2 = cc.apply({ decision: decision(['a', 'b'], 'b'), candidates: candidates(['a', 'b']), requestId: 'req-abc', agentId: 'agent-x', taskType: 'general_chat', protocol: 'chat' });
    assert.deepStrictEqual(r1, r2, 'same requestId must sample identically');
    assert.ok([true, false].includes(r1.active));
  });

  test('C8 percentage=0 never samples; percentage=100 always samples', () => {
    const off = new CanaryController({ percentage: 0 }, true);
    const on = new CanaryController({ percentage: 100 }, true);
    const args = { decision: decision(['a', 'b'], 'b'), candidates: candidates(['a', 'b']), requestId: 'req-1', agentId: 'agent-x', taskType: 'general_chat', protocol: 'chat' };
    assert.strictEqual(off.apply(args).active, false);
    assert.strictEqual(off.apply(args).reason, 'not_sampled');
    assert.strictEqual(on.apply(args).active, true);
  });

  test('C8 allowedAgents filters', () => {
    const cc = new CanaryController({ percentage: 100, allowedAgents: ['test-agent-1'] }, true);
    const args = { decision: decision(['a', 'b'], 'b'), candidates: candidates(['a', 'b']), requestId: 'req-1', taskType: 'general_chat', protocol: 'chat' };
    assert.strictEqual(cc.apply({ ...args, agentId: 'other' }).reason, 'agent_not_allowed');
    assert.strictEqual(cc.apply({ ...args, agentId: 'test-agent-1' }).active, true);
  });

  test('C8 allowedTaskTypes filters', () => {
    const cc = new CanaryController({ percentage: 100, allowedTaskTypes: ['writing'] }, true);
    const args = { decision: decision(['a', 'b'], 'b'), candidates: candidates(['a', 'b']), requestId: 'req-1', agentId: 'test-agent-1', protocol: 'chat' };
    assert.strictEqual(cc.apply({ ...args, taskType: 'coding' }).reason, 'task_type_not_allowed');
    assert.strictEqual(cc.apply({ ...args, taskType: 'writing' }).active, true);
  });

  test('C8 reorder puts primary first, keeps others in Phase1 order (stable)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const args = { decision: decision(['a', 'b', 'c'], 'c'), candidates: candidates(['a', 'b', 'c']), requestId: 'req-1', agentId: 'x', taskType: 'general_chat', protocol: 'chat' };
    const r = cc.apply(args);
    assert.strictEqual(r.active, true);
    assert.strictEqual(r.orderedCandidates[0].modelId, 'c', 'primary must move to front');
    assert.deepStrictEqual(r.orderedCandidates.map((x) => x.modelId), ['c', 'a', 'b'], 'rest keep Phase1 order');
  });

  test('C8 fail open on exception returns original candidates', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const bad = { decision: null, candidates: null, requestId: 'req-1', agentId: 'x', taskType: 'general_chat', protocol: 'chat' };
    const r = cc.apply(bad);
    assert.strictEqual(r.active, false);
    assert.deepStrictEqual(r.orderedCandidates, []);
    assert.ok(r.reason.startsWith('exception') || r.reason === 'no_legal_candidate');
  });

  test('C8 kill switch stops sampling immediately', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    cc.stop('kill_switch');
    const args = { decision: decision(['a', 'b'], 'b'), candidates: candidates(['a', 'b']), requestId: 'req-1', agentId: 'x', taskType: 'general_chat', protocol: 'chat' };
    const r = cc.apply(args);
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'killed');
    assert.strictEqual(cc.metrics.autoStop.reason, 'kill_switch');
  });

  test('C8 budget violation triggers auto-stop (fail safe to Phase1)', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    const paidCand = [{ modelId: 'paid', provider: 'p', tier: 'tier1', paid: true, capability: ['chat'] }];
    const d = { ranked: [{ modelId: 'paid', provider: 'p', blocked: null, paid: true }], recommendation: { modelId: 'paid', provider: 'p', paid: true }, task: { taskType: 'general_chat' } };
    const r = cc.apply({ decision: d, candidates: paidCand, requestId: 'req-1', agentId: 'x', taskType: 'general_chat', protocol: 'chat', budget: { allowPaid: false } });
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.reason, 'budget_violation');
    assert.ok(cc.stopped, 'auto-stop must trigger');
    assert.strictEqual(cc.metrics.autoStop.reason, 'budget_violation');
  });

  test('C8 metrics accumulate via recordFinalized; incomplete rise auto-stops', () => {
    const cc = new CanaryController({ percentage: 100 }, true);
    for (let i = 0; i < 3; i++) {
      cc.recordFinalized({ requestId: 'r' + i, outcome: 'incomplete', attempts: [{}, {}], latencyMs: 10 });
    }
    assert.strictEqual(cc.metrics.incomplete, 3);
    assert.strictEqual(cc.metrics.attempts, 6);
    assert.ok(cc.stopped, 'incomplete_rise must auto-stop');
    assert.strictEqual(cc.metrics.autoStop.reason, 'incomplete_rise');
  });

  test('C8 disabled controller (shadow mode) never samples', () => {
    const cc = new CanaryController({ percentage: 100 }, false);
    const args = { decision: decision(['a', 'b'], 'b'), candidates: candidates(['a', 'b']), requestId: 'req-1', agentId: 'x', taskType: 'general_chat', protocol: 'chat' };
    assert.strictEqual(cc.apply(args).active, false);
    assert.strictEqual(cc.apply(args).reason, 'disabled');
  });

  test('C8 default allowed task types include low-risk types only', () => {
    const cc = new CanaryController({}, true);
    assert.ok(cc.allowedTaskTypes.includes('general_chat'));
    assert.ok(!cc.allowedTaskTypes.includes('coding'));
    assert.ok(!cc.allowedTaskTypes.includes('vision'));
    assert.ok(!cc.allowedTaskTypes.includes('tool_orchestration'));
  });
});

describe('Phase2-C IntelligenceLayer Canary 集成', () => {
  const AC_CONFIG = {
    intelligence: {
      mode: 'active_canary',
      activeCanary: { percentage: 100, allowedAgents: ['test-agent-1'], allowedTaskTypes: ['general_chat'] },
      shadow: { retentionDays: 30 },
    },
    models: [
      { id: 'm1', provider: 'p1', tier: 'tier1', paid: false, capabilities: { chat: 100 }, context_window: 32000 },
      { id: 'm2', provider: 'p2', tier: 'tier2', paid: false, capabilities: { chat: 100, reasoning: 100 }, context_window: 32000 },
    ],
    budget: { allowPaid: true },
    agent_bindings: {},
  };

  test('C8 active_canary mode: suggest returns canary orderedCandidates', async () => {
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
      agentId: 'test-agent-1', budget: AC_CONFIG.budget, candidates: cands, protocol: 'chat',
    });
    assert.ok(d, 'suggest must return decision');
    assert.ok(d.canary, 'canary field must exist');
    assert.strictEqual(d.canary.active, true, 'percentage=100 + allowed agent/task must sample');
    assert.ok(Array.isArray(d.canary.orderedCandidates));
    assert.strictEqual(d.canary.orderedCandidates.length, 2);
  });

  test('C8 shadow mode: canary disabled, no canary reorder', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer({ ...AC_CONFIG, intelligence: { mode: 'shadow', shadow: {} } }, { store });
    assert.strictEqual(layer.mode, 'shadow');
    const d = await layer.suggest({
      requestId: 'shadow-1', body: { messages: [{ role: 'user', content: 'Hello' }] },
      agentId: 'test-agent-1', budget: AC_CONFIG.budget, candidates: [{ modelId: 'm1', provider: 'p1', paid: false, capability: ['chat'] }], protocol: 'chat',
    });
    assert.ok(d);
    assert.ok(!d.canary || d.canary.active === false);
  });

  test('C8 killCanary stops sampling without code change', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(AC_CONFIG, { store });
    const st = layer.killCanary();
    assert.strictEqual(st.canary.stopped, true);
    assert.strictEqual(st.canary.autoStop.reason, 'kill_switch');
    const d = await layer.suggest({
      requestId: 'canary-2', body: { messages: [{ role: 'user', content: 'Hello' }] },
      agentId: 'test-agent-1', budget: AC_CONFIG.budget, candidates: [{ modelId: 'm1', provider: 'p1', paid: false, capability: ['chat'] }], protocol: 'chat',
    });
    assert.ok(d.canary.active === false, 'after kill, no sampling');
  });

  test('C8 off mode: suggest null, canary untouched', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer({ intelligence: { mode: 'off' }, models: [], budget: {}, agent_bindings: {} }, { store });
    assert.strictEqual(layer.mode, 'off');
    assert.strictEqual(await layer.suggest({ requestId: 'x', body: {}, agentId: 'g', budget: {}, candidates: [] }), null);
    assert.strictEqual(layer.status().canary.stopped, false);
  });
});
