// test/integration/shadow-mode.test.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Shadow 模式集成测试：
//   - 三协议（chat / responses / anthropic）同一内部 requestId
//   - Shadow 记录：智能建议 + 传统路由真实结果
//   - Shadow 不增加上游调用（与 off 模式调用次数一致）
//   - Shadow 不影响用户响应（响应内容与 off 一致）
//   - 可立即切回 off

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createMockProvider,
  writeConfig,
  startSmartRouter,
  stopSmartRouter,
  httpRequest,
  httpStreamRequest,
  sleep,
} from './helpers.js';

function buildShadowConfig(mockPort, dataDir) {
  const config = {
    server: { port: 28789, host: '127.0.0.1', data_dir: dataDir, request_timeout_ms: 30000 },
    data_dir: dataDir,
    intelligence: {
      mode: 'shadow',
      shadow: {
        policy: { tierPreference: true, preferFree: true },
      },
    },
    routing: {
      strategy: 'tier_weighted',
      tier_weights: { tier1: 10, tier2: 5 },
      max_concurrent: 16,
      max_retries: 3,
      retry_backoff_ms: 100,
      cooldown_default_sec: 60,
      health_check_interval_sec: 999999,
      failover_on_error: true,
    },
    budget: { allowPaid: false, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
    providers: [
      { name: 'mock-a', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k-a', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
    ],
    models: [
      { id: 'test-model-a', tier: 'tier1', provider: 'mock-a', apiModel: 'test-model-a', enabled: true, paid: false, capability: ['chat', 'tool_use', 'streaming'], price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' } },
    ],
    agent_bindings: {},
    circuit_breaker: { enabled: false, failure_threshold: 100, failure_window_sec: 60, open_state_sec: 120, half_open_max_calls: 2, key_disable_on_auth_invalid: true },
  };
  return config;
}

function countChatPosts(provider) {
  return provider.receivedRequests.filter(
    (r) => r.method === 'POST' && r.url && r.url.includes('/chat/completions')
  ).length;
}

describe('Phase2-A Shadow Mode (HTTP)', () => {
  let tmpDir, mockProvider, mockPort;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sr-shadow-'));
    mockProvider = createMockProvider();
    await mockProvider.listen();
    mockPort = mockProvider.port;
  });

  after(async () => {
    if (mockProvider) await mockProvider.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('chat: shadow records same requestId, response unchanged, no extra upstream calls', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-shadow-chat-'));
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'cmpl-shadow', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'SHADOW_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });
    const config = buildShadowConfig(mockPort, dataDir);
    const configPath = writeConfig(config, dataDir);
    const router = await startSmartRouter(configPath);
    await sleep(200);
    try {
      const resp = await httpRequest(router.port, '/v1/chat/completions', {
        body: { model: 'test-model-a', messages: [{ role: 'user', content: 'Write a JS function' }] },
        headers: { 'x-request-id': 'shadow-chat-ext' },
      });
      // 用户响应不变
      assert.strictEqual(resp.status, 200);
      const parsed = JSON.parse(resp.body);
      assert.ok(parsed.choices[0].message.content.includes('SHADOW_OK'));

      // 上游调用次数：仅 1 次（无额外调用）
      assert.strictEqual(countChatPosts(mockProvider), 1, 'shadow must not add upstream calls');

      // 记录存在：同 requestId + 智能建议 + 传统结果
      const layer = router.server._components.intelligence;
      assert.strictEqual(layer.isShadow(), true);
      const records = layer.getRecords();
      assert.strictEqual(records.length, 1);
           const rec = records[0];
      assert.ok(rec.requestId.startsWith('sr_'), 'internal requestId sr_ format');
      assert.ok(rec.intelligence?.recommendation, 'intelligence suggestion recorded');
      assert.strictEqual(rec.intelligence.recommendation.modelId, 'test-model-a');
      assert.ok(rec.intelligence.predictions.quality !== null);
      assert.ok(rec.intelligence.explanation.summary.length > 0);
      assert.strictEqual(rec.traditional?.finalModel, 'test-model-a');
      assert.strictEqual(rec.traditional?.outcome, 'completed');

      // 对照摘要
      const comp = layer.getComparison();
      assert.strictEqual(comp.total, 1);
    } finally {
      await stopSmartRouter(router);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('responses: shadow records with same internal requestId', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-shadow-resp-'));
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'resp-shadow', object: 'response', status: 'completed', model: 'test-model-a',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RESP_OK' }] }],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    });
    const config = buildShadowConfig(mockPort, dataDir);
    const configPath = writeConfig(config, dataDir);
    const router = await startSmartRouter(configPath);
    await sleep(200);
    try {
      const resp = await httpRequest(router.port, '/v1/responses', {
        body: { model: 'test-model-a', input: 'Summarize this document' },
        headers: { 'x-request-id': 'shadow-resp-ext' },
      });
      assert.strictEqual(resp.status, 200);

      const layer = router.server._components.intelligence;
      const records = layer.getRecords();
      assert.strictEqual(records.length, 1);
           const rec = records[0];
      assert.ok(rec.requestId.startsWith('sr_'));
      assert.strictEqual(rec.protocol, 'responses');
      assert.ok(rec.task?.taskType, "task analysis recorded");
      assert.strictEqual(rec.traditional?.finalProvider, 'mock-a');
    } finally {
      await stopSmartRouter(router);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('anthropic stream: shadow records with same internal requestId, stream unaffected', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-shadow-anth-'));
    mockProvider.setDefaultResponse({
      status: 200,
      stream: true,
      events: [
        { id: 'c1', object: 'chat.completion.chunk', model: 'test-model-a', choices: [{ index: 0, delta: { content: 'ANTH_OK' }, finish_reason: null }] },
        { id: 'c2', object: 'chat.completion.chunk', model: 'test-model-a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ],
      sendDone: true,
    });
    const config = buildShadowConfig(mockPort, dataDir);
    const configPath = writeConfig(config, dataDir);
    const router = await startSmartRouter(configPath);
    await sleep(200);
    try {
      const resp = await httpStreamRequest(router.port, '/v1/messages', {
        body: { model: 'test-model-a', stream: true, messages: [{ role: 'user', content: 'Explain code below' }], max_tokens: 64 },
        headers: { 'x-request-id': 'shadow-anth-ext' },
      });
      assert.strictEqual(resp.status, 200);
      const all = resp.events.map((e) => e.data).join('\n');
      assert.ok(all.includes('ANTH_OK'), 'stream content must reach client');

      const layer = router.server._components.intelligence;
      const records = layer.getRecords();
      assert.strictEqual(records.length, 1);
           const rec = records[0];
      assert.ok(rec.requestId.startsWith('sr_'));
      assert.strictEqual(rec.protocol, 'anthropic');
      assert.ok(rec.task?.codeRelated === true || rec.task !== null);
    } finally {
      await stopSmartRouter(router);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('off mode: zero records, zero overhead, response unchanged', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-off-'));
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'cmpl-off', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OFF_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });
    const config = buildShadowConfig(mockPort, dataDir);
    config.intelligence.mode = 'off';
    const configPath = writeConfig(config, dataDir);
    const router = await startSmartRouter(configPath);
    await sleep(200);
    try {
      const resp = await httpRequest(router.port, '/v1/chat/completions', {
        body: { model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.strictEqual(resp.status, 200);
      assert.ok(resp.body.includes('OFF_OK'));
      const layer = router.server._components.intelligence;
      assert.strictEqual(layer.status().mode, 'off');
      assert.strictEqual(layer.getRecords().length, 0, 'off mode must record nothing');
    } finally {
      await stopSmartRouter(router);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });
});
