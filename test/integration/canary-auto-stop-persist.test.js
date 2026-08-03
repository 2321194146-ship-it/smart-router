// test/integration/canary-auto-stop-persist.test.js
// Smart Router Mainline - Phase 2-C (5% Live Pilot)
// 自动停止状态必须立即持久化（SQLite app_state），重启后仍保持 stopped，不得恢复采样。
// 覆盖：
//   - incomplete_rise（连续 3 个实际 Active incomplete）
//   - consecutive_provider_errors（连续 3 个 Active provider_error）
//   - first_byte_switch（首字节后切换 1 次）
//   - budget_violation（apply 阶段预算防御停止 → suggest 返回前自动持久化）

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntelligenceLayer } from '../../src/intelligence/index.js';
import { SQLiteStore } from '../../src/storage/sqlite-store.js';

const AC_CONFIG = {
  intelligence: {
    mode: 'active_canary',
    activeCanary: {
      percentage: 100,
      allowedAgents: ['claude-code'],
      allowedProtocols: ['anthropic'],
      allowedTaskTypes: ['general_chat', 'writing'],
    },
    shadow: { retentionDays: 30 },
  },
  models: [
    { id: 'm1', provider: 'p1', tier: 'tier1', paid: false, capabilities: { chat: 100, streaming: 100 }, context_window: 32000 },
    { id: 'm2', provider: 'p2', tier: 'tier2', paid: false, capabilities: { chat: 100, reasoning: 100, streaming: 100 }, context_window: 64000 },
  ],
  budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
  agent_bindings: {},
};

const LOW_RISK_BODY = { messages: [{ role: 'user', content: 'Explain the water cycle in simple terms.' }] };
const LOW_RISK_CAND = [{ modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'streaming'] }];

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'canary-autostop-'));
  const dbPath = join(dir, 'smart-router.db');
  return { dir, dbPath };
}

async function suggest(layer, requestId) {
  return layer.suggest({
    requestId,
    body: LOW_RISK_BODY,
    agentId: 'claude-code',
    budget: AC_CONFIG.budget,
    candidates: LOW_RISK_CAND,
    protocol: 'anthropic',
  });
}

describe('Phase2-C 自动停止立即持久化（5% Live Pilot）', () => {
  test('L2 incomplete_rise: 3 Active incomplete → auto-stop persisted → restart keeps stopped', async () => {
    const { dir, dbPath } = makeStore();
    try {
      const store = new SQLiteStore(dbPath);
      await store.init();
      const layer = new IntelligenceLayer(AC_CONFIG, { store });
      for (let i = 0; i < 3; i++) {
        const d = await suggest(layer, 'inc-' + i);
        assert.strictEqual(d.canary.active, true, 'must be Active: ' + d.canary.reason);
        await layer.recordFinalized({
          requestId: 'inc-' + i, outcome: 'incomplete', attempts: [{}, {}], latencyMs: 5, cost: 0,
        });
      }
      assert.strictEqual(layer.status().canary.stopped, true);
      assert.strictEqual(layer.status().canary.autoStop.reason, 'incomplete_rise');
      const killedRaw = await store.getAppState('canary.killed');
      assert.ok(killedRaw, 'canary.killed must be persisted');
      assert.strictEqual(JSON.parse(killedRaw).reason, 'incomplete_rise');
      await store.close();

      // 重启：同一数据库
      const store2 = new SQLiteStore(dbPath);
      await store2.init();
      const layer2 = new IntelligenceLayer(AC_CONFIG, { store: store2 });
      await layer2.restoreCanaryState();
      assert.strictEqual(layer2.status().canary.stopped, true, 'restart must keep stopped');
      assert.strictEqual(layer2.status().canary.autoStop.reason, 'incomplete_rise');
      // 不得恢复 5% 采样
      const d2 = await suggest(layer2, 'post-restart');
      assert.strictEqual(d2.canary.active, false);
      assert.strictEqual(d2.canary.reason, 'killed');
      await store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('L2 consecutive_provider_errors: 3 Active provider_error → auto-stop persisted → restart keeps stopped', async () => {
    const { dir, dbPath } = makeStore();
    try {
      const store = new SQLiteStore(dbPath);
      await store.init();
      const layer = new IntelligenceLayer(AC_CONFIG, { store });
      for (let i = 0; i < 3; i++) {
        const d = await suggest(layer, 'pe-' + i);
        assert.strictEqual(d.canary.active, true, 'must be Active: ' + d.canary.reason);
        await layer.recordFinalized({ requestId: 'pe-' + i, outcome: 'provider_error', attempts: [{}], latencyMs: 5, cost: 0 });
      }
      assert.strictEqual(layer.status().canary.autoStop.reason, 'consecutive_provider_errors');
      const killedRaw = await store.getAppState('canary.killed');
      assert.ok(killedRaw);
      assert.strictEqual(JSON.parse(killedRaw).reason, 'consecutive_provider_errors');
      await store.close();

      const store2 = new SQLiteStore(dbPath);
      await store2.init();
      const layer2 = new IntelligenceLayer(AC_CONFIG, { store: store2 });
      await layer2.restoreCanaryState();
      assert.strictEqual(layer2.status().canary.stopped, true, 'restart must keep stopped');
      const d2 = await suggest(layer2, 'post-restart');
      assert.strictEqual(d2.canary.reason, 'killed', 'must not resume sampling');
      await store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('L2 first_byte_switch: single Active first-byte switch → auto-stop persisted → restart keeps stopped', async () => {
    const { dir, dbPath } = makeStore();
    try {
      const store = new SQLiteStore(dbPath);
      await store.init();
      const layer = new IntelligenceLayer(AC_CONFIG, { store });
      const d = await suggest(layer, 'fbs-1');
      assert.strictEqual(d.canary.active, true, 'must be Active: ' + d.canary.reason);
      await layer.recordFinalized({
        requestId: 'fbs-1', outcome: 'provider_error',
        attempts: [
          { attemptNumber: 1, firstByteSentToClient: true },
          { attemptNumber: 2, firstByteSentToClient: false },
        ],
        latencyMs: 5, cost: 0,
      });
      assert.strictEqual(layer.status().canary.autoStop.reason, 'first_byte_switch');
      const killedRaw = await store.getAppState('canary.killed');
      assert.ok(killedRaw);
      assert.strictEqual(JSON.parse(killedRaw).reason, 'first_byte_switch');
      await store.close();

      const store2 = new SQLiteStore(dbPath);
      await store2.init();
      const layer2 = new IntelligenceLayer(AC_CONFIG, { store: store2 });
      await layer2.restoreCanaryState();
      assert.strictEqual(layer2.status().canary.stopped, true);
      const d2 = await suggest(layer2, 'post-restart');
      assert.strictEqual(d2.canary.reason, 'killed');
      await store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('L2 budget_violation (apply defense) → suggest persists before return → restart keeps stopped', async () => {
    const { dir, dbPath } = makeStore();
    try {
      const store = new SQLiteStore(dbPath);
      await store.init();
      const layer = new IntelligenceLayer(AC_CONFIG, { store });
      // 直接触发 Canary 预算防御停止（DecisionEngine 前置拦截之外的最后防线）
      const d0 = {
        ranked: [{ modelId: 'm1', provider: 'p1', blocked: null, paid: true, estimatedCost: 5.0 }],
        recommendation: { modelId: 'm1', provider: 'p1' },
        task: { taskType: 'general_chat', complexity: 0.2 },
      };
      const applied = layer.canary.apply({
        decision: d0,
        candidates: [{ modelId: 'm1', provider: 'p1', tier: 'tier1', paid: true, capability: ['chat'] }],
        requestId: 'bv-1', agentId: 'claude-code', taskType: 'general_chat',
        task: { taskType: 'general_chat', complexity: 0.2 },
        protocol: 'anthropic',
        budget: { allowPaid: false, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
      });
      assert.strictEqual(applied.reason, 'budget_violation');
      assert.strictEqual(layer.status().canary.stopped, true);
      // suggest() 返回前必须自动持久化（apply 阶段停止）
      const d = await suggest(layer, 'post-bv');
      assert.ok(d, 'suggest must still return normally');
      const killedRaw = await store.getAppState('canary.killed');
      assert.ok(killedRaw, 'budget_violation must be persisted by suggest');
      assert.strictEqual(JSON.parse(killedRaw).reason, 'budget_violation');
      await store.close();

      const store2 = new SQLiteStore(dbPath);
      await store2.init();
      const layer2 = new IntelligenceLayer(AC_CONFIG, { store: store2 });
      await layer2.restoreCanaryState();
      assert.strictEqual(layer2.status().canary.stopped, true, 'restart must keep stopped');
      assert.strictEqual(layer2.status().canary.autoStop.reason, 'budget_violation');
      const d2 = await suggest(layer2, 'post-restart');
      assert.strictEqual(d2.canary.reason, 'killed');
      await store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
