// src/intelligence/decision-engine.js
// Smart Router Mainline - Phase 2-B (Active Readiness)
// Decision Engine：组合 Task Analyzer + Capability Registry + Policy + Budget + ProviderHealth，
// 对候选模型评分并输出「智能建议」。
//
// Shadow 约束：
//   - 只输出机器可执行元数据（recommendation / ranked / predictions / explanation）
//   - 不修改 Phase1 候选顺序，不触发上游调用，不影响用户响应
//   - 不附加任何 System Prompt
//   - 只读 ProviderHealth / CircuitBreaker；不修改 Provider 状态；不扩大合法候选集合
//
// Phase2-B：
//   - 统一任务能力需求画像（requiredCapabilities）参与评分
//   - 硬约束：streaming/tool_use/vision/contextWindow/protocol/request_cost_exceeded
//   - Provider 健康：可用但近期不稳定 → 降分；样本不足（<5）只用静态先验
//   - 同 modelId 不同 Provider 分开评分、分开预测
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { analyzeTask } from './task-analyzer.js';
import { CapabilityRegistry } from './capability-registry.js';
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
    // Provider 健康（只读注入；可空）
    this.health = opts.health || null;
  }

  analyze(body, options = {}) {
    return analyzeTask(body, { protocol: options.protocol });
  }

  /**
   * 读取 Provider 健康统计（只读）。
   * @param {string} providerName
   * @returns {{ status, failureRate, avgLatency, sampleCount }|null}
   */
  _providerHealth(providerName) {
    if (!this.health || typeof this.health.getHealthSummary !== 'function') return null;
    try {
      const summary = this.health.getHealthSummary();
      const rec = summary && summary[providerName];
      if (!rec) return null;
      return {
        status: rec.status || 'unknown',
        failureRate: typeof rec.failureRate === 'number' ? rec.failureRate / 100 : 0,
        avgLatency: rec.avgLatency || 0,
        sampleCount: rec.totalRequests || 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * 通过 Capability Registry 构建标准化候选画像（modelId + provider 统一身份）。
   */
  _buildProfile(candidate) {
    const modelId = candidate?.modelId || candidate?.model?.id || null;
    const provider = candidate?.provider || candidate?.model?.provider || null;
    const profile = modelId ? this.registry.getProfile(modelId, provider) : null;
    if (profile) return profile;
    // 候选不在配置中：回退到候选自带字段（capability 数组 → 对象）
    const caps = Array.isArray(candidate?.capability)
      ? candidate.capability.map(String)
      : (Array.isArray(candidate?.model?.capability) ? candidate.model.capability.map(String) : []);
    const capabilities = {};
    for (const k of ['chat', 'coding', 'reasoning', 'tool_use', 'vision', 'structured_output', 'long_context', 'streaming']) {
      capabilities[k] = caps.includes(k) ? 1 : 0;
    }
    return {
      modelId,
      provider,
      capabilities,
      contextWindow: candidate?.model?.context_window || candidate?.model?.max_tokens || 0,
      price: candidate?.model?.price || candidate?.price || null,
      tier: candidate?.tier || candidate?.model?.tier || 'tier3',
      paid: !!candidate?.paid || !!candidate?.model?.paid,
      reliability: 0,
      latencyPriorMs: 0,
      protocols: capabilities.chat >= 1 ? ['chat', 'responses', 'anthropic'] : [],
      enabled: true,
    };
  }

  /**
   * 对一组候选生成智能建议。
   */
  decide({ body, agentId, budget, candidates, protocol }) {
    const task = this.analyze(body, { protocol });
    const rawCandidates = Array.isArray(candidates) ? candidates : [];

    // 预算评估（标准化画像）
    const profiles = rawCandidates.map((c) => this._buildProfile(c));
    const budgetAssessment = evaluateBudget({
      agentId,
      requestedModel: body?.model || null,
      task,
      candidates: profiles,
      config: this.config,
    });

    // 候选评分（保持 Phase1 候选顺序；Provider 健康只读）
    const ranked = rawCandidates.map((c) => {
      const profile = this._buildProfile(c);
      const health = this._providerHealth(profile.provider);
      const scored = scoreCandidate(profile, task, this.policy, budget, protocol, health);
      return {
        modelId: profile.modelId,
        provider: profile.provider,
        tier: profile.tier,
        paid: profile.paid,
        score: scored.score,
        reasons: scored.reasons,
        blocked: scored.blocked,
        estimatedCost: estimateCost(profile, task),
      };
    });

    // 只有未被硬约束/预算阻止的候选才可成为 recommendation
    const available = ranked.filter((r) => !r.blocked);
    const recommendation = available.length > 0
      ? available.reduce((best, r) => (r.score > best.score ? r : best))
      : null;

    // 预测：仅针对推荐候选（modelId + provider 对应）
    let predictions = { cost: null, quality: null, latency: null };
    if (recommendation) {
      const recProfile = profiles.find(
        (p) => p.modelId === recommendation.modelId && p.provider === recommendation.provider,
      );
      if (recProfile) {
        const health = this._providerHealth(recProfile.provider);
        predictions = {
          cost: estimateCost(recProfile, task),
          quality: predictQuality(recProfile, task),
          latency: predictLatency(recProfile, health),
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
