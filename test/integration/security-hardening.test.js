import http from 'node:http';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { createMockProvider, createTestConfig, writeConfig, startSmartRouter, stopSmartRouter } from './helpers.js';

function request(port, path, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Production HTTP hardening', { concurrency: false }, () => {
  let mock;
  let router;
  let originalToken;

  before(async () => {
    originalToken = process.env.SMART_ROUTER_API_TOKEN;
    process.env.SMART_ROUTER_API_TOKEN = 'test-api-token-123';
    mock = createMockProvider();
    await mock.listen();
  });

  after(async () => {
    if (originalToken === undefined) delete process.env.SMART_ROUTER_API_TOKEN;
    else process.env.SMART_ROUTER_API_TOKEN = originalToken;
    await stopSmartRouter(router);
    await mock.close();
  });

  test('non-loopback bind requires bearer auth and accepts the configured env token', async () => {
    const config = createTestConfig(mock.port, { dataDir: `/tmp/sr-security-${Date.now()}` });
    config.server.host = '0.0.0.0';
    config.server.auth = { enabled: true };
    const path = writeConfig(config, `/tmp/sr-security-config-${Date.now()}`);
    router = await startSmartRouter(path);

    const unauthorized = await request(router.port, '/v1/models');
    assert.strictEqual(unauthorized.status, 401);
    const authorized = await request(router.port, '/v1/models', {
      headers: { Authorization: 'Bearer test-api-token-123' },
    });
    assert.strictEqual(authorized.status, 200);
  });

  test('non-loopback bind fails closed when the API token is absent', async () => {
    const saved = process.env.SMART_ROUTER_API_TOKEN;
    delete process.env.SMART_ROUTER_API_TOKEN;
    try {
      const config = createTestConfig(mock.port, { dataDir: `/tmp/sr-security-missing-${Date.now()}` });
      config.server.host = '0.0.0.0';
      const path = writeConfig(config, `/tmp/sr-security-missing-config-${Date.now()}`);
      await assert.rejects(() => createServer(path), /public API auth is required/);
    } finally {
      process.env.SMART_ROUTER_API_TOKEN = saved;
    }
  });

  test('invalid JSON is rejected with 400 before routing to a provider', async () => {
    const before = mock.receivedRequests.length;
    const response = await request(router.port, '/v1/chat/completions', {
      method: 'POST',
      body: '{not-json',
      headers: { Authorization: 'Bearer test-api-token-123' },
    });
    assert.strictEqual(response.status, 400);
    assert.match(response.body, /invalid json/i);
    assert.strictEqual(mock.receivedRequests.length, before);
  });

  test('rate limiter returns 429 and Retry-After without touching the provider', async () => {
    const config = createTestConfig(mock.port, { dataDir: `/tmp/sr-security-rate-${Date.now()}` });
    config.routing.rate_limit = { enabled: true, window_ms: 1000, max_requests: 2 };
    const path = writeConfig(config, `/tmp/sr-security-rate-config-${Date.now()}`);
    const limitedRouter = await startSmartRouter(path);
    try {
      // 启动时健康探测也访问 Provider，先让它完成再测公网请求是否触达上游。
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = mock.receivedRequests.length;
      await request(limitedRouter.port, '/v1/models');
      await request(limitedRouter.port, '/v1/models');
      const blocked = await request(limitedRouter.port, '/v1/models');
      assert.strictEqual(blocked.status, 429);
      assert.ok(Number(blocked.headers['retry-after']) >= 1);
      assert.strictEqual(mock.receivedRequests.length, before);
    } finally {
      await stopSmartRouter(limitedRouter);
    }
  });
});
