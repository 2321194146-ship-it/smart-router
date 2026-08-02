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
// Capability Registry 真正参与决策：
//   - 候选统一身份 = modelId + provider
//   - 通过 registry.getProfile(modelId, provider) 获得标准化画像
//     （capabilities / contextWindow / price / protocols / tier / paid）
//   - 同一 modelId 不同 Provider 分开评分、分开预测
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { analyzeTask } from './task-analyzer.js';
import { CapabilityRegistry, deriveProtocols } from './capability-registry.js';
import {
  normalizePolicy,
  scoreCandidate,
  estimateCost,
  predictQuality,
  predictLatency,
} from './policy.js';
import { evaluateBudget } from './budget.js';
import { explainDecision } from './explainability.js';

export class DecisionEngine {
  constructor(config, opts = {}) {
    this.config = config;
    this.registry = new CapabilityRegistry(config);
    this.policy = normalizePolicy(opts.policy || config?.intelligence?.shadow?.policy);
  }

  analyze(body, options = {}) {
    return analyzeTask(body, { protocol: options.protocol });
  }

  /**
   * 通过 Capability Registry 构建标准化候选画像（modelId + provider 统一身份）。
   */
  _buildProfile(candidate) {
    const modelId = candidate?.modelId || candidate?.model?.id || null;
    const provider = candidate?.provider || candidate?.model?.provider || null;
    // 优先从 Registry 读取权威画像
    const profile = modelId ? this.registry.getProfile(modelId, provider) : null;
    if (profile) {
      // 用候选执行信息补充（tier/paid 若候选与配置不一致，以配置为准）
      return profile;
    }
    // 候选不在配置中（Registry 未命中）：回退到候选自带字段
    const caps = Array.isArray(candidate?.capability)
      ? candidate.capability.map(String)
      : (Array.isArray(candidate?.model?.capability) ? candidate.model.capability.map(String) : []);
    return {
      modelId,
      provider,
      tier: candidate?.tier || candidate?.model?.tier || 'tier3',
      paid: !!candidate?.paid || !!candidate?.model?.paid,
      capabilities: caps,
      contextWindow: candidate?.model?.context_window || candidate?.model?.max_tokens || 0,
      price: candidate?.model?.price || candidate?.price || null,
      protocols: deriveProtocols({ capability: caps, provider, id: modelId }),
      enabled: true,
    };
  }

  /**
   * 对一组候选生成智能建议。
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

    const budgetAssessment = evaluateBudget({
      agentId,
      requestedModel: body?.model || null,
      task,
      candidates: Array.isArray(candidates) ? candidates : [],
      config: this.config,
    });

    // 通过 Registry 标准化（modelId + provider），保持 Phase1 候选顺序
    const ranked = (Array.isArray(candidates) ? candidates : []).map((c) => {
      const profile = this._buildProfile(c);
      const scored = scoreCandidate(profile, task, this.policy, budget, protocol);
      return {
        modelId: profile.modelId,
        provider: profile.provider,
        tier: profile.tier,
        paid: profile.paid,
        score: scored.score,
        reasons: scored.reasons,
        blocked: scored.blocked,
      };
    });

    // 只有未被硬约束阻止的候选才可成为 recommendation
    const available = ranked.filter((r) => !r.blocked);
    const recommendation = available.length > 0
      ? available.reduce((best, r) => (r.score > best.score ? r : best))
      : null;

    // 预测：仅针对推荐候选（modelId + provider 对应）
    let predictions = { cost: null, quality: null, latency: null };
    if (recommendation) {
      const recProfile = (Array.isArray(candidates) ? candidates : [])
        .map((c) => this._buildProfile(c))
        .find((p) => p.modelId === recommendation.modelId && p.provider === recommendation.provider);
      if (recProfile) {
        predictions = {
          cost: estimateCost(recProfile, task),
          quality: predictQuality(recProfile, task),
          latency: predictLatency(recProfile),
        };
      }
    }

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
