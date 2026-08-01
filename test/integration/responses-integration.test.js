// test/integration/responses-integration.test.js
// Responses API HTTP integration tests

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createMockProvider, createTestConfig, writeConfig, startSmartRouter, httpRequest, httpStreamRequest } from './helpers.js';

describe('Responses API Integration', () => {
  let mockProvider, mockPort, routerInfo, configPath;

  before(async () => {
    mockProvider = createMockProvider();
    await mockProvider.listen();
    mockPort = mockProvider.port;
    const config = createTestConfig(mockPort);
    const configDir = `/tmp/sr-test-responses-${Date.now()}`;
    configPath = writeConfig(config, configDir);
    routerInfo = await startSmartRouter(configPath);
  });

  after(async () => {
    if (routerInfo?.server) routerInfo.server.close();
    if (mockProvider) await mockProvider.close();
  });

  test('non-streaming Responses request', async () => {
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'resp-test', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Response from API' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    const resp = await httpRequest(routerInfo.port, '/v1/responses', {
      body: { model: 'test-model-a', input: 'Hello' },
    });
    assert.strictEqual(resp.status, 200);
    const body = JSON.parse(resp.body);
    assert.ok(body.id);
  });

  test('streaming Responses with response.completed', async () => {
    mockProvider.setDefaultResponse({
      status: 200,
      stream: true,
      events: [
        { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
        { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ],
    });

    const resp = await httpStreamRequest(routerInfo.port, '/v1/responses', {
      body: { model: 'test-model-a', input: 'Stream test', stream: true },
    });
    assert.strictEqual(resp.status, 200);
    assert.ok(resp.events.length > 0);
  });

  test('function_call in Responses', async () => {
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'resp-func', object: 'chat.completion', model: 'test-model-a',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
      },
    });

    const resp = await httpRequest(routerInfo.port, '/v1/responses', {
      body: {
        model: 'test-model-a',
        input: 'Search for test',
        tools: [{ type: 'function', name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
      },
    });
    assert.strictEqual(resp.status, 200);
  });

  test('upstream receives correct request body', async () => {
    mockProvider.receivedRequests.length = 0;
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'resp-verify', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    });

    await httpRequest(routerInfo.port, '/v1/responses', {
      body: { model: 'test-model-a', input: 'Verify body' },
    });

    assert.ok(mockProvider.receivedRequests.length > 0);
    const lastReq = mockProvider.receivedRequests[mockProvider.receivedRequests.length - 1];
    assert.ok(lastReq.body);
    assert.ok(lastReq.body.messages || lastReq.body.input, 'upstream should receive request body');
  });
});
