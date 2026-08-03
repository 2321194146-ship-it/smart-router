// src/intelligence/policy.js
// Smart Router Mainline - Phase 2-B (Active Readiness)
// Policy：候选评分与硬约束（Shadow 版）。
//
// 硬约束（blocked，不是普通评分项）：
//   - 请求 stream=true 而模型无 streaming → blocked（streaming 硬性）
//   - 任务需要 tool_use 而模型不支持 → blocked
//   - 任务需要 vision 而模型不支持 → blocked
//   - 输入上下文超过模型 contextWindow → blocked
//   - 协议无法 native/adapter 兼容 → blocked
//   - estimatedCost > maxRequestCost → blocked = request_cost_exceeded（默认无审批，必须阻止）
//
// 软能力匹配分：按 requiredCapabilities 需求强度 × 模型能力分计算匹配度。
//
// 预测（确定性）：
//   - 成本：每个候选按自己的 price 计算
//   - 延迟：latencyPriorMs > 静态先验 > ProviderHealth 历史均值（仅样本充足时）
//   - 质量：能力匹配 + tier + reliability，不把 tier 当作唯一质量替代品
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { CAPABILITY_KEYS, HARD_CAPABILITY_KEYS, SOFT_CAPABILITY_KEYS } from './task-analyzer.js';

const DEFAULT_POLICY = Object.freeze({
  tierPreference: true,
  preferFree: true,
  costWeight: 0.32,
  capabilityWeight: 0.55, // 能力匹配为主导（不把 tier 当作质量替代品）
  tierWeight: 0.06,
  paidPenalty: 0.2,
  reliabilityWeight: 0.08,
  // Phase2-C：二元能力判定阈值（0-1，默认 0.9，vision=95 视为支持）
  binaryThreshold: 0.9,
  // Phase2-C：等级软能力显式安全阈值（0 = 不启用；>0 且需求=1.0 且低于阈值 → blocked）
  gradedSafetyThreshold: 0,
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
    reliabilityWeight: typeof p.reliabilityWeight === 'number' ? p.reliabilityWeight : DEFAULT_POLICY.reliabilityWeight,
    binaryThreshold: typeof p.binaryThreshold === 'number' ? p.binaryThreshold : DEFAULT_POLICY.binaryThreshold,
    gradedSafetyThreshold: typeof p.gradedSafetyThreshold === 'number' ? p.gradedSafetyThreshold : DEFAULT_POLICY.gradedSafetyThreshold,
  };
}

// ----------------------------------------------------------------------------
// 硬约束
// ----------------------------------------------------------------------------

/**
 * 硬性能力检查（含 streaming 硬性）。返回 blocked 原因或 null。
 *
 * @param {object} candidate 标准化画像（含 capabilities 对象）
 * @param {object} task 任务画像（含 requiredCapabilities / hardCapabilities）
 * @param {string|null} protocol 请求协议
 * @returns {string|null}
 */
export function hardConstraintBlock(candidate, task, protocol, thresholds = null) {
  const binaryTh = thresholds && typeof thresholds.binary === 'number' ? thresholds.binary : 0.9;
  const gradedTh = thresholds && typeof thresholds.graded === 'number' ? thresholds.graded : 0;
  const caps = candidate?.capabilities || {};
  const blocks = [];

  // Phase2-C：二元硬能力（仅 HARD_CAPABILITY_KEYS：streaming/vision/tool_use/structured_output）。
  // 需求>=1.0 且模型能力分 < binaryThreshold（默认 0.9）→ blocked。
  // chat/coding/reasoning 等等级能力即使需求=1.0 也不会出现在这里（analyzeTask 已过滤）。
  const hard = Array.isArray(task?.hardCapabilities) ? task.hardCapabilities : [];
  for (const k of hard) {
    if (!HARD_CAPABILITY_KEYS.includes(k)) continue; // 等级能力跳过硬性判定
    if ((caps[k] || 0) < binaryTh) {
      blocks.push(`missing ${k} (required)`);
    }
  }
  // 兼容旧字段（task.needsToolUse / needsVision / needsStreaming）
  if (task?.needsToolUse && (caps.tool_use || 0) < binaryTh) blocks.push('missing tool_use (required)');
  if (task?.needsVision && (caps.vision || 0) < binaryTh) blocks.push('missing vision (required)');
  if (task?.needsStreaming && (caps.streaming || 0) < binaryTh) blocks.push('missing streaming (required)');
  if (task?.needsStructuredOutput && (caps.structured_output || 0) < binaryTh) {
    blocks.push('missing structured_output (required)');
  }
  // 等级软能力：仅显式安全阈值阻断（gradedSafetyThreshold > 0 才生效；默认 0 = 不阻断）
  if (gradedTh > 0) {
    const req = task?.requiredCapabilities || {};
    for (const k of SOFT_CAPABILITY_KEYS) {
      if ((req[k] || 0) >= 1.0 && (caps[k] || 0) < gradedTh) {
        blocks.push(`missing ${k} (below safety threshold ${gradedTh})`);
      }
    }
  }
  // 上下文窗口溢出（contextWindow 硬约束）：
  // Phase2-C 优先用 input+output 总量（含安全余量）；未提供时回退 input。
  const estCtxTokens = task?.estimatedTotalTokens || task?.estimatedInputTokens;
  if (estCtxTokens && candidate?.contextWindow && estCtxTokens > candidate.contextWindow) {
    blocks.push(`input tokens ${estCtxTokens} > contextWindow ${candidate.contextWindow}`);
  }
  // 协议兼容
  if (protocol) {
    const protocols = Array.isArray(candidate?.protocols) ? candidate.protocols : [];
    if (!protocols.includes(protocol)) {
      blocks.push(`protocol "${protocol}" not supported`);
    }
  }
  return blocks.length > 0 ? blocks.join('; ') : null;
}

/**
 * 预算硬约束：estimatedCost > maxRequestCost → request_cost_exceeded。
 * @param {object} candidate 标准化画像（含 price）
 * @param {object} task 任务画像
 * @param {object} budget 生效预算
 * @returns {string|null}
 */
export function budgetBlock(candidate, task, budget) {
  if (!budget) return null;
  if (budget.allowPaid === false && candidate.paid) return 'paid model blocked by allowPaid=false';
  if (Array.isArray(budget.allowedModels) && budget.allowedModels.length > 0
    && !budget.allowedModels.includes(candidate.modelId)) {
    return `model "${candidate.modelId}" not in allowedModels`;
  }
  if (Array.isArray(budget.allowedProviders) && budget.allowedProviders.length > 0
    && !budget.allowedProviders.includes(candidate.provider)) {
    return `provider "${candidate.provider}" not in allowedProviders`;
  }
  if (typeof budget.maxRequestCost === 'number' && Number.isFinite(budget.maxRequestCost)) {
    const estCost = estimateCost(candidate, task);
    if (estCost > budget.maxRequestCost) {
      return `request_cost_exceeded (estimated ${estCost.toFixed(6)} > maxRequestCost ${budget.maxRequestCost})`;
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// 评分
// ----------------------------------------------------------------------------

/**
 * 对单个标准化候选评分（0-1）。
 * 硬约束被阻止 → score=0 + blocked。
 *
 * 评分分量：
 *   - 能力匹配（requiredCapabilities × capabilities，按需求强度加权）
 *   - tier（低权重，不当作唯一质量替代品）
 *   - 付费
 *   - 成本（越低越高）
 *   - Provider 可靠性（reliability 配置 + 健康统计）
 *
 * @param {object} candidate 标准化画像
 * @param {object} task 任务画像
 * @param {object} policy 规范化策略
 * @param {object} budget 生效预算
 * @param {string|null} protocol 请求协议
 * @param {object} [health] Provider 健康统计 { status, failureRate, avgLatency, sampleCount }
 * @returns {{ score: number, reasons: string[], blocked: string|null }}
 */
export function scoreCandidate(candidate, task, policy, budget, protocol, health = null) {
  const reasons = [];

  // 0. 预算硬约束
  const budgetBlocked = budgetBlock(candidate, task, budget);
  if (budgetBlocked) {
    return { score: 0, reasons, blocked: budgetBlocked };
  }

  // 1. 硬性能力约束（仅二元能力 + contextWindow/protocol；阈值可配置）
  const hardBlock = hardConstraintBlock(candidate, task, protocol, {
    binary: policy.binaryThreshold ?? 0.9,
    graded: policy.gradedSafetyThreshold ?? 0,
  });
  if (hardBlock) {
    return { score: 0, reasons, blocked: hardBlock };
  }

  // 2. 能力匹配分：需求强度 × 模型能力（软能力按 0-1 匹配）
  //    强需求（need>=0.7）模型能力明显不足（have < need*0.5）→ 额外惩罚
  const req = task?.requiredCapabilities || {};
  const caps = candidate.capabilities || {};
  let capScore = 0;
  let capWeightSum = 0;
  let weakHardNeeds = 0;
  for (const k of CAPABILITY_KEYS) {
    const need = req[k] || 0;
    if (need <= 0) continue;
    const have = caps[k] || 0;
    capScore += need * Math.min(1, have / Math.max(need, 0.01));
    capWeightSum += need;
    if (need >= 0.7 && have < need * 0.5) weakHardNeeds++;
  }
  capScore = capWeightSum > 0 ? capScore / capWeightSum : 0.5;
  capScore *= Math.pow(0.75, weakHardNeeds);
  if (task?.needsToolUse && (caps.tool_use || 0) >= 1.0) reasons.push('has tool_use (required)');
  if (task?.needsVision && (caps.vision || 0) >= 1.0) reasons.push('has vision (required)');
  if (task?.needsStreaming && (caps.streaming || 0) >= 1.0) reasons.push('has streaming (required)');
  if ((req.reasoning || 0) > 0.5 && (caps.reasoning || 0) >= 1.0) reasons.push('has reasoning');
  if ((req.coding || 0) > 0.5 && (caps.coding || 0) >= 1.0) reasons.push('has coding');

  // 3. tier 分（低权重，不当作唯一质量替代品）
  //    Phase2-C：tierPreference=false → tier 权重置 0（tier 不参与排序）
  const tierRank = { tier1: 1.0, tier2: 0.7, tier3: 0.4 };
  const tierScore = tierRank[candidate.tier] ?? 0.5;
  const tierWeightEff = policy.tierPreference ? policy.tierWeight : 0;

  // 4. 付费分
  //    Phase2-C：preferFree=false → 免费/付费无差别（paidPenalty 不生效）
  const paidScore = candidate.paid && policy.preferFree ? 1 - policy.paidPenalty : 1.0;

  // 5. 成本分（复杂任务降低成本权重，简单任务成本优先）
  const complexityEff = typeof task?.complexity === 'number' ? task.complexity : 0.3;
  const costWeightEff = policy.costWeight * (1 - 0.4 * complexityEff);
  let costScore = 0.5;
  const price = candidate.price || {};
  const inCost = price.input_cost_per_1k || 0;
  const outCost = price.output_cost_per_1k || 0;
  if (inCost > 0 || outCost > 0) {
    costScore = Math.max(0, 1 - (inCost + outCost * 3) / 0.05);
    costScore = Number(costScore.toFixed(3));
  }
  // Phase2-C：preferFree=true → 免费候选成本分下限提升。
  // 仅当任务【无强 soft 需求】（coding/reasoning 需求 < 0.7）时生效 —— "质量达标后优先免费"：
  // 复杂推理/编码任务仍以能力为主，不允许免费奖励压过明显的能力差距。
  const reqCaps = task?.requiredCapabilities || {};
  const strongSoftNeed = SOFT_CAPABILITY_KEYS.some((k) => k !== 'chat' && (reqCaps[k] || 0) >= 0.7);
  if (policy.preferFree && !candidate.paid && !strongSoftNeed) costScore = Math.max(costScore, 0.6);

  // 6. Provider 可靠性分（配置 reliability + 健康统计）
  let relScore = 0.7;
  if (typeof candidate.reliability === 'number' && candidate.reliability > 0) {
    relScore = 0.5 + candidate.reliability * 0.5;
  }
  if (health) {
    const samples = health.sampleCount || 0;
    if (samples >= 5) {
      // 样本充足：成功率 + 状态降分
      const failureRate = health.failureRate ?? 0;
      relScore = Math.min(relScore, 0.7 + (1 - failureRate) * 0.3);
      if (health.status === 'degraded') relScore -= 0.15;
      if (health.status === 'down') relScore -= 0.4;
    }
    // 样本不足（<5）：只用静态先验，不剧烈调整
  }
  relScore = Number(Math.min(1, Math.max(0.1, relScore)).toFixed(3));

  // Phase2-C：权重归一化（避免配置调整导致总分失衡）
  const wSum =
    policy.capabilityWeight + tierWeightEff + 0.1 + costWeightEff + policy.reliabilityWeight;
  const wNorm = wSum > 0 ? 1 / wSum : 1;

  const total =
    (capScore * policy.capabilityWeight +
      tierScore * tierWeightEff +
      paidScore * 0.1 +
      costScore * costWeightEff +
      relScore * policy.reliabilityWeight) * wNorm;
  const score = Math.min(1, Math.max(0, total));

  return {
    score: Number(score.toFixed(3)),
    reasons,
    blocked: null,
    tiebreak: {
      tier: tierRank[candidate.tier] ?? 0.5,
      capability: capScore,
      reliability: relScore,
      cost: costScore,
      latency: candidate.latencyPriorMs || 0,
      phase1Order: candidate._phase1Index ?? 0,
    },
  };
}

/**
 * Phase2-C：确定性 Tie-Breaker（用于推荐选择，保持可复现）。
 * 顺序：分数 → tier → capability → reliability → cost → latency → Phase1 顺序。
 * 输入 ranked 项需含 score 与 tiebreak 元数据。
 */
export function pickBest(ranked) {
  const list = Array.isArray(ranked) ? ranked.filter((r) => !r.blocked) : [];
  if (list.length === 0) return null;
  let best = list[0];
  for (const r of list) {
    if (compareTiebreak(r, best) < 0) best = r;
  }
  return best;
}

function compareTiebreak(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  const ta = a.tiebreak || {};
  const tb = b.tiebreak || {};
  // 用户指定顺序（Phase2-C 第6节）：capability → reliability → cost → latency → Phase1 order
  const capA = ta.capability ?? 0;
  const capB = tb.capability ?? 0;
  if (capA !== capB) return capB - capA;
  if (ta.reliability !== tb.reliability) return tb.reliability - ta.reliability;
  if (ta.cost !== tb.cost) return ta.cost - tb.cost;
  if (ta.latency !== tb.latency) return ta.latency - tb.latency;
  return (ta.phase1Order ?? 0) - (tb.phase1Order ?? 0);
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

const TIER_LATENCY_BASE = { tier1: 1200, tier2: 1800, tier3: 2400 };
const PROVIDER_LATENCY_OFFSET = { modelscope: 0, gateway: 0, mock: 0, internlm: 200 };

/**
 * 预测延迟（毫秒）——确定性优先：latencyPriorMs > 静态先验 > 健康历史均值。
 * @param {object} candidate 标准化画像
 * @param {object|null} [health] 健康统计 { avgLatency, sampleCount }
 */
export function predictLatency(candidate, health = null) {
  if (typeof candidate?.latencyPriorMs === 'number' && candidate.latencyPriorMs > 0) {
    return candidate.latencyPriorMs;
  }
  const base = TIER_LATENCY_BASE[candidate?.tier] ?? 1500;
  const providerOffset = PROVIDER_LATENCY_OFFSET[candidate?.provider] ?? 150;
  const prior = base + providerOffset;
  if (health && (health.sampleCount || 0) >= 5 && typeof health.avgLatency === 'number' && health.avgLatency > 0) {
    return Math.round((prior + health.avgLatency) / 2);
  }
  return prior;
}

/**
 * 预测质量（0-1）——能力匹配 + tier + reliability；仅在通过硬约束后调用；上限 0.95。
 */
export function predictQuality(candidate, task) {
  const tierRank = { tier1: 0.95, tier2: 0.85, tier3: 0.7 };
  const tierBase = tierRank[candidate?.tier] ?? 0.8;
  // 能力匹配为主（0.6）、tier 为辅（0.4）：复杂任务缺失所需能力显著降分，
  // 不以 tier 当作唯一质量替代品
  const req = task?.requiredCapabilities || {};
  const caps = candidate?.capabilities || {};
  const needKeys = CAPABILITY_KEYS.filter((k) => (req[k] || 0) > 0.5);
  let capQuality = 1.0;
  if (needKeys.length > 0) {
    capQuality = needKeys.reduce((s, k) => s + (caps[k] || 0), 0) / needKeys.length;
  }
  const relBoost = ((candidate?.reliability || 0) - 0.6) * 0.05;
  const raw = tierBase * 0.4 + capQuality * 0.6 + relBoost;
  return Number(Math.min(0.95, Math.max(0.4, raw)).toFixed(3));
}

export default {
  normalizePolicy,
  hardConstraintBlock,
  budgetBlock,
  scoreCandidate,
  pickBest,
  estimateCost,
  predictQuality,
  predictLatency,
  DEFAULT_POLICY,
};
