import http from 'node:http';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderClient } from '../../src/provider/client.js';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function clientFor(port, provider = {}) {
  return new ProviderClient({
    server: { request_timeout_ms: 500 },
    providers: [{
      name: 'mock',
      base_url: `http://127.0.0.1:${port}/v1`,
      api_key: 'test-key',
      auth_header: 'Authorization',
      auth_prefix: 'Bearer ',
      ...provider,
    }],
    models: [{ id: 'model', apiModel: 'upstream-model', provider: 'mock' }],
  }, {
    nextKey: () => ({ keyId: 'mock-0', key: 'test-key', provider: 'mock' }),
    markKeySucceeded() {},
    markKeyFailed() {},
  });
}

describe('ProviderClient stream resource guards', () => {
  test('aborts a stream after the idle timeout', async () => {
    let upstreamClosed = false;
    const server = await listen((req, res) => {
      req.on('close', () => { upstreamClosed = true; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"chunk-1"}\n\n');
    });
    const client = clientFor(server.address().port);
    const result = await client.callChat('model', { model: 'model', stream: true }, {
      streamIdleTimeoutMs: 40,
      streamTotalTimeoutMs: 300,
    });
    const reader = result.response.body.getReader();
    const first = await reader.read();
    assert.strictEqual(first.done, false);
    await assert.rejects(reader.read(), /timeout|aborted/i);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(upstreamClosed, true);
  });

  test('aborts a continuously active stream at the total deadline', async () => {
    let timer;
    const server = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      timer = setInterval(() => res.write('data: {"id":"heartbeat"}\n\n'), 10);
      req.on('close', () => clearInterval(timer));
    });
    const client = clientFor(server.address().port);
    const result = await client.callChat('model', { model: 'model', stream: true }, {
      streamIdleTimeoutMs: 100,
      streamTotalTimeoutMs: 65,
    });
    const reader = result.response.body.getReader();
    await reader.read();
    await assert.rejects(async () => {
      while (true) await reader.read();
    }, /timeout|aborted/i);
  });

  test('native Anthropic request preserves native fields and maps only the upstream model id', async () => {
    let received;
    const server = await listen((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        received = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg-1', type: 'message', role: 'assistant', model: 'upstream-model',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });
    const client = clientFor(server.address().port, {
      api_type: 'anthropic_native',
      auth_header: 'x-api-key',
      auth_prefix: '',
      version_header: 'anthropic-version',
      version_value: '2023-06-01',
    });
    await client.callAnthropic('model', {
      model: 'model',
      system: 'Be concise',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
      output_config: { structured: { enabled: true } },
    }, { nativeRequest: true });
    assert.strictEqual(received.model, 'upstream-model');
    assert.strictEqual(received.output_config.structured.enabled, true);
    assert.strictEqual(received.system, 'Be concise');
    assert.strictEqual(received.tools[0].name, 'lookup');
    assert.deepStrictEqual(received.tool_choice, { type: 'auto' });
  });

  test('supports providers whose API base path already contains a non-v1 version', async () => {
    let receivedUrl = null;
    const server = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chat-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    });
    const client = clientFor(server.address().port, {
      base_url: `http://127.0.0.1:${server.address().port}/api/v4`,
      strip_v1_prefix: true,
    });
    await client.callChat('model', { model: 'model', messages: [{ role: 'user', content: 'Hi' }] });
    assert.strictEqual(receivedUrl, '/api/v4/chat/completions');
  });
});
