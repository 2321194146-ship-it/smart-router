// src/intelligence/shadow-recorder.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Shadow Recorder：记录智能建议（执行前）与真实最终结果（Finalize 后），绑定同一 requestId。
//
// 持久化：store.saveShadowDecision（执行前 upsert）+ store.finalizeShadowDecision（Finalize 后更新）。
// 脱敏：task_profile 仅保存白名单特征（taskType/complexity/token 估算/能力信号等），
//       不保存完整用户 Prompt；lastUserText 默认不进入持久化。
//
// 对照状态：
//   - exact_match              ：建议与真实 模型+Provider 均一致
//   - model_match_provider_diff：模型一致、Provider 不同
//   - policy_agreement         ：双方都拒绝/预算阻止（建议=null 且真实=budget_exceeded/no_candidate）
//   - different                ：建议与实际不一致
//   - not_comparable           ：不可比（client_aborted / internal_error 等非模型选择终态）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

/** 持久化任务画像白名单（排除 lastUserText 等敏感内容） */
const TASK_PROFILE_WHITELIST = [
  'taskType', 'requiredCapabilities', 'hardCapabilities', 'complexity',
  'estimatedInputTokens', 'estimatedOutputTokens', 'estimatedTotalTokens',
  'toolsAvailable', 'toolsRequired', 'structuredOutputRequired',
  'needsToolUse', 'needsVision', 'needsStreaming',
  'needsStructuredOutput', 'codeRelated', 'hasLongContext', 'messageCount', 'signals',
];

/**
 * 从 Task Analyzer 输出提取脱敏任务画像。
 * @param {object|null} task 完整任务画像
 * @returns {object|null}
 */
export function sanitizeTaskProfile(task) {
  if (!task || typeof task !== 'object') return null;
  const out = {};
  for (const key of TASK_PROFILE_WHITELIST) {
    if (task[key] !== undefined) out[key] = task[key];
  }
  return out;
}

/**
 * 计算对照状态。
 * @param {object|null} suggestion 建议阶段记录（含 recommendation）
 * @param {object} auditRecord 最终 Audit
 * @returns {string}
 */
export function computeComparisonStatus(suggestion, auditRecord) {
  const rec = suggestion?.recommendation || null;
  const outcome = auditRecord?.outcome || null;
  const finalModel = auditRecord?.finalModel ?? null;
  const finalProvider = auditRecord?.finalProvider ?? null;

  // 非模型选择的终态：取消 / 内部错误 → 不可比
  if (outcome === 'client_aborted' || outcome === 'internal_error') return 'not_comparable';

  // 双方都拒绝：无建议 + 预算/无候选 → 策略一致
  if (!rec && (outcome === 'budget_exceeded' || outcome === 'no_candidate')) return 'policy_agreement';

  // 无建议：执行失败（provider 故障/不完整）→ 不可比；完成 → 不同
  if (!rec) {
    if (outcome === 'provider_error' || outcome === 'provider_unavailable' || outcome === 'incomplete') {
      return 'not_comparable';
    }
    return 'different';
  }

  // 有建议但实际被拦截/失败 → 建议未被采纳
  if (outcome === 'budget_exceeded' || outcome === 'no_candidate'
    || outcome === 'provider_error' || outcome === 'provider_unavailable'
    || outcome === 'incomplete') {
    return 'different';
  }

  // completed：比较模型与 Provider
  if (finalModel === rec.modelId && finalProvider === rec.provider) return 'exact_match';
  if (finalModel === rec.modelId) return 'model_match_provider_diff';
  return 'different';
}

/**
 * 从 Audit 提取最终真实结果（attempts 含 usage/cost/latency）。
 */
function extractActuals(auditRecord) {
  const attempts = Array.isArray(auditRecord?.attempts) ? auditRecord.attempts : [];
  const successful = attempts.find((a) => a.transportOutcome === 'success') || null;
  return {
    actual_final_model: auditRecord.finalModel ?? null,
    actual_final_provider: auditRecord.finalProvider ?? null,
    actual_outcome: auditRecord.outcome ?? null,
    actual_attempt_count: auditRecord.attemptCount ?? (attempts.length || 0),
    actual_usage: successful?.usage ?? null,
    actual_cost: successful?.cost ?? null,
    actual_latency: successful?.latencyMs ?? null,
  };
}

export class ShadowRecorder {
  constructor(options = {}) {
    this.options = options;
    this.store = options.store || null;
    this._enabled = options.enabled !== false;
    this.retentionDays = typeof options.retentionDays === 'number' ? options.retentionDays : 30;
    this._memory = new Map(); // requestId -> suggestion 快照（无 store 时兜底）
  }

  /**
   * 记录智能建议（执行前；幂等 upsert）。
   */
  async recordSuggestion(entry) {
    if (!this._enabled) return;
    if (!entry?.requestId) return;

    const taskProfile = sanitizeTaskProfile(entry.taskProfile);
    const row = {
      request_id: entry.requestId,
      protocol: entry.protocol ?? null,
      agent_id: entry.agentId ?? null,
      requested_model: entry.requestedModel ?? null,
      task_profile: taskProfile ? JSON.stringify(taskProfile) : null,
      recommendation: entry.recommendation ? JSON.stringify(entry.recommendation) : null,
      ranked_candidates: Array.isArray(entry.ranked) ? JSON.stringify(entry.ranked) : null,
      predictions: entry.predictions ? JSON.stringify(entry.predictions) : null,
      explanation: entry.explanation ? JSON.stringify(entry.explanation) : null,
      created_at: entry.createdAt || new Date().toISOString(),
    };

    // 内存镜像（供无 store 场景与快速读取）
    this._memory.set(entry.requestId, {
      requestId: entry.requestId,
      protocol: row.protocol,
      agentId: row.agent_id,
      requestedModel: row.requested_model,
      taskProfile,
      recommendation: entry.recommendation || null,
      ranked: entry.ranked || [],
      predictions: entry.predictions || null,
      explanation: entry.explanation || null,
      createdAt: row.created_at,
    });

    if (this.store && typeof this.store.saveShadowDecision === 'function') {
      await this.store.saveShadowDecision(row);
    }
  }

  /**
   * 记录真实最终结果（Finalize 原子事务成功后由观察者调用）。
   * @param {object} auditRecord 最终 Audit 记录
   */
  async recordFinalized(auditRecord) {
    if (!this._enabled) return;
    if (!auditRecord?.requestId) return;

    const requestId = auditRecord.requestId;
    const suggestion = this.getSuggestion(requestId);
    if (!suggestion) return;

    const actuals = extractActuals(auditRecord);
    const comparisonStatus = computeComparisonStatus(suggestion, auditRecord);

    const finalRow = {
      request_id: requestId,
      actual_final_model: actuals.actual_final_model,
      actual_final_provider: actuals.actual_final_provider,
      actual_outcome: actuals.actual_outcome,
      actual_attempt_count: actuals.actual_attempt_count,
      actual_usage: actuals.actual_usage ? JSON.stringify(actuals.actual_usage) : null,
      actual_cost: actuals.actual_cost ? JSON.stringify(actuals.actual_cost) : null,
      actual_latency: actuals.actual_latency,
      comparison_status: comparisonStatus,
      finalized_at: new Date().toISOString(),
    };

    // 更新内存镜像
    const mem = this._memory.get(requestId);
    if (mem) {
      mem.actualFinalModel = actuals.actual_final_model;
      mem.actualFinalProvider = actuals.actual_final_provider;
      mem.actualOutcome = actuals.actual_outcome;
      mem.actualAttemptCount = actuals.actual_attempt_count;
      mem.actualUsage = actuals.actual_usage;
      mem.actualCost = actuals.actual_cost;
      mem.actualLatency = actuals.actual_latency;
      mem.comparisonStatus = comparisonStatus;
      mem.finalizedAt = finalRow.finalized_at;
    }

    if (this.store && typeof this.store.finalizeShadowDecision === 'function') {
      await this.store.finalizeShadowDecision(finalRow);
    }
  }

  /** 获取建议快照（内存）。 */
  getSuggestion(requestId) {
    return this._memory.get(requestId) || null;
  }

  /** 获取单条完整记录（优先 store）。 */
  async get(requestId) {
    if (this.store && typeof this.store.getShadowDecision === 'function') {
      const row = await this.store.getShadowDecision(requestId);
      if (row) return row;
    }
    const mem = this._memory.get(requestId);
    return mem ? { ...mem } : null;
  }

  /** 获取全部记录（优先 store）。 */
  async getAll() {
    if (this.store && typeof this.store.listShadowDecisions === 'function') {
      return this.store.listShadowDecisions();
    }
    return [...this._memory.values()];
  }

  /** 记录数量。 */
  get size() {
    return this._memory.size;
  }

  /**
   * 对照摘要：acceptance 分母不含 not_comparable / policy_agreement。
   * @returns {object}
   */
  async summarizeComparison() {
    const rows = await this.getAll();
    let exactMatch = 0;
    let modelMatchProviderDiff = 0;
    let policyAgreement = 0;
    let different = 0;
    let notComparable = 0;
    const comparison = [];

    for (const r of rows) {
      const status = r.comparisonStatus || 'not_comparable';
      const row = {
        requestId: r.requestId,
        protocol: r.protocol,
        agentId: r.agentId,
        suggested: r.recommendation?.modelId ?? null,
        suggestedProvider: r.recommendation?.provider ?? null,
        suggestedScore: r.recommendation?.score ?? null,
        real: r.actualFinalModel ? `${r.actualFinalProvider}/${r.actualFinalModel}` : null,
        realOutcome: r.actualOutcome ?? null,
        comparisonStatus: status,
        predictedCost: r.predictions?.cost ?? null,
        predictedLatency: r.predictions?.latency ?? null,
        realLatency: r.actualLatency ?? null,
        explanationSummary: r.explanation?.summary ?? null,
      };
      comparison.push(row);
      if (status === 'exact_match') exactMatch++;
      else if (status === 'model_match_provider_diff') modelMatchProviderDiff++;
      else if (status === 'policy_agreement') policyAgreement++;
      else if (status === 'different') different++;
      else notComparable++;
    }

    const comparable = exactMatch + modelMatchProviderDiff + different;
    return {
      total: rows.length,
      exact_match: exactMatch,
      model_match_provider_diff: modelMatchProviderDiff,
      policy_agreement: policyAgreement,
      different,
      not_comparable: notComparable,
      comparable,
      acceptanceRate: comparable > 0 ? Number(((exactMatch / comparable) * 100).toFixed(1)) : 0,
      comparison,
    };
  }

  async prune() {
    if (this.store && typeof this.store.pruneShadowDecisions === 'function') {
      return this.store.pruneShadowDecisions(this.retentionDays);
    }
    return 0;
  }

  clear() {
    this._memory.clear();
  }
}

export default { ShadowRecorder, sanitizeTaskProfile, computeComparisonStatus };
