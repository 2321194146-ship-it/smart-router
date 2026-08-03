// test/unit/policy-toggle.test.js
// Smart Router Mainline - Phase 2-C
// Policy 配置真实生效：preferFree / tierPreference / 确定性 Tie-Breaker

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  normalizePolicy, scoreCandidate, pickBest,
} from '../../src/intelligence/policy.js';
import { DecisionEngine } from '../../src/intelligence/decision-engine.js';

const BUDGET = { allowPaid: true, allowedModels: [], allowedProviders: [], maxRequestCost: 100 };
const TASK = { requiredCapabilities: { chat: 1 }, hardCapabilities: [], complexity: 0.3 };

function cand(modelId, over = {}) {
  return {
    modelId, provider: 'p', tier: 'tier2', paid: false,
    capabilities: { chat: 1, coding: 0, reasoning: 0, tool_use: 0, vision: 0, structured_output: 0, long_context: 1, streaming: 0 },
    contextWindow: 100000, price: {}, reliability: 0.8, protocols: ['chat'],
    ...over,
  };
}

describe('Phase2-C Policy 配置真实生效', () => {
  test('C6 preferFree=true boosts free candidate vs preferFree=false', () => {
    const free = cand('free', { paid: false, tier: 'tier3', price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } });
    const paid = cand('paid', { paid: true, tier: 'tier1', price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 }, reliability: 0.9 });

    const pFree = normalizePolicy({ preferFree: true });
    const pNoPref = normalizePolicy({ preferFree: false });

    const rFree = scoreCandidate(free, TASK, pFree, BUDGET, 'chat');
    const rNoPref = scoreCandidate(free, TASK, pNoPref, BUDGET, 'chat');
    // preferFree=false 时免费模型不再享受免费成本提升 → 分数变化
    assert.notStrictEqual(rFree.score, rNoPref.score, 'preferFree toggle must change free candidate score');
  });

  test('C6 preferFree=false removes paidPenalty', () => {
    const paid = cand('paid', { paid: true, tier: 'tier1', price: { input_cost_per_1k: 0, output_cost_per_1k: 0 }, reliability: 0.9 });
    const pFree = normalizePolicy({ preferFree: true });
    const pNoPref = normalizePolicy({ preferFree: false });
    const withPenalty = scoreCandidate(paid, TASK, pFree, BUDGET, 'chat');
    const noPenalty = scoreCandidate(paid, TASK, pNoPref, BUDGET, 'chat');
    assert.ok(noPenalty.score >= withPenalty.score, 'preferFree=false must not penalize paid');
  });

  test('C6 tierPreference=false zeroes tier weight', () => {
    const t1 = cand('a', { tier: 'tier1' });
    const t3 = cand('b', { tier: 'tier3' });
    const pTier = normalizePolicy({ tierPreference: true });
    const pNoTier = normalizePolicy({ tierPreference: false });
    const gapOn = scoreCandidate(t1, TASK, pTier, BUDGET, 'chat').score - scoreCandidate(t3, TASK, pTier, BUDGET, 'chat').score;
    const gapOff = scoreCandidate(t1, TASK, pNoTier, BUDGET, 'chat').score - scoreCandidate(t3, TASK, pNoTier, BUDGET, 'chat').score;
    assert.ok(gapOn > 0, 'tier1 should outrank tier3 when tierPreference=true');
    assert.ok(gapOff < gapOn, 'tier gap must shrink when tierPreference=false');
  });

  test('C6 deterministic tie-breaker: score tie → capability → reliability → cost → latency → order', () => {
    // 同分 → capability
    const c1 = { score: 0.8, tiebreak: { capability: 0.5, reliability: 0.8, cost: 0.6, latency: 100, phase1Order: 0 } };
    const c2 = { score: 0.8, tiebreak: { capability: 0.9, reliability: 0.8, cost: 0.6, latency: 100, phase1Order: 1 } };
    assert.strictEqual(pickBest([c1, c2]).tiebreak.capability, 0.9, 'higher capability wins on tie');
    // 同 capability → reliability
    const r1 = { score: 0.8, tiebreak: { capability: 0.9, reliability: 0.5, cost: 0.6, latency: 100, phase1Order: 0 } };
    const r2 = { score: 0.8, tiebreak: { capability: 0.9, reliability: 0.95, cost: 0.6, latency: 100, phase1Order: 1 } };
    assert.strictEqual(pickBest([r1, r2]).tiebreak.reliability, 0.95, 'higher reliability wins on tie');
    // 全部相同 → phase1Order
    const d1 = { score: 0.8, tiebreak: { capability: 0.9, reliability: 0.8, cost: 0.6, latency: 100, phase1Order: 2 } };
    const d2 = { score: 0.8, tiebreak: { capability: 0.9, reliability: 0.8, cost: 0.6, latency: 100, phase1Order: 1 } };
    assert.strictEqual(pickBest([d1, d2]).tiebreak.phase1Order, 1, 'earlier Phase1 order wins final tie');
  });

  test('C6 pickBest skips blocked candidates', () => {
    const blocked = { score: 0, blocked: 'missing streaming (required)', tiebreak: {} };
    const good = { score: 0.7, tiebreak: { tier: 0.7 } };
    assert.strictEqual(pickBest([blocked, good]).score, 0.7);
    assert.strictEqual(pickBest([blocked]), null);
  });

  test('C6 decision engine honors tierPreference=false (tier no longer dominant)', () => {
    const config = {
      intelligence: { mode: 'shadow', shadow: { policy: { tierPreference: false, preferFree: true } } },
      models: [
        { id: 't1m', provider: 'p', tier: 'tier1', paid: false, capabilities: { chat: 100 }, context_window: 32000, reliability: 0.8 },
        { id: 't3m', provider: 'p', tier: 'tier3', paid: false, capabilities: { chat: 100, coding: 100, reasoning: 100 }, context_window: 32000, reliability: 0.95 },
      ],
      budget: { allowPaid: true },
      agent_bindings: {},
    };
    const engine = new DecisionEngine(config);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'Hello there' }] },
      agentId: 'generic',
      budget: { allowPaid: true },
      candidates: [
        { modelId: 't1m', provider: 'p', tier: 'tier1', paid: false, capability: ['chat'] },
        { modelId: 't3m', provider: 'p', tier: 'tier3', paid: false, capability: ['chat', 'coding', 'reasoning'] },
      ],
      protocol: 'chat',
    });
    // 简单聊天：tier3 能力更全（coding/reasoning 也满分）应胜出或至少不被 tier 压制
    assert.ok(d.recommendation, 'must recommend');
    assert.strictEqual(d.recommendation.modelId, 't3m', 'tierPreference=false must let capability win over tier');
  });
});
