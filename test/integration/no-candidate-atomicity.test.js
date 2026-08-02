// test/integration/no-candidate-atomicity.test.js
// Smart Router Mainline - Phase 1 Sealed Final
// no_candidate atomicity regression tests:
//
//   A. no_candidate transaction rollback:
//        inject audit_records write failure -> finalized=false, requests.status
//        unchanged, audit=null, cost=null, safe retry
//        after recovery: finalized=true, requests.status=no_candidate,
//        audit exists, cost absent
//
//   B. Three-protocol HTTP no-candidate:
//        Chat / Responses / Anthropic with an empty candidate list
//        -> correct HTTP status, same internal requestId,
//           requests.status=no_candidate, audit.outcome=no_candidate,
//           attempts=0, cost=0

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createMockProvider,
  createTestConfig,
  writeConfig,
  startSmartRouter,
  stopSmartRouter,
  httpRequest,
  sleep,
} from './helpers.js';
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

function count(db, sql) {
  return db.prepare(sql).get().c;
}

describe('A. no_candidate transaction rollback', () => {
  test('audit write failure -> rollback, no half-state, safe retry to no_candidate', async () => {
    const requestId = 'nc-rollback-1';
    const store = new SQLiteStore(':memory:');
    await store.init();

    // Inject: any INSERT into audit_records aborts the transaction
    store._db.exec(
      "CREATE TRIGGER trg_fail_nc_audit BEFORE INSERT ON audit_records BEGIN SELECT RAISE(ABORT, 'injected saveAuditRecord failure'); END;"
    );

    const costTracker = new CostTracker(MODEL_CONFIG, store);
    const finalizer = new Finalizer(costTracker, store);

    await store.saveRequest({
      requestId, agentId: 'test', protocol: 'chat',
      model: 'nonexistent-model', provider: null,
      timestamp: new Date().toISOString(),
    });

    // finalize with Outcome.NO_CANDIDATE (empty attempt log)
    const al = new AttemptLog(requestId);
    await assert.rejects(
      () => finalizer.finalizeRequestTransaction(requestId, al, Outcome.NO_CANDIDATE, {
        agentId: 'test', protocol: 'chat', requestedModel: 'nonexistent-model',
      }),
      /injected saveAuditRecord failure/,
    );

    // finalized=false
    assert.strictEqual(await store.isFinalized(requestId), false, 'finalized must be false after rollback');
    // requests.status unchanged (null / not no_candidate)
    const req = await store.getRequest(requestId);
    assert.notStrictEqual(req.status, 'no_candidate', 'requests.status must not be set after rollback');
    // audit=null
    assert.strictEqual(await store.getAuditRecord(requestId), null, 'audit must be null after rollback');
    // cost=null
    assert.strictEqual(await store.getCost(requestId), null, 'cost must be null after rollback');
    // in-memory cost untouched
    assert.strictEqual(costTracker.records.size, 0, 'in-memory cost must stay empty');

    // Safe retry after dropping the trigger
    store._db.exec('DROP TRIGGER IF EXISTS trg_fail_nc_audit');
    const retry = await finalizer.finalizeRequestTransaction(requestId, al, Outcome.NO_CANDIDATE, {
      agentId: 'test', protocol: 'chat', requestedModel: 'nonexistent-model',
    });
    assert.ok(retry.finalized, 'retry after rollback should succeed');

    // finalized=true
    assert.strictEqual(await store.isFinalized(requestId), true);
    // requests.status=no_candidate
    const req2 = await store.getRequest(requestId);
    assert.strictEqual(req2.status, 'no_candidate');
    // audit exists with outcome=no_candidate
    const audit = await store.getAuditRecord(requestId);
    assert.ok(audit, 'audit must exist after retry');
    assert.strictEqual(audit.outcome, 'no_candidate');
    assert.strictEqual(audit.attemptCount, 0);
    // cost absent
    assert.strictEqual(await store.getCost(requestId), null, 'no_candidate must not write cost');
    // in-memory cost still empty
    assert.strictEqual(costTracker.records.size, 0);

    store.close();
  });
});

describe('B. Three-protocol HTTP no-candidate', () => {
  let tmpDir;
  after(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  // strictModel + nonexistent model -> candidates empty -> no_candidate (503)
  function buildNoCandidateConfig(port, dataDir) {
    const config = createTestConfig(port, { dataDir, strictModel: true });
    return config;
  }

  async function startRouter(port, dataDir) {
    const config = buildNoCandidateConfig(port, dataDir);
    const configPath = writeConfig(config, dataDir);
    const router = await startSmartRouter(configPath);
    await sleep(200);
    return router;
  }

  async function assertNoCandidateEvidence(router, externalId, expectedProtocol, resp) {
    const store = router.server._components.store;
    // HTTP status: 503 service_unavailable
    assert.strictEqual(resp.status, 503, `expected 503, got ${resp.status}`);

    // Same internal requestId via externalRequestId
    const req = await store.getRequestByExternalId(externalId);
    assert.ok(req, 'request persisted with externalRequestId');
    assert.ok(req.requestId.startsWith('sr_'), 'internal requestId sr_ format');
    assert.strictEqual(req.protocol, expectedProtocol);
    assert.strictEqual(req.status, 'no_candidate', 'requests.status=no_candidate');

    // audit.outcome=no_candidate
    const audit = await store.getAuditRecord(req.requestId);
    assert.ok(audit, 'audit must exist');
    assert.strictEqual(audit.outcome, 'no_candidate');
    assert.strictEqual(audit.attemptCount, 0, 'attempts must be empty');

    // attempts=0, cost=0
    assert.strictEqual(
      count(store._db, `SELECT COUNT(*) AS c FROM attempts WHERE request_id = '${req.requestId}'`),
      0,
      'attempts count must be 0',
    );
    assert.strictEqual(
      count(store._db, `SELECT COUNT(*) AS c FROM cost_records WHERE request_id = '${req.requestId}'`),
      0,
      'cost count must be 0',
    );
  }

  test('Chat: nonexistent model (strictModel) -> 503, no_candidate evidence', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sr-nc-chat-'));
    const provider = createMockProvider();
    await provider.listen();
    try {
      const router = await startRouter(provider.port, tmpDir);
      try {
        const resp = await httpRequest(router.port, '/v1/chat/completions', {
          body: { model: 'nonexistent-model', messages: [{ role: 'user', content: 'Hi' }] },
          headers: { 'x-request-id': 'nc-chat-ext-1' },
        });
        await assertNoCandidateEvidence(router, 'nc-chat-ext-1', 'chat', resp);
      } finally { await stopSmartRouter(router); }
    } finally { await provider.close(); }
  });

  test('Responses: nonexistent model (strictModel) -> 503, no_candidate evidence', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sr-nc-resp-'));
    const provider = createMockProvider();
    await provider.listen();
    try {
      const router = await startRouter(provider.port, tmpDir);
      try {
        const resp = await httpRequest(router.port, '/v1/responses', {
          body: { model: 'nonexistent-model', input: 'Hi' },
          headers: { 'x-request-id': 'nc-resp-ext-1' },
        });
        await assertNoCandidateEvidence(router, 'nc-resp-ext-1', 'responses', resp);
      } finally { await stopSmartRouter(router); }
    } finally { await provider.close(); }
  });

  test('Anthropic: nonexistent model (strictModel) -> 503, no_candidate evidence', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sr-nc-anth-'));
    const provider = createMockProvider();
    await provider.listen();
    try {
      const router = await startRouter(provider.port, tmpDir);
      try {
        const resp = await httpRequest(router.port, '/v1/messages', {
          body: { model: 'nonexistent-model', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 64 },
          headers: { 'x-request-id': 'nc-anth-ext-1' },
        });
        await assertNoCandidateEvidence(router, 'nc-anth-ext-1', 'anthropic', resp);
      } finally { await stopSmartRouter(router); }
    } finally { await provider.close(); }
  });
});
