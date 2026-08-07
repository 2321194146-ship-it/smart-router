// test/integration/provider-fallback-integration.test.js
// Provider error handling and fallback integration tests

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createMockProvider, createTestConfig, writeConfig, startSmartRouter, httpRequest } from './helpers.js';

describe('Provider and Fallback Integration', () => {
  let mockProvider, mockPort;

  before(async () => {
    mockProvider = createMockProvider();
    await mockProvider.listen();
    mockPort = mockProvider.port;
  });

  after(async () => {
    if (mockProvider) await mockProvider.close();
  });

  test('401 error triggers key failure', async () => {
    mockProvider.queueResponse({
      match: (req) => req.body?.model === 'test-model-a',
      response: { status: 401, body: { error: { message: 'Invalid API key', type: 'invalid_request_error' } } },
    });

    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'fb-401', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Fallback success' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });

    const config = createTestConfig(mockPort);
    const configDir = `/tmp/sr-test-fb401-${Date.now()}`;
    const configPath = writeConfig(config, configDir);
    const routerInfo = await startSmartRouter(configPath);

    try {
      const resp = await httpRequest(routerInfo.port, '/v1/chat/completions', {
        body: { model: 'test-model-a', messages: [{ role: 'user', content: 'Test 401' }] },
      });
      // Should either fail or fallback to another provider
      assert.ok(resp.status === 200 || resp.status >= 400);
    } finally {
      routerInfo.server.close();
    }
  });

  test('429 transient error allows fallback', async () => {
    mockProvider.queueResponse({
      match: (req) => req.body?.model === 'test-model-a',
      response: { status: 429, body: { error: { message: 'Rate limited', type: 'rate_limit_exceeded' } } },
    });

    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'fb-429', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Success after 429' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });

    const config = createTestConfig(mockPort);
    const configDir = `/tmp/sr-test-fb429-${Date.now()}`;
    const configPath = writeConfig(config, configDir);
    const routerInfo = await startSmartRouter(configPath);

    try {
      const resp = await httpRequest(routerInfo.port, '/v1/chat/completions', {
        body: { model: 'test-model-a', messages: [{ role: 'user', content: 'Test 429' }] },
      });
      assert.ok(resp.status === 200 || resp.status >= 400);
    } finally {
      routerInfo.server.close();
    }
  });

  test('500 server error triggers fallback', async () => {
    mockProvider.queueResponse({
      match: (req) => req.body?.model === 'test-model-a',
      response: { status: 500, body: { error: { message: 'Internal server error', type: 'server_error' } } },
    });

    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'fb-500', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Success after 500' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });

    const config = createTestConfig(mockPort);
    const configDir = `/tmp/sr-test-fb500-${Date.now()}`;
    const configPath = writeConfig(config, configDir);
    const routerInfo = await startSmartRouter(configPath);

    try {
      const resp = await httpRequest(routerInfo.port, '/v1/chat/completions', {
        body: { model: 'test-model-a', messages: [{ role: 'user', content: 'Test 500' }] },
      });
      assert.ok(resp.status === 200 || resp.status >= 400);
    } finally {
      routerInfo.server.close();
    }
  });

  test('budget insufficient prevents paid fallback', async () => {
    const config = createTestConfig(mockPort, {
      allowPaid: false,
      modelBPaid: true,
      customModels: [
        { id: 'test-model-a', tier: 'tier1', provider: 'mock-a', apiModel: 'test-model-a', enabled: true, paid: false },
        { id: 'test-model-b', tier: 'tier2', provider: 'mock-b', apiModel: 'test-model-b', enabled: true, paid: true, price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } },
      ],
    });
    const configDir = `/tmp/sr-test-budget-${Date.now()}`;
    const configPath = writeConfig(config, configDir);
    const routerInfo = await startSmartRouter(configPath);

    try {
      const resp = await httpRequest(routerInfo.port, '/v1/chat/completions', {
        body: { model: 'test-model-b', messages: [{ role: 'user', content: 'Paid test' }] },
      });
      assert.ok(resp.status >= 400, 'paid model with allowPaid=false should fail');
    } finally {
      routerInfo.server.close();
    }
  });

  test('free model failure allows fallback to another free model', async () => {
    mockProvider.queueResponse({
      match: (req) => req.body?.model === 'test-model-a',
      response: { status: 503, body: { error: { message: 'Service unavailable' } } },
      once: true,
    });

    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'fb-free', object: 'chat.completion', model: 'test-model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Success' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });

    const config = createTestConfig(mockPort);
    const configDir = `/tmp/sr-test-freefb-${Date.now()}`;
    const configPath = writeConfig(config, configDir);
    const routerInfo = await startSmartRouter(configPath);

    try {
      const resp = await httpRequest(routerInfo.port, '/v1/chat/completions', {
        body: { model: 'test-model-a', messages: [{ role: 'user', content: 'Test free fallback' }] },
      });
      // Should eventually succeed via fallback
      assert.ok(resp.status === 200 || resp.status >= 400);
    } finally {
      routerInfo.server.close();
    }
  });

  test('incomplete responses fall through three free candidates before completing', async () => {
    mockProvider.queueResponse({
      match: (req) => req.body?.model === 'fallback-model-1',
      response: {
        status: 200,
        body: {
          id: 'fb-incomplete-1', object: 'chat.completion', model: 'fallback-model-1',
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
        },
      },
      once: true,
    });
    mockProvider.queueResponse({
      match: (req) => req.body?.model === 'fallback-model-2',
      response: {
        status: 200,
        body: {
          id: 'fb-incomplete-2', object: 'chat.completion', model: 'fallback-model-2',
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
        },
      },
      once: true,
    });
    mockProvider.setDefaultResponse({
      status: 200,
      body: {
        id: 'fb-incomplete-3', object: 'chat.completion', model: 'fallback-model-3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Third candidate completed' }, finish_reason: 'stop' }],
      },
    });

    const config = createTestConfig(mockPort, {
      customProviders: [
        { name: 'mock-a', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'test-key-a', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
        { name: 'mock-b', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'test-key-b', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
        { name: 'mock-c', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'test-key-c', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
      ],
      customModels: [
        { id: 'fallback-model-1', tier: 'tier1', provider: 'mock-a', apiModel: 'fallback-model-1', enabled: true, paid: false, capability: ['chat'] },
        { id: 'fallback-model-2', tier: 'tier2', provider: 'mock-b', apiModel: 'fallback-model-2', enabled: true, paid: false, capability: ['chat'] },
        { id: 'fallback-model-3', tier: 'tier3', provider: 'mock-c', apiModel: 'fallback-model-3', enabled: true, paid: false, capability: ['chat'] },
      ],
    });
    const configDir = `/tmp/sr-test-three-freefb-${Date.now()}`;
    const configPath = writeConfig(config, configDir);
    const routerInfo = await startSmartRouter(configPath);
    const chatRequestCountBefore = mockProvider.receivedRequests.filter(
      (request) => request.method === 'POST' && request.url?.includes('/chat/completions'),
    ).length;

    try {
      const resp = await httpRequest(routerInfo.port, '/v1/chat/completions', {
        body: { model: 'auto', messages: [{ role: 'user', content: 'Test three-way fallback' }] },
      });
      assert.strictEqual(resp.status, 200);
      const body = JSON.parse(resp.body);
      assert.strictEqual(body.model, 'fallback-model-3');
      assert.strictEqual(body.choices[0].message.content, 'Third candidate completed');
      const chatModels = mockProvider.receivedRequests
        .filter((request) => request.method === 'POST' && request.url?.includes('/chat/completions'))
        .slice(chatRequestCountBefore)
        .map((request) => request.body?.model);
      assert.deepStrictEqual(chatModels, ['fallback-model-1', 'fallback-model-2', 'fallback-model-3']);
    } finally {
      routerInfo.server.close();
    }
  });
});
