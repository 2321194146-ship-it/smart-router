// test/integration/chat-integration.test.js
// Chat Completions HTTP integration tests

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createMockProvider, createTestConfig, writeConfig, startSmartRouter, httpRequest, httpStreamRequest } from './helpers.js';

describe('Chat Completions Integration', () => {
  let mockProvider, mockPort, routerInfo, configPath;

  before(async () => {
    mockProvider = createMockProvider();
    await mockProvider.listen();
    mockPort = mockProvider.port;

    const config = createTestConfig(mockPort);
    const configDir = `/tmp/sr-test-config-${Date.now()}`;
    configPath = writeConfig(config, configDir);
    routerInfo = await startSmartRouter(configPath);
  });

  after(async () => {
    if (routerInfo?.server) routerInfo.server.close();
    if (mockProvider) await mockProvider.close();
  });

  test('non-streaming complete request', async () => {
    const resp = await httpRequest(routerInfo.port, '/v1/chat/completions', {
      body: { model: 'test-model-a', messages: [{ role: 'user', content: 'Hello' }] },
    });
    assert.strictEqual(resp.status, 200);
    const body = JSON.parse(resp.body);
    assert.ok(body.id);
    assert.ok(body.choices);
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].finish_reason, 'stop');

    // Verify mock provider received the request
    assert.ok(mockProvider.receivedRequests.length > 0);
    const lastReq = mockProvider.receivedRequests[mockProvider.receivedRequests.length - 1];
    assert.ok(lastReq.body.messages);
    assert.strictEqual(lastReq.body.messages[0].content, 'Hello');
  });

  test('streaming complete request with [DONE]', async () => {
    mockProvider.setDefaultResponse({
      status: 200,
      stream: true,
      events: [
        { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
        { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ],
    });

    const resp = await httpStreamRequest(routerInfo.port, '/v1/chat/completions', {
      body: { model: 'test-model-a', messages: [{ role: 'user', content: 'Stream test' }], stream: true },
    });
    assert.strictEqual(resp.status, 200);
    assert.ok(resp.events.length >= 2);
    assert.ok(resp.events.some(e => e.data === '[DONE]'));
  });

  test('tool_calls in response', async () => {
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'chatcmpl-tools', object: 'chat.completion', model: 'test-model-a',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      },
    });

    const resp = await httpRequest(routerInfo.port, '/v1/chat/completions', {
      body: {
        model: 'test-model-a',
        messages: [{ role: 'user', content: 'Weather in SF' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      },
    });
    assert.strictEqual(resp.status, 200);
    const body = JSON.parse(resp.body);
    assert.ok(body.choices[0].message.tool_calls);
    assert.strictEqual(body.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.strictEqual(body.choices[0].finish_reason, 'tool_calls');
  });

  test('strict model prevents model switch', async () => {
    const config = createTestConfig(mockPort, { strictModel: true });
    const configDir = `/tmp/sr-test-strict-${Date.now()}`;
    const strictConfigPath = writeConfig(config, configDir);
    const strictRouter = await startSmartRouter(strictConfigPath);

    try {
      const resp = await httpRequest(strictRouter.port, '/v1/chat/completions', {
        body: { model: 'nonexistent-model', messages: [{ role: 'user', content: 'Test' }] },
      });
      // Should fail since strict model doesn't allow switching
      assert.ok(resp.status >= 400);
    } finally {
      strictRouter.server.close();
    }
  });

  test('allowPaid=false blocks paid models', async () => {
    const config = createTestConfig(mockPort, { allowPaid: false, modelBPaid: true });
    const configDir = `/tmp/sr-test-nopaid-${Date.now()}`;
    const noPaidPath = writeConfig(config, configDir);
    const noPaidRouter = await startSmartRouter(noPaidPath);

    try {
      const resp = await httpRequest(noPaidRouter.port, '/v1/chat/completions', {
        body: { model: 'test-model-b', messages: [{ role: 'user', content: 'Test' }] },
      });
      // Paid model should be blocked
      assert.ok(resp.status >= 400);
      const body = JSON.parse(resp.body);
      assert.ok(body.error);
    } finally {
      noPaidRouter.server.close();
    }
  });

  test('no candidates returns error', async () => {
    // Use strictModel with a nonexistent model to force no candidates
    const config = createTestConfig(mockPort, { strictModel: true });
    const configDir = `/tmp/sr-test-nocand-${Date.now()}`;
    const strictConfigPath = writeConfig(config, configDir);
    const strictRouter = await startSmartRouter(strictConfigPath);

    try {
      const resp = await httpRequest(strictRouter.port, '/v1/chat/completions', {
        body: { model: 'nonexistent-model-xyz', messages: [{ role: 'user', content: 'Test' }] },
        headers: {},
      });
      assert.ok(resp.status >= 400, 'strict model with nonexistent model should return error');
    } finally {
      strictRouter.server.close();
    }
  });
});
