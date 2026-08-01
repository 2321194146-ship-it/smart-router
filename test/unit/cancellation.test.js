// test/unit/cancellation.test.js
// Smart Router Mainline - Phase 1
// 客户端取消处理测试
//
// 使用 Node.js 内置 node:test 和 node:assert，无第三方依赖。

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { CancelToken, isAbortError } from '../../src/runtime/cancellation.js';

describe('Cancellation', () => {
  test('CancelToken starts not aborted', () => {
    const token = new CancelToken();
    assert.strictEqual(token.isAborted(), false);
    assert.strictEqual(token.reason, null);
  });

  test('abort sets aborted flag', () => {
    const token = new CancelToken();
    token.abort('manual_cancel');
    assert.strictEqual(token.isAborted(), true);
    assert.strictEqual(token.reason, 'manual_cancel');
  });

  test('abort triggers signal', () => {
    const token = new CancelToken();
    assert.strictEqual(token.signal.aborted, false);
    token.abort('manual_cancel');
    assert.strictEqual(token.signal.aborted, true);
  });

  test('abort calls onCancel listeners', () => {
    const token = new CancelToken();
    let called = false;
    let receivedReason = null;
    token.onCancel((reason) => {
      called = true;
      receivedReason = reason;
    });
    token.abort('client_aborted_request');
    assert.strictEqual(called, true);
    assert.strictEqual(receivedReason, 'client_aborted_request');
  });

  test('abort is idempotent (second call does nothing)', () => {
    const token = new CancelToken();
    let callCount = 0;
    token.onCancel(() => { callCount++; });
    token.abort('first_reason');
    token.abort('second_reason');
    assert.strictEqual(callCount, 1);
    assert.strictEqual(token.reason, 'first_reason');
  });

  test('onCancel fires immediately if already aborted', () => {
    const token = new CancelToken();
    token.abort('already_done');
    let called = false;
    let receivedReason = null;
    token.onCancel((reason) => {
      called = true;
      receivedReason = reason;
    });
    assert.strictEqual(called, true);
    assert.strictEqual(receivedReason, 'already_done');
  });

  test('signal can be passed to fetch', () => {
    const token = new CancelToken();
    const signal = token.signal;
    assert.ok(signal instanceof AbortSignal);
    assert.strictEqual(signal.aborted, false);
    token.abort('test');
    assert.strictEqual(signal.aborted, true);
  });

  test('isAbortError detects AbortError', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    assert.strictEqual(isAbortError(err), true);
  });

  test('isAbortError detects TimeoutError', () => {
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    assert.strictEqual(isAbortError(err), true);
  });

  test('isAbortError detects cause chain', () => {
    const cause = new Error('aborted');
    cause.name = 'AbortError';
    const err = new Error('wrapper');
    err.cause = cause;
    assert.strictEqual(isAbortError(err), true);
  });

  test('isAbortError detects ABORT_ERR code', () => {
    const err = new Error('aborted');
    err.code = 'ABORT_ERR';
    assert.strictEqual(isAbortError(err), true);
  });

  test('isAbortError returns false for regular errors', () => {
    assert.strictEqual(isAbortError(new Error('network error')), false);
  });

  test('isAbortError returns false for null/undefined', () => {
    assert.strictEqual(isAbortError(null), false);
    assert.strictEqual(isAbortError(undefined), false);
  });

  test('fromHttp creates token from req/res', () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writableEnded = false;
    const token = CancelToken.fromHttp(req, res);
    assert.ok(token instanceof CancelToken);
    assert.strictEqual(token.isAborted(), false);
  });

  test('fromHttp aborts on req aborted event', () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writableEnded = false;
    const token = CancelToken.fromHttp(req, res);
    req.emit('aborted');
    assert.strictEqual(token.isAborted(), true);
    assert.strictEqual(token.reason, 'client_aborted_request');
  });

  test('fromHttp aborts on res close event (when not writableEnded)', () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writableEnded = false;
    const token = CancelToken.fromHttp(req, res);
    res.emit('close');
    assert.strictEqual(token.isAborted(), true);
    assert.strictEqual(token.reason, 'client_aborted_response');
  });

  test('fromHttp does not abort on res close when writableEnded', () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writableEnded = true;
    const token = CancelToken.fromHttp(req, res);
    res.emit('close');
    assert.strictEqual(token.isAborted(), false);
  });

  test('fromHttp handles null req/res', () => {
    const token = CancelToken.fromHttp(null, null);
    assert.ok(token instanceof CancelToken);
    assert.strictEqual(token.isAborted(), false);
  });

  test('fromHttp cleanup removes listeners after abort', () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writableEnded = false;
    const token = CancelToken.fromHttp(req, res);
    token.abort('manual');
    const listenerCountBefore = req.listenerCount('aborted');
    req.emit('aborted');
    assert.strictEqual(token.reason, 'manual');
    assert.strictEqual(req.listenerCount('aborted'), listenerCountBefore);
  });

  test('dispose removes listeners without triggering abort', () => {
    const token = new CancelToken();
    let called = false;
    token.onCancel(() => { called = true; });
    token.dispose();
    token.abort('test');
    assert.strictEqual(called, false);
    assert.strictEqual(token.isAborted(), true);
  });

  test('onCancel unsubscribe prevents future callback', () => {
    const token = new CancelToken();
    let called = false;
    const unsub = token.onCancel(() => { called = true; });
    assert.strictEqual(typeof unsub, 'function');
    unsub();
    token.abort('test');
    assert.strictEqual(called, false);
  });

  test('multiple onCancel listeners all fire', () => {
    const token = new CancelToken();
    let count = 0;
    token.onCancel(() => { count++; });
    token.onCancel(() => { count++; });
    token.onCancel(() => { count++; });
    token.abort('test');
    assert.strictEqual(count, 3);
  });

  test('listener exception does not block other listeners', () => {
    const token = new CancelToken();
    let secondCalled = false;
    token.onCancel(() => { throw new Error('listener error'); });
    token.onCancel(() => { secondCalled = true; });
    token.abort('test');
    assert.strictEqual(secondCalled, true);
  });
});
