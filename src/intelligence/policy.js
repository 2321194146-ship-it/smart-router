// src/intelligence/policy.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Policy：候选评分与硬约束（Shadow 版）。
//
// 硬约束（blocked，不是普通评分项）：
//   - 任务需要 tool_use 而模型不支持 → blocked
//   - 任务需要 vision 而模型不支持 → blocked
//   - 输入上下文超过模型 contextWindow → blocked
//   - 协议无法 native/adapter 兼容 → blocked
// 被硬约束阻止的候选：score=0 + blocked 原因，绝不能成为 recommendation。
//
// 预测（确定性）：
//   - 成本：每个候选按自己的 price 分别计算
//   - 延迟：静态先验（tier + provider 偏移 + 模型覆盖），无 Math.random()
//   - 质量：仅在通过硬约束后计算，不输出 1.0
//
// 仅使用 Node.js 内置模块，无第三方依赖。

const DEFAULT_POLICY = Object.freeze({
  tierPreference: true,
  preferFree: true,
  costWeight: 0.25,
  capabilityWeight: 0.35,
  tierWeight: 0.25,
  paidPenalty: 0.2,
});

export function normalizePolicy(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    tierPreference: p.tierPreference !== false,
    preferFree: p.preferFree !== false,
    costWeight: typeof p.costWeight === 'number' ? p.costWeight : DEFAULT_POLICY.costWeight,
    capabilityWeight: typeof p.capabilityWeight === 'number' ? p.capabilityWeight : DEFAULT_POLICY.capabilityWeight,
    tierWeight: typeof p.tierWeight === 'number' ? p.tierWeight : DEFAULT_POLICY.tierWeight,
    paidPenalty: typeof p.paidPenalty === 'number' ? p.paidPenalty : DEFAULT_POLICY.paidPenalty,
  };
}

// ----------------------------------------------------------------------------
// 硬约束
// ----------------------------------------------------------------------------

/**
 * 硬性能力检查。返回 blocked 原因或 null。
 *
 * @param {object} candidate 标准化画像 { modelId, provider, capabilities, contextWindow, protocols }
 * @param {object} task 任务画像
 * @param {string|null} protocol 请求协议（chat / responses / anthropic）
 * @returns {string|null}
 */
export function hardConstraintBlock(candidate, task, protocol) {
  const caps = Array.isArray(candidate?.capabilities) ? candidate.capabilities : [];
  const blocks = [];

  if (task?.needsToolUse && !caps.includes('tool_use')) {
    blocks.push('missing tool_use (required)');
  }
  if (task?.needsVision && !caps.includes('vision')) {
    blocks.push('missing vision (required)');
  }
  if (task?.estimatedInputTokens && candidate?.contextWindow
    && task.estimatedInputTokens > candidate.contextWindow) {
    blocks.push(
      `input tokens ${task.estimatedInputTokens} > contextWindow ${candidate.contextWindow}`,
    );
  }
  if (protocol) {
    const protocols = Array.isArray(candidate?.protocols) ? candidate.protocols : [];
    if (!protocols.includes(protocol)) {
      blocks.push(`protocol "${protocol}" not supported`);
    }
  }
  return blocks.length > 0 ? blocks.join('; ') : null;
}

// ----------------------------------------------------------------------------
// 评分
// ----------------------------------------------------------------------------

/**
 * 对单个标准化候选评分（0-1）。
 * 硬约束被阻止 → score=0 + blocked。
 *
 * @param {object} candidate { modelId, provider, tier, paid, capabilities, contextWindow, price, protocols }
 * @param {object} task 任务画像
 * @param {object} policy 规范化策略
 * @param {object} budget 生效预算
 * @param {string|null} protocol 请求协议
 * @returns {{ score: number, reasons: string[], blocked: string|null }}
 */
export function scoreCandidate(candidate, task, policy, budget, protocol) {
  const reasons = [];

  // 0. 预算硬性约束（Phase2 评估；Phase1 CostTracker 负责真实执行拦截）
  if (budget) {
    if (budget.allowPaid === false && candidate.paid) {
      return { score: 0, reasons, blocked: 'paid model blocked by allowPaid=false' };
    }
    if (Array.isArray(budget.allowedModels) && budget.allowedModels.length > 0
      && !budget.allowedModels.includes(candidate.modelId)) {
      return { score: 0, reasons, blocked: `model "${candidate.modelId}" not in allowedModels` };
    }
    if (Array.isArray(budget.allowedProviders) && budget.allowedProviders.length > 0
      && !budget.allowedProviders.includes(candidate.provider)) {
      return { score: 0, reasons, blocked: `provider "${candidate.provider}" not in allowedProviders` };
    }
  }

  // 1. 硬性能力约束（tool_use / vision / contextWindow / protocol）
  const hardBlock = hardConstraintBlock(candidate, task, protocol);
  if (hardBlock) {
    return { score: 0, reasons, blocked: hardBlock };
  }

  // 2. 能力匹配分（已通过硬约束 → 需求必满足，加分）
  let capScore = 0.5;
  const caps = candidate.capabilities || [];
  if (task?.needsToolUse && caps.includes('tool_use')) {
    capScore = 1.0;
    reasons.push('has tool_use (required)');
  }
  if (task?.needsVision && caps.includes('vision')) {
    capScore = Math.min(1, capScore + 0.3);
    reasons.push('has vision (required)');
  }

  // 3. tier 分
  const tierRank = { tier1: 1.0, tier2: 0.7, tier3: 0.4 };
  const tierScore = tierRank[candidate.tier] ?? 0.5;
  if (policy.tierPreference) reasons.push(`tier=${candidate.tier}`);

  // 4. 付费分
  let paidScore = candidate.paid ? 1 - policy.paidPenalty : 1.0;
  if (candidate.paid) reasons.push('paid model penalty');
  else if (policy.preferFree) reasons.push('free model preferred');

  // 5. 成本分（price 越低越高；无价格视为免费）
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

// ----------------------------------------------------------------------------
// 预测
// ----------------------------------------------------------------------------

/**
 * 预估单次请求成本（每个候选按自己的 price 计算；无价格 → 0 免费）。
 */
export function estimateCost(candidate, task) {
  const price = candidate?.price || {};
  const inCost = price.input_cost_per_1k || 0;
  const outCost = price.output_cost_per_1k || 0;
  if (inCost <= 0 && outCost <= 0) return 0;
  const inTokens = task?.estimatedInputTokens || 1000;
  const outTokens = Math.ceil((task?.complexity || 0.3) * 800) + 100;
  const cost = (inTokens / 1000) * inCost + (outTokens / 1000) * outCost;
  return Number(cost.toFixed(8));
}

// 确定性延迟先验（无 Math.random()）
const TIER_LATENCY_BASE = { tier1: 1200, tier2: 1800, tier3: 2400 };
const PROVIDER_LATENCY_OFFSET = {
  modelscope: 0,
  gateway: 0,
  mock: 0,
  internlm: 200,
};
const MODEL_LATENCY_OVERRIDE = {
  'gateway-auto': 1500,
};

/**
 * 预测延迟（毫秒）——确定性：相同输入、相同状态 → 相同输出。
 */
export function predictLatency(candidate) {
  const base = TIER_LATENCY_BASE[candidate?.tier] ?? 1500;
  const providerOffset = PROVIDER_LATENCY_OFFSET[candidate?.provider] ?? 150;
  const modelOverride = candidate?.modelId ? MODEL_LATENCY_OVERRIDE[candidate.modelId] : undefined;
  return modelOverride ?? base + providerOffset;
}

/**
 * 预测质量（0-1）——仅在候选通过硬约束后调用；上限 0.95（不输出 1.0）。
 */
export function predictQuality(candidate, task) {
  const tierRank = { tier1: 0.95, tier2: 0.85, tier3: 0.7 };
  const base = tierRank[candidate?.tier] ?? 0.8;
  const complexity = task?.complexity || 0.3;
  const boost = complexity > 0.7 ? 0.03 : complexity < 0.3 ? -0.03 : 0;
  return Number(Math.min(0.95, Math.max(0.4, base + boost)).toFixed(3));
}

export default {
  normalizePolicy,
  hardConstraintBlock,
  scoreCandidate,
  estimateCost,
  predictQuality,
  predictLatency,
  DEFAULT_POLICY,
};
