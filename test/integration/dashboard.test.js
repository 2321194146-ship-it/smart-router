import http from 'node:http';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockProvider, createTestConfig, writeConfig, startSmartRouter, stopSmartRouter } from './helpers.js';

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Local Dashboard', { concurrency: false }, () => {
  let mock;
  let router;

  before(async () => {
    mock = createMockProvider();
    await mock.listen();
    const config = createTestConfig(mock.port, { dataDir: `/tmp/sr-dashboard-${Date.now()}` });
    const path = writeConfig(config, `/tmp/sr-dashboard-config-${Date.now()}`);
    router = await startSmartRouter(path);
  });

  after(async () => {
    await stopSmartRouter(router);
    await mock.close();
  });

  test('serves the dashboard shell and local assets with restrictive headers', async () => {
    const page = await request(router.port, '/dashboard');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.match(page.body, /Smart Router Control Room/);
    assert.match(page.body, /路由模拟器/);
    assert.match(page.body, /请求日志/);
    assert.match(page.body, /option value="completed">成功/);
    assert.match(page.body, /备份与回滚/);

    const script = await request(router.port, '/dashboard/app.js');
    assert.equal(script.status, 200);
    assert.match(script.body, /adminToken/);
    assert.match(script.body, /_smart-router\/providers\/test/);
    assert.match(script.body, /_smart-router\/intelligence\/simulate/);
    assert.match(script.body, /_smart-router\/config\/rollback/);
    assert.doesNotMatch(script.body, /localStorage|sessionStorage/);

    const styles = await request(router.port, '/dashboard/styles.css');
    assert.equal(styles.status, 200);
    assert.match(styles.body, /metric-grid/);
    assert.match(styles.body, /provider-test-result/);
  });

  test('does not expose the dashboard when the server is configured for non-loopback binding', async () => {
    const config = createTestConfig(mock.port, { dataDir: `/tmp/sr-dashboard-public-${Date.now()}` });
    config.server.host = '0.0.0.0';
    const savedToken = process.env.SMART_ROUTER_API_TOKEN;
    process.env.SMART_ROUTER_API_TOKEN = 'dashboard-test-api-token';
    const path = writeConfig(config, `/tmp/sr-dashboard-public-config-${Date.now()}`);
    const publicRouter = await startSmartRouter(path);
    try {
      const page = await request(publicRouter.port, '/dashboard');
      assert.equal(page.status, 404);
    } finally {
      await stopSmartRouter(publicRouter);
      if (savedToken === undefined) delete process.env.SMART_ROUTER_API_TOKEN;
      else process.env.SMART_ROUTER_API_TOKEN = savedToken;
    }
  });
});
