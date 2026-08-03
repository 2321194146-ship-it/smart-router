// src/intelligence/index.js
// Smart Router Mainline - Phase 2-B (Active Readiness)
// Intelligence Layer 入口：off / shadow 两种模式。
//
// 模式语义：
//   - off   ：智能层完全禁用（Phase1 行为不变，零开销，不产生任何 Shadow 记录）
//   - shadow：执行前生成智能建议（suggest，await + 异常隔离 + 明确日志）
//             → Phase1 执行 → Finalize 原子事务成功后观察者 recordFinalized
//
// 运行顺序（正确）：
//   候选生成 → Intelligence.suggest()（await，确保建议落库）→ Phase1 Execution
//   → 协议验证/流式完成 → Finalize 原子提交 → Intelligence.recordFinalized()
//
// 异步异常隔离（方案A）：
//   协议层调用 await suggest()，外层 try/catch 捕获并 log shadow_error；
//   确保 suggestion 已落库后 Execution 才可能 Finalize（不出现已 Finalize 但建议未创建）。
//   观察者钩子失败不影响用户请求与 Phase1 执行结果（Finalizer 内部已隔离异常）。

import { DecisionEngine } from './decision-engine.js';
import { ShadowRecorder } from './shadow-recorder.js';
import { CanaryController } from './canary-controller.js';

export class IntelligenceLayer {
  /**
   * @param {object} config 已加载配置（intelligence.mode: 'off' | 'shadow'）
   * @param {object} [deps] { store: SQLiteStore/MemoryStore, health: ProviderHealth }
   */
  constructor(config, deps = null) {
    this.config = config || {};
    const intel = this.config.intelligence || {};
    // Phase2-C：off / shadow / active_canary（Active 默认关闭）
    this.mode = intel.mode === 'active_canary' ? 'active_canary'
      : intel.mode === 'shadow' ? 'shadow'
        : 'off';
    this.enabled = this.mode !== 'off';

    const store = deps?.store || null;
    // Phase2-C Safety Sealed：保存 store 引用，用于 Kill Switch 状态持久化/恢复
    this._store = store;
    const health = deps?.health || null;
    const shadowCfg = intel.shadow || {};
    // Active Canary 控制器（仅 active_canary 模式启用；其余模式 disabled）
    this.canary = new CanaryController(intel.activeCanary || {}, this.mode === 'active_canary');

    this.decisionEngine = new DecisionEngine(this.config, {
      policy: shadowCfg.policy,
      health,
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
   * 生成智能建议并持久化（执行前调用；await 保证落库；off 模式返回 null）。
   * 异常由调用方 try/catch 捕获（方案A），不产生 unhandledRejection。
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
    // Phase2-C：Active Canary 采样与重排（仅 active_canary 模式；Fail Open → 原顺序）
    if (this.canary && this.canary.enabled) {
      decision.canary = this.canary.apply({
        decision,
        candidates: params.candidates || [],
        requestId: params.requestId || null,
        agentId: params.agentId || 'generic',
        taskType: decision.task?.taskType || null,
        // Phase2-C Safety Sealed：完整任务画像必须传给 CanaryController（低风险资格全量判断）
        task: decision.task,
        protocol: params.protocol,
        budget: params.budget,
        requestedModel: params.body?.model || null,
      });
    }
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

  /** 记录真实最终结果（Finalize 原子事务成功后由观察者调用）。 */
  async recordFinalized(auditRecord) {
    if (!this.enabled) return;
    // Canary 指标与自动停止（仅 active_canary 模式生效）
    if (this.canary && this.canary.enabled) {
      this.canary.recordFinalized({
        requestId: auditRecord.requestId,
        outcome: auditRecord.outcome,
        finalModel: auditRecord.finalModel,
        finalProvider: auditRecord.finalProvider,
        attempts: auditRecord.attempts,
        cost: auditRecord.cost?.totalCost,
        latencyMs: auditRecord.latencyMs,
      });
    }
    await this.recorder.recordFinalized(auditRecord);
  }

  /** 注册为 Finalizer 观察者。 */
  attachTo(finalizer) {
    if (typeof finalizer?.addObserver === 'function') {
      finalizer.addObserver((auditRecord) => this.recordFinalized(auditRecord));
    }
  }

  async get(requestId) {
    return this.recorder.get(requestId);
  }

  async getRecords() {
    return this.recorder.getAll();
  }

  async getComparison() {
    return this.recorder.summarizeComparison();
  }

  async prune() {
    return this.recorder.prune();
  }

  status() {
    return {
      mode: this.mode,
      enabled: this.enabled,
      records: this.recorder.size,
      retentionDays: this.recorder.retentionDays,
      canary: this.canary ? this.canary.snapshot() : null,
    };
  }

  /** Kill Switch：无需改代码即可停止 Active Canary（回退 shadow 行为）。
   *  同步停止（进程内立即生效）+ 异步持久化 killed 状态（重启后仍保持）。
   */
  killCanary(reason = 'kill_switch') {
    if (this.canary) this.canary.stop(reason);
    this.persistCanaryState().catch(() => {});
    return this.status();
  }

  /**
   * resume-shadow：只恢复 Shadow，绝不自动恢复 Active。
   * 将模式降级为 shadow（Canary 禁用采样），并持久化 intelligence.mode=shadow，
   * 重启后仍保持 shadow，不会因配置 active_canary 而自动恢复。
   */
  resumeShadow() {
    if (this.mode === 'active_canary') {
      this.mode = 'shadow';
      if (this.canary) this.canary.enabled = false;
    }
    this.persistCanaryState().catch(() => {});
    return this.status();
  }

  /**
   * 将当前 Canary 状态持久化到 app_state（canary.killed / intelligence.mode）。
   * 管理接口可 await 以确保落库后再响应。
   */
  async persistCanaryState() {
    if (!this._store) return;
    try {
      if (this.canary?.killed) {
        await this._store.setAppState('canary.killed', JSON.stringify({
          reason: this.canary.metrics.autoStop?.reason || 'kill_switch',
          at: this.canary.metrics.autoStop?.at || new Date().toISOString(),
        }));
      }
      if (this.mode !== 'active_canary') {
        await this._store.setAppState('intelligence.mode', this.mode);
      }
    } catch { /* 持久化失败不影响进程内状态 */ }
  }

  /**
   * 启动时恢复持久化状态（server 初始化后调用一次）：
   *   - canary.killed → 恢复 killed（重启后仍保持 Kill Switch）
   *   - intelligence.mode=shadow 且配置为 active_canary → 降级为 shadow
   */
  async restoreCanaryState() {
    if (!this._store) return;
    try {
      const killedRaw = await this._store.getAppState('canary.killed');
      if (killedRaw && this.canary) {
        try {
          this.canary.restoreKilled(JSON.parse(killedRaw));
        } catch {
          this.canary.restoreKilled({ reason: 'kill_switch' });
        }
      }
      const modeRaw = await this._store.getAppState('intelligence.mode');
      if (modeRaw === 'shadow' && this.mode === 'active_canary') {
        this.mode = 'shadow';
        if (this.canary) this.canary.enabled = false;
      }
    } catch { /* 恢复失败不影响启动 */ }
  }
}

export default { IntelligenceLayer };
