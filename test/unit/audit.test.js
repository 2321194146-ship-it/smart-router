// test/unit/audit.test.js
// Smart Router Mainline - Phase 1
// 审计和运行时收尾测试
//
// 使用 Node.js 内置 node:test 和 node:assert，无第三方依赖。

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { AttemptLog, AttemptRecord } from '../../src/runtime/attempts.js';
import { Finalizer } from '../../src/runtime/finalization.js';
import {
  Outcome,
  shouldRecordQualityFeedback,
  deriveValidatedOutcome,
  deriveTransportOutcome,
} from '../../src/runtime/outcomes.js';
import { CostTracker } from '../../src/cost/tracker.js';
import { ErrorType } from '../../src/provider/errors.js';

// ----------------------------------------------------------------------------
// 最小化测试配置
// ----------------------------------------------------------------------------

function makeCostConfig() {
  return {
    models: [
      {
        id: 'gpt-4',
        paid: false,
        price: {
          input_cost_per_1k: 0.03,
          output_cost_per_1k: 0.06,
          currency: 'USD',
        },
      },
    ],
    budget: { allowPaid: true },
  };
}

// ----------------------------------------------------------------------------
// AttemptLog 测试
// ----------------------------------------------------------------------------

describe('AttemptLog', () => {
  test('records each attempt independently', () => {
    const log = new AttemptLog('req-1');
    log.addAttempt('gpt-4', 'openai', 'openai-0');
    log.addAttempt('claude-3', 'anthropic', 'anthropic-0');
    log.addAttempt('gemini', 'google', 'google-0');

    assert.equal(log.getCount(), 3);
    const all = log.getAll();
    assert.equal(all[0].attemptNumber, 1);
    assert.equal(all[0].model, 'gpt-4');
    assert.equal(all[1].attemptNumber, 2);
    assert.equal(all[1].model, 'claude-3');
    assert.equal(all[2].attemptNumber, 3);
    assert.equal(all[2].model, 'gemini');
  });

  test('getLast returns the most recent attempt', () => {
    const log = new AttemptLog('req-1');
    log.addAttempt('gpt-4', 'openai', 'openai-0');
    log.addAttempt('claude-3', 'anthropic', 'anthropic-0');

    const last = log.getLast();
    assert.equal(last.attemptNumber, 2);
    assert.equal(last.model, 'claude-3');
  });

  test('getLast returns null for empty log', () => {
    const log = new AttemptLog('req-1');
    assert.equal(log.getLast(), null);
  });

  test('getSuccessful returns the actual successful attempt', () => {
    const log = new AttemptLog('req-1');
    const a1 = log.addAttempt('gpt-4', 'openai', 'openai-0');
    a1.setTransportResult('error', 500, 200, null);

    const a2 = log.addAttempt('claude-3', 'anthropic', 'anthropic-0');
    a2.setTransportResult('success', 200, 350, 120);
    a2.setValidatedResult('completed');

    const successful = log.getSuccessful();
    assert.ok(successful);
    assert.equal(successful.attemptNumber, 2);
    assert.equal(successful.model, 'claude-3');
    assert.equal(successful.provider, 'anthropic');
  });

  test('getSuccessful returns null when no success', () => {
    const log = new AttemptLog('req-1');
    const a1 = log.addAttempt('gpt-4', 'openai', 'openai-0');
    a1.setTransportResult('error', 500, 200, null);

    assert.equal(log.getSuccessful(), null);
  });

  test('hasSuccess returns correct boolean', () => {
    const log = new AttemptLog('req-1');
    assert.equal(log.hasSuccess(), false);

    const a1 = log.addAttempt('gpt-4', 'openai', 'openai-0');
    a1.setTransportResult('error', 500, 200, null);
    assert.equal(log.hasSuccess(), false);

    const a2 = log.addAttempt('gpt-4', 'openai', 'openai-1');
    a2.setTransportResult('success', 200, 350, 120);
    assert.equal(log.hasSuccess(), true);
  });

  test('hasAborted detects aborted attempts', () => {
    const log = new AttemptLog('req-1');
    const a1 = log.addAttempt('gpt-4', 'openai', 'openai-0');
    a1.setTransportResult('aborted', null, 100, null);
    assert.equal(log.hasAborted(), true);
  });

  test('toJSON serializes all attempts', () => {
    const log = new AttemptLog('req-1');
    const a1 = log.addAttempt('gpt-4', 'openai', 'openai-0');
    a1.setTransportResult('success', 200, 350, 120);
    a1.setValidatedResult('completed');
    a1.setUsage(
      { prompt_tokens: 100, completion_tokens: 50 },
      { inputCost: 0.003, outputCost: 0.003, totalCost: 0.006, currency: 'USD' }
    );

    const json = log.toJSON();
    assert.equal(json.length, 1);
    assert.equal(json[0].transportOutcome, 'success');
    assert.equal(json[0].validatedOutcome, 'completed');
    assert.equal(json[0].model, 'gpt-4');
    assert.ok(json[0].usage);
    assert.ok(json[0].cost);
  });
});

// ----------------------------------------------------------------------------
// AttemptRecord: transport 与 validated outcome 分离
// ----------------------------------------------------------------------------

describe('AttemptRecord outcome separation', () => {
  test('transport_outcome and validated_outcome are separate fields', () => {
    const record = new AttemptRecord(1, 'gpt-4', 'openai', 'openai-0');
    record.setTransportResult('success', 200, 350, 120);
    record.setValidatedResult('incomplete');

    assert.equal(record.transportOutcome, 'success');
    assert.equal(record.validatedOutcome, 'incomplete');
    assert.notEqual(record.transportOutcome, record.validatedOutcome);
  });

  test('transport success + validated null for error responses', () => {
    const record = new AttemptRecord(1, 'gpt-4', 'openai', 'openai-0');
    record.setTransportResult('error', 500, 200, null);

    assert.equal(record.transportOutcome, 'error');
    assert.equal(record.validatedOutcome, null);
  });

  test('aborted transport sets no validated outcome', () => {
    const record = new AttemptRecord(1, 'gpt-4', 'openai', 'openai-0');
    record.setTransportResult('aborted', null, 100, null);

    assert.equal(record.transportOutcome, 'aborted');
    assert.equal(record.validatedOutcome, null);
    assert.equal(record.isAborted(), true);
  });

  test('isCompleted requires both transport success and validated completed', () => {
    const record = new AttemptRecord(1, 'gpt-4', 'openai', 'openai-0');

    record.setTransportResult('success', 200, 350, 120);
    record.setValidatedResult('incomplete');
    assert.equal(record.isCompleted(), false);

    record.setValidatedResult('completed');
    assert.equal(record.isCompleted(), true);
  });

  test('budgetBlocked attempts have null outcomes', () => {
    const record = new AttemptRecord(1, 'gpt-4', 'openai', 'openai-0');
    record.markBudgetBlocked();

    assert.equal(record.budgetBlocked, true);
    assert.equal(record.transportOutcome, null);
    assert.equal(record.validatedOutcome, null);
  });

  test('toJSON includes both outcome fields', () => {
    const record = new AttemptRecord(1, 'gpt-4', 'openai', 'openai-0');
    record.setTransportResult('success', 200, 350, 120);
    record.setValidatedResult('completed');

    const json = record.toJSON();
    assert.equal('transportOutcome' in json, true);
    assert.equal('validatedOutcome' in json, true);
    assert.equal(json.transportOutcome, 'success');
    assert.equal(json.validatedOutcome, 'completed');
  });
});

// ----------------------------------------------------------------------------
// shouldRecordQualityFeedback
// ----------------------------------------------------------------------------

describe('shouldRecordQualityFeedback', () => {
  test('only completed/incomplete record quality feedback', () => {
    assert.equal(shouldRecordQualityFeedback(Outcome.COMPLETED), true);
    assert.equal(shouldRecordQualityFeedback(Outcome.INCOMPLETE), true);
  });

  test('non-quality outcomes do not record feedback', () => {
    assert.equal(shouldRecordQualityFeedback(Outcome.NO_CANDIDATE), false);
    assert.equal(shouldRecordQualityFeedback(Outcome.CLIENT_ABORTED), false);
    assert.equal(shouldRecordQualityFeedback(Outcome.BUDGET_EXCEEDED), false);
    assert.equal(shouldRecordQualityFeedback(Outcome.PROVIDER_ERROR), false);
    assert.equal(shouldRecordQualityFeedback(Outcome.CLIENT_ERROR), false);
    assert.equal(shouldRecordQualityFeedback(Outcome.VALIDATION_FAILED), false);
  });
});

// ----------------------------------------------------------------------------
// deriveValidatedOutcome
// ----------------------------------------------------------------------------

describe('deriveValidatedOutcome', () => {
  test('returns incomplete for finish_reason=length', () => {
    const execResult = { success: true, transportOutcome: 'success' };
    const body = {
      choices: [
        { finish_reason: 'length', message: { content: 'truncated...' } },
      ],
    };
    assert.equal(deriveValidatedOutcome(execResult, body), 'incomplete');
  });

  test('returns incomplete for finish_reason=content_filter', () => {
    const execResult = { success: true };
    const body = {
      choices: [
        { finish_reason: 'content_filter', message: { content: '' } },
      ],
    };
    assert.equal(deriveValidatedOutcome(execResult, body), 'incomplete');
  });

  test('returns completed for finish_reason=stop', () => {
    const execResult = { success: true };
    const body = {
      choices: [
        { finish_reason: 'stop', message: { content: 'Hello!' } },
      ],
    };
    assert.equal(deriveValidatedOutcome(execResult, body), 'completed');
  });

  test('returns incomplete for empty choices array', () => {
    const execResult = { success: true };
    const body = { choices: [] };
    assert.equal(deriveValidatedOutcome(execResult, body), 'incomplete');
  });

  test('returns incomplete for non-array choices shape', () => {
    const execResult = { success: true };
    const body = { choices: { message: { content: 'not an array' } } };
    assert.equal(deriveValidatedOutcome(execResult, body), 'incomplete');
  });

  test('returns incomplete for body with error field', () => {
    const execResult = { success: true };
    const body = { error: { message: 'something went wrong' } };
    assert.equal(deriveValidatedOutcome(execResult, body), 'incomplete');
  });

  test('returns null for transport failure', () => {
    const execResult = { success: false, transportOutcome: 'error' };
    assert.equal(deriveValidatedOutcome(execResult, {}), null);
  });

  test('returns incomplete for empty response body string', () => {
    const execResult = { success: true };
    assert.equal(deriveValidatedOutcome(execResult, ''), 'incomplete');
  });

  test('returns incomplete for Anthropic max_tokens stop_reason', () => {
    const execResult = { success: true };
    const body = {
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
    };
    assert.equal(deriveValidatedOutcome(execResult, body), 'incomplete');
  });

  test('returns completed for Anthropic normal response', () => {
    const execResult = { success: true };
    const body = {
      content: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
    };
    assert.equal(deriveValidatedOutcome(execResult, body), 'completed');
  });

  test('returns incomplete for null executionResult', () => {
    assert.equal(deriveValidatedOutcome(null, {}), null);
  });
});

// ----------------------------------------------------------------------------
// deriveTransportOutcome
// ----------------------------------------------------------------------------

describe('deriveTransportOutcome', () => {
  test('returns success for 200', () => {
    assert.equal(deriveTransportOutcome(200, null), 'success');
  });

  test('returns success for 201', () => {
    assert.equal(deriveTransportOutcome(201, null), 'success');
  });

  test('returns error for 4xx', () => {
    assert.equal(deriveTransportOutcome(400, null), 'error');
    assert.equal(deriveTransportOutcome(404, null), 'error');
    assert.equal(deriveTransportOutcome(429, null), 'error');
  });

  test('returns error for 5xx', () => {
    assert.equal(deriveTransportOutcome(500, null), 'error');
    assert.equal(deriveTransportOutcome(503, null), 'error');
  });

  test('returns aborted for AbortError', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    assert.equal(deriveTransportOutcome(null, err), 'aborted');
  });

  test('returns aborted for ABORT_ERR code', () => {
    const err = new Error('aborted');
    err.code = 'ABORT_ERR';
    assert.equal(deriveTransportOutcome(null, err), 'aborted');
  });

  test('returns timeout for TimeoutError', () => {
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    assert.equal(deriveTransportOutcome(null, err), 'timeout');
  });

  test('returns error for network failure without httpStatus', () => {
    const err = new Error('ECONNREFUSED');
    assert.equal(deriveTransportOutcome(null, err), 'error');
  });

  test('returns error for null inputs (unknown failure)', () => {
    assert.equal(deriveTransportOutcome(null, null), 'error');
  });
});

// ----------------------------------------------------------------------------
// Finalizer: 审计和收尾
// ----------------------------------------------------------------------------

describe('Finalizer', () => {
  let costTracker;
  let finalizer;

  beforeEach(() => {
    costTracker = new CostTracker(makeCostConfig());
    finalizer = new Finalizer(costTracker);
  });

  // --------------------------------------------------------------------------
  // finalizeNoCandidate
  // --------------------------------------------------------------------------

  test('finalizeNoCandidate writes audit record', async () => {
    const result = await finalizer.finalizeNoCandidate('req-nc', 'gpt-4', {
      agentId: 'test-agent',
      protocol: 'chat',
    });

    assert.equal(result.finalized, true);
    assert.ok(result.auditRecord);
    assert.equal(result.auditRecord.outcome, Outcome.NO_CANDIDATE);
    assert.equal(result.auditRecord.requestId, 'req-nc');
    assert.equal(result.auditRecord.requestedModel, 'gpt-4');
    assert.equal(result.auditRecord.finalModel, null);
    assert.equal(result.auditRecord.attemptCount, 0);
    assert.equal(result.auditRecord.agentId, 'test-agent');

    // Audit record is stored
    const stored = finalizer.getAuditRecord('req-nc');
    assert.ok(stored);
    assert.equal(stored.outcome, Outcome.NO_CANDIDATE);
  });

  test('finalizeNoCandidate does not record cost', async () => {
    await finalizer.finalizeNoCandidate('req-nc', 'gpt-4', {});
    assert.equal(costTracker.hasRecord('req-nc'), false);
  });

  test('finalizeNoCandidate does not record quality feedback', async () => {
    await finalizer.finalizeNoCandidate('req-nc', 'gpt-4', {});
    const feedback = finalizer.getQualityFeedbackSummary();
    assert.equal(Object.keys(feedback).length, 0);
  });

  // --------------------------------------------------------------------------
  // finalize 幂等
  // --------------------------------------------------------------------------

  test('finalize is idempotent - second call returns already_finalized', async () => {
    const log = new AttemptLog('req-1');
    const attempt = log.addAttempt('gpt-4', 'openai', 'openai-0');
    attempt.setTransportResult('success', 200, 350, 120);
    attempt.setValidatedResult('completed');
    attempt.setUsage(
      { prompt_tokens: 100, completion_tokens: 50 },
      { inputCost: 0.003, outputCost: 0.003, totalCost: 0.006, currency: 'USD' }
    );

    const result1 = await finalizer.finalize('req-1', log, Outcome.COMPLETED, {
      agentId: 'test',
      protocol: 'chat',
    });
    assert.equal(result1.finalized, true);

    const result2 = await finalizer.finalize('req-1', log, Outcome.COMPLETED, {
      agentId: 'test',
      protocol: 'chat',
    });
    assert.equal(result2.finalized, false);
    assert.equal(result2.reason, 'already_finalized');
  });

  test('isFinalized tracks finalized requestIds', async () => {
    assert.equal(finalizer.isFinalized('req-1'), false);
    await finalizer.finalizeNoCandidate('req-1', 'gpt-4', {});
    assert.equal(finalizer.isFinalized('req-1'), true);
  });

  // --------------------------------------------------------------------------
  // 成本仅扣一次
  // --------------------------------------------------------------------------

  test('cost is recorded only once per requestId', async () => {
    const log = new AttemptLog('req-cost');
    const attempt = log.addAttempt('gpt-4', 'openai', 'openai-0');
    attempt.setTransportResult('success', 200, 350, 120);
    attempt.setValidatedResult('completed');
    attempt.setUsage(
      { prompt_tokens: 100, completion_tokens: 50 },
      { inputCost: 0.003, outputCost: 0.003, totalCost: 0.006, currency: 'USD' }
    );

    await finalizer.finalize('req-cost', log, Outcome.COMPLETED, {});
    assert.equal(costTracker.hasRecord('req-cost'), true);

    // Second finalize is skipped (idempotent), cost not recorded again
    await finalizer.finalize('req-cost', log, Outcome.COMPLETED, {});

    // Direct recordCost also deduplicates
    const result = costTracker.recordCost(
      'req-cost',
      'gpt-4',
      'openai',
      { prompt_tokens: 100, completion_tokens: 50 },
      null
    );
    assert.equal(result.recorded, false);
  });

  test('CostTracker recordCost deduplicates by requestId', () => {
    const result1 = costTracker.recordCost(
      'req-dedup',
      'gpt-4',
      'openai',
      { prompt_tokens: 100, completion_tokens: 50 },
      null
    );
    assert.equal(result1.recorded, true);

    const result2 = costTracker.recordCost(
      'req-dedup',
      'gpt-4',
      'openai',
      { prompt_tokens: 200, completion_tokens: 100 },
      null
    );
    assert.equal(result2.recorded, false);
  });

  // --------------------------------------------------------------------------
  // client_aborted 不记模型质量失败
  // --------------------------------------------------------------------------

  test('client_aborted does not record quality feedback', async () => {
    assert.equal(shouldRecordQualityFeedback(Outcome.CLIENT_ABORTED), false);

    const log = new AttemptLog('req-aborted');
    const attempt = log.addAttempt('gpt-4', 'openai', 'openai-0');
    attempt.setTransportResult('aborted', null, 100, null);
    attempt.setError(ErrorType.CLIENT_ABORTED, 'client disconnected');

    await finalizer.finalize('req-aborted', log, Outcome.CLIENT_ABORTED, {
      agentId: 'test',
      protocol: 'chat',
    });

    const feedback = finalizer.getQualityFeedbackSummary();
    assert.equal(Object.keys(feedback).length, 0);
  });

  // --------------------------------------------------------------------------
  // provider_error 不回写质量反馈
  // --------------------------------------------------------------------------

  test('provider_error does not record quality feedback', async () => {
    assert.equal(shouldRecordQualityFeedback(Outcome.PROVIDER_ERROR), false);

    const log = new AttemptLog('req-err');
    const attempt = log.addAttempt('gpt-4', 'openai', 'openai-0');
    attempt.setTransportResult('error', 500, 200, null);
    attempt.setError(ErrorType.SERVER_ERROR, 'internal server error');

    await finalizer.finalize('req-err', log, Outcome.PROVIDER_ERROR, {});

    const feedback = finalizer.getQualityFeedbackSummary();
    assert.equal(Object.keys(feedback).length, 0);
  });

  // --------------------------------------------------------------------------
  // completed 才回写质量反馈
  // --------------------------------------------------------------------------

  test('completed outcome records quality feedback as success', async () => {
    const log = new AttemptLog('req-ok');
    const attempt = log.addAttempt('gpt-4', 'openai', 'openai-0');
    attempt.setTransportResult('success', 200, 350, 120);
    attempt.setValidatedResult('completed');
    attempt.setUsage(
      { prompt_tokens: 100, completion_tokens: 50 },
      { inputCost: 0.003, outputCost: 0.003, totalCost: 0.006, currency: 'USD' }
    );

    await finalizer.finalize('req-ok', log, Outcome.COMPLETED, {});

    const feedback = finalizer.getQualityFeedback('openai', 'gpt-4');
    assert.ok(feedback);
    assert.equal(feedback.success, 1);
    assert.equal(feedback.failure, 0);
    assert.equal(feedback.total, 1);
  });

  test('incomplete outcome records quality feedback as failure', async () => {
    const log = new AttemptLog('req-inc');
    const attempt = log.addAttempt('gpt-4', 'openai', 'openai-0');
    attempt.setTransportResult('success', 200, 350, 120);
    attempt.setValidatedResult('incomplete');
    attempt.setUsage(
      { prompt_tokens: 100, completion_tokens: 50 },
      { inputCost: 0.003, outputCost: 0.003, totalCost: 0.006, currency: 'USD' }
    );

    await finalizer.finalize('req-inc', log, Outcome.INCOMPLETE, {});

    const feedback = finalizer.getQualityFeedback('openai', 'gpt-4');
    assert.ok(feedback);
    assert.equal(feedback.success, 0);
    assert.equal(feedback.failure, 1);
  });

  // --------------------------------------------------------------------------
  // 审计记录完整性
  // --------------------------------------------------------------------------

  test('finalize writes complete audit record with attempts', async () => {
    const log = new AttemptLog('req-audit');
    const a1 = log.addAttempt('gpt-4', 'openai', 'openai-0');
    a1.setTransportResult('error', 429, 100, null);
    a1.setError(ErrorType.RATE_LIMIT_TRANSIENT, 'rate limited');

    const a2 = log.addAttempt('claude-3', 'anthropic', 'anthropic-0');
    a2.setTransportResult('success', 200, 350, 120);
    a2.setValidatedResult('completed');
    a2.setUsage(
      { prompt_tokens: 100, completion_tokens: 50 },
      { inputCost: 0.003, outputCost: 0.003, totalCost: 0.006, currency: 'USD' }
    );

    const result = await finalizer.finalize('req-audit', log, Outcome.COMPLETED, {
      agentId: 'test-agent',
      protocol: 'chat',
      responseSize: 1024,
    });

    assert.equal(result.finalized, true);
    const audit = result.auditRecord;
    assert.equal(audit.requestId, 'req-audit');
    assert.equal(audit.outcome, Outcome.COMPLETED);
    assert.equal(audit.finalModel, 'claude-3');
    assert.equal(audit.finalProvider, 'anthropic');
    assert.equal(audit.attemptCount, 2);
    assert.equal(audit.attempts.length, 2);
    assert.equal(audit.agentId, 'test-agent');
    assert.equal(audit.protocol, 'chat');
    assert.equal(audit.responseSize, 1024);

    // Each attempt in audit has separate transport/validated outcomes
    assert.equal(audit.attempts[0].transportOutcome, 'error');
    assert.equal(audit.attempts[0].validatedOutcome, null);
    assert.equal(audit.attempts[1].transportOutcome, 'success');
    assert.equal(audit.attempts[1].validatedOutcome, 'completed');
  });

  test('getAuditRecords returns all records', async () => {
    await finalizer.finalizeNoCandidate('req-1', 'gpt-4', {});
    await finalizer.finalizeNoCandidate('req-2', 'claude-3', {});

    const records = finalizer.getAuditRecords();
    assert.equal(records.length, 2);
  });

  test('finalize without successful attempt uses options model/provider', async () => {
    const log = new AttemptLog('req-no-success');
    const a1 = log.addAttempt('gpt-4', 'openai', 'openai-0');
    a1.setTransportResult('error', 500, 200, null);

    const result = await finalizer.finalize(
      'req-no-success',
      log,
      Outcome.PROVIDER_ERROR,
      { model: 'gpt-4', provider: 'openai' }
    );

    assert.equal(result.auditRecord.finalModel, 'gpt-4');
    assert.equal(result.auditRecord.finalProvider, 'openai');
  });

  test('finalize without costTracker does not throw', async () => {
    const f = new Finalizer(null);
    const log = new AttemptLog('req-no-ct');
    const attempt = log.addAttempt('gpt-4', 'openai', 'openai-0');
    attempt.setTransportResult('success', 200, 350, 120);
    attempt.setValidatedResult('completed');
    attempt.setUsage(
      { prompt_tokens: 100, completion_tokens: 50 },
      { inputCost: 0.003, outputCost: 0.003, totalCost: 0.006, currency: 'USD' }
    );

    const result = await f.finalize('req-no-ct', log, Outcome.COMPLETED, {});
    assert.equal(result.finalized, true);
  });
});
