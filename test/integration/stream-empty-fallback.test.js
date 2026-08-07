// test/integration/stream-empty-fallback.test.js
// Smart Router Mainline - Phase 1
// True streaming pre-first-content fallback regression tests (#3):
//   Provider A returns 200 with EMPTY SSE (no valid protocol events)
//   -> execution engine must close A and fall back to Provider B
//   -> final outcome = completed, same requestId, 2 attempts
//   -> Attempt 1 (A) = content_invalid, Attempt 2 (B) = completed
//
// Covers all three protocols: Chat, Responses, Anthropic.
// Also verifies externalRequestId persistence (#5) via x-request-id.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createMockProvider,
  createTestConfig,
  writeConfig,
  startSmartRouter,
  stopSmartRouter,
  httpStreamRequest,
  sleep,
} from './helpers.js';

function countChatPosts(provider) {
  return provider.receivedRequests.filter(
    (r) => r.method === 'POST' && r.url && r.url.includes('/chat/completions')
  ).length;
}

function countMessagesPosts(provider) {
  return provider.receivedRequests.filter(
    (r) => r.method === 'POST' && r.url && r.url.includes('/messages')
  ).length;
}

function buildSeparateProviderConfig(portA, portB, dataDir) {
  const config = createTestConfig(0, { dataDir });
  config.providers = [
    { name: 'mock-a', base_url: `http://127.0.0.1:${portA}/v1`, api_key: 'k-a', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
    { name: 'mock-b', base_url: `http://127.0.0.1:${portB}/v1`, api_key: 'k-b', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
  ];
  config.models = [
    { id: 'test-model-a', tier: 'tier1', provider: 'mock-a', apiModel: 'test-model-a', enabled: true, paid: false, capability: ['chat', 'streaming'], price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' } },
    { id: 'test-model-a-fb', tier: 'tier2', provider: 'mock-b', apiModel: 'test-model-a', enabled: true, paid: false, capability: ['chat', 'streaming'], price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' } },
  ];
  return config;
}

// B's normal SSE stream (OpenAI chat format, converted by adapters)
function buildNormalStreamEvents(content) {
  return [
    { id: 'cmpl-b', object: 'chat.completion.chunk', created: 0, model: 'test-model-a', choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id: 'cmpl-b', object: 'chat.completion.chunk', created: 0, model: 'test-model-a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
}

async function setupRouter(providerA, providerB, dataDir) {
  const config = buildSeparateProviderConfig(providerA.port, providerB.port, dataDir);
  const configPath = writeConfig(config, dataDir);
  const router = await startSmartRouter(configPath);
  await sleep(200); // let health check settle
  return router;
}

function findEventData(events, needle) {
  return events.find((e) => typeof e.data === 'string' && e.data.includes(needle))?.data || null;
}

async function assertFallbackEvidence(router, externalId, expectedProtocol) {
  const store = router.server._components.store;
  const req = await store.getRequestByExternalId(externalId);
  assert.ok(req, 'request should be persisted with externalRequestId');
  assert.ok(req.requestId.startsWith('sr_'), 'internal requestId should be sr_ format');
  assert.notStrictEqual(req.requestId, externalId, 'external id must not be the primary key');
  if (expectedProtocol) {
    assert.strictEqual(req.protocol, expectedProtocol);
  }

  const audit = await store.getAuditRecord(req.requestId);
  assert.ok(audit, 'audit should exist');
  assert.strictEqual(audit.outcome, 'completed');
  assert.strictEqual(audit.finalProvider, 'mock-b');
  assert.strictEqual(audit.attemptCount, 2, 'should have exactly 2 attempts');

  const attempts = await store.getAttempts(req.requestId);
  assert.strictEqual(attempts.length, 2);
  assert.strictEqual(attempts[0].provider, 'mock-a');
  assert.strictEqual(attempts[0].validatedOutcome, 'error');
  assert.strictEqual(attempts[0].errorType, 'content_invalid');
  assert.strictEqual(attempts[1].provider, 'mock-b');
  assert.strictEqual(attempts[1].validatedOutcome, 'completed');
}

describe('Streaming Pre-First-Content Fallback (empty SSE)', () => {
  let tmpDir;
  before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'sr-stream-fb-')); });
  after(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  test('Chat: A empty SSE -> B normal SSE, completed, 2 attempts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-chat-fb-'));
    const providerA = createMockProvider();
    const providerB = createMockProvider();
    providerA.setDefaultResponse({ status: 200, stream: true, events: [], sendDone: false });
    providerB.setDefaultResponse({ status: 200, stream: true, events: buildNormalStreamEvents('Hello from B'), sendDone: true });
    await providerA.listen();
    await providerB.listen();

    try {
      const router = await setupRouter(providerA, providerB, dataDir);
      try {
        const resp = await httpStreamRequest(router.port, '/v1/chat/completions', {
          body: { model: 'auto', stream: true, messages: [{ role: 'user', content: 'Hi' }] },
          headers: { 'x-request-id': 'ext-chat-1' },
        });

        assert.strictEqual(resp.status, 200);
        const all = resp.events.map((e) => e.data).join('\n');
        assert.ok(all.includes('Hello from B'), 'response should contain B content');
        assert.ok(all.includes('[DONE]'), 'response should end with [DONE]');

        assert.strictEqual(countChatPosts(providerA), 1, 'A should be called exactly once');
        assert.strictEqual(countChatPosts(providerB), 1, 'B should be called exactly once (fallback)');

        await assertFallbackEvidence(router, 'ext-chat-1', 'chat');
      } finally {
        await stopSmartRouter(router);
      }
    } finally {
      await providerA.close();
      await providerB.close();
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('Responses: A no valid events -> B response.completed, completed, 2 attempts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-resp-fb-'));
    const providerA = createMockProvider();
    const providerB = createMockProvider();
    providerA.setDefaultResponse({ status: 200, stream: true, events: [], sendDone: false });
    providerB.setDefaultResponse({ status: 200, stream: true, events: buildNormalStreamEvents('Hello responses B'), sendDone: true });
    await providerA.listen();
    await providerB.listen();

    try {
      const router = await setupRouter(providerA, providerB, dataDir);
      try {
        const resp = await httpStreamRequest(router.port, '/v1/responses', {
          body: { model: 'auto', stream: true, input: 'Hi' },
          headers: { 'x-request-id': 'ext-resp-1' },
        });

        assert.strictEqual(resp.status, 200);
        const completedData = findEventData(resp.events, 'response.completed');
        assert.ok(completedData, 'should receive response.completed');

        // Responses adapter converts the request to Chat format upstream,
        // so upstream hits land on /v1/chat/completions on the mock providers.
        assert.strictEqual(countChatPosts(providerA), 1, 'A should be called exactly once');
        assert.strictEqual(countChatPosts(providerB), 1, 'B should be called exactly once (fallback)');

        await assertFallbackEvidence(router, 'ext-resp-1', 'responses');
      } finally {
        await stopSmartRouter(router);
      }
    } finally {
      await providerA.close();
      await providerB.close();
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('Anthropic: A no valid events before termination -> B message_stop, completed, 2 attempts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sr-anth-fb-'));
    const providerA = createMockProvider();
    const providerB = createMockProvider();
    providerA.setDefaultResponse({ status: 200, stream: true, events: [], sendDone: false });
    providerB.setDefaultResponse({ status: 200, stream: true, events: buildNormalStreamEvents('Hello anthropic B'), sendDone: true });
    await providerA.listen();
    await providerB.listen();

    try {
      const router = await setupRouter(providerA, providerB, dataDir);
      try {
        const resp = await httpStreamRequest(router.port, '/v1/messages', {
          body: { model: 'auto', stream: true, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 64 },
          headers: { 'x-request-id': 'ext-anth-1' },
        });

        assert.strictEqual(resp.status, 200);
        const stopData = findEventData(resp.events, 'message_stop');
        assert.ok(stopData, 'should receive message_stop');

        // A 应恰好被调用一次（上游路径依 provider 认证风格：OpenAI 兼容走 chat，
        // Anthropic 风格走 /v1/messages；核心意图是空流后 fallback 到 B）
        assert.strictEqual(countChatPosts(providerA) + countMessagesPosts(providerA), 1, 'A should be called exactly once');
        assert.strictEqual(countChatPosts(providerB) + countMessagesPosts(providerB), 1, 'B should be called exactly once (fallback)');

        await assertFallbackEvidence(router, 'ext-anth-1', 'anthropic');
      } finally {
        await stopSmartRouter(router);
      }
    } finally {
      await providerA.close();
      await providerB.close();
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });
});
