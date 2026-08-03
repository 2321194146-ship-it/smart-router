// test/integration/canary-active.test.js
// Smart Router Mainline - Phase 2-C
// Active Canary 端到端：active_canary 模式下协议层应用重排候选执行。

import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../../src/server.js';

function httpJson(port, path, payload, timeoutMs = 15000, extraHeaders = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(data); } catch { parsed = data; } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.write(body); req.end();
  });
}

function createMockProvider() {
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl', object: 'chat.completion', model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'CANARY_OK', finish_reason: 'stop' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

describe('Phase2-C Active Canary 端到端', () => {
  test('C8 active_canary reorders execution to recommended model; shadow rows intact', async () => {
    const mock = await createMockProvider();
    const tmp = join(process.cwd(), 'test', '.tmp-canary');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    const config = {
      server: { host: '127.0.0.1', port: 28794, data_dir: tmp, request_timeout_ms: 20000 },
      data_dir: tmp,
      intelligence: {
        mode: 'active_canary',
        activeCanary: { percentage: 100, allowedAgents: ['claude-code'], allowedTaskTypes: ['general_chat'] },
        shadow: { retentionDays: 30 },
      },
      routing: { strategy: 'tier_weighted', tier_weights: { tier1: 10, tier2: 5, tier3: 1 }, max_concurrent: 4, max_retries: 1, retry_backoff_ms: 20, cooldown_default_sec: 60, health_check_interval_sec: 999999, failover_on_error: true },
      budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
      providers: [
        { name: 'mock', base_url: `http://127.0.0.1:${mock.port}/v1`, api_key: 'k', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
      ],
      models: [
        { id: 'phase1-first', provider: 'mock', apiModel: 'phase1-first', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100 }, capability: ['chat'], context_window: 32000, reliability: 0.5 },
        { id: 'canary-best', provider: 'mock', apiModel: 'canary-best', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100, reasoning: 100 }, capability: ['chat', 'reasoning'], context_window: 64000, reliability: 0.95 },
      ],
      agent_bindings: { 'claude-code': { model_ids: ['phase1-first', 'canary-best'] } },
      circuit_breaker: { enabled: false, failure_threshold: 100, failure_window_sec: 60, open_state_sec: 120, half_open_max_calls: 2, key_disable_on_auth_invalid: true },
    };
    const configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = server.address().port;

    try {
      // 简单聊天任务（general_chat，allowedTaskTypes 内，allowedAgents 内）
      const resp = await httpJson(port, '/v1/chat/completions', {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello there, how are you?' }],
      }, 15000, { 'User-Agent': 'Claude-Code/1.0' });
      assert.strictEqual(resp.status, 200, 'active_canary must not break Phase1 execution');
      assert.ok(String(resp.body?.choices?.[0]?.message?.content || '').includes('CANARY_OK'));

      const store = server._components.store;
      const rows = await store.listShadowDecisions();
      assert.strictEqual(rows.length, 1, 'one shadow row expected');
      const row = rows[0];
      // 采样命中（percentage=100）：执行模型 = 推荐模型（canary-best）
      assert.strictEqual(row.actualFinalModel, 'canary-best', 'canary reorder must execute recommended model');
      assert.strictEqual(row.recommendation.modelId, 'canary-best');
      assert.strictEqual(row.actualOutcome, 'completed');

      // Canary 指标
      const intel = server._components.intelligence;
      const status = intel.status();
      assert.strictEqual(status.mode, 'active_canary');
      assert.ok(status.canary.eligible >= 1);
      assert.ok(status.canary.sampled >= 1);
      assert.ok(status.canary.active >= 1);
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      mock.server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('C8 shadow mode does NOT reorder (Phase1 execution unchanged)', async () => {
    const mock = await createMockProvider();
    const tmp = join(process.cwd(), 'test', '.tmp-canary2');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    const config = {
      server: { host: '127.0.0.1', port: 28795, data_dir: tmp, request_timeout_ms: 20000 },
      data_dir: tmp,
      intelligence: { mode: 'shadow', shadow: { retentionDays: 30 } },
      routing: { strategy: 'tier_weighted', tier_weights: { tier1: 10, tier2: 5, tier3: 1 }, max_concurrent: 4, max_retries: 1, retry_backoff_ms: 20, cooldown_default_sec: 60, health_check_interval_sec: 999999, failover_on_error: true },
      budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
      providers: [
        { name: 'mock', base_url: `http://127.0.0.1:${mock.port}/v1`, api_key: 'k', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
      ],
      models: [
        { id: 'phase1-first', provider: 'mock', apiModel: 'phase1-first', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100 }, capability: ['chat'], context_window: 32000, reliability: 0.5 },
        { id: 'canary-best', provider: 'mock', apiModel: 'canary-best', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100, reasoning: 100 }, capability: ['chat', 'reasoning'], context_window: 64000, reliability: 0.95 },
      ],
      agent_bindings: { 'claude-code': { model_ids: ['phase1-first', 'canary-best'] } },
      circuit_breaker: { enabled: false, failure_threshold: 100, failure_window_sec: 60, open_state_sec: 120, half_open_max_calls: 2, key_disable_on_auth_invalid: true },
    };
    const configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = server.address().port;
    try {
      const resp = await httpJson(port, '/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'Hello' }] }, 15000, { 'User-Agent': 'Claude-Code/1.0' });
      assert.strictEqual(resp.status, 200);
      const rows = await server._components.store.listShadowDecisions();
      // Phase1 首选 tier1 模型（phase1-first）；shadow 不重排 → 执行 phase1-first
      assert.strictEqual(rows[0].actualFinalModel, 'phase1-first');
      const intel = server._components.intelligence;
      assert.strictEqual(intel.status().mode, 'shadow');
      assert.strictEqual(intel.status().canary.enabled ?? false, false);
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      mock.server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
