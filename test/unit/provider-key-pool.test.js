// test/unit/provider-key-pool.test.js
// Smart Router Mainline - Phase 1
// Key 池管理测试
//
// 使用 Node.js 内置 node:test 和 node:assert，无第三方依赖。

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { KeyPool, KeyStatus } from '../../src/provider/key-pool.js';
import { ErrorType } from '../../src/provider/errors.js';

// ----------------------------------------------------------------------------
// 最小化测试配置
// ----------------------------------------------------------------------------

function makeConfig() {
  return {
    providers: [
      { name: 'openai', api_key: 'sk-openai-001' },
      {
        name: 'anthropic',
        api_keys: ['sk-ant-001', 'sk-ant-002', 'sk-ant-003'],
      },
      { name: 'empty', api_key: '' },
    ],
  };
}

// ----------------------------------------------------------------------------
// 测试
// ----------------------------------------------------------------------------

describe('KeyPool', () => {
  let pool;

  beforeEach(() => {
    pool = new KeyPool(makeConfig());
  });

  // --------------------------------------------------------------------------
  // 初始化
  // --------------------------------------------------------------------------

  describe('initialization', () => {
    test('initializes with multiple providers and keys', () => {
      assert.deepEqual(pool.getKeyIds('openai'), ['openai-0']);
      assert.deepEqual(pool.getKeyIds('anthropic'), [
        'anthropic-0',
        'anthropic-1',
        'anthropic-2',
      ]);
    });

    test('empty api_key produces no keys', () => {
      assert.deepEqual(pool.getKeyIds('empty'), []);
    });

    test('unknown provider returns empty keyIds', () => {
      assert.deepEqual(pool.getKeyIds('nonexistent'), []);
    });

    test('all keys start as ACTIVE', () => {
      for (const keyId of pool.getKeyIds('anthropic')) {
        assert.equal(pool.getKeyStatus('anthropic', keyId), KeyStatus.ACTIVE);
      }
    });
  });

  // --------------------------------------------------------------------------
  // getKeys
  // --------------------------------------------------------------------------

  describe('getKeys', () => {
    test('returns active keys', () => {
      const keys = pool.getKeys('anthropic');
      assert.equal(keys.length, 3);
      assert.ok(keys.every((k) => k.keyId.startsWith('anthropic-')));
      assert.ok(keys.every((k) => k.provider === 'anthropic'));
    });

    test('returns empty for provider with no keys', () => {
      assert.equal(pool.getKeys('empty').length, 0);
    });

    test('returns empty for unknown provider', () => {
      assert.equal(pool.getKeys('nonexistent').length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // nextKey 轮换
  // --------------------------------------------------------------------------

  describe('nextKey rotation', () => {
    test('returns a key when keys are available', () => {
      const key = pool.nextKey('anthropic');
      assert.ok(key);
      assert.ok(key.keyId.startsWith('anthropic-'));
      assert.equal(key.provider, 'anthropic');
    });

    test('rotates to least recently used', () => {
      // Set different initial lastUsed timestamps to create a known order.
      // This is necessary because synchronous nextKey calls in the same
      // millisecond would produce identical Date.now() values.
      pool._keys.get('anthropic-0').lastUsed = 1000;
      pool._keys.get('anthropic-1').lastUsed = 2000;
      pool._keys.get('anthropic-2').lastUsed = 3000;

      // Picks least recently used (smallest lastUsed = 1000)
      const k1 = pool.nextKey('anthropic');
      assert.equal(k1.keyId, 'anthropic-0');

      // anthropic-0 now has Date.now() (>> 3000); anthropic-1 (2000) is next
      const k2 = pool.nextKey('anthropic');
      assert.equal(k2.keyId, 'anthropic-1');

      // anthropic-2 (3000) is now the least recently used
      const k3 = pool.nextKey('anthropic');
      assert.equal(k3.keyId, 'anthropic-2');

      // All have been used; wraps around to anthropic-0
      // (oldest Date.now() since it was set first, or stable sort first)
      const k4 = pool.nextKey('anthropic');
      assert.equal(k4.keyId, 'anthropic-0');
    });

    test('updates lastUsed after selection', () => {
      const k1 = pool.nextKey('anthropic');
      const rec1 = pool.getKeyRecord(k1.keyId);
      assert.ok(rec1.lastUsed > 0);

      // Wait a tick so timestamps differ
      const k2 = pool.nextKey('anthropic');
      const rec2 = pool.getKeyRecord(k2.keyId);
      const rec1After = pool.getKeyRecord(k1.keyId);

      // k1 was used before k2
      assert.ok(rec1After.lastUsed <= rec2.lastUsed);
    });
  });

  // --------------------------------------------------------------------------
  // nextKey with excludeKeys
  // --------------------------------------------------------------------------

  describe('nextKey with excludeKeys', () => {
    test('skips excluded keys', () => {
      const key = pool.nextKey('anthropic', ['anthropic-0', 'anthropic-1']);
      assert.equal(key.keyId, 'anthropic-2');
    });

    test('returns null when all keys are excluded', () => {
      const key = pool.nextKey('anthropic', [
        'anthropic-0',
        'anthropic-1',
        'anthropic-2',
      ]);
      assert.equal(key, null);
    });

    test('ignore excludeKeys for unknown keyIds', () => {
      const key = pool.nextKey('anthropic', ['nonexistent']);
      assert.ok(key);
    });
  });

  // --------------------------------------------------------------------------
  // markKeyFailed
  // --------------------------------------------------------------------------

  describe('markKeyFailed', () => {
    test('AUTH_INVALID -> INVALID status (permanent)', () => {
      pool.markKeyFailed('openai', 'openai-0', ErrorType.AUTH_INVALID);
      assert.equal(pool.getKeyStatus('openai', 'openai-0'), KeyStatus.INVALID);
    });

    test('AUTH_INVALID key is no longer available', () => {
      pool.markKeyFailed('openai', 'openai-0', ErrorType.AUTH_INVALID);
      assert.equal(pool.nextKey('openai'), null);
      assert.equal(pool.getKeys('openai').length, 0);
    });

    test('FORBIDDEN_KEY -> COOLING (key-level cooldown)', () => {
      pool.markKeyFailed('openai', 'openai-0', ErrorType.FORBIDDEN_KEY);
      const rec = pool.getKeyRecord('openai-0');
      // FORBIDDEN_KEY triggers shouldDisableKey=true, but key-pool cools it 7200s
      assert.equal(rec.status, KeyStatus.COOLING);
    });

    test('RATE_LIMIT_TRANSIENT -> COOLING with ~30s cooldown', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.RATE_LIMIT_TRANSIENT);
      const rec = pool.getKeyRecord('anthropic-0');
      assert.equal(rec.status, KeyStatus.COOLING);
      const remainingMs = rec.cooldownUntil - Date.now();
      assert.ok(
        remainingMs > 25000 && remainingMs <= 30000,
        `expected ~30s remaining, got ${remainingMs}ms`
      );
    });

    test('RATE_LIMIT_QUOTA -> COOLING with ~600s cooldown', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.RATE_LIMIT_QUOTA);
      const rec = pool.getKeyRecord('anthropic-0');
      assert.equal(rec.status, KeyStatus.COOLING);
      const remainingMs = rec.cooldownUntil - Date.now();
      assert.ok(
        remainingMs > 595000 && remainingMs <= 600000,
        `expected ~600s remaining, got ${remainingMs}ms`
      );
    });

    test('SERVER_ERROR -> COOLING with exponential backoff', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.SERVER_ERROR);
      const rec1 = pool.getKeyRecord('anthropic-0');
      assert.equal(rec1.status, KeyStatus.COOLING);
      // First failure: 30s * 2^0 = 30s
      const remaining1 = rec1.cooldownUntil - Date.now();
      assert.ok(remaining1 > 25000 && remaining1 <= 30000);

      // Force recovery to test second failure backoff
      const internalRec = pool._keys.get('anthropic-0');
      internalRec.status = KeyStatus.ACTIVE;
      internalRec.cooldownUntil = null;

      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.SERVER_ERROR);
      const rec2 = pool.getKeyRecord('anthropic-0');
      // Second failure: 30s * 2^1 = 60s
      const remaining2 = rec2.cooldownUntil - Date.now();
      assert.ok(remaining2 > 55000 && remaining2 <= 60000);
    });

    test('CLIENT_ABORTED -> no cooldown (status stays ACTIVE)', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.CLIENT_ABORTED);
      const rec = pool.getKeyRecord('anthropic-0');
      assert.equal(rec.status, KeyStatus.ACTIVE);
      assert.equal(rec.cooldownUntil, null);
    });

    test('UNKNOWN -> no cooldown (status stays ACTIVE)', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.UNKNOWN);
      const rec = pool.getKeyRecord('anthropic-0');
      assert.equal(rec.status, KeyStatus.ACTIVE);
      assert.equal(rec.cooldownUntil, null);
    });

    test('incrementing failureCount on each failure', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.CLIENT_ABORTED);
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.CLIENT_ABORTED);
      const rec = pool.getKeyRecord('anthropic-0');
      assert.equal(rec.failureCount, 2);
    });
  });

  // --------------------------------------------------------------------------
  // 冷却恢复
  // --------------------------------------------------------------------------

  describe('cooldown recovery', () => {
    test('cooling key becomes active after cooldown expires', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.RATE_LIMIT_TRANSIENT);
      assert.equal(
        pool.getKeyStatus('anthropic', 'anthropic-0'),
        KeyStatus.COOLING
      );

      // Simulate cooldown expiry by setting cooldownUntil to the past
      const rec = pool._keys.get('anthropic-0');
      rec.cooldownUntil = Date.now() - 1000;

      assert.equal(
        pool.getKeyStatus('anthropic', 'anthropic-0'),
        KeyStatus.ACTIVE
      );
    });

    test('cooling key is excluded from nextKey until recovered', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.RATE_LIMIT_TRANSIENT);

      // nextKey should skip the cooling key
      const key = pool.nextKey('anthropic');
      assert.notEqual(key.keyId, 'anthropic-0');
    });

    test('INVALID key does not recover', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.AUTH_INVALID);
      const rec = pool._keys.get('anthropic-0');
      rec.cooldownUntil = Date.now() - 1000; // should not matter

      assert.equal(
        pool.getKeyStatus('anthropic', 'anthropic-0'),
        KeyStatus.INVALID
      );
    });
  });

  // --------------------------------------------------------------------------
  // nextKey returns null when all cooling
  // --------------------------------------------------------------------------

  describe('all keys cooling', () => {
    test('nextKey returns null when all keys are cooling', () => {
      for (const keyId of pool.getKeyIds('anthropic')) {
        pool.markKeyFailed('anthropic', keyId, ErrorType.RATE_LIMIT_TRANSIENT);
      }
      assert.equal(pool.nextKey('anthropic'), null);
    });

    test('getKeys returns empty when all keys are cooling', () => {
      for (const keyId of pool.getKeyIds('anthropic')) {
        pool.markKeyFailed('anthropic', keyId, ErrorType.RATE_LIMIT_TRANSIENT);
      }
      assert.equal(pool.getKeys('anthropic').length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // markKeySucceeded
  // --------------------------------------------------------------------------

  describe('markKeySucceeded', () => {
    test('updates successCount and resets failureCount', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.CLIENT_ABORTED);
      assert.equal(pool.getKeyRecord('anthropic-0').failureCount, 1);

      pool.markKeySucceeded('anthropic', 'anthropic-0');
      const rec = pool.getKeyRecord('anthropic-0');
      assert.equal(rec.failureCount, 0);
      assert.equal(rec.successCount, 1);
    });

    test('recovers from COOLING after success', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.RATE_LIMIT_TRANSIENT);
      assert.equal(
        pool.getKeyStatus('anthropic', 'anthropic-0'),
        KeyStatus.COOLING
      );

      pool.markKeySucceeded('anthropic', 'anthropic-0');
      assert.equal(
        pool.getKeyStatus('anthropic', 'anthropic-0'),
        KeyStatus.ACTIVE
      );
    });

    test('updates lastSuccess timestamp', () => {
      pool.markKeySucceeded('anthropic', 'anthropic-0');
      const rec = pool.getKeyRecord('anthropic-0');
      assert.ok(rec.lastSuccess > 0);
    });
  });

  // --------------------------------------------------------------------------
  // 手动禁用/启用
  // --------------------------------------------------------------------------

  describe('manual disable/enable', () => {
    test('disableKey sets DISABLED status', () => {
      pool.disableKey('anthropic', 'anthropic-0');
      assert.equal(
        pool.getKeyStatus('anthropic', 'anthropic-0'),
        KeyStatus.DISABLED
      );
    });

    test('disabled key is excluded from nextKey', () => {
      pool.disableKey('anthropic', 'anthropic-0');
      const key = pool.nextKey('anthropic');
      assert.notEqual(key.keyId, 'anthropic-0');
    });

    test('enableKey restores DISABLED key to ACTIVE', () => {
      pool.disableKey('anthropic', 'anthropic-0');
      pool.enableKey('anthropic', 'anthropic-0');
      assert.equal(
        pool.getKeyStatus('anthropic', 'anthropic-0'),
        KeyStatus.ACTIVE
      );
    });

    test('enableKey does not restore INVALID key', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.AUTH_INVALID);
      pool.enableKey('anthropic', 'anthropic-0');
      assert.equal(
        pool.getKeyStatus('anthropic', 'anthropic-0'),
        KeyStatus.INVALID
      );
    });
  });

  // --------------------------------------------------------------------------
  // getKeyHealthSummary
  // --------------------------------------------------------------------------

  describe('getKeyHealthSummary', () => {
    test('returns correct status counts for healthy pool', () => {
      const summary = pool.getKeyHealthSummary();
      assert.ok(summary.anthropic);
      assert.equal(summary.anthropic.total, 3);
      assert.equal(summary.anthropic.active, 3);
      assert.equal(summary.anthropic.cooling, 0);
      assert.equal(summary.anthropic.invalid, 0);
      assert.equal(summary.anthropic.disabled, 0);
    });

    test('reflects cooling keys in summary', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.RATE_LIMIT_TRANSIENT);
      pool.markKeyFailed('anthropic', 'anthropic-1', ErrorType.RATE_LIMIT_QUOTA);

      const summary = pool.getKeyHealthSummary();
      assert.equal(summary.anthropic.active, 1);
      assert.equal(summary.anthropic.cooling, 2);
    });

    test('reflects invalid keys in summary', () => {
      pool.markKeyFailed('anthropic', 'anthropic-0', ErrorType.AUTH_INVALID);

      const summary = pool.getKeyHealthSummary();
      assert.equal(summary.anthropic.active, 2);
      assert.equal(summary.anthropic.invalid, 1);
    });

    test('includes per-key details', () => {
      const summary = pool.getKeyHealthSummary();
      assert.equal(summary.anthropic.keys.length, 3);
      assert.ok(summary.anthropic.keys[0].keyId);
      assert.equal(summary.anthropic.keys[0].status, KeyStatus.ACTIVE);
    });

    test('includes all providers', () => {
      const summary = pool.getKeyHealthSummary();
      assert.ok(summary.openai);
      assert.ok(summary.anthropic);
      // 'empty' provider has no keys, but still appears with total=0
      assert.ok(summary.empty);
      assert.equal(summary.empty.total, 0);
    });
  });
});
