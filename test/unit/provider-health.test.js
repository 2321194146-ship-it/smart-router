// test/unit/provider-health.test.js
// Smart Router Mainline - Phase 1
// Provider 健康检查和熔断器测试
//
// 使用 Node.js 内置 node:test 和 node:assert，无第三方依赖。

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  ProviderHealth,
  CircuitBreaker,
  ProviderStatus,
  CircuitState,
} from '../../src/provider/health.js';

// ----------------------------------------------------------------------------
// 最小化测试配置
// ----------------------------------------------------------------------------

function makeHealthConfig() {
  return {
    providers: [
      { name: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
      { name: 'anthropic', base_url: 'https://api.anthropic.com', api_key: 'sk-ant' },
    ],
  };
}

function makeCircuitConfig(overrides = {}) {
  return {
    enabled: true,
    failure_threshold: 3,
    failure_window_sec: 60,
    open_state_sec: 120,
    half_open_max_probes: 2,
    slow_call_threshold_ms: 100,
    slow_call_ratio: 0.5,
    slow_call_window_sec: 60,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// ProviderHealth 测试
// ----------------------------------------------------------------------------

describe('ProviderHealth', () => {
  let health;

  beforeEach(() => {
    health = new ProviderHealth(makeHealthConfig());
  });

  // --------------------------------------------------------------------------
  // 初始化
  // --------------------------------------------------------------------------

  describe('initialization', () => {
    test('initializes with providers from config', () => {
      const summary = health.getHealthSummary();
      assert.ok(summary.openai);
      assert.ok(summary.anthropic);
    });

    test('initial status is UNKNOWN', () => {
      const summary = health.getHealthSummary();
      assert.equal(summary.openai.status, ProviderStatus.UNKNOWN);
      assert.equal(summary.anthropic.status, ProviderStatus.UNKNOWN);
    });

    test('initial totalRequests is 0', () => {
      const summary = health.getHealthSummary();
      assert.equal(summary.openai.totalRequests, 0);
    });

    test('empty config produces no providers', () => {
      const h = new ProviderHealth({});
      const summary = h.getHealthSummary();
      assert.equal(Object.keys(summary).length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // 记录成功
  // --------------------------------------------------------------------------

  describe('recordResult success', () => {
    test('success -> status ACTIVE', () => {
      health.recordResult('openai', true, 350);
      const h = health.getHealth('openai');
      assert.equal(h.status, ProviderStatus.ACTIVE);
      assert.equal(h.totalSuccesses, 1);
      assert.equal(h.consecutiveSuccesses, 1);
      assert.equal(h.consecutiveFailures, 0);
    });

    test('multiple successes keep status ACTIVE', () => {
      health.recordResult('openai', true, 200);
      health.recordResult('openai', true, 300);
      health.recordResult('openai', true, 250);
      const h = health.getHealth('openai');
      assert.equal(h.status, ProviderStatus.ACTIVE);
      assert.equal(h.totalSuccesses, 3);
    });

    test('avgLatency is updated', () => {
      health.recordResult('openai', true, 300);
      health.recordResult('openai', true, 500);
      const h = health.getHealth('openai');
      assert.equal(h.avgLatency, 400); // (300 + 500) / 2
    });
  });

  // --------------------------------------------------------------------------
  // 记录失败
  // --------------------------------------------------------------------------

  describe('recordResult failure', () => {
    test('single failure -> status DEGRADED (failRate > threshold)', () => {
      health.recordResult('openai', false, 100);
      const h = health.getHealth('openai');
      assert.equal(h.status, ProviderStatus.DEGRADED);
      assert.equal(h.totalFailures, 1);
      assert.equal(h.consecutiveFailures, 1);
    });

    test('success then failure -> DEGRADED', () => {
      health.recordResult('openai', true, 200);
      health.recordResult('openai', false, 100);
      const h = health.getHealth('openai');
      assert.equal(h.status, ProviderStatus.DEGRADED);
    });

    test('failure after successes resets consecutiveSuccesses', () => {
      health.recordResult('openai', true, 200);
      health.recordResult('openai', true, 200);
      health.recordResult('openai', false, 100);
      const h = health.getHealth('openai');
      assert.equal(h.consecutiveSuccesses, 0);
      assert.equal(h.consecutiveFailures, 1);
    });
  });

  // --------------------------------------------------------------------------
  // 连续失败 -> DOWN
  // --------------------------------------------------------------------------

  describe('consecutive failures -> DOWN', () => {
    test('5 consecutive failures -> DOWN', () => {
      for (let i = 0; i < 5; i++) {
        health.recordResult('openai', false, 100);
      }
      const h = health.getHealth('openai');
      assert.equal(h.status, ProviderStatus.DOWN);
      assert.equal(h.consecutiveFailures, 5);
    });

    test('4 failures -> not DOWN yet (still DEGRADED)', () => {
      for (let i = 0; i < 4; i++) {
        health.recordResult('openai', false, 100);
      }
      const h = health.getHealth('openai');
      assert.notEqual(h.status, ProviderStatus.DOWN);
    });

    test('success after failures resets to ACTIVE', () => {
      for (let i = 0; i < 4; i++) {
        health.recordResult('openai', false, 100);
      }
      // Need enough successes to bring failure rate below 0.3 threshold
      // 4 failures / (4 + N) < 0.3 -> N > 9.33
      for (let i = 0; i < 10; i++) {
        health.recordResult('openai', true, 200);
      }
      const h = health.getHealth('openai');
      assert.equal(h.consecutiveFailures, 0);
      assert.equal(h.status, ProviderStatus.ACTIVE);
    });
  });

  // --------------------------------------------------------------------------
  // isAvailable
  // --------------------------------------------------------------------------

  describe('isAvailable', () => {
    test('returns true for UNKNOWN provider', () => {
      assert.equal(health.isAvailable('openai'), true);
    });

    test('returns true for ACTIVE provider', () => {
      health.recordResult('openai', true, 200);
      assert.equal(health.isAvailable('openai'), true);
    });

    test('returns true for DEGRADED provider', () => {
      health.recordResult('openai', false, 100);
      assert.equal(health.isAvailable('openai'), true);
    });

    test('returns false for DOWN provider', () => {
      for (let i = 0; i < 5; i++) {
        health.recordResult('openai', false, 100);
      }
      assert.equal(health.isAvailable('openai'), false);
    });

    test('returns false for unknown provider', () => {
      assert.equal(health.isAvailable('nonexistent'), false);
    });
  });

  // --------------------------------------------------------------------------
  // getHealthSummary
  // --------------------------------------------------------------------------

  describe('getHealthSummary', () => {
    test('returns all providers', () => {
      const summary = health.getHealthSummary();
      assert.equal(Object.keys(summary).length, 2);
      assert.ok('openai' in summary);
      assert.ok('anthropic' in summary);
    });

    test('includes failureRate calculation', () => {
      health.recordResult('openai', true, 200);
      health.recordResult('openai', false, 100);
      const summary = health.getHealthSummary();
      assert.equal(summary.openai.failureRate, 50); // 1/2 = 50%
    });

    test('includes avgLatency', () => {
      health.recordResult('openai', true, 400);
      const summary = health.getHealthSummary();
      assert.equal(summary.openai.avgLatency, 400);
    });

    test('dynamically registers unknown provider on recordResult', () => {
      health.recordResult('gemini', true, 200);
      const summary = health.getHealthSummary();
      assert.ok(summary.gemini);
    });
  });
});

// ----------------------------------------------------------------------------
// CircuitBreaker 测试
// ----------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  let cb;

  beforeEach(() => {
    cb = new CircuitBreaker(makeCircuitConfig());
  });

  // --------------------------------------------------------------------------
  // CLOSED 状态
  // --------------------------------------------------------------------------

  describe('CLOSED state', () => {
    test('CLOSED state allows calls', () => {
      assert.equal(cb.allow('test-key'), true);
      assert.equal(cb.getState('test-key'), CircuitState.CLOSED);
    });

    test('no record returns CLOSED by default', () => {
      assert.equal(cb.getState('new-key'), CircuitState.CLOSED);
    });

    test('disabled breaker always allows calls', () => {
      const disabled = new CircuitBreaker({ enabled: false, failure_threshold: 1 });
      disabled.record('key', false, 100);
      assert.equal(disabled.allow('key'), true);
    });
  });

  // --------------------------------------------------------------------------
  // 失败次数达阈值 -> OPEN
  // --------------------------------------------------------------------------

  describe('failures reach threshold -> OPEN', () => {
    test('consecutive failures reach threshold -> OPEN', () => {
      cb.record('key', false, 100);
      cb.record('key', false, 100);
      assert.equal(cb.getState('key'), CircuitState.CLOSED);

      cb.record('key', false, 100); // 3rd failure
      assert.equal(cb.getState('key'), CircuitState.OPEN);
    });

    test('success resets consecutive failure count', () => {
      cb.record('key', false, 100);
      cb.record('key', false, 100);
      // 2 failures, threshold is 3, still CLOSED
      assert.equal(cb.getState('key'), CircuitState.CLOSED);

      cb.record('key', true, 100); // resets consecutiveFailures to 0
      const rec = cb._records.get('key');
      assert.equal(rec.consecutiveFailures, 0);
      assert.equal(cb.getState('key'), CircuitState.CLOSED);
    });
  });

  // --------------------------------------------------------------------------
  // OPEN 状态禁止调用
  // --------------------------------------------------------------------------

  describe('OPEN state blocks calls', () => {
    test('OPEN state returns false from allow()', () => {
      for (let i = 0; i < 3; i++) cb.record('key', false, 100);
      assert.equal(cb.getState('key'), CircuitState.OPEN);
      assert.equal(cb.allow('key'), false);
    });
  });

  // --------------------------------------------------------------------------
  // 冷却后 -> HALF_OPEN
  // --------------------------------------------------------------------------

  describe('after cooldown -> HALF_OPEN', () => {
    test('OPEN transitions to HALF_OPEN after cooldown', () => {
      for (let i = 0; i < 3; i++) cb.record('key', false, 100);
      assert.equal(cb.getState('key'), CircuitState.OPEN);

      // Simulate cooldown expiry
      const rec = cb._records.get('key');
      rec.openUntil = Date.now() - 1000;

      assert.equal(cb.getState('key'), CircuitState.HALF_OPEN);
    });

    test('allow() in expired OPEN transitions to HALF_OPEN and allows probe', () => {
      for (let i = 0; i < 3; i++) cb.record('key', false, 100);

      const rec = cb._records.get('key');
      rec.openUntil = Date.now() - 1000;

      // allow() should transition to HALF_OPEN and permit first probe
      assert.equal(cb.allow('key'), true);
      assert.equal(cb.getState('key'), CircuitState.HALF_OPEN);
    });
  });

  // --------------------------------------------------------------------------
  // HALF_OPEN 探测成功 -> CLOSED
  // --------------------------------------------------------------------------

  describe('HALF_OPEN probe success -> CLOSED', () => {
    test('successful probe in HALF_OPEN closes circuit', () => {
      for (let i = 0; i < 3; i++) cb.record('key', false, 100);

      const rec = cb._records.get('key');
      rec.openUntil = Date.now() - 1000;

      cb.allow('key'); // transitions to HALF_OPEN
      assert.equal(cb.getState('key'), CircuitState.HALF_OPEN);

      cb.record('key', true, 100); // probe success
      assert.equal(cb.getState('key'), CircuitState.CLOSED);
    });
  });

  // --------------------------------------------------------------------------
  // HALF_OPEN 探测失败 -> OPEN
  // --------------------------------------------------------------------------

  describe('HALF_OPEN probe failure -> OPEN', () => {
    test('failed probe in HALF_OPEN reopens circuit', () => {
      for (let i = 0; i < 3; i++) cb.record('key', false, 100);

      const rec = cb._records.get('key');
      rec.openUntil = Date.now() - 1000;

      cb.allow('key'); // transitions to HALF_OPEN
      assert.equal(cb.getState('key'), CircuitState.HALF_OPEN);

      cb.record('key', false, 100); // probe failure
      assert.equal(cb.getState('key'), CircuitState.OPEN);
    });
  });

  // --------------------------------------------------------------------------
  // 慢调用比率触发熔断
  // --------------------------------------------------------------------------

  describe('high slow call ratio -> OPEN', () => {
    test('slow call ratio exceeds threshold -> OPEN', () => {
      const slowCb = new CircuitBreaker(
        makeCircuitConfig({
          failure_threshold: 100, // high threshold to avoid count-based tripping
          slow_call_threshold_ms: 100,
          slow_call_ratio: 0.5,
        })
      );

      // Record 4 successful but slow calls (latency > 100ms)
      slowCb.record('key', true, 200);
      slowCb.record('key', true, 200);
      slowCb.record('key', true, 200);
      assert.equal(slowCb.getState('key'), CircuitState.CLOSED);

      slowCb.record('key', true, 200); // 4th sample, ratio = 1.0 > 0.5
      assert.equal(slowCb.getState('key'), CircuitState.OPEN);
    });

    test('fast calls do not trigger slow call ratio', () => {
      const slowCb = new CircuitBreaker(
        makeCircuitConfig({
          failure_threshold: 100,
          slow_call_threshold_ms: 100,
          slow_call_ratio: 0.5,
        })
      );

      for (let i = 0; i < 10; i++) {
        slowCb.record('key', true, 50); // fast calls
      }
      assert.equal(slowCb.getState('key'), CircuitState.CLOSED);
    });
  });

  // --------------------------------------------------------------------------
  // reset
  // --------------------------------------------------------------------------

  describe('reset', () => {
    test('reset forces CLOSED state', () => {
      for (let i = 0; i < 3; i++) cb.record('key', false, 100);
      assert.equal(cb.getState('key'), CircuitState.OPEN);

      cb.reset('key');
      assert.equal(cb.getState('key'), CircuitState.CLOSED);
    });

    test('resetAll clears all records', () => {
      for (let i = 0; i < 3; i++) cb.record('key1', false, 100);
      for (let i = 0; i < 3; i++) cb.record('key2', false, 100);

      cb.resetAll();
      assert.equal(cb.getState('key1'), CircuitState.CLOSED);
      assert.equal(cb.getState('key2'), CircuitState.CLOSED);
    });
  });

  // --------------------------------------------------------------------------
  // getSummary
  // --------------------------------------------------------------------------

  describe('getSummary', () => {
    test('returns state and failure info for all keys', () => {
      cb.record('key', false, 100);
      cb.record('key', false, 100);

      const summary = cb.getSummary();
      assert.ok(summary.key);
      assert.equal(summary.key.state, CircuitState.CLOSED);
      assert.equal(summary.key.consecutiveFailures, 2);
    });
  });
});
