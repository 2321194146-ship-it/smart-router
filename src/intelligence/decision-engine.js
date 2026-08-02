// src/intelligence/decision-engine.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Decision Engine：组合 Task Analyzer + Capability Registry + Policy + Budget，
// 对候选模型评分并输出「智能建议」。
//
// Shadow 约束：
//   - 只输出机器可执行元数据（recommendation / ranked / predictions / explanation）
//   - 不修改 Phase1 候选顺序，不触发上游调用，不影响用户响应
//   - 不附加任何 System Prompt
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { analyzeTask } from './task-analyzer.js';
import { CapabilityRegistry } from './capability-registry.js';
import { normalizePolicy, scoreCandidate, predictQuality, predictLatency } from './policy.js';
import { evaluateBudget } from './budget.js';
import { explainDecision } from './explainability.js';

/**
 * 智能决策引擎（Shadow）。
 */
export class DecisionEngine {
  /**
   * @param {object} config 已加载配置
   * @param {object} [opts]
   * @param {object} [opts.policy] policy 覆盖
   */
  constructor(config, opts = {}) {
    this.config = config;
    this.registry = new CapabilityRegistry(config);
    this.policy = normalizePolicy(opts.policy || config?.intelligence?.shadow?.policy);
  }

  /**
   * 分析请求体（Task Analyzer）。
   */
  analyze(body, options = {}) {
    return analyzeTask(body, { protocol: options.protocol });
  }

  /**
   * 对一组候选生成智能建议（评分排序 + 预测 + 解释）。
   *
   * @param {object} params
   * @param {object} params.body 协议请求体
   * @param {string} params.agentId
   * @param {object} params.budget 生效预算（Phase1 CostTracker.resolveBudget 结果）
   * @param {object[]} params.candidates Phase1 候选列表（保持原顺序）
   * @param {string} [params.protocol]
   * @returns {{
   *   mode: 'shadow',
   *   task: object,
   *   budgetAssessment: object,
   *   recommendation: object|null,
   *   ranked: object[],
   *   predictions: object,
   *   explanation: object
   * }}
   */
  decide({ body, agentId, budget, candidates, protocol }) {
    const task = this.analyze(body, { protocol });

    // Budget 评估（Shadow）
    const budgetAssessment = evaluateBudget({
      agentId,
      requestedModel: body?.model || null,
      task,
      candidates,
      config: this.config,
    });

    // 候选评分（保持 Phase1 候选顺序，仅附加评分）
    const ranked = (Array.isArray(candidates) ? candidates : []).map((c) => {
      const candidate = {
        modelId: c.modelId || c.model,
        provider: c.provider,
        tier: c.tier,
        paid: !!c.paid,
        capability: Array.isArray(c.capability) ? c.capability : [],
        price: c.model?.price || c.price || null,
      };
      const scored = scoreCandidate(candidate, task, this.policy, budget || budgetAssessment);
      return {
        modelId: candidate.modelId,
        provider: candidate.provider,
        tier: candidate.tier,
        paid: candidate.paid,
        score: scored.score,
        reasons: scored.reasons,
        blocked: scored.blocked,
      };
    });

    const available = ranked.filter((r) => !r.blocked);
    const recommendation = available.length > 0
      ? available.reduce((best, r) => (r.score > best.score ? r : best))
      : null;

    // 预测（对推荐模型）
    const recCandidate = recommendation
      ? {
          modelId: recommendation.modelId,
          provider: recommendation.provider,
          tier: recommendation.tier,
          paid: recommendation.paid,
          price: (Array.isArray(candidates) ? candidates.find((c) => (c.modelId || c.model) === recommendation.modelId) : null)?.model?.price || null,
        }
      : null;
    const predictions = {
      cost: recommendation
        ? (budgetAssessment.estimatedCost ?? null)
        : null,
      quality: recCandidate ? predictQuality(recCandidate, task) : null,
      latency: recCandidate ? predictLatency(recCandidate) : null,
    };

    const explanation = explainDecision({ recommendation, ranked, predictions });

    return {
      mode: 'shadow',
      task,
      budgetAssessment,
      recommendation,
      ranked,
      predictions,
      explanation,
    };
  }
}

export default { DecisionEngine };
