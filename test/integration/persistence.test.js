// test/integration/persistence.test.js
// Smart Router Mainline - Phase 1
// Persistence test: verify data survives store close/reopen (simulating restart)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteStore } from '../../src/storage/sqlite-store.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

describe('Persistence: SQLite Store Restart', () => {
  let tmpDir, dbPath;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sr-persist-'));
    dbPath = join(tmpDir, 'test.db');
  });

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('audit records survive store close/reopen', async () => {
    // Phase 1: Write data
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      await store.saveAuditRecord({
        requestId: 'req-audit-1',
        outcome: 'completed',
        finalModel: 'test-model',
        finalProvider: 'mock-a',
        attempts: [{ attemptNumber: 1, model: 'test-model', provider: 'mock-a' }],
        timestamp: new Date().toISOString(),
      });

      await store.saveAuditRecord({
        requestId: 'req-audit-2',
        outcome: 'no_candidate',
        timestamp: new Date().toISOString(),
      });

      // Verify in same session
      const r1 = await store.getAuditRecord('req-audit-1');
      assert.ok(r1, 'audit record should exist in same session');
      assert.strictEqual(r1.requestId, 'req-audit-1');
      assert.strictEqual(r1.outcome, 'completed');

      await store.close();
    }

    // Phase 2: Reopen and verify data persisted
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      const r1 = await store.getAuditRecord('req-audit-1');
      assert.ok(r1, 'audit record should survive restart');
      assert.strictEqual(r1.requestId, 'req-audit-1');
      assert.strictEqual(r1.outcome, 'completed');
      assert.strictEqual(r1.finalModel, 'test-model');

      const r2 = await store.getAuditRecord('req-audit-2');
      assert.ok(r2, 'second audit record should survive restart');
      assert.strictEqual(r2.outcome, 'no_candidate');

      const all = await store.getAllAuditRecords();
      assert.ok(all.length >= 2, 'should have at least 2 audit records after restart');

      await store.close();
    }
  });

  test('cost records survive restart with deduplication', async () => {
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      const result1 = await store.saveCost({
        requestId: 'req-cost-1',
        modelId: 'test-model',
        provider: 'mock-a',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        cost: { inputCost: 0.001, outputCost: 0.002, totalCost: 0.003, currency: 'USD' },
        dateKey: '2026-08-01',
        timestamp: new Date().toISOString(),
      });
      assert.ok(result1.recorded, 'first cost record should be recorded');

      // Duplicate - should be rejected
      const result2 = await store.saveCost({
        requestId: 'req-cost-1',
        modelId: 'test-model',
        provider: 'mock-a',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        cost: { inputCost: 0.001, outputCost: 0.002, totalCost: 0.003, currency: 'USD' },
        dateKey: '2026-08-01',
        timestamp: new Date().toISOString(),
      });
      assert.ok(!result2.recorded, 'duplicate cost record should be rejected');

      await store.close();
    }

    // Reopen and verify
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      const cost = await store.getCost('req-cost-1');
      assert.ok(cost, 'cost record should survive restart');
      assert.strictEqual(cost.requestId, 'req-cost-1');
      assert.strictEqual(cost.modelId, 'test-model');

      const hasCost = await store.hasCost('req-cost-1');
      assert.ok(hasCost, 'hasCost should return true after restart');

      await store.close();
    }
  });

  test('finalized idempotency survives restart', async () => {
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      const result1 = await store.saveFinalized({
        requestId: 'req-fin-1',
        outcome: 'completed',
        agentId: 'claude-code',
        protocol: 'anthropic',
        timestamp: new Date().toISOString(),
      });
      assert.ok(result1.finalized, 'first finalize should succeed');

      const result2 = await store.saveFinalized({
        requestId: 'req-fin-1',
        outcome: 'completed',
        timestamp: new Date().toISOString(),
      });
      assert.ok(!result2.finalized, 'duplicate finalize should be rejected');

      await store.close();
    }

    // Reopen and verify
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      const isFin = await store.isFinalized('req-fin-1');
      assert.ok(isFin, 'finalized status should survive restart');

      // Attempting to finalize again should fail
      const result = await store.saveFinalized({
        requestId: 'req-fin-1',
        outcome: 'completed',
        timestamp: new Date().toISOString(),
      });
      assert.ok(!result.finalized, 'should not allow re-finalize after restart');

      await store.close();
    }
  });

  test('key status survives restart (401 permanent failure)', async () => {
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      await store.saveKeyStatus({
        provider: 'mock-a',
        keyId: 'mock-a-0',
        status: 'invalid',
        reason: '401_auth_invalid',
        updatedAt: new Date().toISOString(),
      });

      await store.saveKeyStatus({
        provider: 'mock-a',
        keyId: 'mock-a-1',
        status: 'cooling',
        reason: '429_transient',
        updatedAt: new Date().toISOString(),
      });

      await store.close();
    }

    // Reopen and verify
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      const statuses = await store.getKeyStatuses('mock-a');
      assert.ok(statuses.length >= 2, 'should have at least 2 key statuses after restart');

      const invalid = statuses.find(s => s.keyId === 'mock-a-0');
      assert.ok(invalid, 'should find the invalid key');
      assert.strictEqual(invalid.status, 'invalid');
      assert.strictEqual(invalid.reason, '401_auth_invalid');

      const cooling = statuses.find(s => s.keyId === 'mock-a-1');
      assert.ok(cooling, 'should find the cooling key');
      assert.strictEqual(cooling.status, 'cooling');

      await store.close();
    }
  });

  test('provider health (circuit breaker) survives restart', async () => {
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      await store.saveProviderHealth({
        provider: 'mock-a',
        state: 'open',
        failureCount: 5,
        lastFailureAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await store.saveProviderHealth({
        provider: 'mock-b',
        state: 'closed',
        failureCount: 0,
        updatedAt: new Date().toISOString(),
      });

      await store.close();
    }

    // Reopen and verify
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      const healthA = await store.getProviderHealth('mock-a');
      assert.ok(healthA, 'provider health should survive restart');
      assert.strictEqual(healthA.provider, 'mock-a');
      assert.strictEqual(healthA.state, 'open');
      assert.strictEqual(healthA.failureCount, 5);

      const allHealth = await store.getAllProviderHealth();
      assert.ok(allHealth.length >= 2, 'should have at least 2 provider health records');

      await store.close();
    }
  });

  test('request metadata survives restart', async () => {
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      await store.saveRequest({
        requestId: 'req-meta-1',
        agentId: 'claude-code',
        protocol: 'anthropic',
        model: 'claude-sonnet',
        provider: 'anthropic',
        timestamp: new Date().toISOString(),
      });

      await store.close();
    }

    // Reopen and verify
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      const req = await store.getRequest('req-meta-1');
      assert.ok(req, 'request metadata should survive restart');
      assert.strictEqual(req.requestId, 'req-meta-1');
      assert.strictEqual(req.agentId, 'claude-code');
      assert.strictEqual(req.protocol, 'anthropic');

      await store.close();
    }
  });

  test('attempt records survive restart', async () => {
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      await store.saveAttempt({
        requestId: 'req-attempt-1',
        attemptNumber: 1,
        model: 'test-model-a',
        provider: 'mock-a',
        keyId: 'mock-a-0',
        transportOutcome: 'success',
        validatedOutcome: 'completed',
        httpStatus: 200,
        latencyMs: 350,
        timestamp: new Date().toISOString(),
      });

      await store.saveAttempt({
        requestId: 'req-attempt-1',
        attemptNumber: 2,
        model: 'test-model-b',
        provider: 'mock-b',
        keyId: 'mock-b-0',
        transportOutcome: 'error',
        validatedOutcome: null,
        httpStatus: 500,
        latencyMs: 100,
        timestamp: new Date().toISOString(),
      });

      await store.close();
    }

    // Reopen and verify
    {
      const store = new SQLiteStore(dbPath);
      await store.init();

      const attempts = await store.getAttempts('req-attempt-1');
      assert.ok(attempts.length >= 2, 'should have at least 2 attempts after restart');

      const attempt1 = attempts.find(a => a.attemptNumber === 1);
      assert.ok(attempt1, 'should find attempt 1');
      assert.strictEqual(attempt1.model, 'test-model-a');
      assert.strictEqual(attempt1.transportOutcome, 'success');

      const attempt2 = attempts.find(a => a.attemptNumber === 2);
      assert.ok(attempt2, 'should find attempt 2');
      assert.strictEqual(attempt2.transportOutcome, 'error');
      assert.strictEqual(attempt2.httpStatus, 500);

      await store.close();
    }
  });

  test('MemoryStore provides same interface as SQLiteStore', async () => {
    const memStore = new MemoryStore();
    await memStore.init();

    // Test basic operations
    await memStore.saveRequest({
      requestId: 'mem-req-1',
      protocol: 'chat',
      timestamp: new Date().toISOString(),
    });

    const req = await memStore.getRequest('mem-req-1');
    assert.ok(req, 'MemoryStore should return saved request');

    const finResult = await memStore.saveFinalized({
      requestId: 'mem-req-1',
      outcome: 'completed',
      timestamp: new Date().toISOString(),
    });
    assert.ok(finResult.finalized, 'first finalize should succeed');

    const finResult2 = await memStore.saveFinalized({
      requestId: 'mem-req-1',
      outcome: 'completed',
      timestamp: new Date().toISOString(),
    });
    assert.ok(!finResult2.finalized, 'duplicate finalize should be rejected');

    const costResult = await memStore.saveCost({
      requestId: 'mem-req-1',
      modelId: 'test-model',
      provider: 'mock-a',
      cost: { totalCost: 0.001, currency: 'USD' },
      dateKey: '2026-08-01',
      timestamp: new Date().toISOString(),
    });
    assert.ok(costResult.recorded, 'cost should be recorded');

    await memStore.saveKeyStatus({
      provider: 'mock-a',
      keyId: 'mock-a-0',
      status: 'invalid',
      reason: '401',
      updatedAt: new Date().toISOString(),
    });

    const keyStatuses = await memStore.getKeyStatuses('mock-a');
    assert.ok(keyStatuses.length > 0, 'should have key statuses');

    await memStore.saveProviderHealth({
      provider: 'mock-a',
      state: 'open',
      failureCount: 3,
      updatedAt: new Date().toISOString(),
    });

    const health = await memStore.getProviderHealth('mock-a');
    assert.ok(health, 'should have provider health');
    assert.strictEqual(health.state, 'open');

    await memStore.saveAuditRecord({
      requestId: 'mem-req-1',
      outcome: 'completed',
      timestamp: new Date().toISOString(),
    });

    const audit = await memStore.getAuditRecord('mem-req-1');
    assert.ok(audit, 'should have audit record');

    await memStore.close();
  });
});
