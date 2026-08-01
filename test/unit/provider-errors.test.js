// test/unit/provider-errors.test.js
// Smart Router Mainline - Phase 1
// Provider 错误分类体系测试
//
// 使用 Node.js 内置 node:test 和 node:assert，无第三方依赖。

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  ErrorType,
  classifyError,
  isRetriable,
  getCooldownDuration,
  shouldDisableKey,
  isQuotaExhausted,
} from '../../src/provider/errors.js';

// ----------------------------------------------------------------------------
// 辅助：构造响应体
// ----------------------------------------------------------------------------

function openAiError(message, code) {
  return { error: { message, code: code || null, type: 'invalid_request_error' } };
}

// ----------------------------------------------------------------------------
// 401 AUTH_INVALID
// ----------------------------------------------------------------------------

describe('Provider Error Classification', () => {
  describe('401 -> AUTH_INVALID', () => {
    test('401 classifies as AUTH_INVALID', () => {
      assert.equal(classifyError(401), ErrorType.AUTH_INVALID);
    });

    test('401 with body still classifies as AUTH_INVALID', () => {
      assert.equal(
        classifyError(401, openAiError('Invalid authentication')),
        ErrorType.AUTH_INVALID
      );
    });

    test('shouldDisableKey returns true for AUTH_INVALID', () => {
      assert.equal(shouldDisableKey(ErrorType.AUTH_INVALID), true);
    });
  });

  // --------------------------------------------------------------------------
  // 403 顺序敏感分类
  // --------------------------------------------------------------------------

  describe('403 classification (order-sensitive)', () => {
    test('403 with model-level message -> FORBIDDEN_MODEL', () => {
      const body = openAiError('model not found', 'model_not_found');
      assert.equal(classifyError(403, body, 'model_not_found'), ErrorType.FORBIDDEN_MODEL);
    });

    test('403 with "does not exist" -> FORBIDDEN_MODEL', () => {
      const body = openAiError('The model does not exist');
      assert.equal(classifyError(403, body), ErrorType.FORBIDDEN_MODEL);
    });

    test('403 with key-level message -> FORBIDDEN_KEY', () => {
      const body = openAiError('invalid api key provided', 'invalid_api_key');
      assert.equal(classifyError(403, body, 'invalid_api_key'), ErrorType.FORBIDDEN_KEY);
    });

    test('403 with "authentication" keyword -> FORBIDDEN_KEY', () => {
      const body = openAiError('authentication failed');
      assert.equal(classifyError(403, body), ErrorType.FORBIDDEN_KEY);
    });

    test('403 with provider-level message -> FORBIDDEN_PROVIDER', () => {
      const body = openAiError('billing quota exceeded', 'access_denied');
      assert.equal(classifyError(403, body, 'access_denied'), ErrorType.FORBIDDEN_PROVIDER);
    });

    test('403 with "subscription" keyword -> FORBIDDEN_PROVIDER', () => {
      const body = openAiError('your subscription has expired');
      assert.equal(classifyError(403, body), ErrorType.FORBIDDEN_PROVIDER);
    });

    test('403 with region-level message -> FORBIDDEN_REGION', () => {
      const body = openAiError('region restricted');
      assert.equal(classifyError(403, body), ErrorType.FORBIDDEN_REGION);
    });

    test('403 with "country" keyword -> FORBIDDEN_REGION', () => {
      const body = openAiError('access blocked in your country');
      assert.equal(classifyError(403, body), ErrorType.FORBIDDEN_REGION);
    });

    test('403 with temp message -> FORBIDDEN_TEMP', () => {
      const body = openAiError('temporarily overloaded, try again later');
      assert.equal(classifyError(403, body), ErrorType.FORBIDDEN_TEMP);
    });

    test('403 with no matching keywords -> FORBIDDEN_TEMP (conservative fallback)', () => {
      const body = openAiError('something unexpected happened');
      assert.equal(classifyError(403, body), ErrorType.FORBIDDEN_TEMP);
    });

    test('403 model takes priority over key (order sensitivity)', () => {
      // message contains both "model" and "api key" -> model wins
      const body = openAiError('model api key mismatch');
      assert.equal(classifyError(403, body), ErrorType.FORBIDDEN_MODEL);
    });
  });

  // --------------------------------------------------------------------------
  // 429 RATE_LIMIT
  // --------------------------------------------------------------------------

  describe('429 classification', () => {
    test('429 transient -> RATE_LIMIT_TRANSIENT', () => {
      const body = openAiError('rate limit exceeded, slow down');
      assert.equal(classifyError(429, body), ErrorType.RATE_LIMIT_TRANSIENT);
    });

    test('429 with "too many requests" -> RATE_LIMIT_TRANSIENT', () => {
      const body = openAiError('too many requests');
      assert.equal(classifyError(429, body), ErrorType.RATE_LIMIT_TRANSIENT);
    });

    test('429 quota via errorCode -> RATE_LIMIT_QUOTA', () => {
      const body = openAiError('insufficient quota');
      assert.equal(
        classifyError(429, body, 'insufficient_quota'),
        ErrorType.RATE_LIMIT_QUOTA
      );
    });

    test('429 quota via body keyword -> RATE_LIMIT_QUOTA', () => {
      const body = openAiError('monthly quota exhausted');
      assert.equal(classifyError(429, body), ErrorType.RATE_LIMIT_QUOTA);
    });

    test('429 quota via long retry-after (>=600s) -> RATE_LIMIT_QUOTA', () => {
      const body = openAiError('rate limited');
      assert.equal(
        classifyError(429, body, null, { retryAfter: 600 }),
        ErrorType.RATE_LIMIT_QUOTA
      );
    });

    test('429 with short retry-after (<600s) -> RATE_LIMIT_TRANSIENT', () => {
      const body = openAiError('rate limited');
      assert.equal(
        classifyError(429, body, null, { retryAfter: 30 }),
        ErrorType.RATE_LIMIT_TRANSIENT
      );
    });
  });

  // --------------------------------------------------------------------------
  // 5xx SERVER_ERROR
  // --------------------------------------------------------------------------

  describe('5xx classification', () => {
    test('500 -> SERVER_ERROR', () => {
      assert.equal(classifyError(500), ErrorType.SERVER_ERROR);
    });

    test('502 -> SERVER_ERROR', () => {
      assert.equal(classifyError(502), ErrorType.SERVER_ERROR);
    });

    test('503 -> SERVER_ERROR', () => {
      assert.equal(classifyError(503), ErrorType.SERVER_ERROR);
    });

    test('5xx isRetriable returns true', () => {
      assert.equal(isRetriable(ErrorType.SERVER_ERROR), true);
    });
  });

  // --------------------------------------------------------------------------
  // NETWORK_ERROR
  // --------------------------------------------------------------------------

  describe('Network error classification', () => {
    test('fetch failure (no httpStatus + cause) -> NETWORK_ERROR', () => {
      const cause = new Error('fetch failed: ECONNREFUSED');
      assert.equal(
        classifyError(null, null, null, { cause }),
        ErrorType.NETWORK_ERROR
      );
    });

    test('NETWORK_ERROR is retriable', () => {
      assert.equal(isRetriable(ErrorType.NETWORK_ERROR), true);
    });
  });

  // --------------------------------------------------------------------------
  // CLIENT_ABORTED
  // --------------------------------------------------------------------------

  describe('Client aborted classification', () => {
    test('aborted flag -> CLIENT_ABORTED', () => {
      assert.equal(
        classifyError(null, null, null, { aborted: true }),
        ErrorType.CLIENT_ABORTED
      );
    });

    test('AbortError cause -> CLIENT_ABORTED', () => {
      const cause = new Error('The operation was aborted');
      cause.name = 'AbortError';
      assert.equal(
        classifyError(null, null, null, { cause }),
        ErrorType.CLIENT_ABORTED
      );
    });

    test('CLIENT_ABORTED is not retriable', () => {
      assert.equal(isRetriable(ErrorType.CLIENT_ABORTED), false);
    });
  });

  // --------------------------------------------------------------------------
  // Other 4xx
  // --------------------------------------------------------------------------

  describe('Other 4xx classification', () => {
    test('400 -> UNKNOWN', () => {
      assert.equal(classifyError(400), ErrorType.UNKNOWN);
    });

    test('404 -> UNKNOWN', () => {
      assert.equal(classifyError(404), ErrorType.UNKNOWN);
    });

    test('422 -> UNKNOWN', () => {
      assert.equal(classifyError(422), ErrorType.UNKNOWN);
    });

    test('408 -> NETWORK_ERROR (retriable transient)', () => {
      assert.equal(classifyError(408), ErrorType.NETWORK_ERROR);
    });

    test('UNKNOWN is not retriable', () => {
      assert.equal(isRetriable(ErrorType.UNKNOWN), false);
    });
  });

  // --------------------------------------------------------------------------
  // isRetriable comprehensive
  // --------------------------------------------------------------------------

  describe('isRetriable', () => {
    test('returns true for retriable error types', () => {
      assert.equal(isRetriable(ErrorType.RATE_LIMIT_TRANSIENT), true);
      assert.equal(isRetriable(ErrorType.FORBIDDEN_TEMP), true);
      assert.equal(isRetriable(ErrorType.SERVER_ERROR), true);
      assert.equal(isRetriable(ErrorType.NETWORK_ERROR), true);
    });

    test('returns false for non-retriable error types', () => {
      assert.equal(isRetriable(ErrorType.AUTH_INVALID), false);
      assert.equal(isRetriable(ErrorType.FORBIDDEN_KEY), false);
      assert.equal(isRetriable(ErrorType.FORBIDDEN_MODEL), false);
      assert.equal(isRetriable(ErrorType.FORBIDDEN_PROVIDER), false);
      assert.equal(isRetriable(ErrorType.FORBIDDEN_REGION), false);
      assert.equal(isRetriable(ErrorType.RATE_LIMIT_QUOTA), false);
      assert.equal(isRetriable(ErrorType.CLIENT_ABORTED), false);
      assert.equal(isRetriable(ErrorType.UNKNOWN), false);
    });
  });

  // --------------------------------------------------------------------------
  // getCooldownDuration comprehensive
  // --------------------------------------------------------------------------

  describe('getCooldownDuration', () => {
    test('AUTH_INVALID -> 86400s (24h)', () => {
      assert.equal(getCooldownDuration(ErrorType.AUTH_INVALID), 86400);
    });

    test('FORBIDDEN_KEY -> 3600s (1h)', () => {
      assert.equal(getCooldownDuration(ErrorType.FORBIDDEN_KEY), 3600);
    });

    test('FORBIDDEN_MODEL -> 1800s (30min)', () => {
      assert.equal(getCooldownDuration(ErrorType.FORBIDDEN_MODEL), 1800);
    });

    test('FORBIDDEN_PROVIDER -> 1800s (30min)', () => {
      assert.equal(getCooldownDuration(ErrorType.FORBIDDEN_PROVIDER), 1800);
    });

    test('FORBIDDEN_REGION -> 86400s (24h)', () => {
      assert.equal(getCooldownDuration(ErrorType.FORBIDDEN_REGION), 86400);
    });

    test('FORBIDDEN_TEMP -> 60s (1min)', () => {
      assert.equal(getCooldownDuration(ErrorType.FORBIDDEN_TEMP), 60);
    });

    test('RATE_LIMIT_TRANSIENT -> 30s', () => {
      assert.equal(getCooldownDuration(ErrorType.RATE_LIMIT_TRANSIENT), 30);
    });

    test('RATE_LIMIT_QUOTA -> 3600s (1h)', () => {
      assert.equal(getCooldownDuration(ErrorType.RATE_LIMIT_QUOTA), 3600);
    });

    test('SERVER_ERROR -> 60s (1min)', () => {
      assert.equal(getCooldownDuration(ErrorType.SERVER_ERROR), 60);
    });

    test('NETWORK_ERROR -> 15s', () => {
      assert.equal(getCooldownDuration(ErrorType.NETWORK_ERROR), 15);
    });

    test('CLIENT_ABORTED -> 0s (no cooldown)', () => {
      assert.equal(getCooldownDuration(ErrorType.CLIENT_ABORTED), 0);
    });

    test('UNKNOWN -> 0s (no cooldown)', () => {
      assert.equal(getCooldownDuration(ErrorType.UNKNOWN), 0);
    });
  });

  // --------------------------------------------------------------------------
  // shouldDisableKey comprehensive
  // --------------------------------------------------------------------------

  describe('shouldDisableKey', () => {
    test('returns true only for AUTH_INVALID and FORBIDDEN_KEY', () => {
      assert.equal(shouldDisableKey(ErrorType.AUTH_INVALID), true);
      assert.equal(shouldDisableKey(ErrorType.FORBIDDEN_KEY), true);
    });

    test('returns false for all other error types', () => {
      assert.equal(shouldDisableKey(ErrorType.FORBIDDEN_MODEL), false);
      assert.equal(shouldDisableKey(ErrorType.FORBIDDEN_PROVIDER), false);
      assert.equal(shouldDisableKey(ErrorType.FORBIDDEN_REGION), false);
      assert.equal(shouldDisableKey(ErrorType.FORBIDDEN_TEMP), false);
      assert.equal(shouldDisableKey(ErrorType.RATE_LIMIT_TRANSIENT), false);
      assert.equal(shouldDisableKey(ErrorType.RATE_LIMIT_QUOTA), false);
      assert.equal(shouldDisableKey(ErrorType.SERVER_ERROR), false);
      assert.equal(shouldDisableKey(ErrorType.NETWORK_ERROR), false);
      assert.equal(shouldDisableKey(ErrorType.CLIENT_ABORTED), false);
      assert.equal(shouldDisableKey(ErrorType.UNKNOWN), false);
    });
  });

  // --------------------------------------------------------------------------
  // isQuotaExhausted (direct)
  // --------------------------------------------------------------------------

  describe('isQuotaExhausted', () => {
    test('returns true for explicit quota error codes', () => {
      assert.equal(isQuotaExhausted(null, 'insufficient_quota', null), true);
      assert.equal(isQuotaExhausted(null, 'billing_hard_limit_reached', null), true);
      assert.equal(isQuotaExhausted(null, 'usage_limit_reached', null), true);
    });

    test('returns true for quota keywords in body', () => {
      assert.equal(isQuotaExhausted('monthly quota exhausted', null, null), true);
      assert.equal(isQuotaExhausted('credit limit reached', null, null), true);
    });

    test('returns true for long retry-after (>=600s)', () => {
      assert.equal(isQuotaExhausted('rate limited', null, 600), true);
      assert.equal(isQuotaExhausted('rate limited', null, 3600), true);
    });

    test('returns false for transient signals', () => {
      assert.equal(isQuotaExhausted('rate limit exceeded', null, null), false);
      assert.equal(isQuotaExhausted('too many requests', null, 30), false);
      assert.equal(isQuotaExhausted(null, null, null), false);
    });
  });
});
