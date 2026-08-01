// test/integration/anthropic-integration.test.js
// Anthropic Messages HTTP integration tests

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createMockProvider, createTestConfig, writeConfig, startSmartRouter, httpRequest, httpStreamRequest } from './helpers.js';

describe('Anthropic Messages Integration', () => {
  let mockProvider, mockPort, routerInfo, configPath;

  before(async () => {
    mockProvider = createMockProvider();
    await mockProvider.listen();
    mockPort = mockProvider.port;

    const config = createTestConfig(mockPort);
    const configDir = `/tmp/sr-test-anthropic-${Date.now()}`;
    configPath = writeConfig(config, configDir);
    routerInfo = await startSmartRouter(configPath);
  });

  after(async () => {
    if (routerInfo?.server) routerInfo.server.close();
    if (mockProvider) await mockProvider.close();
  });

  test('non-streaming Anthropic request', async () => {
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'chatcmpl-anthropic', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Anthropic' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    const resp = await httpRequest(routerInfo.port, '/v1/messages', {
      body: {
        model: 'test-model-a',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      },
      headers: { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    });
    assert.strictEqual(resp.status, 200);
    const body = JSON.parse(resp.body);
    assert.strictEqual(body.type, 'message');
    assert.strictEqual(body.role, 'assistant');
    assert.ok(Array.isArray(body.content));
    assert.ok(body.content.length > 0);
  });

  test('streaming Anthropic with message_stop', async () => {
    mockProvider.setDefaultResponse({
      status: 200,
      stream: true,
      events: [
        { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
        { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ],
    });

    const resp = await httpStreamRequest(routerInfo.port, '/v1/messages', {
      body: {
        model: 'test-model-a',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Stream test' }],
        stream: true,
      },
      headers: { 'anthropic-version': '2023-06-01' },
    });
    assert.strictEqual(resp.status, 200);
    // Should have message_start, content_block_start, content_block_delta, message_delta, message_stop events
    const types = resp.events.map(e => {
      try { return JSON.parse(e.data).type; } catch { return e.data; }
    });
    assert.ok(types.some(t => t === 'message_start'), 'should have message_start');
    assert.ok(types.some(t => t === 'message_stop'), 'should have message_stop');
  });

  test('abnormal EOF does not fake completed', async () => {
    mockProvider.setDefaultResponse({
      status: 200,
      stream: true,
      events: [
        { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: null }] },
        // No finish_reason, no [DONE] - simulate abnormal EOF
      ],
      sendDone: false,
      endAfterStream: false, // Close without proper ending
    });

    const resp = await httpStreamRequest(routerInfo.port, '/v1/messages', {
      body: {
        model: 'test-model-a',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'EOF test' }],
        stream: true,
      },
      headers: { 'anthropic-version': '2023-06-01' },
    });
    assert.strictEqual(resp.status, 200);
    // Should have an error event, not a normal message_stop with end_turn
    const types = resp.events.map(e => {
      try { return JSON.parse(e.data).type; } catch { return e.data; }
    });
    // Should NOT have message_stop with end_turn (would indicate faked completion)
    const messageDeltas = resp.events.filter(e => {
      try {
        const parsed = JSON.parse(e.data);
        return parsed.type === 'message_delta' && parsed.delta?.stop_reason === 'end_turn';
      } catch { return false; }
    });
    assert.strictEqual(messageDeltas.length, 0, 'should not fake end_turn on abnormal EOF');
  });

  test('count_tokens endpoint', async () => {
    const resp = await httpRequest(routerInfo.port, '/v1/messages/count_tokens', {
      body: {
        model: 'test-model-a',
        messages: [{ role: 'user', content: 'Count my tokens' }],
      },
      headers: { 'anthropic-version': '2023-06-01' },
    });
    assert.strictEqual(resp.status, 200);
    const body = JSON.parse(resp.body);
    assert.ok(typeof body.input_tokens === 'number');
  });

  test('tool_use/tool_result passthrough', async () => {
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

    const resp = await httpRequest(routerInfo.port, '/v1/messages', {
      body: {
        model: 'test-model-a',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Weather?' }],
        tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      },
      headers: { 'anthropic-version': '2023-06-01' },
    });
    assert.strictEqual(resp.status, 200);
    const body = JSON.parse(resp.body);
    const toolUseBlocks = body.content.filter(b => b.type === 'tool_use');
    assert.ok(toolUseBlocks.length > 0);
    assert.strictEqual(toolUseBlocks[0].name, 'get_weather');
  });
});
