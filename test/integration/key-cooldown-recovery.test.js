// test/integration/key-cooldown-recovery.test.js
// Smart Router Mainline - Phase 1
// Key cooldown state persistence and restart recovery regression tests (#4):
//   - 429 transient -> cooldown_until persisted to SQLite
//   - restart: expired cooldown -> key auto-recovers to ACTIVE and is reselectable
//   - restart: active cooldown -> key stays COOLING
//   - restart: 401 invalid stays INVALID, disabled stays DISABLED
//   - COOLING with cooldownUntil=null must NOT be permanently stuck

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SQLiteStore } from '../../src/storage/sqlite-store.js';
import { KeyPool, KeyStatus } from '../../src/provider/key-pool.js';
import { ErrorType } from '../../src/provider/errors.js';

function buildConfig(providerName = 'mock-a', apiKey = 'test-key-1') {
  return {
    providers: [
      {
        name: providerName,
        base_url: 'http://127.0.0.1:19999/v1',
        api_key: apiKey,
        auth_header: 'Authorization',
        auth_prefix: 'Bearer ',
      },
    ],
    routing: { cooldown_default_sec: 60 },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Key Cooldown Persistence and Restart Recovery', () => {
  test('429 transient -> cooldown persisted to SQLite (cooldown_until in future)', async () => {
    const store = new SQLiteStore(':memory:');
    await store.init();
    const config = buildConfig();
    const pool = new KeyPool(config, store);
    await pool._restorePromise;

    pool.markKeyFailed('mock-a', 'mock-a-0', ErrorType.RATE_LIMIT_TRANSIENT);
    await sleep(150); // let _persistKeyStatus flush

    const row = await store.getKeyStatus('mock-a', 'mock-a-0');
    assert.ok(row, 'key status should be persisted');
    assert.strictEqual(row.status, KeyStatus.COOLING);
    assert.ok(row.cooldownUntil > Date.now(), 'cooldown_until should be in the future');
    assert.ok(row.failureCount >= 1, 'failure_count should be recorded');

    // Key should NOT be selectable while cooling
    assert.strictEqual(pool.nextKey('mock-a'), null, 'cooling key must not be selectable');
    store.close();
  });

  test('restart: expired cooldown -> key recovers to ACTIVE and is reselectable', async () => {
    const store = new SQLiteStore(':memory:');
    await store.init();
    const config = buildConfig();

    // Phase 1: trigger 429, persist cooling
    const pool1 = new KeyPool(config, store);
    await pool1._restorePromise;
    pool1.markKeyFailed('mock-a', 'mock-a-0', ErrorType.RATE_LIMIT_TRANSIENT);
    await sleep(150);
    const row1 = await store.getKeyStatus('mock-a', 'mock-a-0');
    assert.ok(row1.cooldownUntil > Date.now(), 'cooldown set in future');
    assert.strictEqual(pool1.nextKey('mock-a'), null);
    pool1._providerKeyIds.clear();

    // Simulate time passing: expire the cooldown directly in SQLite
    store._db.prepare(
      'UPDATE key_status SET cooldown_until = ? WHERE provider = ? AND key_id = ?'
    ).run(Date.now() - 1000, 'mock-a', 'mock-a-0');

    // Phase 2: "restart" - a brand new KeyPool reading the same store
    const pool2 = new KeyPool(config, store);
    await pool2._restorePromise;

    // Key should be ACTIVE and reselectable
    const status2 = await store.getKeyStatus('mock-a', 'mock-a-0');
    assert.strictEqual(status2.status, KeyStatus.ACTIVE, 'expired cooldown should recover to ACTIVE');
    assert.strictEqual(status2.cooldownUntil, null, 'cooldown_until should be cleared after recovery');

    const selected = pool2.nextKey('mock-a');
    assert.ok(selected, 'recovered key should be reselectable');
    assert.strictEqual(selected.keyId, 'mock-a-0');
    store.close();
  });

  test('restart: active cooldown -> key stays COOLING (not recoverable until expiry)', async () => {
    const store = new SQLiteStore(':memory:');
    await store.init();
    const config = buildConfig();

    const pool1 = new KeyPool(config, store);
    await pool1._restorePromise;
    pool1.markKeyFailed('mock-a', 'mock-a-0', ErrorType.RATE_LIMIT_TRANSIENT);
    await sleep(150);
    pool1._providerKeyIds.clear();

    // Restart BEFORE expiry
    const pool2 = new KeyPool(config, store);
    await pool2._restorePromise;

    const status2 = await store.getKeyStatus('mock-a', 'mock-a-0');
    assert.strictEqual(status2.status, KeyStatus.COOLING, 'unexpired cooldown should stay COOLING');
    assert.ok(status2.cooldownUntil > Date.now(), 'cooldown_until should remain in future');
    assert.strictEqual(pool2.nextKey('mock-a'), null, 'cooling key must not be selectable');
    store.close();
  });

  test('restart: 401 invalid stays INVALID permanently', async () => {
    const store = new SQLiteStore(':memory:');
    await store.init();
    const config = buildConfig();

    const pool1 = new KeyPool(config, store);
    await pool1._restorePromise;
    pool1.markKeyFailed('mock-a', 'mock-a-0', ErrorType.AUTH_INVALID);
    await sleep(150);
    pool1._providerKeyIds.clear();

    const pool2 = new KeyPool(config, store);
    await pool2._restorePromise;

    const status2 = await store.getKeyStatus('mock-a', 'mock-a-0');
    assert.strictEqual(status2.status, KeyStatus.INVALID, '401 must stay INVALID after restart');
    assert.strictEqual(pool2.nextKey('mock-a'), null, 'INVALID key must never be selectable');
    store.close();
  });

  test('restart: disabled stays DISABLED', async () => {
    const store = new SQLiteStore(':memory:');
    await store.init();
    const config = buildConfig();

    const pool1 = new KeyPool(config, store);
    await pool1._restorePromise;
    pool1.disableKey('mock-a', 'mock-a-0');
    await sleep(150);
    pool1._providerKeyIds.clear();

    const pool2 = new KeyPool(config, store);
    await pool2._restorePromise;

    const status2 = await store.getKeyStatus('mock-a', 'mock-a-0');
    assert.strictEqual(status2.status, KeyStatus.DISABLED, 'disabled must stay DISABLED after restart');
    assert.strictEqual(pool2.nextKey('mock-a'), null);
    store.close();
  });

  test('COOLING with cooldownUntil=null must NOT be permanently stuck', async () => {
    const store = new SQLiteStore(':memory:');
    await store.init();
    const config = buildConfig();

    // Directly persist an anomalous state: cooling with no cooldown_until
    await store.saveKeyStatus({
      provider: 'mock-a',
      keyId: 'mock-a-0',
      status: KeyStatus.COOLING,
      reason: 'anomalous',
      cooldownUntil: null,
      failureCount: 1,
      updatedAt: new Date().toISOString(),
    });

    // Restart: restore must recover the key instead of leaving it stuck
    const pool = new KeyPool(config, store);
    await pool._restorePromise;

    const status = await store.getKeyStatus('mock-a', 'mock-a-0');
    assert.strictEqual(status.status, KeyStatus.ACTIVE, 'cooling-without-deadline must recover to ACTIVE');
    assert.strictEqual(status.cooldownUntil, null);

    const selected = pool.nextKey('mock-a');
    assert.ok(selected, 'recovered key should be reselectable');
    store.close();
  });
});
