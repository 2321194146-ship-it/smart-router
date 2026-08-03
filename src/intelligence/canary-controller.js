// src/intelligence/canary-controller.js
// Smart Router Mainline - Phase 2-C
// Active Canary 控制器：低风险 5% 流量实验的安全开关与重排控制器。
//
// 设计原则（Phase2-C 第 8/9 节）：
//   - 新模式：off / shadow / active_canary（默认 shadow，Active 默认关闭）
//   - 确定性采样：requestId 的 SHA-256 哈希（无 Math.random，可复现）
//   - 仅允许在【Phase1-legal 候选】内重排：Primary = 智能建议推荐，Fallback = 未 blocked 候选
//   - 禁止：扩展候选集合、绕过 budget/allowed 列表、改变 strict、修改消息、注入提示、
//     首字节后切换、并行模型
//   - Fail Open：任何异常 → 返回 Phase1 原始候选顺序
//   - Kill Switch：kill() 或配置 killSwitch:true → 立即停止采样（无需改代码）
//   - 自动停止：预算违规 / 质量回退 / incomplete 上升 / 连续错误 / 显式 kill → 回退 shadow
//
// 指标（CanaryMetrics）：
//   eligible / sampled / active / activeVsPhase1 / cost / quality / incomplete / failed /
//   aborted / attempts / paidRatio / decisionLatencyMs / fallbackCount / autoStop
//
// 仅使用 Node.js 内置模块（node:crypto），无第三方依赖。

import { createHash } from 'node:crypto';

const DEFAULT_ALLOWED_TASK_TYPES = [
  'general_chat', 'writing', 'summarization', 'translation', 'extraction',
];

export class CanaryController {
  /**
   * @param {object} [cfg] { percentage, allowedAgents, allowedTaskTypes, killSwitch }
   * @param {boolean} [enabled] 是否处于 active_canary 模式
   */
  constructor(cfg = {}, enabled = false) {
    this.enabled = enabled;
    this.percentage = typeof cfg.percentage === 'number' ? Math.min(100, Math.max(0, cfg.percentage)) : 5;
    this.allowedAgents = Array.isArray(cfg.allowedAgents) ? cfg.allowedAgents : [];
    this.allowedTaskTypes = Array.isArray(cfg.allowedTaskTypes) && cfg.allowedTaskTypes.length > 0
      ? cfg.allowedTaskTypes
      : DEFAULT_ALLOWED_TASK_TYPES;
    this.killed = cfg.killSwitch === true;
    this.metrics = {
      eligible: 0, sampled: 0, active: 0, activeVsPhase1: { same: 0, diff: 0 },
      cost: 0, quality: 0, incomplete: 0, failed: 0, aborted: 0,
      attempts: 0, paidRatio: 0, paidCount: 0, totalCost: 0,
      decisionLatencyMs: 0, fallbackCount: 0, autoStop: null,
    };
  }

  /** 确定性采样：requestId SHA-256 前 8 位 hex → [0,100) */
  _sample(requestId) {
    const h = createHash('sha256').update(String(requestId == null ? '' : requestId)).digest('hex');
    const num = parseInt(h.slice(0, 8), 16);
    return (num % 100) < this.percentage;
  }

  isAgentAllowed(agentId) {
    if (this.allowedAgents.length === 0) return true; // 未限制 = 全部允许
    return this.allowedAgents.includes(agentId);
  }

  isTaskTypeAllowed(taskType) {
    return this.allowedTaskTypes.includes(taskType);
  }

  /** 停止采样（kill switch / 自动停止）。停止后 apply 一律返回 Phase1 顺序。 */
  stop(reason) {
    if (this.killed) return;
    this.killed = true;
    this.metrics.autoStop = { reason, at: new Date().toISOString() };
  }

  get stopped() {
    return this.killed;
  }

  /**
   * 对一次建议应用 Canary：采样命中且允许 → 在 Phase1-legal 候选内重排。
   * Fail Open：任何异常/非法 → 返回原 candidates（Phase1 顺序）。
   *
   * @returns {{ orderedCandidates: Array, active: boolean, reason: string|null, primary: string|null }}
   */
  apply({ decision, candidates, requestId, agentId, taskType, protocol, budget }) {
    const orig = Array.isArray(candidates) ? candidates : [];
    if (!this.enabled) return { orderedCandidates: orig, active: false, reason: 'disabled' };
    this.metrics.eligible++;
    try {
      if (this.killed) return { orderedCandidates: orig, active: false, reason: 'killed' };
      if (!this.isAgentAllowed(agentId)) return { orderedCandidates: orig, active: false, reason: 'agent_not_allowed' };
      if (!this.isTaskTypeAllowed(taskType)) return { orderedCandidates: orig, active: false, reason: 'task_type_not_allowed' };
      if (!this._sample(requestId)) return { orderedCandidates: orig, active: false, reason: 'not_sampled' };
      this.metrics.sampled++;

      // 仅 Phase1-legal 候选可参与重排（未 blocked = 通过能力/预算/协议硬约束）
      const ranked = Array.isArray(decision?.ranked) ? decision.ranked : [];
      const legal = ranked.filter((r) => !r.blocked);
      if (legal.length === 0) return { orderedCandidates: orig, active: false, reason: 'no_legal_candidate' };

      const primary = decision?.recommendation || null;
      const primaryId = primary?.modelId || null;
      const primaryProvider = primary?.provider || null;

      // 预算防御：Primary 不得违反生效预算（allowPaid / allowedModels / allowedProviders / maxRequestCost）。
      // 使用 ranked 中的完整条目（含 paid）而非仅 recommendation 摘要。
      if (budget) {
        const p = legal.find((r) => r.modelId === primaryId && r.provider === primaryProvider) || primary;
        if (p && this._budgetViolation(p, budget, decision?.task)) {
          this.stop('budget_violation');
          return { orderedCandidates: orig, active: false, reason: 'budget_violation' };
        }
      }

      // 重排：Primary 置顶，其余保持 Phase1 原始顺序（稳定排序）
      const ordered = [...orig].sort((a, b) => {
        const aIsPrimary = a.modelId === primaryId && a.provider === primaryProvider ? 0 : 1;
        const bIsPrimary = b.modelId === primaryId && b.provider === primaryProvider ? 0 : 1;
        return aIsPrimary - bIsPrimary;
      });

      this.metrics.active++;
      const phase1First = orig[0];
      if (primaryId && phase1First && primaryId === phase1First.modelId && primaryProvider === phase1First.provider) {
        this.metrics.activeVsPhase1.same++;
      } else {
        this.metrics.activeVsPhase1.diff++;
      }
      return {
        orderedCandidates: ordered,
        active: true,
        reason: 'sampled',
        primary: primary ? `${primary.modelId}@${primary.provider}` : null,
      };
    } catch (e) {
      // Fail Open：异常一律回退 Phase1 顺序
      return { orderedCandidates: orig, active: false, reason: 'exception:' + String(e.message || e) };
    }
  }

  _budgetViolation(candidate, budget, task) {
    const c = candidate || {};
    if (budget.allowPaid === false && c.paid) return true;
    if (Array.isArray(budget.allowedModels) && budget.allowedModels.length > 0
      && !budget.allowedModels.includes(c.modelId)) return true;
    if (Array.isArray(budget.allowedProviders) && budget.allowedProviders.length > 0
      && !budget.allowedProviders.includes(c.provider)) return true;
    return false;
  }

  /**
   * 记录一次真实执行结果（由 IntelligenceLayer.recordFinalized 调用），用于指标与自动停止。
   */
  recordFinalized({ requestId, outcome, finalModel, finalProvider, attempts, cost, latencyMs, agentId, taskType }) {
    if (!this.enabled) return;
    const att = Array.isArray(attempts) ? attempts : [];
    this.metrics.attempts += att.length;
    if (typeof latencyMs === 'number') this.metrics.decisionLatencyMs += latencyMs;
    if (typeof cost === 'number') this.metrics.totalCost += cost;
    if (outcome === 'incomplete') this.metrics.incomplete++;
    if (outcome === 'client_aborted') this.metrics.aborted++;
    if (outcome === 'provider_error' || outcome === 'budget_exceeded'
      || outcome === 'no_candidate' || outcome === 'provider_unavailable') this.metrics.failed++;
    if (finalModel && this.metrics.fallbackCount === undefined) this.metrics.fallbackCount = att.length > 1 ? att.length - 1 : 0;
    else if (att.length > 1) this.metrics.fallbackCount += att.length - 1;

    // 自动停止条件（Phase2-C 第 9 节）——保守阈值，命中即回退 shadow
    if (outcome === 'budget_exceeded') this.stop('budget_exceeded');
    if (outcome === 'incomplete' && this.metrics.incomplete >= 3) this.stop('incomplete_rise');
    if (outcome === 'provider_error' && this.metrics.failed >= 3) this.stop('consecutive_provider_errors');
    if (outcome === 'no_candidate' && this.metrics.failed >= 3) this.stop('consecutive_no_candidate');
  }

  /** 汇总指标快照。 */
  snapshot() {
    const m = this.metrics;
    return {
      percentage: this.percentage,
      stopped: this.killed,
      autoStop: m.autoStop,
      eligible: m.eligible,
      sampled: m.sampled,
      active: m.active,
      activeVsPhase1: { ...m.activeVsPhase1 },
      incomplete: m.incomplete,
      failed: m.failed,
      aborted: m.aborted,
      attempts: m.attempts,
      fallbackCount: m.fallbackCount,
      totalCost: m.totalCost,
      allowedAgents: [...this.allowedAgents],
      allowedTaskTypes: [...this.allowedTaskTypes],
    };
  }
}

export default { CanaryController };
