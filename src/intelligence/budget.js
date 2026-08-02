// src/intelligence/budget.js
// Smart Router Mainline - Phase 2-A (Shadow)
// 基础 Budget：Shadow 版预算评估。
//
// 与 Phase1 的 CostTracker（硬性安全闸门）互补：
//   - Phase1 CostTracker：生产执行时硬性拦截（budget_exceeded）
//   - Phase2 Budget：Shadow 评估「请求的预算画像」（预估成本、付费状态、allowed 检查、
//     日度预算占用预测），仅供智能建议与记录，不拦截执行
//
// Shadow 约束：只读配置 + 纯本地计算。
//
// 仅使用 Node.js 内置模块，无第三方依赖。

// ----------------------------------------------------------------------------
// 预算画像
// ----------------------------------------------------------------------------

/**
 * 评估请求的预算画像（Shadow）。
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.requestedModel 请求的模型（可为 null）
 * @param {object} params.task 任务画像
 * @param {object} params.candidates 候选列表（含 paid / price / provider）
 * @param {object} params.config 配置（含 budget / agent_bindings）
 * @returns {{
 *   agentId: string,
 *   allowPaid: boolean,
 *   maxRequestCost: number,
 *   allowedModels: string[],
 *   allowedProviders: string[],
 *   strictModel: boolean,
 *   estimatedCost: number|null,
 *   paidCandidates: number,
 *   freeCandidates: number,
 *   wouldBlockAll: boolean,   // 预算是否会阻止所有候选（Shadow 评估）
 *   reasons: string[]
 * }}
 */
export function evaluateBudget({ agentId, requestedModel, task, candidates, config }) {
  const reasons = [];
  const agentBinding = config?.agent_bindings?.[agentId] || null;
  const agentBudget = agentBinding?.budget || {};
  const globalBudget = config?.budget || {};

  const allowPaid =
    typeof agentBudget.allowPaid === 'boolean'
      ? agentBudget.allowPaid
      : typeof globalBudget.allowPaid === 'boolean'
        ? globalBudget.allowPaid
        : true;
  const maxRequestCost =
    typeof agentBudget.maxRequestCost === 'number'
      ? agentBudget.maxRequestCost
      : typeof globalBudget.maxRequestCost === 'number'
        ? globalBudget.maxRequestCost
        : Infinity;
  const allowedModels =
    Array.isArray(agentBudget.allowedModels) && agentBudget.allowedModels.length > 0
      ? agentBudget.allowedModels
      : Array.isArray(globalBudget.allowedModels)
        ? globalBudget.allowedModels
        : [];
  const allowedProviders =
    Array.isArray(agentBudget.allowedProviders) && agentBudget.allowedProviders.length > 0
      ? agentBudget.allowedProviders
      : Array.isArray(globalBudget.allowedProviders)
        ? globalBudget.allowedProviders
        : [];
  const strictModel =
    typeof agentBudget.strictModel === 'boolean'
      ? agentBudget.strictModel
      : typeof globalBudget.strictModel === 'boolean'
        ? globalBudget.strictModel
        : false;

  const list = Array.isArray(candidates) ? candidates : [];
  const paidCandidates = list.filter((c) => c.paid).length;
  const freeCandidates = list.length - paidCandidates;

  // 预估成本：取候选中最便宜的付费价（若全免费则 0）
  let estimatedCost = null;
  const priced = list.filter((c) => c.price && ((c.price.input_cost_per_1k || 0) > 0 || (c.price.output_cost_per_1k || 0) > 0));
  if (priced.length > 0) {
    const est = list.map((c) => {
      const price = c.price || {};
      const inTokens = task?.estimatedInputTokens || 1000;
      const outTokens = Math.ceil((task?.complexity || 0.3) * 800) + 100;
      return (inTokens / 1000) * (price.input_cost_per_1k || 0)
        + (outTokens / 1000) * (price.output_cost_per_1k || 0);
    });
    estimatedCost = Math.min(...est);
  }

  // 预算是否会阻止所有候选
  let wouldBlockAll = false;
  const blockReasons = [];
  if (!allowPaid && paidCandidates === list.length && list.length > 0) {
    wouldBlockAll = true;
    blockReasons.push('all candidates paid and allowPaid=false');
  }
  if (allowedModels.length > 0 && list.length > 0
    && !list.some((c) => allowedModels.includes(c.modelId))) {
    wouldBlockAll = true;
    blockReasons.push('no candidate in allowedModels');
  }
  if (allowedProviders.length > 0 && list.length > 0
    && !list.some((c) => allowedProviders.includes(c.provider))) {
    wouldBlockAll = true;
    blockReasons.push('no candidate in allowedProviders');
  }
  if (wouldBlockAll) reasons.push(...blockReasons);

  return {
    agentId,
    allowPaid,
    maxRequestCost,
    allowedModels,
    allowedProviders,
    strictModel,
    estimatedCost,
    paidCandidates,
    freeCandidates,
    wouldBlockAll,
    reasons,
  };
}

export default { evaluateBudget };
