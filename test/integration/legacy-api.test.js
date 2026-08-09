// 28788 legacy compatibility API contract.
// First slice mirrors the safe, read-only surface used by the former 7878 panel.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createMockProvider, createTestConfig, writeConfig, startSmartRouter, stopSmartRouter } from './helpers.js';

const ADMIN_TOKEN = 'legacy-api-test-admin-token';

describe('28788 legacy compatibility API', () => {
  let mock;
  let router;

  test('exposes safe read-only 7878-compatible endpoints and protects admin data', async () => {
    process.env.SMART_ROUTER_ADMIN_TOKEN = ADMIN_TOKEN;
    mock = createMockProvider();
    await mock.listen();
    const dataDir = `/tmp/sr-legacy-api-${Date.now()}`;
    const config = createTestConfig(mock.port, { dataDir });
    const configPath = writeConfig(config, `/tmp/sr-legacy-api-config-${Date.now()}`);
    router = await startSmartRouter(configPath);
    const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };

    try {
      const health = await fetch(`http://127.0.0.1:${router.port}/api/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).status, 'ok');

      const unauthorized = await fetch(`http://127.0.0.1:${router.port}/api/models`);
      assert.equal(unauthorized.status, 401);

      const models = await fetch(`http://127.0.0.1:${router.port}/api/models`, { headers: auth });
      assert.equal(models.status, 200);
      const modelBody = await models.json();
      assert.equal(modelBody.success, true);
      assert.ok(modelBody.models.some((item) => item.id === 'test-model-a'));
      assert.ok(!JSON.stringify(modelBody).includes('test-key-a'));

      const providers = await fetch(`http://127.0.0.1:${router.port}/api/providers`, { headers: auth });
      assert.equal(providers.status, 200);
      const providerBody = await providers.json();
      assert.ok(Array.isArray(providerBody));
      assert.ok(providerBody.some((item) => item.name === 'mock-a'));
      assert.ok(!JSON.stringify(providerBody).includes('test-key-a'));

      const stats = await fetch(`http://127.0.0.1:${router.port}/stats`, { headers: auth });
      assert.equal(stats.status, 200);
      assert.equal((await stats.json()).overview.total_requests, 0);

      const overview = await fetch(`http://127.0.0.1:${router.port}/api/stats/overview`, { headers: auth });
      assert.equal(overview.status, 200);
      assert.equal((await overview.json()).overview.total_requests, 0);

      for (const path of ['/api/stats/trend?days=7', '/api/stats/latency?days=1', '/api/stats/errors?days=1', '/api/stats/agents?days=7']) {
        const response = await fetch(`http://127.0.0.1:${router.port}${path}`, { headers: auth });
        assert.equal(response.status, 200, path);
      }

      const tenants = await fetch(`http://127.0.0.1:${router.port}/api/tenants`, { headers: auth });
      assert.equal(tenants.status, 200);
      assert.ok(Array.isArray((await tenants.json()).tenants));

      const circuits = await fetch(`http://127.0.0.1:${router.port}/api/circuit-breaker/status`, { headers: auth });
      assert.equal(circuits.status, 200);
      assert.equal(typeof (await circuits.json()), 'object');

      const recent = await fetch(`http://127.0.0.1:${router.port}/api/recent?limit=10`, { headers: auth });
      assert.equal(recent.status, 200);
      assert.ok(Array.isArray((await recent.json()).recent));

      const configSummary = await fetch(`http://127.0.0.1:${router.port}/api/config`, { headers: auth });
      assert.equal(configSummary.status, 200);
      const safeConfig = await configSummary.json();
      assert.ok(safeConfig.providers.every((item) => !('api_key' in item) && !('api_keys' in item)));
      assert.ok(safeConfig.providers.every((item) => item.hasApiKey === true));

      const addModel = await fetch(`http://127.0.0.1:${router.port}/api/config/models`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'legacy-added-model', provider: 'mock-a', capability: 'chat' }),
      });
      assert.equal(addModel.status, 200);
      assert.equal((await addModel.json()).restartRequired, true);

      const addProvider = await fetch(`http://127.0.0.1:${router.port}/api/config/providers`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'legacy-added-provider', base_url: `http://127.0.0.1:${mock.port}/v1`, api_key: 'legacy-secret' }),
      });
      assert.equal(addProvider.status, 200);
      assert.equal((await addProvider.json()).restartRequired, true);

      const afterMutation = await fetch(`http://127.0.0.1:${router.port}/api/config`, { headers: auth });
      const afterMutationBody = await afterMutation.json();
      assert.ok(!JSON.stringify(afterMutationBody).includes('legacy-secret'));
      const persistedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.ok(persistedConfig.providers.some((item) => item.name === 'legacy-added-provider'));
      assert.ok(persistedConfig.models.some((item) => item.id === 'legacy-added-model'));

      const addMcp = await fetch(`http://127.0.0.1:${router.port}/api/mcp-servers`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'local-mcp', url: `http://127.0.0.1:${mock.port}/mcp`, enabled: true }),
      });
      assert.equal(addMcp.status, 200);
      assert.equal((await addMcp.json()).restartRequired, true);
      const afterMcp = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(afterMcp.mcp_servers['local-mcp'].url, `http://127.0.0.1:${mock.port}/mcp`);
    } finally {
      await stopSmartRouter(router);
      await mock.close();
      delete process.env.SMART_ROUTER_ADMIN_TOKEN;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
