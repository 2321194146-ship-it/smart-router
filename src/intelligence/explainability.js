// src/intelligence/explainability.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Explainability：为智能决策生成机器可读的解释。
//
// 每条解释包含：
//   - choice：被选中的模型（建议）
//   - score：评分
//   - reasons：选择原因（策略/能力/成本/tier）
//   - eliminated：被淘汰候选及淘汰原因
//   - prediction：成本/质量/延迟预测
//   - summary：自然语言摘要（结构化模板，非 LLM 生成）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

/**
 * 将决策结果转为可解释记录。
 *
 * @param {object} decision Decision Engine 输出
 *   - recommendation { modelId, provider, score }
 *   - ranked { modelId, provider, score, reasons, blocked }[]
 *   - predictions { cost, quality, latency }
 * @returns {object} 解释记录
 */
export function explainDecision(decision) {
  const rec = decision?.recommendation || null;
  const ranked = Array.isArray(decision?.ranked) ? decision.ranked : [];
  const predictions = decision?.predictions || {};

  const eliminated = ranked
    .filter((r) => r.modelId !== rec?.modelId)
    .map((r) => ({
      modelId: r.modelId,
      provider: r.provider,
      score: r.score,
      reason: r.blocked || (r.score < (rec?.score || 0) ? `lower score (${r.score}) than recommendation (${rec.score})` : 'not selected'),
    }));

  const summaryParts = [];
  if (rec) {
    summaryParts.push(`推荐 ${rec.provider}/${rec.modelId}（score=${rec.score}）`);
  } else {
    summaryParts.push('无推荐（所有候选被预算/策略淘汰）');
  }
  if (predictions.cost !== undefined && predictions.cost !== null) {
    summaryParts.push(`预估成本 ${predictions.cost}`);
  }
  if (predictions.quality !== undefined) {
    summaryParts.push(`预估质量 ${predictions.quality}`);
  }
  if (predictions.latency !== undefined) {
    summaryParts.push(`预估延迟 ${predictions.latency}ms`);
  }
  if (eliminated.length > 0) {
    summaryParts.push(`淘汰 ${eliminated.length} 个候选`);
  }

  return {
    recommendation: rec,
    predictions,
    eliminated,
    summary: summaryParts.join('；'),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 生成人类可读的淘汰原因（供报告与展示）。
 * @param {string} modelId
 * @param {object} elimination
 * @returns {string}
 */
export function formatEliminationReason(modelId, elimination) {
  if (!elimination) return '';
  if (elimination.reason) return `淘汰 ${modelId}: ${elimination.reason}`;
  return `淘汰 ${modelId}`;
}

export default { explainDecision, formatEliminationReason };
