// test/integration/transaction-rollback.test.js
// Smart Router Mainline - Phase 1
// True transaction atomicity regression tests:
//   - saveCost failure  -> full rollback, no half-state
//   - saveAuditRecord failure -> full rollback, no half-state
//   - in-memory CostTracker NOT updated on failure
//   - safe to retry after rollback
//
// Requirement (#1): any step failure inside finalizeRequestTransaction must
// roll back ALL writes (finalized_requests, requests status, attempts,
// cost_records, audit_records) and must NOT touch in-memory cost state.

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
  // finalized_requests must NOT exist
  const finalized = await store.isFinalized(requestId);
  assert.strictEqual(finalized, false, 'finalized_requests should not exist after rollback');

  // cost_records must NOT exist
  const cost = await store.getCost(requestId);
  assert.ok(!cost, 'cost_records should not exist after rollback');

  // audit_records must NOT exist
  const audit = await store.getAuditRecord(requestId);
  assert.ok(!audit, 'audit_records should not exist after rollback');

  // attempts must NOT exist (rolled back with the transaction)
  const attempts = await store.getAttempts(requestId);
  assert.strictEqual(attempts.length, 0, 'attempts should not exist after rollback');

  // requests status must NOT be completed
  const req = await store.getRequest(requestId);
  assert.ok(req, 'request row should exist (saved before finalize)');
  assert.notStrictEqual(req.status, 'completed', 'requests.status must not be completed after rollback');

  // in-memory cost must NOT exist
  assert.ok(
    !costTracker.records.has(requestId),
    'in-memory cost must not exist after rollback',
  );
}

describe('Transaction Atomicity (finalizeRequestTransaction)', () => {
  test('saveCost failure -> full rollback + safe retry', async () => {
    const requestId = 'txn-cost-fail';
    const store = new SQLiteStore(':memory:');
    await store.init();

    // Inject saveCost failure
    store.saveCost = async () => { throw new Error('injected saveCost failure'); };

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

    // Safe retry: restore saveCost, retry must succeed
    delete store.saveCost;
    const retry = await finalizer.finalizeRequestTransaction(requestId, al, Outcome.COMPLETED, { protocol: 'chat' });
    assert.ok(retry.finalized, 'retry after rollback should succeed');
    assert.ok(costTracker.records.has(requestId), 'in-memory cost written after successful retry');
    assert.strictEqual(costTracker.records.size, 1, 'cost recorded exactly once');

    store.close();
  });

  test('saveAuditRecord failure -> full rollback + safe retry', async () => {
    const requestId = 'txn-audit-fail';
    const store = new SQLiteStore(':memory:');
    await store.init();

    // Inject saveAuditRecord failure
    store.saveAuditRecord = async () => { throw new Error('injected saveAuditRecord failure'); };

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
    delete store.saveAuditRecord;
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

    // finalized_requests
    assert.strictEqual(await store.isFinalized(requestId), true);
    // attempts
    assert.strictEqual((await store.getAttempts(requestId)).length, 1);
    // cost_records
    assert.ok(await store.getCost(requestId));
    // audit_records
    assert.ok(await store.getAuditRecord(requestId));
    // requests status updated to completed
    const req = await store.getRequest(requestId);
    assert.strictEqual(req.status, 'completed');
    // in-memory cost
    assert.ok(costTracker.records.has(requestId));
    assert.strictEqual(costTracker.records.size, 1);

    // Idempotent: second call does not duplicate
    const again = await finalizer.finalizeRequestTransaction(requestId, al, Outcome.COMPLETED, { protocol: 'chat' });
    assert.strictEqual(again.finalized, false);
    assert.strictEqual(again.reason, 'already_finalized');
    assert.strictEqual(costTracker.records.size, 1, 'cost must not double-record');

    store.close();
  });
});
