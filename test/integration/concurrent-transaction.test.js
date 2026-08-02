// test/integration/concurrent-transaction.test.js
// Smart Router Mainline - Phase 1 Sealed Final
// Concurrent transaction regression tests (方案A: finalizeRequestAtomic):
//
//   - Fire 100+ finalizeRequestTransaction concurrently against ONE
//     SQLiteStore (single DatabaseSync connection).
//   - Covers protocols: chat / responses / anthropic
//   - Covers outcomes: completed / incomplete / client_aborted / no_candidate
//   - Verifies NO "cannot start a transaction within a transaction",
//     no lost writes, no duplicate cost, no duplicate audit.

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteStore } from '../../src/storage/sqlite-store.js';
import { CostTracker } from '../../src/cost/tracker.js';
import { Finalizer } from '../../src/runtime/finalization.js';
import { AttemptLog } from '../../src/runtime/attempts.js';
import { Outcome } from '../../src/runtime/outcomes.js';

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

const PROTOCOLS = ['chat', 'responses', 'anthropic'];

// Outcome -> attempt shape (some have usage/cost, some do not)
function buildAttemptLog(requestId, outcome) {
  const al = new AttemptLog(requestId);
  if (outcome === Outcome.NO_CANDIDATE) {
    // empty attempt log: no attempts, no cost
    return al;
  }
  const attempt = al.add({
    attemptNumber: 1,
    model: 'test-model',
    provider: 'mock-a',
    keyId: 'mock-a-0',
    latencyMs: 50,
    firstByteMs: 20,
    headersReceived: true,
    timestamp: new Date().toISOString(),
  });
  if (outcome === Outcome.CLIENT_ABORTED) {
    attempt.transportOutcome = 'aborted';
    attempt.validatedOutcome = 'incomplete';
    attempt.errorType = 'client_aborted';
    // aborted: no usage -> no cost
  } else {
    attempt.setTransportResult('success', 200, 50, 20);
    // completed / incomplete both carry usage -> cost written
    attempt.setUsage(
      { prompt_tokens: 10, completion_tokens: 5 },
      null,
    );
    attempt.setValidatedResult(outcome === Outcome.COMPLETED ? 'completed' : 'incomplete');
  }
  return al;
}

function count(db, sql) {
  return db.prepare(sql).get().c;
}

describe('Concurrent finalizeRequestTransaction (100+ on one SQLiteStore)', () => {
  let tmpDir;
  after(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  test('100 concurrent finalizes: no transaction nesting error, no lost/duplicate writes', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sr-concurrent-'));
    const store = new SQLiteStore(join(tmpDir, 'concurrent.db'));
    await store.init();
    const costTracker = new CostTracker(MODEL_CONFIG, store);
    const finalizer = new Finalizer(costTracker, store);

    const N = 100;
    const jobs = [];
    const errors = [];

    // Save request rows first (outside finalize, like the runtime does)
    for (let i = 0; i < N; i++) {
      const requestId = `req-${String(i).padStart(3, '0')}`;
      const protocol = PROTOCOLS[i % PROTOCOLS.length];
      const outcome = i % 4 === 0 ? Outcome.COMPLETED
        : i % 4 === 1 ? Outcome.INCOMPLETE
        : i % 4 === 2 ? Outcome.CLIENT_ABORTED
        : Outcome.NO_CANDIDATE;
      await store.saveRequest({
        requestId, agentId: 'test', protocol,
        model: 'test-model', provider: 'mock-a',
        timestamp: new Date().toISOString(),
      });
      jobs.push({ requestId, protocol, outcome });
    }

    // Fire all finalizes concurrently
    const results = await Promise.all(jobs.map(async ({ requestId, protocol, outcome }) => {
      try {
        const al = buildAttemptLog(requestId, outcome);
        const r = await finalizer.finalizeRequestTransaction(
          requestId, al, outcome, { agentId: 'test', protocol },
        );
        return { requestId, outcome, result: r };
      } catch (err) {
        errors.push({ requestId, outcome, error: err.message });
        return { requestId, outcome, result: { finalized: false, reason: err.message } };
      }
    }));

    // 1. All 100 succeeded
    assert.strictEqual(errors.length, 0, `concurrent finalize errors: ${JSON.stringify(errors)}`);
    assert.strictEqual(results.filter((r) => r.result.finalized).length, N, 'all 100 must finalize');

    // 2. finalized_requests = 100
    assert.strictEqual(count(store._db, 'SELECT COUNT(*) AS c FROM finalized_requests'), N);

    // 3. requests terminal status = 100 (no null status)
    assert.strictEqual(
      count(store._db, 'SELECT COUNT(*) AS c FROM requests WHERE status IS NOT NULL'),
      N,
    );
    assert.strictEqual(count(store._db, 'SELECT COUNT(*) AS c FROM requests'), N);

    // 4. audit_records = 100
    assert.strictEqual(count(store._db, 'SELECT COUNT(*) AS c FROM audit_records'), N);

    // 5. attempts: 1 per non-no_candidate job (75 jobs) -> 75
    const attemptExpected = jobs.filter((j) => j.outcome !== Outcome.NO_CANDIDATE).length;
    assert.strictEqual(count(store._db, 'SELECT COUNT(*) AS c FROM attempts'), attemptExpected);

    // 6. cost_records: completed + incomplete jobs (50) -> 50, each unique
    const costExpected = jobs.filter((j) =>
      j.outcome === Outcome.COMPLETED || j.outcome === Outcome.INCOMPLETE).length;
    assert.strictEqual(count(store._db, 'SELECT COUNT(*) AS c FROM cost_records'), costExpected);
    assert.strictEqual(
      count(store._db, 'SELECT COUNT(DISTINCT request_id) AS c FROM cost_records'),
      costExpected,
      'no duplicate cost records',
    );

    // 7. no_candidate audits: outcome=no_candidate, attempts empty, cost absent
    for (const j of jobs.filter((x) => x.outcome === Outcome.NO_CANDIDATE)) {
      const audit = await store.getAuditRecord(j.requestId);
      assert.strictEqual(audit.outcome, 'no_candidate');
      assert.strictEqual(audit.attemptCount, 0);
      assert.strictEqual(await store.getCost(j.requestId), null);
    }

    // 8. client_aborted audits: no cost written
    for (const j of jobs.filter((x) => x.outcome === Outcome.CLIENT_ABORTED)) {
      const audit = await store.getAuditRecord(j.requestId);
      assert.strictEqual(audit.outcome, 'client_aborted');
      assert.strictEqual(await store.getCost(j.requestId), null);
    }

    // 9. completed audits: cost exists exactly once
    for (const j of jobs.filter((x) => x.outcome === Outcome.COMPLETED)) {
      assert.ok(await store.getCost(j.requestId));
    }

    // 10. in-memory cost: exactly costExpected records
    assert.strictEqual(costTracker.records.size, costExpected);

    store.close();
  });

  test('50 concurrent finalizes on a FILE-backed SQLiteStore (WAL mode)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sr-concurrent-file-'));
    const store = new SQLiteStore(join(tmpDir, 'file.db'));
    await store.init();
    const costTracker = new CostTracker(MODEL_CONFIG, store);
    const finalizer = new Finalizer(costTracker, store);

    const N = 50;
    const errors = [];
    const results = await Promise.all(Array.from({ length: N }, async (_, i) => {
      const requestId = `file-req-${String(i).padStart(3, '0')}`;
      const protocol = PROTOCOLS[i % PROTOCOLS.length];
      const outcome = i % 2 === 0 ? Outcome.COMPLETED : Outcome.NO_CANDIDATE;
      await store.saveRequest({
        requestId, agentId: 'test', protocol,
        model: 'test-model', provider: 'mock-a',
        timestamp: new Date().toISOString(),
      });
      try {
        const al = buildAttemptLog(requestId, outcome);
        const r = await finalizer.finalizeRequestTransaction(
          requestId, al, outcome, { agentId: 'test', protocol },
        );
        return r.finalized;
      } catch (err) {
        errors.push({ requestId, error: err.message });
        return false;
      }
    }));

    assert.strictEqual(errors.length, 0, `errors: ${JSON.stringify(errors)}`);
    assert.strictEqual(results.filter(Boolean).length, N);
    assert.strictEqual(count(store._db, 'SELECT COUNT(*) AS c FROM finalized_requests'), N);
    assert.strictEqual(count(store._db, 'SELECT COUNT(*) AS c FROM audit_records'), N);
    assert.strictEqual(
      count(store._db, 'SELECT COUNT(*) AS c FROM requests WHERE status IS NOT NULL'),
      N,
    );
    store.close();
  });
});
