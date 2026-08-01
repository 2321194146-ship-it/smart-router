// test/unit/protocol-chat.test.js
// Smart Router Mainline - Phase 1
// Chat 协议转换和流式处理测试
//
// 使用 Node.js 内置 node:test 和 node:assert，无第三方依赖。

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseSSEChunk, isDoneMarker } from '../../src/protocols/chat-stream.js';
import { buildErrorResponse } from '../../src/protocols/chat.js';

describe('Chat Protocol', () => {
  // --------------------------------------------------------------------------
  // SSE chunk 解析
  // --------------------------------------------------------------------------

  describe('parseSSEChunk', () => {
    test('parses single event', () => {
      const events = parseSSEChunk('data: {"hello":"world"}\n\n');
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].data, '{"hello":"world"}');
      assert.strictEqual(events[0].event, null);
      assert.strictEqual(events[0].id, null);
    });

    test('parses multiple events', () => {
      const events = parseSSEChunk('data: msg1\n\ndata: msg2\n\n');
      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0].data, 'msg1');
      assert.strictEqual(events[1].data, 'msg2');
    });

    test('handles multi-line data', () => {
      const events = parseSSEChunk('data: line1\ndata: line2\n\n');
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].data, 'line1\nline2');
    });

    test('handles event and id fields', () => {
      const events = parseSSEChunk('event: message\ndata: hello\nid: 123\n\n');
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].event, 'message');
      assert.strictEqual(events[0].data, 'hello');
      assert.strictEqual(events[0].id, '123');
    });

    test('skips comment lines', () => {
      const events = parseSSEChunk(': this is a comment\ndata: hello\n\n');
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].data, 'hello');
    });

    test('handles Buffer input', () => {
      const events = parseSSEChunk(Buffer.from('data: hello\n\n'));
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].data, 'hello');
    });

    test('returns empty array for empty input', () => {
      assert.strictEqual(parseSSEChunk('').length, 0);
      assert.strictEqual(parseSSEChunk(null).length, 0);
      assert.strictEqual(parseSSEChunk(undefined).length, 0);
    });

    test('handles CRLF line endings', () => {
      const events = parseSSEChunk('data: hello\r\n\r\n');
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].data, 'hello');
    });
  });

  // --------------------------------------------------------------------------
  // [DONE] 检测
  // --------------------------------------------------------------------------

  describe('isDoneMarker', () => {
    test('detects [DONE]', () => {
      assert.strictEqual(isDoneMarker('[DONE]'), true);
    });

    test('does not match non-DONE data', () => {
      assert.strictEqual(isDoneMarker('{"hello":"world"}'), false);
      assert.strictEqual(isDoneMarker('done'), false);
      assert.strictEqual(isDoneMarker(null), false);
      assert.strictEqual(isDoneMarker(undefined), false);
      assert.strictEqual(isDoneMarker(''), false);
    });

    test('handles whitespace', () => {
      assert.strictEqual(isDoneMarker('  [DONE]  '), true);
      assert.strictEqual(isDoneMarker('\n[DONE]\n'), true);
      assert.strictEqual(isDoneMarker('\t[DONE]\t'), true);
    });
  });

  // --------------------------------------------------------------------------
  // 错误响应构建
  // --------------------------------------------------------------------------

  describe('buildErrorResponse', () => {
    test('creates OpenAI-compatible error', () => {
      const result = buildErrorResponse(
        { message: 'Rate limit exceeded', type: 'rate_limit_transient' },
        'req-1',
      );
      assert.ok(result.error);
      assert.strictEqual(result.error.message, 'Rate limit exceeded');
      assert.strictEqual(result.error.type, 'rate_limit_exceeded');
      assert.strictEqual(result.error.param, null);
    });

    test('maps error types correctly', () => {
      const authResult = buildErrorResponse(
        { message: 'bad key', type: 'auth_invalid' },
      );
      assert.strictEqual(authResult.error.type, 'authentication_error');

      const forbiddenResult = buildErrorResponse(
        { message: 'forbidden', type: 'forbidden_model' },
      );
      assert.strictEqual(forbiddenResult.error.type, 'permission_denied');

      const serverResult = buildErrorResponse(
        { message: 'server error', type: 'server_error' },
      );
      assert.strictEqual(serverResult.error.type, 'server_error');

      const abortResult = buildErrorResponse(
        { message: 'aborted', type: 'client_aborted' },
      );
      assert.strictEqual(abortResult.error.type, 'client_closed');

      const invalidResult = buildErrorResponse(
        { message: 'bad request', type: 'invalid_request_error' },
      );
      assert.strictEqual(invalidResult.error.type, 'invalid_request_error');
    });

    test('handles ProviderError', () => {
      // ProviderError-like object with type, code, and message
      const providerError = {
        message: 'Upstream provider returned 500',
        type: 'server_error',
        code: 'upstream_500',
      };
      const result = buildErrorResponse(providerError, 'req-2');
      assert.strictEqual(result.error.message, 'Upstream provider returned 500');
      assert.strictEqual(result.error.type, 'server_error');
      assert.strictEqual(result.error.code, 'upstream_500');
    });

    test('handles generic Error', () => {
      const err = new Error('Something went wrong');
      const result = buildErrorResponse(err, 'req-3');
      assert.strictEqual(result.error.message, 'Something went wrong');
      // Generic Error has no type field, defaults to 'unknown' -> 'internal_error'
      assert.strictEqual(result.error.type, 'internal_error');
      assert.strictEqual(result.error.code, null);
    });

    test('handles null error', () => {
      const result = buildErrorResponse(null);
      assert.strictEqual(result.error.message, 'An unexpected error occurred');
      assert.strictEqual(result.error.type, 'internal_error');
    });

    test('uses errorType alias', () => {
      const result = buildErrorResponse({
        message: 'rate limited',
        errorType: 'rate_limit_transient',
      });
      assert.strictEqual(result.error.type, 'rate_limit_exceeded');
    });

    test('uses errorCode alias', () => {
      const result = buildErrorResponse({
        message: 'error',
        type: 'server_error',
        errorCode: 'ERR_500',
      });
      assert.strictEqual(result.error.code, 'ERR_500');
    });
  });
});
