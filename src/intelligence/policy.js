// src/intelligence/policy.js
// Smart Router Mainline - Phase 2-A (Shadow)
// 基础 Policy：候选选择/淘汰规则（Shadow 版）。
//
// Policy 定义「智能建议」的偏好规则，供 Decision Engine 评分：
//   - 能力匹配优先（tool_use / vision）
//   - tier 偏好（tier1 优先）
//   - 免费优先（paid=false 优先，allowPaid=false 时 paid 直接淘汰）
//   - 成本敏感（price 低优先）
//   - 预算约束（allowedModels / allowedProviders / maxRequestCost）
//
// Shadow 约束：只读，不修改 Phase1 候选顺序，不触发上游调用。
//
// 仅使用 Node.js 内置模块，无第三方依赖。

// ----------------------------------------------------------------------------
// 策略配置
// ----------------------------------------------------------------------------

const DEFAULT_POLICY = Object.freeze({
  tierPreference: true, // 偏好低序号 tier
  preferFree: true, // 免费优先
  preferFastTier: false, // 预留：偏好快速模型
  costWeight: 0.25, // 成本评分权重
  capabilityWeight: 0.35, // 能力匹配权重
  tierWeight: 0.25, // tier 权重
  paidPenalty: 0.2, // 付费模型惩罚
});

/**
 * 规范化 policy 配置。
 */
export function normalizePolicy(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    tierPreference: p.tierPreference !== false,
    preferFree: p.preferFree !== false,
    preferFastTier: !!p.preferFastTier,
    costWeight: typeof p.costWeight === 'number' ? p.costWeight : DEFAULT_POLICY.costWeight,
    capabilityWeight: typeof p.capabilityWeight === 'number' ? p.capabilityWeight : DEFAULT_POLICY.capabilityWeight,
    tierWeight: typeof p.tierWeight === 'number' ? p.tierWeight : DEFAULT_POLICY.tierWeight,
    paidPenalty: typeof p.paidPenalty === 'number' ? p.paidPenalty : DEFAULT_POLICY.paidPenalty,
  };
}

// ----------------------------------------------------------------------------
// 评分
// ----------------------------------------------------------------------------

/**
 * 对单个候选模型进行 Policy 评分（0-1）。
 *
 * @param {object} candidate { modelId, provider, tier, paid, capability, price? }
 * @param {object} task 任务画像（含 needsToolUse / needsVision / complexity）
 * @param {object} policy 规范化后的策略
 * @param {object} budget 生效预算 { allowPaid, maxRequestCost, allowedModels, allowedProviders, strictModel }
 * @returns {{ score: number, reasons: string[], blocked: string|null }}
 */
export function scoreCandidate(candidate, task, policy, budget) {
  const reasons = [];
  const blocked = [];

  // 0. 硬性约束：预算（Shadow 版不执行，仅评估）
  if (budget) {
    if (budget.allowPaid === false && candidate.paid) {
      blocked.push(`paid model blocked by allowPaid=false`);
    }
    if (Array.isArray(budget.allowedModels) && budget.allowedModels.length > 0
      && !budget.allowedModels.includes(candidate.modelId)) {
      blocked.push(`model "${candidate.modelId}" not in allowedModels`);
    }
    if (Array.isArray(budget.allowedProviders) && budget.allowedProviders.length > 0
      && !budget.allowedProviders.includes(candidate.provider)) {
      blocked.push(`provider "${candidate.provider}" not in allowedProviders`);
    }
    if (typeof budget.maxRequestCost === 'number' && Number.isFinite(budget.maxRequestCost)) {
      const estCost = estimateCost(candidate, task);
      if (estCost > budget.maxRequestCost) {
        blocked.push(`estimated cost ${estCost.toFixed(6)} > maxRequestCost ${budget.maxRequestCost}`);
      }
    }
  }
  if (blocked.length > 0) {
    return { score: 0, reasons, blocked: blocked.join('; ') };
  }

  // 1. 能力匹配分
  let capScore = 0.5;
  const caps = Array.isArray(candidate.capability) ? candidate.capability : [];
  if (task?.needsToolUse && caps.includes('tool_use')) {
    capScore = 1.0;
    reasons.push('has tool_use (required)');
  } else if (task?.needsToolUse) {
    capScore = 0.2;
    reasons.push('missing tool_use (required)');
  }
  if (task?.needsVision) {
    if (caps.includes('vision')) {
      capScore = Math.min(1, capScore + 0.3);
      reasons.push('has vision (required)');
    } else {
      capScore = Math.min(capScore, 0.2);
      reasons.push('missing vision (required)');
    }
  }

  // 2. tier 分（tier1=1.0, tier2=0.7, tier3=0.4）
  const tierRank = { tier1: 1.0, tier2: 0.7, tier3: 0.4 };
  const tierScore = tierRank[candidate.tier] ?? 0.5;
  if (policy.tierPreference) reasons.push(`tier=${candidate.tier}`);

  // 3. 付费分
  let paidScore = candidate.paid ? 1 - policy.paidPenalty : 1.0;
  if (candidate.paid) reasons.push('paid model penalty');
  else if (policy.preferFree) reasons.push('free model preferred');

  // 4. 成本分（price 越低越高）
  let costScore = 0.5;
  const price = candidate.price || {};
  const inCost = price.input_cost_per_1k || 0;
  const outCost = price.output_cost_per_1k || 0;
  if (inCost > 0 || outCost > 0) {
    costScore = Math.max(0, 1 - (inCost + outCost * 3) / 0.05);
    costScore = Number(costScore.toFixed(3));
    reasons.push(`price ${inCost}/${outCost} per 1k`);
  } else {
    reasons.push('no price (free/unknown)');
  }

  const total =
    capScore * policy.capabilityWeight +
    tierScore * policy.tierWeight +
    paidScore * 0.15 +
    costScore * policy.costWeight;
  const score = Math.min(1, Math.max(0, total));

  return { score: Number(score.toFixed(3)), reasons, blocked: null };
}

/**
 * 预估单次请求成本（输入 token 来自任务画像，输出 token 按复杂度估算）。
 * @param {object} candidate
 * @param {object} task
 * @returns {number} 预估成本（默认货币）
 */
export function estimateCost(candidate, task) {
  const price = candidate?.price || {};
  const inCost = price.input_cost_per_1k || 0;
  const outCost = price.output_cost_per_1k || 0;
  const inTokens = task?.estimatedInputTokens || 1000;
  const outTokens = Math.ceil((task?.complexity || 0.3) * 800) + 100;
  return (inTokens / 1000) * inCost + (outTokens / 1000) * outCost;
}

/**
 * 预测质量分（0-1）：由 tier 与任务复杂度匹配度决定（Shadow 版启发式）。
 */
export function predictQuality(candidate, task) {
  const tierRank = { tier1: 1.0, tier2: 0.85, tier3: 0.7 };
  const base = tierRank[candidate.tier] ?? 0.8;
  // 复杂任务对 tier1 更有利
  const complexity = task?.complexity || 0.3;
  const boost = complexity > 0.7 ? 0.05 : complexity < 0.3 ? -0.05 : 0;
  return Number(Math.min(1, Math.max(0, base + boost)).toFixed(3));
}

/**
 * 预测延迟（毫秒）：由 tier 与 provider 经验值决定（Shadow 版启发式）。
 */
export function predictLatency(candidate) {
  const base = { tier1: 1200, tier2: 1800, tier3: 2400 }[candidate.tier] ?? 1500;
  return base + Math.floor(Math.random() * 400);
}

export default {
  normalizePolicy,
  scoreCandidate,
  estimateCost,
  predictQuality,
  predictLatency,
  DEFAULT_POLICY,
};
