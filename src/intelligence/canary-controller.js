// src/intelligence/canary-controller.js
// Smart Router Mainline - Phase 2-C (Safety Sealed)
// Active Canary 控制器：低风险 5% 流量实验的安全开关与重排控制器。
//
// 设计原则（Phase2-C 第 8/9 节 + 安全收口）：
//   - 新模式：off / shadow / active_canary（默认 shadow，Active 默认关闭）
//   - 确定性采样：requestId 的 SHA-256 哈希（无 Math.random，可复现）
//   - 仅允许在【Phase1-legal 候选】内重排：
//       Primary = 智能建议推荐；Fallback 链只保留 blocked==null 的合法候选
//       （blocked 候选【绝不】进入 Canary Fallback 链）
//   - 指标只统计【实际 Active 请求】：activeRequests Map 记录采样命中的请求，
//       Finalize 后删除防内存增长；普通 Phase1（未采样）请求不进入指标与自动停止
//   - 低风险资格（第一批 5% 排除）：toolsRequired / visionRequired /
//       structuredOutputRequired / needsLongContext / strictModel / high风险 /
//       低置信度 / recommendation=null / 硬能力 blocked / 非允许协议
//   - 预算防御：allowPaid / allowedModels / allowedProviders / maxRequestCost /
//       strictModel（使用 decision.ranked 完整条目，含 estimatedCost / paid）
//   - 禁止：扩展候选集合、绕过 budget/allowed 列表、改变 strict、修改消息、
//     注入提示、首字节后切换、并行模型
//   - Fail Open：任何异常 → 返回 Phase1 原始候选顺序
//   - Kill Switch：kill() 或配置 killSwitch:true → 立即停止采样（无需改代码）；
//       killed 状态由上层持久化（SQLite app_state），重启后仍保持
//   - 自动停止（仅 Active 请求）：预算违规 1 次 / 硬能力违规 1 次 /
//       首字节后切换 1 次 / 重复 Tool 1 次 / 连续 Provider 错误 3 次 /
//       连续 incomplete 达阈值 / 管理员 Kill Switch
//   - 连续错误为【真连续】计数：成功或无关 outcome 后立即清零
//
// 指标（CanaryMetrics）：
//   eligible / sampled / active / activeVsPhase1 / cost / quality / incomplete /
//   failed / aborted / attempts / paidRatio / decisionLatencyMs / fallbackCount /
//   autoStop / activeRequests
//
// 仅使用 Node.js 内置模块（node:crypto），无第三方依赖。

import { createHash } from 'node:crypto';

const DEFAULT_ALLOWED_TASK_TYPES = [
  'general_chat', 'writing', 'summarization', 'translation', 'extraction',
];

const DEFAULT_ALLOWED_PROTOCOLS = ['chat', 'anthropic', 'responses'];

// 高风险任务类型：第一批 5% 直接排除（vision/tool/coding/debug/arch/research/analysis 等）
// 用户需求：编码/调试/架构等任务应走智能路由选强模型（决策引擎有 Fail-Open 保护）
// 故从高风险名单移出编码类任务；仅保留需特殊处理的类型。
const HIGH_RISK_TASK_TYPES = new Set([
  'vision', 'structured_output',
]);
const HIGH_RISK_COMPLEXITY = 0.98;

// 成功 outcome（用于连续错误清零）
const SUCCESS_OUTCOMES = new Set(['completed', 'success']);
// 失败 outcome（计入 failed 指标）
const FAILED_OUTCOMES = new Set([
  'provider_error', 'budget_exceeded', 'no_candidate', 'provider_unavailable',
]);

export class CanaryController {
  /**
   * @param {object} [cfg] { percentage, allowedAgents, allowedTaskTypes, allowedProtocols, killSwitch }
   * @param {boolean} [enabled] 是否处于 active_canary 模式
   */
  constructor(cfg = {}, enabled = false) {
    this.enabled = enabled;
    this.percentage = typeof cfg.percentage === 'number'
      ? Math.min(100, Math.max(0, cfg.percentage))
      : 5;
    this.allowedAgents = Array.isArray(cfg.allowedAgents) ? cfg.allowedAgents : [];
    this.allowedTaskTypes = Array.isArray(cfg.allowedTaskTypes) && cfg.allowedTaskTypes.length > 0
      ? cfg.allowedTaskTypes
      : DEFAULT_ALLOWED_TASK_TYPES;
    this.allowedProtocols = Array.isArray(cfg.allowedProtocols) && cfg.allowedProtocols.length > 0
      ? cfg.allowedProtocols
      : DEFAULT_ALLOWED_PROTOCOLS;
    // 进程内 kill 状态（持久化恢复由上层 restoreKilled 注入）
    this.killed = cfg.killSwitch === true;
    // 实际 Active 请求状态表：requestId -> { agentId, taskType, protocol, sampledAt, primary, estimatedCost }
    this.activeRequests = new Map();
    // 真连续错误计数（成功即清零）
    this.consecutiveErrors = { provider_error: 0, no_candidate: 0, incomplete: 0 };
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

  isProtocolAllowed(protocol) {
    return this.allowedProtocols.includes(protocol);
  }

  /** 停止采样（kill switch / 自动停止）。停止后 apply 一律返回 Phase1 顺序。 */
  stop(reason) {
    if (this.killed) return;
    this.killed = true;
    this.metrics.autoStop = { reason, at: new Date().toISOString() };
  }

  /** 恢复持久化的 killed 状态（重启后调用；不再采样但保留历史原因）。 */
  restoreKilled(persisted) {
    if (!persisted) return false;
    if (!this.killed) {
      this.killed = true;
      this.metrics.autoStop = {
        reason: persisted.reason || 'kill_switch',
        at: persisted.at || new Date().toISOString(),
        restored: true,
      };
    }
    return this.killed;
  }

  get stopped() {
    return this.killed;
  }

  get activeCount() {
    return this.activeRequests.size;
  }

  /**
   * 低风险资格判断：命中任一排除条件 → 返回原因字符串；全部通过 → null。
   * 第一批 5% 只允许：低风险任务类型 + 无硬能力需求 + 有推荐 + 允许协议 + 存在合法候选。
   */
  _lowRiskExclusion({ decision, task, budget, protocol }) {
    const t = task || {};
    if (t.toolsRequired === true) return 'tools_required';
    if (t.needsVision === true) return 'vision_required';
    if (t.structuredOutputRequired === true) return 'structured_output_required';
    if (t.needsLongContext === true) return 'long_context';
    // 5% Live Pilot：流式请求【允许】进入 Canary（Claude Code Anthropic 常见），
    // 但第一批只允许 anthropic 协议（agentId=claude-code 由 apply 的 allowedAgents 检查）。
    // 流式硬能力仍保留：stream=true + 候选不支持 streaming → 候选 blocked（DecisionEngine）。
    if (t.needsStreaming === true && protocol !== 'anthropic') return 'streaming_protocol_not_allowed';
    if (budget?.strictModel === true) return 'strict_model';
    if (HIGH_RISK_TASK_TYPES.has(t.taskType)) return 'high_risk_task';
    if (typeof t.complexity === 'number' && t.complexity >= HIGH_RISK_COMPLEXITY) return 'high_complexity';
    // 低置信度 / 无推荐：不采样
    if (!decision?.recommendation) return 'no_recommendation';
    if (!this.isProtocolAllowed(protocol)) return 'protocol_not_allowed';
    // 硬能力 blocked：合法候选为空 → 不采样
    const ranked = Array.isArray(decision?.ranked) ? decision.ranked : [];
    const legal = ranked.filter((r) => !r.blocked);
    if (legal.length === 0) return 'no_legal_candidate';
    return null;
  }

  /**
   * 对一次建议应用 Canary：低风险资格 + 采样命中且允许 → 在 Phase1-legal 候选内重排。
   * Fail Open：任何异常/非法 → 返回原 candidates（Phase1 顺序）。
   *
   * @param {object} opts
   *   - decision {object} 完整决策（含 task / ranked / recommendation）
   *   - candidates {object[]} Phase1 候选（含执行字段）
   *   - requestId {string}
   *   - agentId {string}
   *   - taskType {string} 任务类型（decision.task.taskType）
   *   - task {object} 完整任务画像（decision.task）
   *   - protocol {string}
   *   - budget {object} 生效预算（allowPaid / allowedModels / allowedProviders / maxRequestCost / strictModel）
   *   - requestedModel {string|null} 用户显式请求的模型（body.model）
   * @returns {{ orderedCandidates: Array, active: boolean, reason: string|null, primary: string|null, requestId: string|null }}
   */
  apply({ decision, candidates, requestId, agentId, taskType, task, protocol, budget, requestedModel }) {
    const orig = Array.isArray(candidates) ? candidates : [];
    if (!this.enabled) return { orderedCandidates: orig, active: false, reason: 'disabled' };
    this.metrics.eligible++;
    try {
      if (this.killed) return { orderedCandidates: orig, active: false, reason: 'killed' };
      if (!this.isAgentAllowed(agentId)) return { orderedCandidates: orig, active: false, reason: 'agent_not_allowed' };
      if (!this.isTaskTypeAllowed(taskType)) return { orderedCandidates: orig, active: false, reason: 'task_type_not_allowed' };
      // 低风险资格（第一批 5% 排除条件；命中即不采样）
      const exclusion = this._lowRiskExclusion({ decision, task, budget, protocol });
      if (exclusion) return { orderedCandidates: orig, active: false, reason: 'excluded:' + exclusion };
      if (!this._sample(requestId)) return { orderedCandidates: orig, active: false, reason: 'not_sampled' };
      this.metrics.sampled++;

      // 仅 Phase1-legal 候选可参与重排与 Fallback 链：
      // decision.ranked 中 blocked==null 的候选（通过能力/预算/协议硬约束）。
      const ranked = Array.isArray(decision?.ranked) ? decision.ranked : [];
      const legalIds = new Set(ranked.filter((r) => !r.blocked).map((r) => this._identity(r)));
      const legalCandidates = orig.filter((c) => legalIds.has(this._identity(c)));
      if (legalCandidates.length === 0) return { orderedCandidates: orig, active: false, reason: 'no_legal_candidate' };

      // 5% Live Pilot：流式请求所有执行候选必须明确支持 streaming（Canary 层最终防线；
      // 不支持 streaming 的候选已在 DecisionEngine 被 blocked，此处若仍出现则拒绝采样）
      if (task?.needsStreaming === true) {
        const unsupported = legalCandidates.filter((c) => !this._supportsStreaming(c));
        if (unsupported.length > 0) {
          return { orderedCandidates: orig, active: false, reason: 'excluded:streaming_candidate_unsupported' };
        }
      }

      const primary = decision?.recommendation || null;
      const primaryId = primary?.modelId || null;
      const primaryProvider = primary?.provider || null;

      // 预算防御：Primary 不得违反生效预算
      // （allowPaid / allowedModels / allowedProviders / maxRequestCost / strictModel）。
      // 使用 ranked 中的完整条目（含 paid / estimatedCost）。
      if (budget) {
        const p = ranked.find((r) => !r.blocked && this._identity(r) === this._identity(primary))
          || ranked.find((r) => r.modelId === primaryId && r.provider === primaryProvider)
          || primary;
        if (p && this._budgetViolation(p, budget, task, requestedModel)) {
          this.stop('budget_violation');
          return { orderedCandidates: orig, active: false, reason: 'budget_violation' };
        }
      }

      // Primary 必须存在于合法候选（Fail Safe：不在则不做重排）
      const primaryInLegal = legalCandidates.some(
        (c) => this._identity(c) === this._identity({ modelId: primaryId, provider: primaryProvider }),
      );
      if (!primaryInLegal) return { orderedCandidates: orig, active: false, reason: 'primary_not_legal' };

      // 重排：Primary 置顶，其余合法候选保持 Phase1 原始顺序（稳定排序）
      const ordered = [...legalCandidates].sort((a, b) => {
        const aIsPrimary = this._identity(a) === this._identity({ modelId: primaryId, provider: primaryProvider }) ? 0 : 1;
        const bIsPrimary = this._identity(b) === this._identity({ modelId: primaryId, provider: primaryProvider }) ? 0 : 1;
        return aIsPrimary - bIsPrimary;
      });

      // 记录 Active 请求（指标与自动停止只统计这些请求）
      const primaryRanked = ranked.find((r) => this._identity(r) === this._identity({ modelId: primaryId, provider: primaryProvider })) || null;
      this.activeRequests.set(String(requestId == null ? '' : requestId), {
        agentId, taskType, protocol,
        sampledAt: new Date().toISOString(),
        primary: primary ? `${primaryId}@${primaryProvider}` : null,
        estimatedCost: typeof primaryRanked?.estimatedCost === 'number' ? primaryRanked.estimatedCost : null,
        ordered: ordered.map((c) => this._identity(c)),
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
        primary: primary ? `${primaryId}@${primaryProvider}` : null,
        requestId: requestId || null,
      };
    } catch (e) {
      // Fail Open：异常一律回退 Phase1 顺序
      return { orderedCandidates: orig, active: false, reason: 'exception:' + String(e.message || e) };
    }
  }

  _identity(c) {
    if (!c) return 'null@null';
    return `${c.modelId ?? ''}@${c.provider ?? ''}`;
  }

  /**
   * 候选是否明确支持 streaming：
   *   - capabilities.streaming >= 1（0-1/0-100 规范化）
   *   - capability 数组包含 'streaming'（legacy 兼容）
   */
  _supportsStreaming(c) {
    if (!c) return false;
    if (c.capabilities && typeof c.capabilities.streaming !== 'undefined') {
      return Number(c.capabilities.streaming) >= 1;
    }
    if (Array.isArray(c.capability)) {
      return c.capability.includes('streaming');
    }
    return false;
  }

  /**
   * 预算违规检查：
   *   - allowPaid === false 且候选付费 → 违规
   *   - allowedModels 非空且不含候选 modelId → 违规
   *   - allowedProviders 非空且不含候选 provider → 违规
   *   - maxRequestCost > 0 且候选 estimatedCost 超限 → 违规
   *   - strictModel === true 且用户请求了具体模型（非 auto）而候选不是该模型 → 违规
   */
  _budgetViolation(candidate, budget, task, requestedModel) {
    const c = candidate || {};
    if (budget.allowPaid === false && c.paid) return true;
    if (Array.isArray(budget.allowedModels) && budget.allowedModels.length > 0
      && !budget.allowedModels.includes(c.modelId)) return true;
    if (Array.isArray(budget.allowedProviders) && budget.allowedProviders.length > 0
      && !budget.allowedProviders.includes(c.provider)) return true;
    if (typeof budget.maxRequestCost === 'number' && budget.maxRequestCost > 0) {
      const est = typeof c.estimatedCost === 'number' ? c.estimatedCost : null;
      if (est !== null && est > budget.maxRequestCost) return true;
    }
    if (budget.strictModel === true) {
      const req = requestedModel || task?.model || null;
      if (req && req !== 'auto' && c.modelId && c.modelId !== req) return true;
    }
    return false;
  }

  /**
   * 记录一次真实执行结果（由 IntelligenceLayer.recordFinalized 调用）。
   * 只统计【实际 Active 请求】；普通 Phase1（未采样）请求直接忽略，
   * 不进入指标、不计入连续错误、不触发自动停止。
   * Finalize 后从 activeRequests 删除该条目（防内存增长）。
   */
  recordFinalized({ requestId, outcome, finalModel, finalProvider, attempts, cost, latencyMs }) {
    if (!this.enabled) return;
    const key = String(requestId == null ? '' : requestId);
    const active = this.activeRequests.get(key);
    if (!active) return; // 非 Active 请求：不统计
    const att = Array.isArray(attempts) ? attempts : [];

    this.metrics.attempts += att.length;
    if (typeof latencyMs === 'number') this.metrics.decisionLatencyMs += latencyMs;
    if (typeof cost === 'number') this.metrics.totalCost += cost;
    if (outcome === 'incomplete') this.metrics.incomplete++;
    if (outcome === 'client_aborted') this.metrics.aborted++;
    if (FAILED_OUTCOMES.has(outcome)) this.metrics.failed++;
    if (att.length > 1) this.metrics.fallbackCount += att.length - 1;

    // 真连续错误计数：命中对应错误 +1；成功或其他 outcome → 清零
    if (outcome === 'provider_error' || outcome === 'provider_unavailable') {
      this.consecutiveErrors.provider_error++;
    } else {
      this.consecutiveErrors.provider_error = 0;
    }
    if (outcome === 'no_candidate') {
      this.consecutiveErrors.no_candidate++;
    } else {
      this.consecutiveErrors.no_candidate = 0;
    }
    if (outcome === 'incomplete') {
      this.consecutiveErrors.incomplete++;
    } else {
      this.consecutiveErrors.incomplete = 0;
    }

    // 首字节后切换（attempts.length>1 且首个 attempt 已向客户端发送首字节）
    if (att.length > 1 && att[0]?.firstByteSentToClient === true) {
      this.stop('first_byte_switch');
    }
    // 重复 Tool（attempts 中出现重复工具错误标记）
    if (att.some((a) => a?.errorType === 'tool_use_repeated' || a?.errorType === 'duplicate_tool')) {
      this.stop('repeated_tool');
    }
    // 自动停止条件（仅 Active 请求；基于真连续计数）
    if (outcome === 'budget_exceeded') this.stop('budget_exceeded');
    if (this.consecutiveErrors.incomplete >= 3) this.stop('incomplete_rise');
    if (this.consecutiveErrors.provider_error >= 3) this.stop('consecutive_provider_errors');
    if (this.consecutiveErrors.no_candidate >= 3) this.stop('consecutive_no_candidate');

    // Finalize 后清理：防内存增长
    this.activeRequests.delete(key);
  }

  /** 汇总指标快照。 */
  snapshot() {
    const m = this.metrics;
    return {
      enabled: this.enabled,
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
      activeRequests: this.activeRequests.size,
      consecutiveErrors: { ...this.consecutiveErrors },
      allowedAgents: [...this.allowedAgents],
      allowedTaskTypes: [...this.allowedTaskTypes],
      allowedProtocols: [...this.allowedProtocols],
    };
  }
}

export default { CanaryController };
