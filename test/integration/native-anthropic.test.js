import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockProvider, createTestConfig, writeConfig, startSmartRouter, stopSmartRouter, httpRequest, httpStreamRequest } from './helpers.js';

describe('Native Anthropic provider contract', () => {
  let mock;
  let router;

  before(async () => {
    mock = createMockProvider({});
    await mock.listen();
    const config = createTestConfig(mock.port, {
      dataDir: `/tmp/sr-native-anthropic-${Date.now()}`,
      customProviders: [{
        name: 'native',
        base_url: `http://127.0.0.1:${mock.port}/v1`,
        api_type: 'anthropic_native',
        api_key: 'native-key',
        auth_header: 'x-api-key',
        auth_prefix: '',
        version_header: 'anthropic-version',
        version_value: '2023-06-01',
      }],
      customModels: [{
        id: 'native-model',
        apiModel: 'claude-native',
        provider: 'native',
        tier: 'tier1',
        enabled: true,
        paid: false,
        capability: ['chat', 'tool_use', 'streaming'],
        price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' },
      }],
    });
    router = await startSmartRouter(writeConfig(config, `/tmp/sr-native-anthropic-config-${Date.now()}`));
  });

  after(async () => {
    await stopSmartRouter(router);
    await mock.close();
  });

  test('non-streaming native response is returned without Chat re-conversion', async () => {
    mock.setDefaultResponse({
      status: 200,
      body: {
        id: 'msg-native', type: 'message', role: 'assistant', model: 'claude-native',
        content: [{ type: 'text', text: 'native response' }],
        stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 },
      },
    });
    const response = await httpRequest(router.port, '/v1/messages', {
      body: {
        model: 'native-model',
        system: 'Be concise',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        output_config: { structured: { enabled: true } },
        max_tokens: 64,
      },
    });
    assert.strictEqual(response.status, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.type, 'message');
    assert.strictEqual(body.content[0].text, 'native response');
    const upstream = mock.receivedRequests.at(-1);
    assert.strictEqual(upstream.url, '/v1/messages');
    assert.strictEqual(upstream.body.model, 'claude-native');
    assert.ok(upstream.body.output_config);
    assert.strictEqual(upstream.body.system, 'Be concise');
  });

  test('streaming native events are passed through without Chat SSE synthesis', async () => {
    mock.setDefaultResponse({
      status: 200,
      stream: true,
      sendDone: false,
      events: [
        { type: 'message_start', message: { id: 'msg-stream', type: 'message' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native' } },
        { type: 'message_stop' },
      ],
    });
    const response = await httpStreamRequest(router.port, '/v1/messages', {
      body: { model: 'native-model', messages: [{ role: 'user', content: 'Hello' }], stream: true, max_tokens: 64 },
    });
    assert.strictEqual(response.status, 200);
    assert.ok(response.events.some((event) => event.data.includes('message_start')));
    assert.ok(response.events.some((event) => event.data.includes('message_stop')));
    assert.ok(!response.events.some((event) => event.data.includes('chat.completion.chunk')));
  });
});
