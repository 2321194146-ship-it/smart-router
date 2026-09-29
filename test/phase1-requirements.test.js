/**
 * Phase 1 behaviour tests — key state machine, provider fallback, strict cross-provider,
 * config security, cost recording. These cover the requirements from the takeover audit
 * that the original OpenCode candidate tests did NOT verify.
 *
 * Run: node --test test/phase1-requirements.test.js
 */
import { describe, it, after, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { mockResponse, providerConfig, testConfig } from './helpers.js';
import { getConfig } from '../src/config.js';

const CFG_PATH = '/tmp/smart-router-phase1-config.json';
process.env.CONFIG_FILE = CFG_PATH;
writeFileSync(CFG_PATH, JSON.stringify(testConfig));

let fetchMock = null;
function setupMock(handler) {
  if (fetchMock) mock.restoreAll();
  fetchMock = mock.method(globalThis, 'fetch', handler);
}
function cleanupMock() {
  mock.restoreAll();
  fetchMock = null;
}

describe('Phase 1 — multi-key state machine (401/403/429)', () => {
  afterEach(cleanupMock);

  it('switches to next key after 401 (auth failure)', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    const cfg = getConfig();
    cfg.providers['p1k401'] = {
      base_url: 'https://api.test.com/v1',
      keys: [{ id: 'k1', api_key: 'sk-401-k1' }, { id: 'k2', api_key: 'sk-401-k2' }],
      display: 'p1k401', api_type: 'openai',
    };
    cfg.models.push({ id: 'm401', name: 'm401', provider: 'p1k401', enabled: true, tier: 0 });
    const calls = [];
    setupMock((url, opts) => {
      calls.push(opts.headers['Authorization']);
      return calls.length === 1
        ? mockResponse({ error: 'unauthorized' }, 401)
        : mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const result = await executeCandidates(
      [{ model: 'm401', provider: cfg.providers['p1k401'], providerName: 'p1k401', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 'ph1', maxRetries: 5 }
    );
    assert.ok(result.success, 'second key succeeded');
    assert.strictEqual(calls.length, 2, 'key1 401 → key2 200');
    assert.ok(calls[1].includes('sk-401-k2'), 'second call used key2');
  });

  it('switches to next key IMMEDIATELY after 403 (no repeated 403) and does NOT permanently invalidate on an unclassifiable 403', async () => {
    const { executeCandidates, getKeyState } = await import('../src/provider-client.js');
    const cfg = getConfig();
    cfg.providers['p1k403'] = {
      base_url: 'https://api.test.com/v1',
      keys: [{ id: 'k1', api_key: 'sk-403-k1' }, { id: 'k2', api_key: 'sk-403-k2' }],
      display: 'p1k403', api_type: 'openai',
    };
    cfg.models.push({ id: 'm403', name: 'm403', provider: 'p1k403', enabled: true, tier: 0 });
    const calls = [];
    setupMock((url, opts) => {
      calls.push(opts.headers['Authorization']);
      return calls.length === 1
        ? mockResponse({ error: 'forbidden' }, 403)
        : mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const result = await executeCandidates(
      [{ model: 'm403', provider: cfg.providers['p1k403'], providerName: 'p1k403', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 'ph2', maxRetries: 5 }
    );
    assert.ok(result.success, 'succeeded with key2 after 403 on key1');
    assert.strictEqual(calls.length, 2, 'key1 got 403, key2 got 200 (no repeated 403 to key1)');
    assert.ok(calls[1].includes('sk-403-k2'), 'second call used key2');
    // Phase-2 rule: an UNCLASSIFIABLE plain 403 must NOT permanently invalidate the key — it is
    // only temporarily cooled, and the request immediately retries the next key.
    assert.strictEqual(getKeyState('p1k403', 'k1').invalid, false, 'unclassifiable 403 only cools the key temporarily, never invalidates');
    assert.ok(getKeyState('p1k403', 'k1').cooldownUntil > Date.now(), 'a temporary cooldown was applied to the 403-struck key');
  });

  it('switches provider after ALL keys of a provider fail', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    const cfg = getConfig();
    cfg.providers['p1Fail'] = {
      base_url: 'https://api.test.com/v1',
      keys: [{ id: 'k1', api_key: 'sk-fail-k1' }, { id: 'k2', api_key: 'sk-fail-k2' }],
      display: 'p1Fail', api_type: 'openai',
    };
    cfg.providers['p1Ok'] = {
      base_url: 'https://api.test.com/v1',
      keys: [{ id: 'ok1', api_key: 'sk-ok-1' }],
      display: 'p1Ok', api_type: 'openai',
    };
    cfg.models.push({ id: 'mFail', name: 'mFail', provider: 'p1Fail', enabled: true, tier: 0 });
    cfg.models.push({ id: 'mOk', name: 'mOk', provider: 'p1Ok', enabled: true, tier: 1 });
    const calls = [];
    setupMock((url, opts) => {
      calls.push(opts.headers['Authorization']);
      return mockResponse({ error: 'unauthorized' }, 401);
    });
    await assert.rejects(
      executeCandidates(
        [
          { model: 'mFail', provider: cfg.providers['p1Fail'], providerName: 'p1Fail', tier: 0 },
          { model: 'mOk', provider: cfg.providers['p1Ok'], providerName: 'p1Ok', tier: 1 },
        ],
        { messages: [{ role: 'user', content: 'hi' }] },
        { agent: 'test', requestId: 'ph4' }
      ),
      /All providers unavailable/,
      'all keys of p1Fail failed → must fall through to p1Ok, then throw when p1Ok also fails'
    );
    assert.ok(calls.includes('Bearer sk-fail-k1'), 'p1Fail key1 tried');
    assert.ok(calls.includes('Bearer sk-fail-k2'), 'p1Fail key2 tried (both keys attempted)');
    assert.ok(calls.includes('Bearer sk-ok-1'), 'switched to provider p1Ok after p1Fail keys exhausted');
  });
});

describe('Phase 1 — strict model cross-provider failover', () => {
  afterEach(cleanupMock);

  it('strict model fails over to another provider serving the SAME model', async () => {
    const { executeCandidates } = await import('../src/provider-client.js');
    const cfg = getConfig();
    cfg.providers['spA'] = { base_url: 'https://a.test.com/v1', keys: [{ id: 'a1', api_key: 'sk-spA' }], display: 'spA', api_type: 'openai' };
    cfg.providers['spB'] = { base_url: 'https://b.test.com/v1', keys: [{ id: 'b1', api_key: 'sk-spB' }], display: 'spB', api_type: 'openai' };
    cfg.models.push({ id: 'shared-model', name: 'shared-model', provider: 'spA', enabled: true, tier: 0 });
    cfg.models.push({ id: 'shared-model', name: 'shared-model', provider: 'spB', enabled: true, tier: 1 });
    const calls = [];
    setupMock((url) => {
      calls.push(url);
      return url.includes('a.test')
        ? mockResponse({ error: 'server error' }, 500)
        : mockResponse({ choices: [{ message: { content: 'ok from B' } }] });
    });
    const result = await executeCandidates(
      [
        { model: 'shared-model', provider: cfg.providers['spA'], providerName: 'spA', tier: 0, strict: true },
        { model: 'shared-model', provider: cfg.providers['spB'], providerName: 'spB', tier: 1, strict: true },
      ],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 'ph6', maxRetries: 1, maxAttemptsPerCandidate: 1 }
    );
    assert.ok(result.success, 'should succeed via provider B');
    assert.strictEqual(result.provider, 'spB', 'must use provider B (same model, different provider)');
    assert.strictEqual(result.model, 'shared-model', 'model unchanged (no model switch)');
    assert.ok(calls[0].includes('a.test') && calls[1].includes('b.test'), 'tried A then B');
  });
});

describe('Phase 1 — preferred model fallback', () => {
  afterEach(cleanupMock);

  it('preferred model failure falls back to auto candidates', async () => {
    const { routeChatCompletion } = await import('../src/provider-client.js');
    setupMock((url, opts) => {
      const model = JSON.parse(opts.body).model;
      if (model === 'gpt-4o') return mockResponse({ error: 'server error' }, 500);
      return mockResponse({ choices: [{ message: { content: 'ok auto' } }] });
    });
    const result = await routeChatCompletion(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      'test',
      { requestId: 'ph7', preferredModel: 'gpt-4o', maxRetries: 1, maxAttemptsPerCandidate: 1 }
    );
    assert.ok(result.success, 'fallback to auto model succeeded');
    assert.strictEqual(result.model, 'gpt-4o-mini', 'fell back to auto model (not preferred)');
  });
});

describe('Phase 1 — cooldown respected (keys & providers)', () => {
  afterEach(cleanupMock);

  it('rate-limited key is put into cooldown and skipped', async () => {
    const { executeCandidates, getKeyState } = await import('../src/provider-client.js');
    const cfg = getConfig();
    cfg.providers['cdp'] = {
      base_url: 'https://api.test.com/v1',
      keys: [{ id: 'a', api_key: 'sk-cd-a' }, { id: 'b', api_key: 'sk-cd-b' }],
      display: 'cdp', api_type: 'openai',
    };
    cfg.models.push({ id: 'cdm', name: 'cdm', provider: 'cdp', enabled: true, tier: 0 });
    setupMock((url, opts) => {
      if (opts.headers['Authorization'].includes('sk-cd-a')) return mockResponse({ error: 'rate limited' }, 429);
      return mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    // call 1: key a 429 (cooled), key b 200 → success
    const r1 = await executeCandidates(
      [{ model: 'cdm', provider: cfg.providers['cdp'], providerName: 'cdp', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 'cd1', maxRetries: 3, maxAttemptsPerCandidate: 2 }
    );
    assert.ok(r1.success);
    assert.ok(getKeyState('cdp', 'a').cooldownUntil > Date.now(), 'key a in cooldown after 429');
    // call 2: key a cooled → must use key b, never key a
    const used = [];
    setupMock((url, opts) => {
      used.push(opts.headers['Authorization']);
      if (opts.headers['Authorization'].includes('sk-cd-a')) return mockResponse({ error: 'rate limited' }, 429);
      return mockResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    await executeCandidates(
      [{ model: 'cdm', provider: cfg.providers['cdp'], providerName: 'cdp', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 'cd2', maxRetries: 3, maxAttemptsPerCandidate: 2 }
    );
    assert.strictEqual(used.length, 1, 'cd2 made exactly one call');
    assert.ok(used[0].includes('sk-cd-b'), 'cd2 used non-cooled key b');
    assert.ok(!used[0].includes('sk-cd-a'), 'cd2 did NOT reuse cooled key a');
  });

  it('a provider in cooldown is skipped (not called again)', async () => {
    const { routeChatCompletion } = await import('../src/provider-client.js');
    const cfg = getConfig();
    cfg.providers['pcp'] = { base_url: 'https://api.test.com/v1', keys: [{ id: 'a', api_key: 'sk-pc-a' }], display: 'pcp', api_type: 'openai' };
    cfg.models.push({ id: 'pcm1', name: 'pcm1', provider: 'pcp', enabled: true, tier: 0 });
    cfg.models.push({ id: 'pcm2', name: 'pcm2', provider: 'pcp', enabled: true, tier: 0 });
    let calls = 0;
    setupMock(() => { calls++; return mockResponse({ error: 'server' }, 500); });
    for (let i = 0; i < 3; i++) {
      await routeChatCompletion(
        { model: 'pcm1', messages: [{ role: 'user', content: 'hi' }] },
        'test',
        { requestId: 'pc' + i, maxRetries: 1, maxAttemptsPerCandidate: 1 }
      ).catch(() => {});
    }
    const afterCool = calls; // pcp now cooled (3 failures >= failureThreshold)
    await routeChatCompletion(
      { model: 'pcm2', messages: [{ role: 'user', content: 'hi' }] },
      'test',
      { requestId: 'pcFinal', maxRetries: 1, maxAttemptsPerCandidate: 1 }
    ).catch(() => {});
    assert.strictEqual(calls, afterCool, 'provider pcp in cooldown was NOT called again for pcm2');
  });
});

describe('Phase 1 — success must not increase failureCount', () => {
  afterEach(cleanupMock);

  it('a successful call leaves failureCount unchanged', async () => {
    const { executeCandidates, getKeyState } = await import('../src/provider-client.js');
    const cfg = getConfig();
    cfg.providers['sc'] = { base_url: 'https://api.test.com/v1', keys: [{ id: 'a', api_key: 'sk-sc-a' }], display: 'sc', api_type: 'openai' };
    cfg.models.push({ id: 'scm', name: 'scm', provider: 'sc', enabled: true, tier: 0 });
    // cause one failure first
    setupMock(() => mockResponse({ error: 'server' }, 500));
    await executeCandidates(
      [{ model: 'scm', provider: cfg.providers['sc'], providerName: 'sc', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 'sc-a', maxRetries: 1, maxAttemptsPerCandidate: 1 }
    ).catch(() => {});
    const failedCount = getKeyState('sc', 'a').failureCount;
    assert.ok(failedCount >= 1, 'failureCount increased after a failure');
    // now succeed
    setupMock(() => mockResponse({ choices: [{ message: { content: 'ok' } }] }));
    const result = await executeCandidates(
      [{ model: 'scm', provider: cfg.providers['sc'], providerName: 'sc', tier: 0 }],
      { messages: [{ role: 'user', content: 'hi' }] },
      { agent: 'test', requestId: 'sc-b' }
    );
    assert.ok(result.success);
    const st = getKeyState('sc', 'a');
    assert.strictEqual(st.failureCount, failedCount, 'failureCount NOT increased by success');
    assert.strictEqual(st.consecutiveFailures, 0, 'consecutiveFailures reset to 0');
    assert.strictEqual(st.successCount, 1, 'successCount incremented');
  });
});

describe('Phase 1 — config interface security', () => {
  after(cleanupMock);

  it('config endpoint does not leak raw api keys (sanitizeConfigForClient)', async () => {
    // The /api/config endpoint wraps getConfig() with sanitizeConfigForClient,
    // so exercising the sanitizer directly validates the contract without
    // spinning up the DB-backed HTTP server (which would keep the process alive).
    const { sanitizeConfigForClient } = await import('../src/provider-client.js');
    const rawConfig = {
      adminToken: 'super-secret-admin-token',
      providers: {
        openai: {
          base_url: 'https://api.openai.com/v1',
          api_key: 'sk-test-key-abc123def456',
          keys: [{ id: 'k1', api_key: 'sk-raw-key-one' }, { id: 'k2', api_key: 'sk-raw-key-two' }],
          custom_headers: { Authorization: 'Bearer sk-header-secret', 'X-Model': 'gpt-4o' },
        },
      },
    };
    const safe = sanitizeConfigForClient(rawConfig);
    const str = JSON.stringify(safe);
    assert.ok(!str.includes('sk-test-key-abc123def456'), 'raw provider api_key must not appear');
    assert.ok(!str.includes('sk-raw-key-one'), 'raw keys[].api_key must not appear');
    assert.ok(!str.includes('sk-raw-key-two'), 'raw keys[].api_key must not appear');
    assert.ok(!str.includes('super-secret-admin-token'), 'adminToken must not appear');
    assert.ok(!str.includes('sk-header-secret'), 'custom_headers secret must not appear');
    // Masked values keep only the last 4 chars, so 'f456' (from sk-test-key-...-f456) survives.
    assert.ok(str.includes('f456'), 'masked api_key preserves only last 4 chars');
    assert.ok(str.includes('X-Model'), 'non-secret custom header is preserved');
  });
});

describe('Phase 1 — raw config save & reload', () => {
  afterEach(cleanupMock);

  it('saveRawConfigAtomic then reload restores raw config', async () => {
    const fs = await import('node:fs');
    const { saveRawConfigAtomic, getConfig, reloadConfig } = await import('../src/config.js');
    getConfig(); // ensure config is loaded
    const original = fs.readFileSync(CFG_PATH, 'utf8');
    try {
      const raw = {
        providers: {
          pp: { base_url: 'https://x/v1', api_key: 'sk-raw-123', keys: [{ id: 'k', api_key: 'sk-raw-k' }], display: 'pp', api_type: 'openai' },
        },
        models: [{ id: 'mm', name: 'mm', provider: 'pp', enabled: true, tier: 0 }],
        roles: {},
        routing: { maxRetries: 2 },
      };
      saveRawConfigAtomic(raw);
      const onDisk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      assert.strictEqual(onDisk.providers.pp.api_key, 'sk-raw-123', 'raw api_key persisted to disk');
      assert.strictEqual(onDisk.providers.pp.keys[0].api_key, 'sk-raw-k', 'raw keys persisted to disk');
      const cfg = reloadConfig();
      assert.strictEqual(cfg.providers.pp.api_key, 'sk-raw-123', 'reload sees raw api_key');
      assert.strictEqual(cfg.models.find((m) => m.id === 'mm').provider, 'pp', 'reload normalized models');
    } finally {
      fs.writeFileSync(CFG_PATH, original);
      reloadConfig();
    }
  });
});

// Keep the process able to exit cleanly even if a server interval slips through.
after(cleanupMock);
