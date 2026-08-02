// src/runtime/finalization.js
// Smart Router Mainline - Phase 1
// 运行时收尾：幂等 finalize、成本记录、审计记录、模型质量反馈。
//
// 设计要点（参考 6.5.0 的 finalize）：
//   - finalize 幂等：同 requestId 只收尾一次（_finalizedIds 去重）
//   - 成本仅扣一次：通过 requestId 去重（CostTracker.recordCost 自身也有去重）
//   - client_aborted 单独归因：不记为模型质量失败
//   - provider 故障与模型质量分开：只有 completed/incomplete 才回写质量反馈
//   - no_candidate 也写审计记录（finalizeNoCandidate）
//   - transport_outcome 与 validated_outcome 分离（体现在审计记录的 attempts 中）
//   - off 模式保持传统执行行为（Finalizer 仍正常工作，但无智能决策）
//   - 审计记录内存存储，接口预留未来 DB 迁移
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { log } from '../config/loader.js';
import { ErrorType } from '../provider/errors.js';
import {
  Outcome,
  QUALITY_OUTCOMES,
  shouldRecordQualityFeedback,
} from './outcomes.js';
import { AttemptLog } from './attempts.js';

// ----------------------------------------------------------------------------
// Finalizer：运行时收尾
// ----------------------------------------------------------------------------

/**
 * 运行时收尾器。
 *
 * 职责：
 *   - 幂等 finalize：同 requestId 只收尾一次
 *   - 成本记录：仅扣一次（通过 requestId 去重）
 *   - 审计记录：生成完整审计链，包含所有 attempts
 *   - 模型质量反馈：仅 QUALITY_OUTCOMES（completed/incomplete）才回写
 *   - no_candidate 场景：也写审计记录
 *
 * @example
 * const finalizer = new Finalizer(costTracker);
 *
 * // 正常收尾
 * const result = await finalizer.finalize(requestId, attemptLog, Outcome.COMPLETED, {
 *   agentId: 'claude-code',
 *   protocol: 'anthropic',
 *   responseSize: 1024,
 * });
 *
 * // 无候选收尾
 * const result = await finalizer.finalizeNoCandidate(requestId, 'gpt-4', {
 *   agentId: 'claude-code',
 *   protocol: 'chat',
 * });
 */
export class Finalizer {
  /**
   * @param {object} costTracker CostTracker 实例（用于成本记录）
   */
  constructor(costTracker, store = null) {
    this.costTracker = costTracker || null;
    this.store = store || null;

    // 幂等保护：已收尾的 requestId 集合（内存缓存，store 存在时由 DB 唯一约束保证）
    this._finalizedIds = new Set();

    // 审计记录存储（内存版，未来迁移到 DB）
    this._auditRecords = [];

    // 模型质量反馈存储（内存版，未来迁移到 DB）
    // key = "provider:model", value = { success, failure, lastUpdated }
    this._qualityFeedback = new Map();
  }

  // --------------------------------------------------------------------------
  // 核心收尾：finalize
  // --------------------------------------------------------------------------

  /**
   * 收尾单次请求。
   *
   * 步骤：
   *   1. 幂等检查：如果 requestId 已收尾，直接返回
   *   2. 标记为已收尾
   *   3. 从 attemptLog 中提取最终成功的尝试
   *   4. 记录成本（仅扣一次，通过 requestId 去重）
   *   5. 生成审计记录
   *   6. 回写模型质量反馈（仅 QUALITY_OUTCOMES）
   *
   * @param {string} requestId 请求唯一标识
   * @param {object} attemptLog AttemptLog 实例
   * @param {string} finalOutcome 最终 Outcome（validated_outcome）
   * @param {object} [options] 附加选项
   *   - model {string} 最终成功模型
   *   - provider {string} 最终成功 provider
   *   - agentId {string} Agent 标识
   *   - protocol {string} 协议类型 'chat' | 'responses' | 'anthropic'
   *   - responseSize {number} 响应大小（字节）
   * @returns {Promise<{finalized: boolean, reason?: string, auditRecord?: object}>}
   */
  async finalize(requestId, attemptLog, finalOutcome, options = {}) {
    // 1. 幂等检查：优先使用 store 的唯一约束，回退到内存 Set
    if (this.store) {
      try {
        const result = await this.store.saveFinalized({
          requestId,
          outcome: finalOutcome,
          agentId: options.agentId || null,
          protocol: options.protocol || null,
          timestamp: new Date().toISOString(),
        });
        if (!result.finalized) {
          log(`[finalizer] finalize already executed (store), skipping: ${requestId}`);
          return { finalized: false, reason: 'already_finalized' };
        }
      } catch (err) {
        log(`[finalizer] store saveFinalized error, falling back to memory: ${err.message}`);
        if (this._finalizedIds.has(requestId)) {
          return { finalized: false, reason: 'already_finalized' };
        }
      }
    } else {
      if (this._finalizedIds.has(requestId)) {
        log(`[finalizer] finalize already executed, skipping: ${requestId}`);
        return { finalized: false, reason: 'already_finalized' };
      }
    }
    this._finalizedIds.add(requestId);

    // 2. 提取最终成功的尝试
    const successfulAttempt = attemptLog ? attemptLog.getSuccessful() : null;

    // 3. 记录成本（仅扣一次）
    if (successfulAttempt && successfulAttempt.usage && this.costTracker) {
      try {
        const costResult = this.costTracker.recordCost(
          requestId,
          successfulAttempt.model,
          successfulAttempt.provider,
          successfulAttempt.usage,
          successfulAttempt.cost
        );
        if (costResult.recorded) {
          log(
            `[finalizer] cost recorded: ${successfulAttempt.provider}/${successfulAttempt.model} ` +
            `${costResult.record.cost.totalCost} ${costResult.record.cost.currency}`
          );
        }
      } catch (err) {
        log(`[finalizer] cost recording failed: ${err.message}`);
      }
    }

    // 4. 生成审计记录
    const auditRecord = this._buildAuditRecord(
      requestId, attemptLog, finalOutcome, options
    );
    this._auditRecords.push(auditRecord);

    // 持久化审计记录到 store（如果可用）
    if (this.store) {
      try {
        await this.store.saveAuditRecord(auditRecord);
      } catch (err) {
        log(`[finalizer] store saveAuditRecord error: ${err.message}`);
      }
    }

    // 5. 回写模型质量反馈（仅 QUALITY_OUTCOMES）
    if (shouldRecordQualityFeedback(finalOutcome) && successfulAttempt) {
      this._recordQualityFeedback(successfulAttempt, finalOutcome, options);
    }

    log(
      `[finalizer] finalize completed: ${requestId} outcome=${finalOutcome} ` +
      `attempts=${attemptLog ? attemptLog.getCount() : 0}`
    );

    return { finalized: true, auditRecord };
  }

  // --------------------------------------------------------------------------
  // 事务收尾：finalizeRequestTransaction
  // --------------------------------------------------------------------------

  /**
   * 使用单一数据库事务收尾请求。
   *
   * 在同一事务中原子完成：
   *   1. finalized_requests 幂等占位
   *   2. requests 最终状态更新
   *   3. attempts 全部写入
   *   4. cost_records 成本记录
   *   5. audit_records 审计记录
   *
   * 任何一步失败 → 整个事务回滚，不留下半状态。
   * 允许安全重试（幂等）。
   *
   * @param {string} requestId 请求唯一标识
   * @param {object} attemptLog AttemptLog 实例
   * @param {string} finalOutcome 最终 Outcome
   * @param {object} [options] 附加选项
   * @returns {Promise<{finalized: boolean, reason?: string, auditRecord?: object}>}
   */
  async finalizeRequestTransaction(requestId, attemptLog, finalOutcome, options = {}) {
    if (!this.store) {
      return this.finalize(requestId, attemptLog, finalOutcome, options);
    }

    // 幂等检查（事务外）
    try {
      const alreadyFinalized = await this.store.isFinalized(requestId);
      if (alreadyFinalized) {
        log(`[finalizer] transaction: already finalized, skipping: ${requestId}`);
        return { finalized: false, reason: 'already_finalized' };
      }
    } catch (err) {
      log(`[finalizer] isFinalized check error: ${err.message}`);
    }

    const successfulAttempt = attemptLog ? attemptLog.getSuccessful() : null;
    const allAttempts = attemptLog ? attemptLog.toJSON() : [];

    // 预构建审计记录（不写任何状态）
    const auditRecord = this._buildAuditRecord(requestId, attemptLog, finalOutcome, options);

    // 纯计算 costRecord（不写内存、不写数据库）
    let costRecord = null;
    if (successfulAttempt && successfulAttempt.usage && this.costTracker) {
      try {
        costRecord = this.costTracker.calculateCostRecord(
          requestId,
          successfulAttempt.model,
          successfulAttempt.provider,
          successfulAttempt.usage,
          successfulAttempt.cost
        );
      } catch (err) {
        log(`[finalizer] transaction: cost calculation failed: ${err.message}`);
      }
    }

    // 方案A：Store 内部单次同步原子事务（BEGIN IMMEDIATE + 连续同步写入）
    if (typeof this.store.finalizeRequestAtomic === 'function') {
      const payload = {
        requestId,
        outcome: finalOutcome,
        attempts: allAttempts,
        costRecord,
        auditRecord,
        agentId: options.agentId || null,
        protocol: options.protocol || null,
        externalRequestId: options.externalRequestId || null,
        timestamp: new Date().toISOString(),
      };
      let result;
      try {
        result = this.store.finalizeRequestAtomic(payload);
      } catch (err) {
        // 事务失败：内存 Cost、日度统计和质量反馈均不改变
        log(`[finalizer] transaction: failed for ${requestId}: ${err.message}`);
        throw err;
      }
      if (!result.finalized) {
        log(`[finalizer] transaction: already finalized (atomic), skipping: ${requestId}`);
        return { finalized: false, reason: result.reason || 'already_finalized' };
      }
      // 事务成功后：更新内存状态
      this._finalizedIds.add(requestId);
      this._auditRecords.push(auditRecord);
      // 事务成功后：更新 CostTracker 内存聚合
      if (costRecord && this.costTracker) {
        this.costTracker.updateMemoryAggregation(costRecord);
      }
      // 事务成功后：回写模型质量反馈
      if (shouldRecordQualityFeedback(finalOutcome) && successfulAttempt) {
        this._recordQualityFeedback(successfulAttempt, finalOutcome, options);
      }
      log(
        `[finalizer] transaction: finalized ${requestId} outcome=${finalOutcome} ` +
        `attempts=${allAttempts.length} (atomic)`
      );
      return { finalized: true, auditRecord };
    }

    // 回退：store 不支持 finalizeRequestAtomic 时，使用旧的多步事务逻辑
    let transaction = null;
    try {
      transaction = await this.store.beginTransaction();

      // 1. finalized_requests 幂等占位
      const finResult = await this.store.saveFinalized({
        requestId,
        outcome: finalOutcome,
        agentId: options.agentId || null,
        protocol: options.protocol || null,
        timestamp: new Date().toISOString(),
      }, transaction);

      if (!finResult.finalized) {
        await this.store.rollbackTransaction(transaction);
        transaction = null;
        log(`[finalizer] transaction: already finalized (in txn), skipping: ${requestId}`);
        return { finalized: false, reason: 'already_finalized' };
      }

      // 2. 更新 requests 最终状态
      if (typeof this.store.updateRequestStatus === 'function') {
        await this.store.updateRequestStatus(requestId, finalOutcome, transaction);
      }

      // 3. 保存所有 attempts
      for (const attempt of allAttempts) {
        await this.store.saveAttempt({
          requestId,
          attemptNumber: attempt.attemptNumber,
          model: attempt.model,
          provider: attempt.provider,
          keyId: attempt.keyId,
          transportOutcome: attempt.transportOutcome,
          validatedOutcome: attempt.validatedOutcome,
          errorType: attempt.errorType || null,
          errorMessage: attempt.errorMessage || null,
          latencyMs: attempt.latencyMs,
          firstByteMs: attempt.firstByteMs,
          headersReceived: attempt.headersReceived,
          firstByteSentToClient: attempt.firstByteSentToClient,
          usage: attempt.usage,
          cost: attempt.cost,
          timestamp: attempt.timestamp || new Date().toISOString(),
        }, transaction);
      }

      // 4. 保存 cost_records（事务内，失败则整体回滚）
      if (costRecord) {
        await this.store.saveCost(costRecord, transaction);
      }

      // 5. 保存 audit_records（事务内，失败则整体回滚）
      await this.store.saveAuditRecord(auditRecord, transaction);

      // 提交事务
      await this.store.commitTransaction(transaction);
      transaction = null;

      // 事务成功后：更新内存状态
      this._finalizedIds.add(requestId);
      this._auditRecords.push(auditRecord);

      // 事务成功后：更新 CostTracker 内存聚合
      if (costRecord && this.costTracker) {
        this.costTracker.updateMemoryAggregation(costRecord);
      }

      // 事务成功后：回写模型质量反馈
      if (shouldRecordQualityFeedback(finalOutcome) && successfulAttempt) {
        this._recordQualityFeedback(successfulAttempt, finalOutcome, options);
      }

      log(
        `[finalizer] transaction: finalized ${requestId} outcome=${finalOutcome} ` +
        `attempts=${allAttempts.length}`
      );

      return { finalized: true, auditRecord };

    } catch (err) {
      if (transaction) {
        try {
          await this.store.rollbackTransaction(transaction);
          log(`[finalizer] transaction: rolled back for ${requestId}: ${err.message}`);
        } catch (rollbackErr) {
          log(`[finalizer] transaction: rollback failed: ${rollbackErr.message}`);
        }
      }
      // 事务失败：内存 Cost、日度统计和质量反馈均不改变
      log(`[finalizer] transaction: failed for ${requestId}: ${err.message}`);
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // 无候选收尾：finalizeNoCandidate
  // --------------------------------------------------------------------------

  /**
   * 收尾无候选场景。
   *
   * 即使没有候选，也要写审计记录：
   *   - outcome = 'no_candidate'
   *   - 不记录成本
   *   - 不回写质量反馈
   *
   * @param {string} requestId 请求唯一标识
   * @param {string} requestedModel 客户端请求的模型
   * @param {object} [options] 附加选项
   *   - agentId {string} Agent 标识
   *   - protocol {string} 协议类型
   * @returns {Promise<{finalized: boolean, reason?: string, auditRecord?: object}>}
   */
  async finalizeNoCandidate(requestId, requestedModel, options = {}) {
    // 统一原子收尾入口的兼容包装器：
    // 构建空 AttemptLog，委托 finalizeRequestTransaction 以
    // Outcome.NO_CANDIDATE 收尾，事务内完成 finalized_requests /
    // requests.status=no_candidate / audit_records；不写 Cost、不写质量反馈。
    // SQLite 生产路径实际执行的是 finalizeRequestAtomic（同步原子事务）。
    const attemptLog = new AttemptLog(requestId);
    return this.finalizeRequestTransaction(requestId, attemptLog, Outcome.NO_CANDIDATE, {
      ...options,
      requestedModel: options.requestedModel ?? requestedModel,
    });
  }

  // --------------------------------------------------------------------------
  // 审计记录构建
  // --------------------------------------------------------------------------

  /**
   * 构建审计记录。
   *
   * 包含：
   *   - requestId, timestamp
   *   - outcome（validated_outcome，最终结果）
   *   - 最终成功模型/provider（如有）
   *   - attempts 数组（完整审计链，每个 attempt 含 transport_outcome 和 validated_outcome）
   *   - agent 信息
   *   - 协议信息
   *   - 响应大小
   *
   * @param {string} requestId 请求唯一标识
   * @param {object} attemptLog AttemptLog 实例
   * @param {string} outcome 最终 Outcome
   * @param {object} options 附加选项
   * @returns {object} 审计记录
   */
  _buildAuditRecord(requestId, attemptLog, outcome, options) {
    const successfulAttempt = attemptLog ? attemptLog.getSuccessful() : null;
    const attempts = attemptLog ? attemptLog.toJSON() : [];

    return {
      requestId,
      timestamp: new Date().toISOString(),
      outcome, // validated_outcome（最终结果）
      // 最终成功模型/provider（如有）
      finalModel: successfulAttempt ? successfulAttempt.model : (options.model || null),
      finalProvider: successfulAttempt ? successfulAttempt.provider : (options.provider || null),
      // 客户端请求的模型（no_candidate 等场景使用）
      requestedModel: options.requestedModel || null,
      // 完整审计链（每个 attempt 含 transport_outcome 和 validated_outcome）
      attempts,
      attemptCount: attempts.length,
      // agent 信息
      agentId: options.agentId || null,
      // 协议信息
      protocol: options.protocol || null,
      // 响应大小
      responseSize: options.responseSize ?? null,
    };
  }

  // --------------------------------------------------------------------------
  // 模型质量反馈
  // --------------------------------------------------------------------------

  /**
   * 记录模型质量反馈（内存版，未来迁移到 DB）。
   *
   * 只有 completed/incomplete 才记录：
   *   - completed → success 计数 +1
   *   - incomplete → failure 计数 +1
   *
   * 存储 key = "provider:model"，用于按模型维度聚合质量数据。
   *
   * @param {object} attempt 成功的 AttemptRecord
   * @param {string} outcome 最终 Outcome（completed 或 incomplete）
   * @param {object} options 附加选项
   */
  _recordQualityFeedback(attempt, outcome, options) {
    const provider = attempt.provider || 'unknown';
    const model = attempt.model || 'unknown';
    const key = `${provider}:${model}`;

    let entry = this._qualityFeedback.get(key);
    if (!entry) {
      entry = {
        success: 0,
        failure: 0,
        lastUpdated: null,
      };
      this._qualityFeedback.set(key, entry);
    }

    if (outcome === Outcome.COMPLETED) {
      entry.success++;
    } else if (outcome === Outcome.INCOMPLETE) {
      entry.failure++;
    }

    entry.lastUpdated = new Date().toISOString();

    log(
      `[finalizer] quality feedback: ${key} ` +
      `success=${entry.success} failure=${entry.failure} (${outcome})`
    );
  }

  // --------------------------------------------------------------------------
  // 查询接口
  // --------------------------------------------------------------------------

  /**
   * 检查是否已收尾。
   * @param {string} requestId 请求唯一标识
   * @returns {boolean}
   */
  isFinalized(requestId) {
    return this._finalizedIds.has(requestId);
  }

  /**
   * 获取所有审计记录。
   * @returns {object[]} 审计记录数组（浅拷贝，避免外部篡改内部状态）
   */
  getAuditRecords() {
    return [...this._auditRecords];
  }

  /**
   * 获取指定 requestId 的审计记录。
   * @param {string} requestId
   * @returns {object|null}
   */
  getAuditRecord(requestId) {
    return this._auditRecords.find((r) => r.requestId === requestId) || null;
  }

  /**
   * 获取模型质量反馈摘要。
   *
   * 返回每个 provider:model 的质量统计：
   *   - success: 成功次数
   *   - failure: 失败次数（incomplete）
   *   - total: 总次数
   *   - successRate: 成功率（total > 0 时为 success/total，否则 null）
   *   - lastUpdated: 最后更新时间
   *
   * @returns {object} key = "provider:model", value = 质量统计
   */
  getQualityFeedbackSummary() {
    const summary = {};
    for (const [key, entry] of this._qualityFeedback) {
      const total = entry.success + entry.failure;
      summary[key] = {
        success: entry.success,
        failure: entry.failure,
        total,
        successRate: total > 0 ? entry.success / total : null,
        lastUpdated: entry.lastUpdated,
      };
    }
    return summary;
  }

  /**
   * 获取指定 provider:model 的质量反馈。
   * @param {string} provider provider 名称
   * @param {string} model 模型 id
   * @returns {object|null}
   */
  getQualityFeedback(provider, model) {
    const key = `${provider || 'unknown'}:${model || 'unknown'}`;
    const entry = this._qualityFeedback.get(key);
    if (!entry) return null;
    const total = entry.success + entry.failure;
    return {
      success: entry.success,
      failure: entry.failure,
      total,
      successRate: total > 0 ? entry.success / total : null,
      lastUpdated: entry.lastUpdated,
    };
  }

  // --------------------------------------------------------------------------
  // 测试与诊断辅助
  // --------------------------------------------------------------------------

  /**
   * 设置存储后端（用于延迟注入或切换存储）。
   * @param {object} store StorageInterface 实现
   */
  setStore(store) {
    this.store = store || null;
  }

  /**
   * 重置内部状态（主要用于测试隔离）。
   */
  _resetForTest() {
    this._finalizedIds.clear();
    this._auditRecords = [];
    this._qualityFeedback.clear();
  }

  /**
   * 返回简要诊断快照（不暴露内部引用）。
   * @returns {object}
   */
  snapshot() {
    return {
      finalizedCount: this._finalizedIds.size,
      auditRecordCount: this._auditRecords.length,
      qualityFeedbackKeys: [...this._qualityFeedback.keys()],
    };
  }
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  Finalizer,
};
