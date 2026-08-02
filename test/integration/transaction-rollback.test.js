// test/integration/transaction-rollback.test.js
// Smart Router Mainline - Phase 1 Sealed Final
// True transaction atomicity regression tests (方案A: finalizeRequestAtomic):
//   - cost_records write failure  -> full rollback, no half-state
//   - audit_records write failure -> full rollback, no half-state
//   - in-memory CostTracker NOT updated on failure
//   - safe to retry after rollback
//
// Injection strategy: since finalizeRequestAtomic writes via synchronous SQL
// inside BEGIN IMMEDIATE, failures are injected with SQLite BEFORE INSERT
// triggers (RAISE(ABORT)) on cost_records / audit_records.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SQLiteStore } from '../../src/storage/sqlite-store.js';
import { CostTracker } from '../../src/cost/tracker.js';
import { Finalizer } from '../../src/runtime/finalization.js';
import { AttemptLog } from '../../src/runtime/attempts.js';
import { Outcome } from '../../src/runtime/outcomes.js';

// Minimal model config for cost calculation
const MODEL_CONFIG = {
  models: [
    {
      id: 'test-model',
      provider: 'mock-a',
      price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02, currency: 'USD' },
    },
  ],
  budget: { allowPaid: true },
  agent_bindings: {},
};

function buildAttemptLog(requestId) {
  const al = new AttemptLog(requestId);
  al.add({
    attemptNumber: 1,
    model: 'test-model',
    provider: 'mock-a',
    keyId: 'mock-a-0',
    transportOutcome: 'success',
    validatedOutcome: 'success',
    latencyMs: 100,
    firstByteMs: 50,
    headersReceived: true,
    firstByteSentToClient: true,
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    timestamp: new Date().toISOString(),
  });
  return al;
}

async function assertNoHalfState(store, costTracker, requestId) {
  const finalized = await store.isFinalized(requestId);
  assert.strictEqual(finalized, false, 'finalized_requests should not exist after rollback');

  const cost = await store.getCost(requestId);
  assert.ok(!cost, 'cost_records should not exist after rollback');

  const audit = await store.getAuditRecord(requestId);
  assert.ok(!audit, 'audit_records should not exist after rollback');

  const attempts = await store.getAttempts(requestId);
  assert.strictEqual(attempts.length, 0, 'attempts should not exist after rollback');

  const req = await store.getRequest(requestId);
  assert.ok(req, 'request row should exist (saved before finalize)');
  assert.notStrictEqual(req.status, 'completed', 'requests.status must not be completed after rollback');

  assert.ok(
    !costTracker.records.has(requestId),
    'in-memory cost must not exist after rollback',
  );
}

describe('Transaction Atomicity (finalizeRequestAtomic)', () => {
  test('cost_records write failure -> full rollback + safe retry', async () => {
    const requestId = 'txn-cost-fail';
    const store = new SQLiteStore(':memory:');
    await store.init();

    // Inject: any INSERT into cost_records aborts the transaction
    store._db.exec(
      "CREATE TRIGGER trg_fail_cost BEFORE INSERT ON cost_records BEGIN SELECT RAISE(ABORT, 'injected saveCost failure'); END;"
    );

    const costTracker = new CostTracker(MODEL_CONFIG, store);
    const finalizer = new Finalizer(costTracker, store);
    const al = buildAttemptLog(requestId);

    await store.saveRequest({
      requestId, agentId: 'test', protocol: 'chat',
      model: 'test-model', provider: 'mock-a',
      timestamp: new Date().toISOString(),
    });

    // finalize must REJECT (no catch-and-continue)
    await assert.rejects(
      () => finalizer.finalizeRequestTransaction(requestId, al, Outcome.COMPLETED, { protocol: 'chat' }),
      /injected saveCost failure/,
    );

    await assertNoHalfState(store, costTracker, requestId);

    // Safe retry: drop the trigger, retry must succeed
    store._db.exec('DROP TRIGGER IF EXISTS trg_fail_cost');
    const retry = await finalizer.finalizeRequestTransaction(requestId, al, Outcome.COMPLETED, { protocol: 'chat' });
    assert.ok(retry.finalized, 'retry after rollback should succeed');
    assert.ok(costTracker.records.has(requestId), 'in-memory cost written after successful retry');
    assert.strictEqual(costTracker.records.size, 1, 'cost recorded exactly once');

    store.close();
  });

  test('audit_records write failure -> full rollback + safe retry', async () => {
    const requestId = 'txn-audit-fail';
    const store = new SQLiteStore(':memory:');
    await store.init();

    store._db.exec(
      "CREATE TRIGGER trg_fail_audit BEFORE INSERT ON audit_records BEGIN SELECT RAISE(ABORT, 'injected saveAuditRecord failure'); END;"
    );

    const costTracker = new CostTracker(MODEL_CONFIG, store);
    const finalizer = new Finalizer(costTracker, store);
    const al = buildAttemptLog(requestId);

    await store.saveRequest({
      requestId, agentId: 'test', protocol: 'chat',
      model: 'test-model', provider: 'mock-a',
      timestamp: new Date().toISOString(),
    });

    await assert.rejects(
      () => finalizer.finalizeRequestTransaction(requestId, al, Outcome.COMPLETED, { protocol: 'chat' }),
      /injected saveAuditRecord failure/,
    );

    await assertNoHalfState(store, costTracker, requestId);

    // Safe retry
    store._db.exec('DROP TRIGGER IF EXISTS trg_fail_audit');
    const retry = await finalizer.finalizeRequestTransaction(requestId, al, Outcome.COMPLETED, { protocol: 'chat' });
    assert.ok(retry.finalized, 'retry after rollback should succeed');
    assert.ok(costTracker.records.has(requestId), 'in-memory cost written after successful retry');

    store.close();
  });

  test('success path: all 5 tables written, cost recorded exactly once', async () => {
    const requestId = 'txn-success';
    const store = new SQLiteStore(':memory:');
    await store.init();

    const costTracker = new CostTracker(MODEL_CONFIG, store);
    const finalizer = new Finalizer(costTracker, store);
    const al = buildAttemptLog(requestId);

    await store.saveRequest({
      requestId, agentId: 'test', protocol: 'chat',
      model: 'test-model', provider: 'mock-a',
      timestamp: new Date().toISOString(),
    });

    const result = await finalizer.finalizeRequestTransaction(requestId, al, Outcome.COMPLETED, { protocol: 'chat' });
    assert.ok(result.finalized);

    assert.strictEqual(await store.isFinalized(requestId), true);
    assert.strictEqual((await store.getAttempts(requestId)).length, 1);
    assert.ok(await store.getCost(requestId));
    assert.ok(await store.getAuditRecord(requestId));
    const req = await store.getRequest(requestId);
    assert.strictEqual(req.status, 'completed');
    assert.ok(costTracker.records.has(requestId));
    assert.strictEqual(costTracker.records.size, 1);

    const again = await finalizer.finalizeRequestTransaction(requestId, al, Outcome.COMPLETED, { protocol: 'chat' });
    assert.strictEqual(again.finalized, false);
    assert.strictEqual(again.reason, 'already_finalized');
    assert.strictEqual(costTracker.records.size, 1, 'cost must not double-record');

    store.close();
  });
});
