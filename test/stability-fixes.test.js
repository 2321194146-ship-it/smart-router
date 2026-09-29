/**
 * Stability fixes — Phase 2 (final stability hardening)
 *
 * Covers:
 *  (1) Provider-level failures must NOT cycle through every key of a dead provider
 *      and starve healthy providers of the global call budget.
 *  (2) An unclassifiable (plain) 403 must NOT permanently invalidate a key.
 *
 * Uses the real module code paths with a mocked global fetch so each provider/key can be
 * made to fail or succeed. Candidates carry their own `provider.keys` (which is exactly what
 * getAvailableKeys reads), so no external key registration is needed.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert';
import {
  executeCandidates, classifyForbidden,
  getKeyState, getAvailableKeys, resetKeyState, resetAllKeyStates, resetProviderState,
} from '../src/provider-client.js';

let fetchCalls = [];

function makeMessages() {
  return [{ role: 'user', content: 'hello' }];
}

// Build a candidate whose provider carries its own key list (what getAvailableKeys reads).
function candidate(model, name, base, keys) {
  return {
    model,
    modelName: model,
    providerName: name,
    provider: {
      base_url: base,
      api_type: 'openai',
      keys: keys.map((apiKey, i) => ({ id: `${name.toLowerCase()}${i + 1}`, key: apiKey, api_key: apiKey })),
    },
  };
}

function ctx(overrides = {}) {
  return {
    protocol: 'openai',
    agent: 'test',
    maxAttemptsPerKey: 2,
    maxKeysPerProvider: 0,
    maxProvidersPerRequest: 0,
    maxTotalUpstreamCalls: 3,
    ...overrides,
  };
}

function okBody(tag) {
  return { choices: [{ message: { role: 'assistant', content: `ok-${tag}` } }] };
}

function mockResp(body, status) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const resp = {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => text,
    headers: { get: () => null },
  };
  resp.clone = () => mockResp(body, status);
  return resp;
}

function installFetch(handler) {
  fetchCalls = [];
  return mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls.push({ url, auth: (opts && opts.headers && opts.headers.Authorization) || '' });
    return handler(url, opts);
  });
}

function countUrl(substr) {
  return fetchCalls.filter((c) => c.url.includes(substr)).length;
}

// A single-provider 403 legitimately exhausts all candidates, so executeCandidates throws
// "All providers unavailable". The key-state side effects we assert happen before that throw,
// so swallow the exhaustion error here and keep inspecting keyState.
async function runIgnoringExhaustion(candidates, ctxObj) {
  try {
    return await executeCandidates(candidates, { messages: makeMessages() }, ctxObj);
  } catch (e) {
    if (/All providers unavailable/.test(e.message)) return null;
    throw e;
  }
}

test.afterEach(() => {
  resetAllKeyStates();
  for (const n of ['A', 'B', 'C']) resetProviderState(n);
});

// ---------------------------------------------------------------------------
// (1) Provider-level failures must yield to the next provider quickly
// ---------------------------------------------------------------------------

test('5xx on provider A burns only the single-provider retry budget; provider B still succeeds', async () => {
  const restore = installFetch((url) => {
    if (url.includes('provider-a.test')) return mockResp({ error: 'server error' }, 500);
    return mockResp(okBody('B'), 200);
  });
  try {
    const candidates = [
      candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1', 'K_A2', 'K_A3']),
      candidate('m', 'B', 'http://provider-b.test/v1', ['K_B1']),
    ];
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx());
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'B', 'healthy provider B must be reached');
  } finally {
    restore.mock.restore();
  }
  // A only gets the single-provider retry budget (maxAttemptsPerKey = 2), not all 3 keys.
  assert.strictEqual(countUrl('provider-a.test'), 2, 'A should only burn the provider retry budget, not all its keys');
  assert.strictEqual(countUrl('provider-b.test'), 1, 'B must get a chance within the global cap');
});

test('network failure on provider A falls through to provider B', async () => {
  const restore = installFetch((url) => {
    if (url.includes('provider-a.test')) throw new Error('connect ECONNREFUSED');
    return mockResp(okBody('B'), 200);
  });
  try {
    const candidates = [
      candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1', 'K_A2', 'K_A3']),
      candidate('m', 'B', 'http://provider-b.test/v1', ['K_B1']),
    ];
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx());
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'B');
  } finally {
    restore.mock.restore();
  }
  assert.strictEqual(countUrl('provider-a.test'), 2, 'A network failures must not exhaust the global call budget');
});

test('429 (key-level) still rotates to the next key within the same provider', async () => {
  const restore = installFetch((url, opts) => {
    // First key hits a 429, second key succeeds — must succeed inside provider A.
    if (url.includes('provider-a.test')) {
      if (opts.headers.Authorization.includes('K_A1')) return mockResp({ error: 'rate limited' }, 429);
      return mockResp(okBody('A2'), 200);
    }
    return mockResp(okBody('B'), 200);
  });
  try {
    const candidates = [candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1', 'K_A2', 'K_A3'])];
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx({ maxTotalUpstreamCalls: 3 }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'A', '429 must rotate keys inside A, not bail to another provider');
  } finally {
    restore.mock.restore();
  }
  assert.strictEqual(countUrl('provider-a.test'), 2, 'only the first key should 429, then the next key succeeds');
});

test('401 (key-level) still rotates to the next key within the same provider', async () => {
  const restore = installFetch((url, opts) => {
    if (url.includes('provider-a.test')) {
      if (opts.headers.Authorization.includes('K_A1')) return mockResp('Unauthorized', 401);
      return mockResp(okBody('A2'), 200);
    }
    return mockResp(okBody('B'), 200);
  });
  try {
    const candidates = [candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1', 'K_A2', 'K_A3'])];
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx({ maxTotalUpstreamCalls: 3 }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'A', '401 must rotate keys inside A');
  } finally {
    restore.mock.restore();
  }
  assert.strictEqual(countUrl('provider-a.test'), 2, 'only the first key should 401, then the next key succeeds');
});

test('first provider must not consume the entire global call budget', async () => {
  // Global cap 3, A has 3 keys, all 500. A may only spend its provider retry budget (2),
  // leaving room for B — proving A cannot starve B by cycling every key.
  const restore = installFetch((url) => {
    if (url.includes('provider-a.test')) return mockResp({ error: 'server error' }, 500);
    return mockResp(okBody('B'), 200);
  });
  try {
    const candidates = [
      candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1', 'K_A2', 'K_A3']),
      candidate('m', 'B', 'http://provider-b.test/v1', ['K_B1']),
    ];
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx({ maxTotalUpstreamCalls: 3 }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'B');
  } finally {
    restore.mock.restore();
  }
  const total = countUrl('provider-a.test') + countUrl('provider-b.test');
  assert.strictEqual(total, 3, 'total upstream calls must honour the global cap');
  assert.ok(countUrl('provider-a.test') < 3, 'first provider must not exhaust the whole budget');
});

// ---------------------------------------------------------------------------
// (2) An unclassifiable 403 must NOT permanently invalidate the key
// ---------------------------------------------------------------------------

test('classifyForbidden maps plain 403 to conservative_cooldown (not key_forbidden)', () => {
  assert.strictEqual(classifyForbidden('Forbidden'), 'conservative_cooldown');
  assert.strictEqual(classifyForbidden('{"error":"forbidden"}'), 'conservative_cooldown');
});

test('plain 403 does NOT permanently invalidate the key (invalid stays false)', async () => {
  const restore = installFetch(() => mockResp('Forbidden', 403));
  try {
    const candidates = [candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1'])];
    await runIgnoringExhaustion(candidates, ctx());
  } finally {
    restore.mock.restore();
  }
  const st = getKeyState('A', 'a1');
  assert.ok(st, 'key state should exist');
  assert.strictEqual(st.invalid, false, 'plain 403 must NOT mark the key invalid');
  assert.ok(st.cooldownUntil > Date.now(), 'plain 403 should apply a temporary cooldown');
});

test('after its cooldown elapses, a key cooled by an unknown 403 is eligible again', async () => {
  const prov = candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1']).provider;
  const restore = installFetch(() => mockResp('Forbidden', 403));
  try {
    const candidates = [candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1'])];
    await runIgnoringExhaustion(candidates, ctx());
  } finally {
    restore.mock.restore();
  }
  const st = getKeyState('A', 'a1');
  assert.strictEqual(st.invalid, false);
  // Simulate the cooldown window elapsing (resetKeyState clears the temporary cooldown).
  resetKeyState('A', 'a1');
  const available = getAvailableKeys(prov, 'A', 'm', 0);
  assert.ok(available.some((k) => k.id === 'a1'), 'key must be eligible again after cooldown');
});

test('"Invalid API key" 403 permanently invalidates the key', async () => {
  const restore = installFetch(() => mockResp({ error: { message: 'Invalid API key' } }, 403));
  try {
    const candidates = [candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1'])];
    await runIgnoringExhaustion(candidates, ctx());
  } finally {
    restore.mock.restore();
  }
  const st = getKeyState('A', 'a1');
  assert.strictEqual(st.invalid, true, 'explicit "Invalid API key" must permanently disable the key');
});

test('model-level 403 only blocks the key+model pair, key stays alive for other models', async () => {
  const prov = candidate('claude-opus', 'A', 'http://provider-a.test/v1', ['K_A1']).provider;
  const restore = installFetch(() => mockResp({ error: { message: 'model claude-opus is not allowed for this api key' } }, 403));
  try {
    const candidates = [candidate('claude-opus', 'A', 'http://provider-a.test/v1', ['K_A1'])];
    await runIgnoringExhaustion(candidates, ctx());
  } finally {
    restore.mock.restore();
  }
  const st = getKeyState('A', 'a1');
  assert.strictEqual(st.invalid, false, 'key must NOT be invalidated by a model-level 403');
  assert.ok(st.forbiddenModels instanceof Set && st.forbiddenModels.has('claude-opus'), 'claude-opus should be in forbiddenModels');
  const stillGood = getAvailableKeys(prov, 'A', 'gpt-4', 0);
  assert.ok(stillGood.some((k) => k.id === 'a1'), 'key should still serve other models');
  const blocked = getAvailableKeys(prov, 'A', 'claude-opus', 0);
  assert.ok(!blocked.some((k) => k.id === 'a1'), 'key should be blocked for the forbidden model');
});

// ===========================================================================
// PHASE 2b — provider-level failure budget SHARED across a provider's models
// ===========================================================================
// A provider that serves several models is ONE provider. Its failure budget and cooldown must
// be shared across all of its (provider+model) candidates for the whole request, so a single
// dead provider cannot re-earn a fresh budget per model and starve a healthy provider.

test('Provider A (3 models, multiple keys) all 500; global cap 5 → healthy Provider B still succeeds', async () => {
  const restore = installFetch((url) => {
    if (url.includes('provider-a.test')) return mockResp({ error: 'server error' }, 500);
    return mockResp(okBody('B'), 200);
  });
  try {
    const candidates = [
      candidate('m1', 'A', 'http://provider-a.test/v1', ['K_A1', 'K_A2']),
      candidate('m2', 'A', 'http://provider-a.test/v1', ['K_A1', 'K_A2']),
      candidate('m3', 'A', 'http://provider-a.test/v1', ['K_A1', 'K_A2']),
      candidate('m1', 'B', 'http://provider-b.test/v1', ['K_B1']),
    ];
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx({ maxTotalUpstreamCalls: 5 }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'B', 'B must be reached despite A having 3 models');
  } finally {
    restore.mock.restore();
  }
  // Shared budget: A only spends maxAttemptsPerKey (2) TOTAL across ALL its models, not per model.
  assert.strictEqual(countUrl('provider-a.test'), 2, 'A must share ONE provider budget across its 3 models');
  assert.strictEqual(countUrl('provider-b.test'), 1, 'B must get its chance within the global cap of 5');
});

test('maxProvidersPerRequest counts UNIQUE providers (A×2 models + B×1) — B must still be tried', async () => {
  const restore = installFetch((url) => {
    if (url.includes('provider-a.test')) return mockResp({ error: 'server error' }, 500);
    return mockResp(okBody('B'), 200);
  });
  try {
    const candidates = [
      candidate('m1', 'A', 'http://provider-a.test/v1', ['K_A1']),
      candidate('m2', 'A', 'http://provider-a.test/v1', ['K_A1']),
      candidate('m1', 'B', 'http://provider-b.test/v1', ['K_B1']),
    ];
    // With the OLD candidate-index logic, B (index 2) would be cut off by maxProvidersPerRequest=2.
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx({ maxProvidersPerRequest: 2, maxTotalUpstreamCalls: 10 }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'B', 'only 2 DISTINCT providers exist, so B must be reachable');
  } finally {
    restore.mock.restore();
  }
});

test('network error on Provider A skips A\'s OTHER models and moves to Provider B', async () => {
  const restore = installFetch((url) => {
    if (url.includes('provider-a.test')) throw new Error('connect ECONNREFUSED');
    return mockResp(okBody('B'), 200);
  });
  try {
    const candidates = [
      candidate('m1', 'A', 'http://provider-a.test/v1', ['K_A1']),
      candidate('m2', 'A', 'http://provider-a.test/v1', ['K_A1']),
      candidate('m1', 'B', 'http://provider-b.test/v1', ['K_B1']),
    ];
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx({ maxTotalUpstreamCalls: 10 }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'B');
  } finally {
    restore.mock.restore();
  }
  assert.strictEqual(countUrl('provider-a.test'), 2, 'A only burns its shared budget (2), m2 is NOT hit again');
  assert.strictEqual(countUrl('provider-b.test'), 1, 'B is reached after A is abandoned');
});

test('provider-level 403 cooldown (region) skips the provider\'s remaining models', async () => {
  const restore = installFetch((url) => {
    if (url.includes('provider-a.test')) return mockResp({ error: { message: 'This model is not available in your region' } }, 403);
    return mockResp(okBody('B'), 200);
  });
  try {
    const candidates = [
      candidate('m1', 'A', 'http://provider-a.test/v1', ['K_A1']),
      candidate('m2', 'A', 'http://provider-a.test/v1', ['K_A1']),
      candidate('m1', 'B', 'http://provider-b.test/v1', ['K_B1']),
    ];
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx({ maxAttemptsPerKey: 1, maxTotalUpstreamCalls: 10 }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'B');
  } finally {
    restore.mock.restore();
  }
  assert.strictEqual(countUrl('provider-a.test'), 1, 'region 403 cools A → its m2 candidate is skipped');
  const st = getKeyState('A', 'a1');
  assert.strictEqual(st.invalid, false, 'a region/provider 403 must NOT invalidate the key');
});

test('Key-level 429 rotates through ALL keys of the same provider (does not consume provider budget)', async () => {
  const restore = installFetch((url, opts) => {
    if (opts.headers.Authorization.includes('K_A3')) return mockResp(okBody('A3'), 200);
    return mockResp({ error: 'rate limited' }, 429);
  });
  try {
    const candidates = [candidate('m', 'A', 'http://provider-a.test/v1', ['K_A1', 'K_A2', 'K_A3'])];
    const result = await executeCandidates(candidates, { messages: makeMessages() }, ctx({ maxTotalUpstreamCalls: 3 }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.provider, 'A', '429 rotates keys inside A; the 3rd key succeeds');
  } finally {
    restore.mock.restore();
  }
  assert.strictEqual(countUrl('provider-a.test'), 3, '429 is key-level: every key is tried, budget is not spent');
});

// ===========================================================================
// PHASE 2c — 403 classification ORDER and TIGHTER key-invalidation regex
// ===========================================================================
// Model-permission wording must map to model_forbidden (skip key+model only), never key_forbidden
// (which permanently kills the whole key). Only explicit credential-invalidity may kill a key.

test('classifyForbidden: model-permission wording → model_forbidden (never key_forbidden)', () => {
  const modelMsgs = [
    'Permission denied for model gpt-4',
    'You are not authorized to access this model',
    'Access denied: model claude-opus is not enabled for your account',
    'This API key does not have access to model gpt-4',
  ];
  for (const m of modelMsgs) {
    assert.strictEqual(classifyForbidden(m), 'model_forbidden', `must be model_forbidden: ${m}`);
  }
});

test('classifyForbidden: standalone denial (no model/region/credential evidence) → conservative_cooldown', () => {
  for (const m of ['Permission denied', 'Access denied', 'You are not authorized']) {
    assert.strictEqual(classifyForbidden(m), 'conservative_cooldown', `must be conservative_cooldown: ${m}`);
  }
});

test('classifyForbidden: explicit credential invalidity → key_forbidden', () => {
  for (const m of ['Your API key is invalid', 'API token has expired', 'This credential has been revoked', 'API key is incorrect']) {
    assert.strictEqual(classifyForbidden(m), 'key_forbidden', `must be key_forbidden: ${m}`);
  }
});

test('classifyForbidden: region wording → provider_cooldown (even when a model is named)', () => {
  assert.strictEqual(classifyForbidden('This model is not available in your region'), 'provider_cooldown');
});

// Full execution-state check for every model-permission 403: invalid stays false, the model is
// added to forbiddenModels, and the key still serves OTHER models.
for (const { body, model } of [
  { body: 'Permission denied for model gpt-4', model: 'gpt-4' },
  { body: 'You are not authorized to access this model', model: 'gpt-4' },
  { body: 'Access denied: model claude-opus is not enabled for your account', model: 'claude-opus' },
  { body: 'This API key does not have access to model gpt-4', model: 'gpt-4' },
]) {
  test(`model-permission 403 "${body}" only blocks key+model, key stays valid`, async () => {
    const prov = candidate(model, 'A', 'http://provider-a.test/v1', ['K_A1']).provider;
    const restore = installFetch(() => mockResp({ error: { message: body } }, 403));
    try {
      const candidates = [candidate(model, 'A', 'http://provider-a.test/v1', ['K_A1'])];
      await runIgnoringExhaustion(candidates, ctx());
    } finally {
      restore.mock.restore();
    }
    const st = getKeyState('A', 'a1');
    assert.strictEqual(st.invalid, false, 'model-permission 403 must NOT invalidate the key');
    assert.ok(st.forbiddenModels instanceof Set && st.forbiddenModels.has(model), `${model} must be in forbiddenModels`);
    const other = model === 'gpt-4' ? 'claude-3' : 'gpt-4';
    const stillGood = getAvailableKeys(prov, 'A', other, 0);
    assert.ok(stillGood.some((k) => k.id === 'a1'), 'key must still serve other models');
  });
}
