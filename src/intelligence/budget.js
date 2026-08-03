// src/intelligence/budget.js
// Smart Router Mainline - Phase 2-B (Active Readiness)
// Budget：Shadow 预算评估（与 Policy.budgetBlock 保持一致）。
//
// 修复：
//   - budgetAssessment.estimatedCost：用标准化候选画像的 price 分别计算，
//     取「通过能力硬约束的候选」中最便宜者（不再取错误顶层字段）
//   - wouldBlockAll：若全部候选被预算阻止（含 request_cost_exceeded）→ true
//   - maxRequestCost：每个候选先算自己的 estimatedCost，超限即 blocked
//
// Shadow 约束：只读配置 + 纯本地计算，不拦截执行（Phase1 CostTracker 负责真实拦截）。
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { budgetBlock, estimateCost } from './policy.js';

/**
 * 评估请求的预算画像（Shadow）。
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.requestedModel
 * @param {object} params.task 任务画像（含 estimatedInputTokens / complexity）
 * @param {object[]} params.candidates 标准化候选画像列表（含 price/paid/modelId/provider）
 * @param {object} params.config 配置（含 budget / agent_bindings）
 * @returns {{
 *   agentId, allowPaid, maxRequestCost, allowedModels, allowedProviders, strictModel,
 *   estimatedCost, paidCandidates, freeCandidates, wouldBlockAll, reasons, blockedCandidates
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
  const budget = { allowPaid, maxRequestCost, allowedModels, allowedProviders, strictModel };
  const paidCandidates = list.filter((c) => c.paid).length;
  const freeCandidates = list.length - paidCandidates;

  // 每个候选计算自己的预算状态（与 Policy.budgetBlock 一致）
  let estimatedCost = null;
  let wouldBlockAll = false;
  const blockedCandidates = [];
  let anyBudgetBlock = false;
  let anyCandidate = false;

  for (const c of list) {
    anyCandidate = true;
    const block = budgetBlock(c, task, budget);
    if (block) {
      blockedCandidates.push({ modelId: c.modelId, provider: c.provider, reason: block });
      if (block.startsWith('request_cost_exceeded')) anyBudgetBlock = true;
    } else {
      const cost = estimateCost(c, task);
      if (estimatedCost === null || cost < estimatedCost) estimatedCost = cost;
    }
  }

  if (anyCandidate && list.length > 0) {
    if (blockedCandidates.length === list.length) {
      wouldBlockAll = true;
      if (anyBudgetBlock) reasons.push('all candidates exceed maxRequestCost');
      else if (!allowPaid && paidCandidates === list.length) reasons.push('all candidates paid and allowPaid=false');
      else if (allowedModels.length > 0) reasons.push('no candidate in allowedModels');
      else if (allowedProviders.length > 0) reasons.push('no candidate in allowedProviders');
      else reasons.push('all candidates blocked by budget');
    } else if (blockedCandidates.length > 0) {
      reasons.push(`${blockedCandidates.length}/${list.length} candidates blocked by budget`);
    }
  }

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
    blockedCandidates,
    reasons,
  };
}

export default { evaluateBudget };
