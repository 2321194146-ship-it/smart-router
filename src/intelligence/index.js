// src/intelligence/index.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Intelligence Layer 入口：off / shadow 两种模式。
//
// 模式语义：
//   - off   ：智能层完全禁用（Phase1 行为不变，零开销，不产生任何 Shadow 记录）
//   - shadow：执行前生成智能建议（suggest）→ Phase1 执行 → Finalize 原子事务
//             成功后由观察者触发 recordFinalized（真实结果仅来自最终 Audit）
//
// 运行顺序（正确）：
//   候选生成 → Intelligence.suggest() → Phase1 Execution → 协议验证/流式完成
//   → Finalize 原子提交 → Intelligence.recordFinalized()
//
// 观察者钩子失败不影响用户请求与 Phase1 执行结果（Finalizer 内部已隔离异常）。
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { DecisionEngine } from './decision-engine.js';
import { ShadowRecorder } from './shadow-recorder.js';

export class IntelligenceLayer {
  /**
   * @param {object} config 已加载配置（intelligence.mode: 'off' | 'shadow'）
   * @param {object|null} [store] SQLiteStore / MemoryStore（Shadow 持久化）
   */
  constructor(config, store = null) {
    this.config = config || {};
    const intel = this.config.intelligence || {};
    this.mode = intel.mode === 'shadow' ? 'shadow' : 'off';
    this.enabled = this.mode === 'shadow';

    const shadowCfg = intel.shadow || {};
    this.decisionEngine = new DecisionEngine(this.config, {
      policy: shadowCfg.policy,
    });
    this.recorder = new ShadowRecorder({
      enabled: this.enabled,
      store,
      retentionDays: typeof shadowCfg.retentionDays === 'number'
        ? shadowCfg.retentionDays
        : 30,
    });
  }

  isShadow() {
    return this.enabled;
  }

  /**
   * 生成智能建议并持久化（执行前调用；off 模式返回 null 且不落库）。
   *
   * @param {object} params { requestId, body, agentId, budget, candidates, protocol }
   * @returns {object|null} Decision Engine 输出；off 模式返回 null
   */
  async suggest(params) {
    if (!this.enabled) return null;
    const decision = this.decisionEngine.decide({
      body: params.body,
      agentId: params.agentId || 'generic',
      budget: params.budget,
      candidates: params.candidates || [],
      protocol: params.protocol,
    });
    if (params.requestId) {
      await this.recorder.recordSuggestion({
        requestId: params.requestId,
        protocol: params.protocol,
        agentId: params.agentId || 'generic',
        requestedModel: params.body?.model || null,
        taskProfile: decision.task,
        recommendation: decision.recommendation,
        ranked: decision.ranked,
        predictions: decision.predictions,
        explanation: decision.explanation,
      });
    }
    return decision;
  }

  /**
   * 记录真实最终结果（Finalize 原子事务成功后由观察者调用）。
   * @param {object} auditRecord 最终 Audit 记录（来自 Finalizer）
   */
  async recordFinalized(auditRecord) {
    if (!this.enabled) return;
    await this.recorder.recordFinalized(auditRecord);
  }

  /**
   * 注册为 Finalizer 观察者。
   * @param {object} finalizer Finalizer 实例
   */
  attachTo(finalizer) {
    if (typeof finalizer?.addObserver === 'function') {
      finalizer.addObserver((auditRecord) => this.recordFinalized(auditRecord));
    }
  }

  /** 获取单条记录。 */
  async get(requestId) {
    return this.recorder.get(requestId);
  }

  /** 获取全部记录。 */
  async getRecords() {
    return this.recorder.getAll();
  }

  /** 对照摘要。 */
  async getComparison() {
    return this.recorder.summarizeComparison();
  }

  /** 清理过期记录（按保留天数）。 */
  async prune() {
    return this.recorder.prune();
  }

  status() {
    return {
      mode: this.mode,
      enabled: this.enabled,
      records: this.recorder.size,
      retentionDays: this.recorder.retentionDays,
    };
  }
}

export default { IntelligenceLayer };
