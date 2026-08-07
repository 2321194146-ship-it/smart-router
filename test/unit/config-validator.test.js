import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../src/config/validator.js';

function baseConfig() {
  return {
    server: {
      host: '127.0.0.1',
      port: 28788,
      request_timeout_ms: 300000,
      stream_idle_timeout_ms: 30000,
      stream_total_timeout_ms: 300000,
    },
    intelligence: { mode: 'off' },
    routing: { max_concurrent: 16 },
    providers: [{
      name: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'test-key',
      api_type: 'anthropic_native',
    }],
    models: [{
      id: 'claude',
      provider: 'anthropic',
      apiModel: 'claude-sonnet',
      tier: 'tier1',
      enabled: true,
      paid: true,
    }],
    agent_bindings: {},
    budget: { allowPaid: true },
    circuit_breaker: { enabled: true },
  };
}

test('accepts stream timeout settings and explicit native Anthropic provider type', () => {
  const result = validateConfig(baseConfig());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('rejects non-positive or non-integer stream timeout settings', () => {
  const config = baseConfig();
  config.server.stream_idle_timeout_ms = 0;
  config.server.stream_total_timeout_ms = 1.5;

  const result = validateConfig(config);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /stream_idle_timeout_ms must be a positive integer/);
  assert.match(result.errors.join('\n'), /stream_total_timeout_ms must be a positive integer/);
});

test('rejects a total stream timeout shorter than the idle timeout', () => {
  const config = baseConfig();
  config.server.stream_total_timeout_ms = 1000;

  const result = validateConfig(config);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /stream_total_timeout_ms must be >= server\.stream_idle_timeout_ms/);
});

test('rejects unknown provider api types', () => {
  const config = baseConfig();
  config.providers[0].api_type = 'anthropic_guess_by_headers';

  const result = validateConfig(config);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /api_type must be "openai" or "anthropic_native"/);
});
