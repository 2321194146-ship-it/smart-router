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
  constructor(costTracker) {
    this.costTracker = costTracker || null;

    // 幂等保护：已收尾的 requestId 集合
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
    // 1. 幂等检查
    if (this._finalizedIds.has(requestId)) {
      log(`[finalizer] finalize already executed, skipping: ${requestId}`);
      return { finalized: false, reason: 'already_finalized' };
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
    // 幂等检查
    if (this._finalizedIds.has(requestId)) {
      log(`[finalizer] finalize already executed, skipping: ${requestId}`);
      return { finalized: false, reason: 'already_finalized' };
    }
    this._finalizedIds.add(requestId);

    const auditRecord = {
      requestId,
      outcome: Outcome.NO_CANDIDATE,
      requestedModel: requestedModel || null,
      finalModel: null,
      finalProvider: null,
      attempts: [],
      attemptCount: 0,
      agentId: options.agentId || null,
      protocol: options.protocol || null,
      responseSize: options.responseSize ?? null,
      timestamp: new Date().toISOString(),
    };

    this._auditRecords.push(auditRecord);
    log(`[finalizer] no_candidate audit record: ${requestId}`);

    return { finalized: true, auditRecord };
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
