import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyGate, FixedWindowRateLimiter } from '../../src/runtime/request-controls.js';

describe('Request controls', () => {
  test('fixed-window limiter rejects after the configured budget and exposes retry time', () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 1000, maxRequests: 2 });

    assert.deepStrictEqual(limiter.consume('127.0.0.1', 1000), { allowed: true, retryAfterMs: 0 });
    assert.deepStrictEqual(limiter.consume('127.0.0.1', 1100), { allowed: true, retryAfterMs: 0 });
    const blocked = limiter.consume('127.0.0.1', 1200);
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.retryAfterMs, 800);
    assert.deepStrictEqual(limiter.consume('127.0.0.1', 2000), { allowed: true, retryAfterMs: 0 });
  });

  test('rate limits are isolated by client key', () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 1000, maxRequests: 1 });
    assert.strictEqual(limiter.consume('a', 100).allowed, true);
    assert.strictEqual(limiter.consume('a', 101).allowed, false);
    assert.strictEqual(limiter.consume('b', 101).allowed, true);
  });

  test('concurrency gate never exceeds the configured active count', () => {
    const gate = new ConcurrencyGate(1);
    assert.strictEqual(gate.tryAcquire(), true);
    assert.strictEqual(gate.active, 1);
    assert.strictEqual(gate.tryAcquire(), false);
    gate.release();
    gate.release();
    assert.strictEqual(gate.active, 0);
    assert.strictEqual(gate.tryAcquire(), true);
  });
});
