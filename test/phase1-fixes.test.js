/**
 * Phase 1 fixes — regression tests for the ten blocking issues.
 * Covers: multi-key traversal, non-permanent key disabling on 5xx/network,
 * timer leak on network errors, distinct attempt caps, 403 classification,
 * ${ENV} placeholder expansion, and browser auth / CORS.
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';

import {
  executeCandidates, getKeyState, resetAllKeyStates,
  getAvailableKeys, classifyForbidden, isQuotaExhausted,
} from '../src/provider-client.js';
import { expandEnv, getConfig } from '../src/config.js';
import { authenticate, CORS_ALLOWED_HEADERS } from '../src/server.js';
import { mockResponse } from './helpers.js';

// ---- local fixtures -------------------------------------------------------
function multiKeyProvider(name, keys, opts = {}) {
  return {
    base_url: 'https://api.test.local/v1',
    display: name,
    api_type: 'openai',
    enabled: true,
    ...opts,
    keys: keys.map((k, i) => ({ id: 'k' + i, api_key: k, priority: i })),
  };
}
function singleProvider(name, apiKey, opts = {}) {
  return { base_url: 'https://api.test.local/v1', display: name, api_type: 'openai', enabled: true, ...opts, api_key: apiKey };
}
function candidate(model, provider, providerName, extra = {}) {
  return { model, provider, providerName, tier: 0, ...extra };
}
function okBody() { return { choices: [{ message: { content: 'ok' } }] }; }
function ctx(over = {}) {
  return { agent: 'test', requestId: 'fix', maxAttemptsPerKey: 2, maxTotalUpstreamCalls: 20, ...over };
}
function messages() { return [{ role: 'user', content: 'hi' }]; }

afterEach(() => {
  mock.reset();
  resetAllKeyStates();
  try { getConfig().adminToken = ''; } catch {}
});

// ---- I. every available key gets a chance ---------------------------------
describe('I. all available keys are attempted', () => {
  it('Key1 401, Key2 401, Key3 200 → succeeds with Key3', async () => {
    const used = [];
    mock.method(globalThis, 'fetch', async (url, opts) => {
      const auth = opts.headers['Authorization'];
      used.push(auth);
      if (auth.includes('sk-a')) return mockResponse({ error: 'unauthorized' }, 401);
      if (auth.includes('sk-b')) return mockResponse({ error: 'unauthorized' }, 401);
      return mockResponse(okBody());
    });
    const prov = multiKeyProvider('p', ['sk-a', 'sk-b', 'sk-c']);
    const result = await executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 1 }));
    assert.strictEqual(result.success, true);
    assert.ok(used.includes('Bearer sk-a'), 'key1 tried');
    assert.ok(used.includes('Bearer sk-b'), 'key2 tried');
    assert.ok(used.some(u => u.includes('sk-c')), 'key3 used for success');
  });

  it('four keys mixed 401/429 → succeeds on the working key', async () => {
    const used = [];
    mock.method(globalThis, 'fetch', async (url, opts) => {
      const auth = opts.headers['Authorization'];
      used.push(auth);
      if (auth.includes('sk-a')) return mockResponse({ error: 'unauthorized' }, 401);
      if (auth.includes('sk-b')) return mockResponse({ error: 'rate limited' }, 429);
      if (auth.includes('sk-c')) return mockResponse({ error: 'unauthorized' }, 401);
      return mockResponse(okBody());
    });
    const prov = multiKeyProvider('p', ['sk-a', 'sk-b', 'sk-c', 'sk-d']);
    const result = await executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 1 }));
    assert.strictEqual(result.success, true);
    assert.ok(used.some(u => u.includes('sk-d')), 'fourth key used');
  });
});

// ---- II. 5xx / network must NOT permanently disable a key ------------------
describe('II. server & network errors do not invalidate keys', () => {
  it('same key 3x 500 → invalid stays false, key retried each time', async () => {
    const used = [];
    mock.method(globalThis, 'fetch', async (url, opts) => {
      used.push(opts.headers['Authorization']);
      return mockResponse({ error: 'boom' }, 500);
    });
    const prov = singleProvider('p', 'sk-only');
    await assert.rejects(executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 3 })));
    assert.strictEqual(used.length, 3, 'key retried 3 times');
    assert.strictEqual(getKeyState('p', 'default').invalid, false, '500 must NOT invalidate the key');
  });

  it('after provider recovers the key can be called again successfully', async () => {
    mock.method(globalThis, 'fetch', async () => mockResponse({ error: 'boom' }, 500));
    const prov = singleProvider('p', 'sk-only');
    await assert.rejects(executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 2 })));
    assert.strictEqual(getKeyState('p', 'default').invalid, false);
    // simulate recovery: reset provider/key health, then succeed
    resetAllKeyStates();
    mock.method(globalThis, 'fetch', async () => mockResponse(okBody()));
    const result = await executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 2 }));
    assert.strictEqual(result.success, true, 'recovered key serves the request');
  });

  it('network error must not permanently disable the key', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new Error('getaddrinfo ENOTFOUND api.test.local'); });
    const prov = singleProvider('p', 'sk-only');
    await assert.rejects(executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 2 })));
    assert.strictEqual(getKeyState('p', 'default').invalid, false, 'network error must NOT invalidate the key');
  });

  it('401 still immediately invalidates the key', async () => {
    mock.method(globalThis, 'fetch', async () => mockResponse({ error: 'unauthorized' }, 401));
    const prov = singleProvider('p', 'sk-only');
    await assert.rejects(executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 1 })));
    assert.strictEqual(getKeyState('p', 'default').invalid, true, '401 must invalidate the key');
  });
});

// ---- III. no timer leak on network errors ---------------------------------
describe('III. network errors do not leak timers', () => {
  it('many consecutive network errors complete and keep the process exit-able', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNRESET'); });
    const prov = singleProvider('p', 'sk-only');
    for (let i = 0; i < 50; i++) {
      await assert.rejects(executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 1 })));
    }
    // If a 20s timeout timer had leaked per call, the suite would never finish.
    assert.strictEqual(getKeyState('p', 'default').invalid, false);
  });
});

// ---- IV. distinct, real attempt caps --------------------------------------
describe('IV. attempt caps are distinct and the global cap is hard', () => {
  it('configured total cap of 3 → at most 3 upstream calls', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => { calls++; return mockResponse({ error: 'x' }, 500); });
    const prov = singleProvider('p', 'sk-only');
    await assert.rejects(executeCandidates(
      [candidate('m', prov, 'p')],
      { messages: messages() },
      ctx({ maxAttemptsPerKey: 100, maxTotalUpstreamCalls: 3 })
    ));
    assert.strictEqual(calls, 3, 'hard global cap must limit to exactly 3 upstream calls');
  });

  it('three normal keys are not truncated by the default cap', async () => {
    const used = [];
    mock.method(globalThis, 'fetch', async (url, opts) => {
      used.push(opts.headers['Authorization']);
      if (opts.headers['Authorization'].includes('sk-c')) return mockResponse(okBody());
      return mockResponse({ error: 'unauthorized' }, 401);
    });
    const prov = multiKeyProvider('p', ['sk-a', 'sk-b', 'sk-c']);
    // rely on default caps (no override that would truncate)
    const result = await executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, { agent: 't', requestId: 'fix' });
    assert.strictEqual(result.success, true, 'third key still attempted and succeeds');
    assert.ok(used.some(u => u.includes('sk-c')));
  });

  it('first provider cannot consume the whole budget and starve the next', async () => {
    const used = [];
    mock.method(globalThis, 'fetch', async (url, opts) => {
      const auth = opts.headers['Authorization'];
      used.push(auth);
      if (auth.includes('A-')) return mockResponse({ error: 'boom' }, 500); // provider A always fails
      return mockResponse(okBody()); // provider B succeeds
    });
    const provA = multiKeyProvider('A', ['sk-A-1', 'sk-A-2', 'sk-A-3']);
    const provB = singleProvider('B', 'sk-B-1');
    const result = await executeCandidates(
      [candidate('m', provA, 'A'), candidate('m', provB, 'B')],
      { messages: messages() },
      ctx({ maxAttemptsPerKey: 2, maxTotalUpstreamCalls: 20 })
    );
    assert.strictEqual(result.success, true, 'failover to provider B must succeed');
    assert.ok(used.some(u => u.includes('sk-B-1')), 'provider B was reached');
  });
});

// ---- V. 403 classification ------------------------------------------------
describe('V. 403 is classified, not blanket-invalidated', () => {
  it('model-level 403 bans only that key+model, key still serves other models', async () => {
    mock.method(globalThis, 'fetch', async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.model === 'model-a') return mockResponse({ error: 'You do not have access to model model-a' }, 403);
      return mockResponse(okBody());
    });
    const prov = singleProvider('p', 'sk1');
    await assert.rejects(executeCandidates([candidate('model-a', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 1 })));
    const st = getKeyState('p', 'default');
    assert.strictEqual(st.invalid, false, 'model-level 403 must NOT invalidate the key');
    assert.ok(st.forbiddenModels.has('model-a'), 'model-a recorded as forbidden for this key');
    const result = await executeCandidates([candidate('model-b', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 1 }));
    assert.strictEqual(result.success, true, 'same key still serves model-b');
  });

  it('key/account-level 403 invalidates the key', async () => {
    mock.method(globalThis, 'fetch', async () => mockResponse({ error: 'Invalid API key' }, 403));
    const prov = singleProvider('p', 'sk1');
    await assert.rejects(executeCandidates([candidate('m', prov, 'p')], { messages: messages() }, ctx({ maxAttemptsPerKey: 1 })));
    assert.strictEqual(getKeyState('p', 'default').invalid, true, 'key-level 403 invalidates the key');
  });
});

// ---- VI. ${ENV} placeholder expansion -------------------------------------
describe('VI. config env placeholders', () => {
  it('resolves ${ENV} when the variable exists', () => {
    process.env.MY_TEST_KEY = 'topsecret-value';
    const out = expandEnv({ providers: { p: { base_url: 'https://x/v1', api_key: '${MY_TEST_KEY}' } } });
    assert.strictEqual(out.providers.p.api_key, 'topsecret-value');
    delete process.env.MY_TEST_KEY;
  });

  it('disables the key when ${ENV} is missing and never forwards the placeholder', () => {
    const out = expandEnv({ providers: { p: { base_url: 'https://x/v1', api_key: '${MISSING_KEY_XYZ}' } } });
    assert.strictEqual(out.providers.p.enabled, false, 'key disabled when placeholder unresolved');
    assert.notStrictEqual(out.providers.p.api_key, '${MISSING_KEY_XYZ}');
    assert.ok(!JSON.stringify(out).includes('${MISSING_KEY_XYZ}'), 'placeholder never sent to provider');
  });

  it('disabled provider yields no available keys', () => {
    const out = expandEnv({ providers: { p: { base_url: 'https://x/v1', api_key: '${MISSING_KEY_XYZ}' } } });
    assert.strictEqual(getAvailableKeys(out.providers.p, 'p', 'm', 0).length, 0);
  });
});

// ---- VII. browser auth & CORS ---------------------------------------------
describe('VII. browser auth and CORS', () => {
  it('CORS allowed headers include X-Api-Key and Authorization', () => {
    const headers = CORS_ALLOWED_HEADERS.split(',').map(s => s.trim());
    assert.ok(headers.includes('X-Api-Key'), 'X-Api-Key must be an allowed CORS header');
    assert.ok(headers.includes('Authorization'), 'Authorization must be an allowed CORS header');
  });

  it('localhost client allowed, remote client denied when no admin token', () => {
    getConfig().adminToken = '';
    assert.strictEqual(authenticate({ socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.strictEqual(authenticate({ socket: { remoteAddress: '203.0.113.5' } }), false);
  });

  it('with admin token: Bearer and X-Api-Key accepted, wrong rejected', () => {
    getConfig().adminToken = 'secret-token';
    const bearer = { socket: { remoteAddress: '203.0.113.5' }, headers: { authorization: 'Bearer secret-token' } };
    const xkey = { socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-api-key': 'secret-token' } };
    const wrong = { socket: { remoteAddress: '203.0.113.5' }, headers: { authorization: 'Bearer nope' } };
    const none = { socket: { remoteAddress: '203.0.113.5' }, headers: {} };
    assert.strictEqual(authenticate(bearer), true);
    assert.strictEqual(authenticate(xkey), true);
    assert.strictEqual(authenticate(wrong), false);
    assert.strictEqual(authenticate(none), false);
  });

  it('OPTIONS preflight is permitted (CORS advertises X-Api-Key)', () => {
    // The server returns 204 for OPTIONS before authentication; verify the CORS
    // policy would allow a browser preflight carrying X-Api-Key.
    assert.ok(CORS_ALLOWED_HEADERS.includes('X-Api-Key'));
  });
});

// sanity: classifier helpers
describe('403 classifier helpers', () => {
  it('classifyForbidden distinguishes key / model / provider / unknown', () => {
    assert.strictEqual(classifyForbidden('{"error":"Invalid API key"}'), 'key_forbidden');
    assert.strictEqual(classifyForbidden('You do not have access to model claude-opus'), 'model_forbidden');
    assert.strictEqual(classifyForbidden('Model not supported in your region'), 'provider_cooldown');
    assert.strictEqual(classifyForbidden('Forbidden'), 'conservative_cooldown');
  });
  it('isQuotaExhausted detects quota language', () => {
    assert.strictEqual(isQuotaExhausted('quota exceeded'), true);
    assert.strictEqual(isQuotaExhausted('rate limit reached'), false);
  });
});
