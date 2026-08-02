// test/integration/shadow-sealed.test.js
// Smart Router Mainline - Phase 2-A (Shadow) Sealed
// 回归测试：
//   1. Anthropic 流式异常 EOF → actualOutcome=incomplete（与 SQLite Audit 一致，不得记 completed）
//   2. Chat 客户端取消 → actualOutcome=client_aborted（不得记 completed）
//   3. no_candidate → Shadow 记录存在 + policy_agreement
//   4. budget_exceeded → Shadow 记录存在 + policy_agreement + 拒绝原因
//   5. 持久化重启：重启后 Shadow 记录仍存在，建议与最终结果均完整

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import {
  createMockProvider,
  writeConfig,
  startSmartRouter,
  stopSmartRouter,
  httpRequest,
  httpStreamRequest,
  sleep,
} from './helpers.js';

function buildConfig(mockPort, dataDir, overrides = {}) {
  const config = {
    server: { port: 28789, host: '127.0.0.1', data_dir: dataDir, request_timeout_ms: 30000 },
    data_dir: dataDir,
    intelligence: {
      mode: 'shadow',
      shadow: { policy: { tierPreference: true, preferFree: true }, retentionDays: 30 },
    },
    routing: {
      strategy: 'tier_weighted',
      tier_weights: { tier1: 10, tier2: 5 },
      max_concurrent: 16, max_retries: 3, retry_backoff_ms: 100,
      cooldown_default_sec: 60, health_check_interval_sec: 999999, failover_on_error: true,
    },
    budget: { allowPaid: false, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
    providers: [
      { name: 'mock-a', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k-a', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
    ],
    models: [
      { id: 'test-model-a', tier: 'tier1', provider: 'mock-a', apiModel: 'test-model-a', enabled: true, paid: false, capability: ['chat', 'tool_use', 'streaming'], max_tokens: 64000, price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' } },
      { id: 'test-model-paid', tier: 'tier2', provider: 'mock-a', apiModel: 'test-model-paid', enabled: true, paid: true, capability: ['chat'], price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02, currency: 'USD' } },
    ],
    agent_bindings: {},
    circuit_breaker: { enabled: false, failure_threshold: 100, failure_window_sec: 60, open_state_sec: 120, half_open_max_calls: 2, key_disable_on_auth_invalid: true },
  };
  if (overrides.budget) config.budget = { ...config.budget, ...overrides.budget };
  if (overrides.models) config.models = overrides.models(config.models);
  return config;
}

// 发送流式请求并在收到部分数据后主动断开（真实客户端取消）
function httpStreamAndAbort(port, path, payload, headers = {}, abortAfterMs = 400) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
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

describe('Phase2-A Shadow Sealed 回归', () => {
  let mockProvider, mockPort;

  before(async () => {
    mockProvider = createMockProvider();
    await mockProvider.listen();
    mockPort = mockProvider.port;
  });

  after(async () => {
    if (mockProvider) await mockProvider.close();
  });

  test('1. Anthropic stream EOF → actualOutcome=incomplete, matches SQLite Audit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-sealed-eof-'));
    // 上游流式响应在发送内容后异常断开（无 [DONE]）
    mockProvider.setDefaultResponse({
      status: 200,
      stream: true,
      events: [
        { id: 'c1', object: 'chat.completion.chunk', model: 'test-model-a', choices: [{ index: 0, delta: { content: 'PARTIAL_' }, finish_reason: null }] },
      ],
      sendDone: false,
      endAfterStream: false, // socket destroy → EOF
    });
    const config = buildConfig(mockPort, dataDir);
    const configPath = writeConfig(config, dataDir);
    const router = await startSmartRouter(configPath);
    await sleep(200);
    try {
      await httpStreamRequest(router.port, '/v1/messages', {
        body: { model: 'test-model-a', stream: true, messages: [{ role: 'user', content: 'Explain something long' }], max_tokens: 128 },
      });
      await sleep(300);

      const layer = router.server._components.intelligence;
      const records = await layer.getRecords();
      assert.strictEqual(records.length, 1, 'shadow record must exist');
      const rec = records[0];
      assert.strictEqual(rec.actualOutcome, 'incomplete', 'EOF must NOT be recorded as completed');

      // 与 SQLite Audit 一致
      const store = router.server._components.store;
      const audits = await store.getAllAuditRecords();
      const audit = audits.find((a) => a.requestId === rec.requestId);
      assert.ok(audit, 'audit exists for same requestId');
      assert.strictEqual(audit.outcome, 'incomplete', 'shadow actualOutcome matches audit outcome');
    } finally {
      await stopSmartRouter(router);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('2. Chat client cancel → actualOutcome=client_aborted (not completed)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-sealed-abort-'));
    mockProvider.setDefaultResponse({
      status: 200,
      stream: true,
      events: Array.from({ length: 150 }, (_, i) => ({
        id: `c${i}`, object: 'chat.completion.chunk', model: 'test-model-a',
        choices: [{ index: 0, delta: { content: `word${i} ` }, finish_reason: null }],
      })),
      sendDone: true,
    });
    const config = buildConfig(mockPort, dataDir);
    const configPath = writeConfig(config, dataDir);
    const router = await startSmartRouter(configPath);
    await sleep(200);
    try {
      const s = await httpStreamAndAbort(router.port, '/v1/chat/completions', {
        model: 'test-model-a', stream: true,
        messages: [{ role: 'user', content: 'Write a very long story please' }],
        max_tokens: 2000,
      }, {}, 250);
      await sleep(600);

      const layer = router.server._components.intelligence;
      const records = await layer.getRecords();
      assert.strictEqual(records.length, 1, 'shadow record must exist');
      const rec = records[0];
      assert.strictEqual(rec.actualOutcome, 'client_aborted', 'cancel must be client_aborted, not completed');
      assert.strictEqual(rec.comparisonStatus, 'not_comparable');
      assert.ok(s.aborted, 'client actually aborted');
    } finally {
      await stopSmartRouter(router);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('3. no_candidate → shadow record with policy_agreement', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-sealed-nc-'));
    const config = buildConfig(mockPort, dataDir, { budget: { strictModel: true } });
    const configPath = writeConfig(config, dataDir);
    const router = await startSmartRouter(configPath);
    await sleep(200);
    try {
      const resp = await httpRequest(router.port, '/v1/chat/completions', {
        body: { model: 'nonexistent-model', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(resp.status, 503);

      const layer = router.server._components.intelligence;
      const records = await layer.getRecords();
      assert.strictEqual(records.length, 1, 'no_candidate must still have a shadow record');
      const rec = records[0];
      assert.strictEqual(rec.actualOutcome, 'no_candidate');
      assert.strictEqual(rec.recommendation, null, 'no suggestion for no_candidate');
      assert.strictEqual(rec.comparisonStatus, 'policy_agreement', 'both sides reject');
      assert.strictEqual(rec.actualAttemptCount, 0);
    } finally {
      await stopSmartRouter(router);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('4. budget_exceeded → shadow record with policy_agreement + rejection reason', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-sealed-budget-'));
    // 只有付费模型 + allowPaid=false → budget_exceeded
    const config = buildConfig(mockPort, dataDir, {
      models: (base) => [
        { id: 'test-model-paid', tier: 'tier2', provider: 'mock-a', apiModel: 'test-model-paid', enabled: true, paid: true, capability: ['chat'], price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02, currency: 'USD' } },
      ],
    });
    const configPath = writeConfig(config, dataDir);
    const router = await startSmartRouter(configPath);
    await sleep(200);
    try {
      const resp = await httpRequest(router.port, '/v1/chat/completions', {
        body: { model: 'test-model-paid', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(resp.status, 402);

      const layer = router.server._components.intelligence;
      const records = await layer.getRecords();
      assert.strictEqual(records.length, 1, 'budget_exceeded must have a shadow record');
      const rec = records[0];
      assert.strictEqual(rec.actualOutcome, 'budget_exceeded');
      assert.strictEqual(rec.recommendation, null);
      assert.strictEqual(rec.comparisonStatus, 'policy_agreement');
      // 拒绝原因记录在 ranked
      assert.ok(rec.rankedCandidates.length > 0, 'ranked candidates recorded');
      assert.ok(
        rec.rankedCandidates[0].blocked && rec.rankedCandidates[0].blocked.includes('allowPaid=false'),
        'rejection reason recorded',
      );
    } finally {
      await stopSmartRouter(router);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('5. persistence across restart: suggestion + final both survive', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-sealed-restart-'));
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'cmpl-persist', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'PERSIST_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });
    const config = buildConfig(mockPort, dataDir);
    const configPath = writeConfig(config, dataDir);

    // 第一轮：写记录
    const router1 = await startSmartRouter(configPath);
    await sleep(200);
    let requestId = null;
    try {
      const resp = await httpRequest(router1.port, '/v1/chat/completions', {
        body: { model: 'test-model-a', messages: [{ role: 'user', content: 'Write code' }] },
      });
      assert.strictEqual(resp.status, 200);
      const records = await router1.server._components.intelligence.getRecords();
      assert.strictEqual(records.length, 1);
      requestId = records[0].requestId;
    } finally {
      await stopSmartRouter(router1);
    }

    // 第二轮：同一 data_dir 重启，记录仍在
    const router2 = await startSmartRouter(configPath);
    await sleep(200);
    try {
      const store = router2.server._components.store;
      const rows = await store.listShadowDecisions();
      assert.strictEqual(rows.length, 1, 'shadow record must survive restart');
      const row = rows[0];
      assert.strictEqual(row.requestId, requestId);
      assert.ok(row.recommendation, 'suggestion survives restart');
      assert.strictEqual(row.actualOutcome, 'completed', 'final result survives restart');
      assert.strictEqual(row.actualFinalModel, 'test-model-a');
      assert.ok(row.finalizedAt, 'finalized_at persisted');
    } finally {
      await stopSmartRouter(router2);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });
});
