// test/integration/canary-admin.test.js
// Smart Router Mainline - Phase 2-C (Safety Sealed)
// 本地管理接口端到端：status / kill / resume-shadow + SQLite 重启持久化。
//   - 仅 127.0.0.1 + Admin Token（env SMART_ROUTER_ADMIN_TOKEN）
//   - kill 后重启仍保持 killed（Kill Switch 可操作且持久）
//   - resume-shadow 只恢复 Shadow，不自动恢复 Active

import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../../src/server.js';

const ADMIN_TOKEN = 'test-admin-token-123';

function httpJson(port, path, payload, method = 'POST', extraHeaders = {}) {
  return new Promise((resolve) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(data); } catch { parsed = data; } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    if (body) req.write(body);
    req.end();
  });
}

function baseConfig(tmp, mockPort) {
  return {
    server: { host: '127.0.0.1', port: 28796, data_dir: tmp, request_timeout_ms: 20000 },
    data_dir: tmp,
    intelligence: {
      mode: 'active_canary',
      activeCanary: { percentage: 100, allowedAgents: ['claude-code'], allowedTaskTypes: ['general_chat'] },
      shadow: { retentionDays: 30 },
    },
    routing: { strategy: 'tier_weighted', tier_weights: { tier1: 10, tier2: 5, tier3: 1 }, max_concurrent: 4, max_retries: 1, retry_backoff_ms: 20, cooldown_default_sec: 60, health_check_interval_sec: 999999, failover_on_error: true },
    budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
    providers: [
      { name: 'mock', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
    ],
    models: [
      { id: 'phase1-first', provider: 'mock', apiModel: 'phase1-first', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100 }, capability: ['chat'], context_window: 32000, reliability: 0.5 },
      { id: 'canary-best', provider: 'mock', apiModel: 'canary-best', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100, reasoning: 100 }, capability: ['chat', 'reasoning'], context_window: 64000, reliability: 0.95 },
    ],
    agent_bindings: { 'claude-code': { model_ids: ['phase1-first', 'canary-best'] } },
    circuit_breaker: { enabled: false, failure_threshold: 100, failure_window_sec: 60, open_state_sec: 120, half_open_max_calls: 2, key_disable_on_auth_invalid: true },
  };
}

async function createModelDiscoveryProvider() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'discovered-model-a', object: 'model' },
          { id: 'discovered-model-b', object: 'model' },
        ],
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('Phase2-C 本地管理接口（Safety Sealed）', () => {
  test('S4 status requires admin token; 401 on wrong token; 503 when disabled', async () => {
    process.env.SMART_ROUTER_ADMIN_TOKEN = ADMIN_TOKEN;
    const tmp = join(process.cwd(), 'test', '.tmp-admin1');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const config = baseConfig(tmp, 1);
    const configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = server.address().port;
    try {
      // 无 Token → 401
      const noAuth = await httpJson(port, '/_smart-router/intelligence/status', undefined, 'GET');
      assert.strictEqual(noAuth.status, 401, 'missing token must be 401');
      const guardedProviderTest = await httpJson(port, '/_smart-router/providers/test', { provider: {} });
      assert.strictEqual(guardedProviderTest.status, 401, 'new admin actions must use the same token guard');
      // 错误 Token → 401
      const badAuth = await httpJson(port, '/_smart-router/intelligence/status', undefined, 'GET', { Authorization: 'Bearer wrong-token' });
      assert.strictEqual(badAuth.status, 401);
      // 正确 Token → 200
      const ok = await httpJson(port, '/_smart-router/intelligence/status', undefined, 'GET', { Authorization: `Bearer ${ADMIN_TOKEN}` });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.body.ok, true);
      assert.strictEqual(ok.body.mode, 'active_canary');
      assert.ok(ok.body.canary, 'status must include canary snapshot');
      assert.ok(ok.body.config, 'status must include safe config summary');
      assert.ok(ok.body.config.providers.every((provider) => !('api_key' in provider)), 'config summary must not expose api_key');
      assert.ok(ok.body.config.providers.every((provider) => !('api_keys' in provider)), 'config summary must not expose api_keys');
      assert.ok(ok.body.editableConfig, 'status must include editable config draft');
      assert.ok(ok.body.editableConfig.providers.every((provider) => !('api_key' in provider)), 'editable draft must not expose api_key');
      assert.ok(ok.body.editableConfig.providers.every((provider) => !('api_keys' in provider)), 'editable draft must not expose api_keys');
      assert.ok(!('adminToken' in ok.body.editableConfig.intelligence), 'editable draft must not expose adminToken');
      assert.strictEqual(ok.body.config.models[0].id, 'phase1-first');
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      delete process.env.SMART_ROUTER_ADMIN_TOKEN;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('configuration draft validates, applies atomically, preserves secrets, and creates a backup', async () => {
    process.env.SMART_ROUTER_ADMIN_TOKEN = ADMIN_TOKEN;
    const tmp = join(process.cwd(), 'test', '.tmp-admin-config');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const config = baseConfig(tmp, 1);
    config.providers[0].api_keys = ['k', 'k-secondary'];
    const configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    const server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = server.address().port;
    try {
      const status = await httpJson(port, '/_smart-router/intelligence/status', undefined, 'GET', auth);
      const draft = JSON.parse(JSON.stringify(status.body.editableConfig));
      draft.routing.max_retries = 2;
      draft.models[0].enabled = false;

      const validated = await httpJson(port, '/_smart-router/config/validate', { config: draft }, 'POST', auth);
      assert.strictEqual(validated.status, 200);
      assert.strictEqual(validated.body.valid, true);

      const invalid = JSON.parse(JSON.stringify(draft));
      invalid.routing.max_retries = -1;
      const rejected = await httpJson(port, '/_smart-router/config/validate', { config: invalid }, 'POST', auth);
      assert.strictEqual(rejected.status, 422);
      assert.strictEqual(rejected.body.valid, false);

      const applied = await httpJson(port, '/_smart-router/config/apply', { config: draft }, 'POST', auth);
      assert.strictEqual(applied.status, 200);
      assert.strictEqual(applied.body.applied, true);
      assert.strictEqual(applied.body.restartRequired, true);
      assert.ok(applied.body.backupName);
      const saved = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.strictEqual(saved.routing.max_retries, 2);
      assert.strictEqual(saved.providers[0].api_key, 'k', 'existing provider secret must be preserved server-side');
      assert.deepStrictEqual(saved.providers[0].api_keys, ['k', 'k-secondary'], 'existing provider key pool must be preserved server-side');
      assert.ok(readdirSync(tmp).some((name) => name === applied.body.backupName), 'backup file must exist');

      const replacement = JSON.parse(JSON.stringify(draft));
      replacement.providers[0].api_key = 'replacement-key';
      const replaced = await httpJson(port, '/_smart-router/config/apply', { config: replacement }, 'POST', auth);
      assert.strictEqual(replaced.status, 200);
      const replacedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.strictEqual(replacedConfig.providers[0].api_key, 'replacement-key', 'explicit new key must replace the existing key');
      assert.ok(!('api_keys' in replacedConfig.providers[0]), 'explicit new key must not restore the old key pool');

      const backups = await httpJson(port, '/_smart-router/config/backups', undefined, 'GET', auth);
      assert.strictEqual(backups.status, 200);
      assert.ok(backups.body.backups.some((backup) => backup.name === applied.body.backupName));
      assert.ok(backups.body.backups.every((backup) => typeof backup.createdAt === 'string' && Number.isInteger(backup.size)));
      assert.ok(!JSON.stringify(backups.body).includes('replacement-key'), 'backup metadata must never expose secrets');

      const traversal = await httpJson(port, '/_smart-router/config/rollback', { backupName: '../config.json' }, 'POST', auth);
      assert.strictEqual(traversal.status, 400, 'rollback must reject path traversal');

      const rolledBack = await httpJson(port, '/_smart-router/config/rollback', { backupName: applied.body.backupName }, 'POST', auth);
      assert.strictEqual(rolledBack.status, 200);
      assert.strictEqual(rolledBack.body.rolledBack, true);
      assert.strictEqual(rolledBack.body.restartRequired, true);
      const restoredConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.strictEqual(restoredConfig.routing.max_retries, 1, 'rollback must restore the selected backup');
      assert.strictEqual(restoredConfig.providers[0].api_key, 'k');
      assert.deepStrictEqual(restoredConfig.providers[0].api_keys, ['k', 'k-secondary']);
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      delete process.env.SMART_ROUTER_ADMIN_TOKEN;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('provider connection test discovers models without exposing credentials', async () => {
    process.env.SMART_ROUTER_ADMIN_TOKEN = ADMIN_TOKEN;
    const upstream = await createModelDiscoveryProvider();
    const tmp = join(process.cwd(), 'test', '.tmp-admin-provider-test');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const config = baseConfig(tmp, upstream.port);
    config.providers[0].base_url = `http://127.0.0.1:${upstream.port}`;
    const configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    const server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const tested = await httpJson(port, '/_smart-router/providers/test', {
        provider: {
          name: 'mock',
          base_url: config.providers[0].base_url,
          api_type: 'openai',
          auth_header: 'Authorization',
          auth_prefix: 'Bearer ',
        },
      }, 'POST', auth);
      assert.strictEqual(tested.status, 200);
      assert.strictEqual(tested.body.connected, true);
      assert.deepStrictEqual(tested.body.models.map((model) => model.id), ['discovered-model-a', 'discovered-model-b']);
      assert.strictEqual(upstream.requests.at(-1).authorization, 'Bearer k', 'existing key must be reused server-side');
      assert.ok(!JSON.stringify(tested.body).includes('Bearer k'));
      assert.ok(!JSON.stringify(tested.body).includes('api_key'));

      const invalid = await httpJson(port, '/_smart-router/providers/test', {
        provider: { name: 'bad', base_url: 'file:///tmp/nope', api_key: 'not-returned' },
      }, 'POST', auth);
      assert.strictEqual(invalid.status, 400);
      assert.ok(!JSON.stringify(invalid.body).includes('not-returned'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await upstream.close();
      delete process.env.SMART_ROUTER_ADMIN_TOKEN;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('route simulation and request logs explain decisions without exposing credentials', async () => {
    process.env.SMART_ROUTER_ADMIN_TOKEN = ADMIN_TOKEN;
    const tmp = join(process.cwd(), 'test', '.tmp-admin-observability');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const config = baseConfig(tmp, 1);
    const configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    const server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const simulated = await httpJson(port, '/_smart-router/intelligence/simulate', {
        prompt: '写一个 TypeScript 排序函数，并解释复杂度。',
        agentId: 'claude-code',
        protocol: 'chat',
      }, 'POST', auth);
      assert.strictEqual(simulated.status, 200);
      assert.ok(simulated.body.recommendation?.modelId);
      assert.ok(Array.isArray(simulated.body.ranked) && simulated.body.ranked.length > 0);
      assert.ok(simulated.body.explanation);

      await server._components.store.saveAuditRecord({
        requestId: 'audit-visible-1',
        outcome: 'completed',
        finalModel: 'phase1-first',
        finalProvider: 'mock',
        attemptCount: 1,
        agentId: 'claude-code',
        protocol: 'chat',
        responseSize: 128,
        attempts: [{
          attemptNumber: 1,
          model: 'phase1-first',
          provider: 'mock',
          keyId: 'credential-id-must-not-leak',
          validatedOutcome: 'success',
          latencyMs: 42,
          usage: { input_tokens: 10, output_tokens: 5 },
        }],
        timestamp: new Date().toISOString(),
      });
      await server._components.store.saveCost({
        requestId: 'audit-visible-1',
        modelId: 'phase1-first',
        provider: 'mock',
        usage: { input_tokens: 10, output_tokens: 5 },
        cost: { totalCost: 0.001 },
        dateKey: '2026-08-08',
        timestamp: new Date().toISOString(),
      });

      const logs = await httpJson(port, '/_smart-router/logs?limit=10', undefined, 'GET', auth);
      assert.strictEqual(logs.status, 200);
      const entry = logs.body.logs.find((item) => item.requestId === 'audit-visible-1');
      assert.ok(entry);
      assert.strictEqual(entry.latencyMs, 42);
      assert.strictEqual(entry.outcome, 'completed');
      assert.strictEqual(entry.cost.totalCost, 0.001);
      assert.ok(!JSON.stringify(entry).includes('credential-id-must-not-leak'));
      assert.ok(!('keyId' in entry.attempts[0]));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      delete process.env.SMART_ROUTER_ADMIN_TOKEN;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('S4 kill endpoint stops sampling and persists; restart keeps killed', async () => {
    process.env.SMART_ROUTER_ADMIN_TOKEN = ADMIN_TOKEN;
    const tmp = join(process.cwd(), 'test', '.tmp-admin2');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const config = baseConfig(tmp, 1);
    const configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };

    // 第一次启动：kill
    let server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    let port = server.address().port;
    try {
      const kill = await httpJson(port, '/_smart-router/intelligence/kill', {}, 'POST', auth);
      assert.strictEqual(kill.status, 200);
      assert.strictEqual(kill.body.killed, true);
      assert.strictEqual(kill.body.canary.stopped, true);
      assert.strictEqual(kill.body.canary.autoStop.reason, 'admin_kill_switch');
      const st = await httpJson(port, '/_smart-router/intelligence/status', undefined, 'GET', auth);
      assert.strictEqual(st.body.canary.stopped, true);
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }

    // 模拟重启：同一 data_dir 重新启动
    server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = server.address().port;
    try {
      const st = await httpJson(port, '/_smart-router/intelligence/status', undefined, 'GET', auth);
      assert.strictEqual(st.status, 200);
      assert.strictEqual(st.body.canary.stopped, true, 'restart must keep Kill Switch active');
      assert.strictEqual(st.body.canary.autoStop.reason, 'admin_kill_switch');
      assert.strictEqual(st.body.canary.autoStop.restored, true, 'restored flag set');
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      delete process.env.SMART_ROUTER_ADMIN_TOKEN;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('S4 resume-shadow only restores Shadow, never auto-resumes Active (persisted across restart)', async () => {
    process.env.SMART_ROUTER_ADMIN_TOKEN = ADMIN_TOKEN;
    const tmp = join(process.cwd(), 'test', '.tmp-admin3');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const config = baseConfig(tmp, 1);
    const configPath = join(tmp, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };

    let server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    let port = server.address().port;
    try {
      await httpJson(port, '/_smart-router/intelligence/kill', {}, 'POST', auth);
      const resume = await httpJson(port, '/_smart-router/intelligence/resume-shadow', {}, 'POST', auth);
      assert.strictEqual(resume.status, 200);
      assert.strictEqual(resume.body.resumedShadow, true);
      assert.strictEqual(resume.body.mode, 'shadow', 'resume-shadow downgrades mode to shadow');
      assert.strictEqual(resume.body.canary.enabled ?? false, false, 'canary disabled in shadow');
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }

    // 重启：即使配置仍为 active_canary，也必须保持 shadow（绝不自动恢复 Active）
    server = await createServer(configPath);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = server.address().port;
    try {
      const st = await httpJson(port, '/_smart-router/intelligence/status', undefined, 'GET', auth);
      assert.strictEqual(st.body.mode, 'shadow', 'restart must keep shadow mode');
      assert.strictEqual(st.body.canary.enabled ?? false, false);
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      delete process.env.SMART_ROUTER_ADMIN_TOKEN;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
