/**
 * OpenAI protocol path tests
 * Run: node --test test/openai.test.js
 */
import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { mockResponse, mockSSEResponse, providerConfig, testConfig } from './helpers.js';

// ── Config setup (must run before any source import) ──
const CFG_PATH = '/tmp/smart-router-test-config.json';
process.env.CONFIG_FILE = CFG_PATH;
writeFileSync(CFG_PATH, JSON.stringify(testConfig));

// ── Mock fetch ──
let fetchMock = null;

function setupMock(handler) {
  if (fetchMock) mock.restoreAll();
  fetchMock = mock.method(globalThis, 'fetch', handler);
}

function cleanupMock() {
  mock.restoreAll();
  fetchMock = null;
}

// ── Source modules (imported lazily inside tests) ──

describe('callProviderChat — true passthrough', () => {
  after(cleanupMock);

  it('passes through unknown fields from original body', async () => {
    const { callProviderChat } = await import('../src/provider-client.js');
    let sentBody = null;
    setupMock((url, opts) => {
      sentBody = JSON.parse(opts.body);
      return mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });

    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'test' } }],
      tool_choice: 'auto',
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
      stream_options: { include_usage: true },
      user: 'test-user',
      seed: 42,
      frequency_penalty: 0.5,
    };

    await callProviderChat(providerConfig(), { api_key: 'sk-test-key' }, 'gpt-4', body);
    assert.ok(sentBody, 'body was sent');
    assert.deepStrictEqual(sentBody.tools, body.tools, 'tools passthrough');
    assert.strictEqual(sentBody.tool_choice, 'auto', 'tool_choice passthrough');
    assert.strictEqual(sentBody.response_format.type, 'json_object', 'response_format passthrough');
    assert.strictEqual(sentBody.reasoning_effort, 'high', 'reasoning_effort passthrough');
    assert.strictEqual(sentBody.seed, 42, 'seed passthrough');
    assert.strictEqual(sentBody.model, 'gpt-4', 'model override');
  });

  it('preserves array content blocks', async () => {
    const { callProviderChat } = await import('../src/provider-client.js');
    let sentMessages = null;
    setupMock((url, opts) => {
      sentMessages = JSON.parse(opts.body).messages;
      return mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });

    await callProviderChat(providerConfig(), { api_key: 'sk-test-key' }, 'gpt-4o', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
        ]
      }],
    });
    assert.ok(Array.isArray(sentMessages[0].content), 'content stays array');
    assert.strictEqual(sentMessages[0].content.length, 2, 'two blocks preserved');
    assert.strictEqual(sentMessages[0].content[0].type, 'text');
    assert.strictEqual(sentMessages[0].content[1].type, 'image_url');
  });
});

describe('executeCandidates — error handling', () => {
  afterEach(cleanupMock);

  it('returns success on 200 non-streaming', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    setupMock(() => mockResponse({ choices: [{ message: { content: 'ok' } }] }));
    const result = await executeCandidates(
      [{ model: 'gpt-4o', provider: providerConfig(), providerName: 'test-provider', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 't1' }
    );
    assert.ok(result.success);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.isStream, false);
    assert.ok(result.body);
  });

  it('returns error on 400 (no fallback)', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    setupMock(() => mockResponse({ error: 'bad' }, 400));
    const result = await executeCandidates(
      [
        { model: 'gpt-4o', provider: providerConfig(), providerName: 'p1', tier: 0 },
        { model: 'gpt-4o-mini', provider: providerConfig(), providerName: 'p2', tier: 0 },
      ],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 't2' }
    );
    assert.ok(result.error);
    assert.strictEqual(result.status, 400);
  });

  it('returns error on 422 (no fallback)', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    setupMock(() => mockResponse({ error: 'unprocessable' }, 422));
    const result = await executeCandidates(
      [{ model: 'gpt-4o', provider: providerConfig(), providerName: 'p', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 't3' }
    );
    assert.ok(result.error);
    assert.strictEqual(result.status, 422);
  });

  it('skips 401 provider and flags as dead', async () => {
    const { executeCandidates, resetProviderState } = await import('../src/provider-client.js');
    const prov = providerConfig('dead-provider');
    let calls = 0;
    setupMock(() => { calls++; return mockResponse({ error: 'unauthorized' }, 401); });

    const result = await executeCandidates(
      [{ model: 'gpt-4o', provider: prov, providerName: 'dead-provider', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 't4', maxRetries: 5 }
    ).catch(e => e);

    assert.strictEqual(calls, 1, 'only called once (no retry for 401)');
    assert.ok(result instanceof Error || result.error);
    resetProviderState('dead-provider');
  });

  it('retries 429 with another key on the same provider', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    const { getConfig } = await import('../src/config.js');
    const cfg = getConfig();
    cfg.providers['rp429'] = {
      base_url: 'https://api.test.com/v1',
      keys: [{ id: 'k1', api_key: 'sk-rp-k1' }, { id: 'k2', api_key: 'sk-rp-k2' }],
      display: 'rp429', api_type: 'openai',
    };
    cfg.models.push({ id: 'rp429-model', name: 'rp429-model', provider: 'rp429', enabled: true, tier: 0 });
    let calls = 0;
    setupMock(() => {
      calls++;
      if (calls === 1) return mockResponse({ error: 'rate limited' }, 429);
      return mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const result = await executeCandidates(
      [{ model: 'rp429-model', provider: cfg.providers['rp429'], providerName: 'rp429', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 't5', maxRetries: 5 }
    );
    assert.ok(result.success, 'retry succeeded');
    assert.strictEqual(calls, 2, 'called twice (first key 429 → second key 200)');
  });

  it('handles streaming: buffers first chunk', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    const sse = 'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}\n\n';
    setupMock(() => mockResponse(sse, 200, { 'content-type': 'text/event-stream' }));
    const result = await executeCandidates(
      [{ model: 'gpt-4o', provider: providerConfig(), providerName: 'sp', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      { agent: 'test', requestId: 't6' }
    );
    assert.ok(result.success);
    assert.ok(result.isStream);
    assert.ok(typeof result.ttft === 'number', 'TTFT recorded');
    assert.ok(result.remainingStream, 'remainingStream exists');
  });

  it('retries empty non-streaming response', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    let calls = 0;
    setupMock(() => {
      calls++;
      if (calls === 1) return mockResponse({ choices: null }, 200);
      return mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const result = await executeCandidates(
      [{ model: 'gpt-4o', provider: providerConfig(), providerName: 'ep', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 't7', maxRetries: 5 }
    );
    assert.ok(result.success);
    assert.strictEqual(calls, 2, 'retried empty');
  });

  it('strict model returns real error when no provider can serve it', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    setupMock(() => mockResponse({ error: 'oops' }, 500));
    await assert.rejects(
      executeCandidates(
        [{ model: 'gpt-4o', provider: providerConfig('st'), providerName: 'st', tier: 0, strict: true }],
        { messages: [{ role: 'user', content: 'hi' }] },
        { agent: 'test', requestId: 't8', maxRetries: 1, maxAttemptsPerCandidate: 1 }
      ),
      /All providers unavailable/,
      'single strict candidate that always 500 must end in a final error'
    );
  });
});

describe('routeChatCompletion — routing', () => {
  afterEach(cleanupMock);

  it('routes by role name', async () => {
    const { routeChatCompletion } = await import('../src/provider-client.js');
    let sentModel = null;
    setupMock((url, opts) => {
      sentModel = JSON.parse(opts.body).model;
      return mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const result = await routeChatCompletion(
      { model: 'fast', messages: [{ role: 'user', content: 'hi' }] },
      'test'
    );
    assert.ok(result.success);
    assert.strictEqual(sentModel, 'gpt-4o-mini');
  });

  it('routes by exact model name', async () => {
    const { routeChatCompletion } = await import('../src/provider-client.js');
    let sentModel = null;
    setupMock((url, opts) => {
      sentModel = JSON.parse(opts.body).model;
      return mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const result = await routeChatCompletion(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      'test'
    );
    assert.ok(result.success);
    assert.strictEqual(sentModel, 'gpt-4o');
  });

  it('preferred model header overrides', async () => {
    const { routeChatCompletion } = await import('../src/provider-client.js');
    setupMock(() => mockResponse({ choices: [{ message: { content: 'ok' } }] }));
    const result = await routeChatCompletion(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      'test',
      { preferredModel: 'gpt-4o' }
    );
    assert.ok(result.success);
  });

  it('throws for nonexistent model', async () => {
    const { routeChatCompletion } = await import('../src/provider-client.js');
    setupMock(() => mockResponse({ choices: [{ message: { content: 'ok' } }] }));
    await assert.rejects(
      () => routeChatCompletion({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }, 'test'),
      /No available candidates/
    );
  });
});

describe('Anthropic protocol conversion', () => {
  afterEach(cleanupMock);

  it('converts Anthropic request and maps response back', async () => {
    const { handleAnthropicMessage } = await import('../src/anthropic.js');
    setupMock(() => mockResponse({
      id: 'chatcmpl-123',
      model: 'gpt-4o',
      choices: [{
        message: { role: 'assistant', content: 'Hello', tool_calls: [] },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const result = await handleAnthropicMessage({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 100,
    }, 'test', { requestId: 'anth1' });
    assert.ok(!result.error);
    const parsed = JSON.parse(result.body);
    assert.strictEqual(parsed.type, 'message');
    assert.strictEqual(parsed.role, 'assistant');
  });

  it('returns error for unknown model', async () => {
    const { handleAnthropicMessage } = await import('../src/anthropic.js');
    const result = await handleAnthropicMessage({
      model: 'nonexistent',
      messages: [{ role: 'user', content: 'hi' }],
    }, 'test', { requestId: 'anth2' });
    assert.ok(result.error);
    assert.ok(result.status >= 400);
  });
});

describe('logRequest — in-memory logging', () => {
  afterEach(cleanupMock);

  it('logs requests with correct fields', async () => {
    const { logRequest, getRecentLogs } = await import('../src/provider-client.js');
    logRequest({ model: 'gpt-4o', provider: 'test', status: 200, latencyMs: 100, agent: 'utest' });
    const logs = getRecentLogs(5, 'utest');
    assert.ok(logs.length >= 1);
    assert.strictEqual(logs[0].model, 'gpt-4o');
    assert.strictEqual(logs[0].status, 200);
  });
});

describe('v6.1 Regression — candidate loop, multi-key, strict cross-provider', () => {
  afterEach(cleanupMock);

  it('does not skip candidates in fallback (ci++ bug fix)', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    let callOrder = [];
    setupMock((url, opts) => {
      callOrder.push(JSON.parse(opts.body).model);
      return mockResponse({ error: 'fail' }, 500);
    });
    const candidates = [
      { model: 'first', provider: providerConfig(), providerName: 'p1', tier: 0 },
      { model: 'second', provider: providerConfig(), providerName: 'p2', tier: 1 },
    ];
    try {
      await executeCandidates(candidates, { messages: [] }, { agent: 'test', requestId: 'ci-test', maxAttemptsPerCandidate: 1, maxRetries: 4 });
    } catch {}
    assert.strictEqual(callOrder.length, 2, 'both candidates attempted');
    assert.strictEqual(callOrder[0], 'first');
    assert.strictEqual(callOrder[1], 'second');
  });

  it('switches keys on 401 and 403', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    let calls = [];
    const multiKeyProvider = {
      base_url: 'https://api.test.com/v1',
      api_key: 'sk-original-key',
      display: 'multi-key',
      api_type: 'openai',
      keys: [
        { id: 'k1', api_key: 'sk-key1', enabled: true, priority: 0 },
        { id: 'k2', api_key: 'sk-key2', enabled: true, priority: 0 },
      ],
    };
    setupMock((url, opts) => {
      const auth = opts.headers['Authorization'];
      calls.push(auth);
      if (auth === 'Bearer sk-key1') return mockResponse({ error: 'unauthorized' }, 401);
      return mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const result = await executeCandidates(
      [{ model: 'gpt-4o', provider: multiKeyProvider, providerName: 'multi-key', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 'key-test' }
    );
    assert.ok(result.success, 'second key succeeded');
    assert.strictEqual(calls.length, 2, 'called both keys');
    assert.ok(calls[0].includes('sk-key1'), 'first call uses key1');
    assert.ok(calls[1].includes('sk-key2'), 'second call uses key2');
  });

  it('Anthropic multi-turn tool result splitting', async () => {
    const { toOpenAIBody } = await import('../src/anthropic.js');
    const result = toOpenAIBody({
      model: 'claude-4',
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'what is the weather?' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'sunny' }] },
        ]},
        { role: 'assistant', content: [{ type: 'text', text: 'It is sunny.' }] },
      ],
      max_tokens: 100,
    });
    const msgs = result.body.messages;
    assert.strictEqual(msgs.length, 3, 'user split into user + tool, plus assistant');
    assert.strictEqual(msgs[0].role, 'user');
    assert.strictEqual(msgs[0].content, 'what is the weather?');
    assert.strictEqual(msgs[1].role, 'tool');
    assert.strictEqual(msgs[1].content, 'sunny');
    assert.strictEqual(msgs[1].tool_call_id, 'toolu_1');
    assert.strictEqual(msgs[2].role, 'assistant');
  });
});

describe('Key sanitization and config atomic save', () => {
  afterEach(cleanupMock);

  it('recursively sanitizes api_key and custom_headers', async () => {
    const { sanitizeConfigForClient } = await import('../src/provider-client.js');
    const dirty = {
      providers: {
        test: {
          api_key: 'sk-abcdefghijklmnopqrst',
          custom_headers: { 'X-Auth-Token': 'secret-value-12345' },
          keys: [{ id: 'k1', api_key: 'sk-aaaaaaaaaaaa' }],
        },
      },
      adminToken: 'super-secret-token',
    };
    const clean = sanitizeConfigForClient(dirty);
    assert.ok(clean.providers.test.api_key.endsWith('qrst'), 'ends with last 4 chars');
    assert.ok(clean.providers.test.api_key.startsWith('*'), 'masked with stars');
    assert.ok(clean.providers.test.custom_headers['X-Auth-Token'].includes('****'), 'custom header masked');
    assert.ok(clean.providers.test.keys[0].api_key.includes('****'), 'keys array api_key masked');
    assert.strictEqual(clean.adminToken, '***', 'admin token masked');
  });
});

describe('Cost DB multi-provider recording', () => {
  afterEach(cleanupMock);

  it('records and retrieves cost across providers', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { unlinkSync } = await import('node:fs');
    const { recordCost, getCostOverview, getCostDaily } = await import('../src/cost.js');
    const dbPath = '/tmp/smart-router-cost-test.db';
    try { unlinkSync(dbPath); } catch {}
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS cost_daily (
      date TEXT NOT NULL, model TEXT NOT NULL, provider TEXT DEFAULT '',
      requests INTEGER DEFAULT 1, tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0, cost_rmb REAL DEFAULT 0,
      PRIMARY KEY (date, model, provider)
    )`);
    const upsert = db.prepare(
      'INSERT INTO cost_daily (date, model, provider, requests, tokens_in, tokens_out, cost_rmb) VALUES (?,?,?,?,?,?,?) ON CONFLICT(date, model, provider) DO UPDATE SET requests = requests + 1, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_rmb = cost_rmb + ?'
    );
    recordCost(db, upsert, 'gpt-4o', 'provider-a', 100, 50, 'test');
    recordCost(db, upsert, 'claude-4', 'provider-b', 200, 100, 'test');
    const overview = getCostOverview(db);
    assert.ok(overview.total.requests >= 2, 'at least 2 requests recorded');
    assert.ok(overview.total.cost_rmb > 0, 'cost > 0');
    const daily = getCostDaily(db, 1);
    assert.ok(daily.length >= 2, 'at least 2 entries across providers');
    db.close();
    try { unlinkSync(dbPath); } catch {}
  });
});
