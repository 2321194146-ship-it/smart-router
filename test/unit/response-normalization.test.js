import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatCompletionResponse } from '../../src/protocols/response-normalization.js';

describe('normalizeChatCompletionResponse', () => {
  test('keeps a valid choices array unchanged', () => {
    const response = { choices: [{ index: 0, message: { content: 'ok' } }] };
    const normalized = normalizeChatCompletionResponse(response);
    assert.deepEqual(normalized, response);
  });

  test('wraps a single choice object', () => {
    const normalized = normalizeChatCompletionResponse({
      choices: { index: 0, message: { content: 'ok' }, finish_reason: 'stop' },
    });
    assert.deepEqual(normalized.choices, [
      { index: 0, message: { content: 'ok' }, finish_reason: 'stop' },
    ]);
  });

  test('converts a numeric-keyed choices object in order', () => {
    const normalized = normalizeChatCompletionResponse({
      choices: {
        1: { index: 1, message: { content: 'b' } },
        0: { index: 0, message: { content: 'a' } },
      },
    });
    assert.deepEqual(normalized.choices.map((choice) => choice.index), [0, 1]);
  });

  test('does not guess for an unknown object shape', () => {
    const response = { choices: { unexpected: true } };
    assert.deepEqual(normalizeChatCompletionResponse(response), response);
  });
});
