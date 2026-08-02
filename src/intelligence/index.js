// src/intelligence/index.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Intelligence Layer 入口：off / shadow 两种模式。
//
// 模式语义：
//   - off   ：智能层完全禁用（Phase1 行为不变，零开销）
//   - shadow：智能层计算建议并记录，但不影响执行路径
//             （不增加上游调用、不修改候选顺序、不影响用户响应）
//
// 使用：
//   const intelligence = new IntelligenceLayer(config);
//   const suggestion = intelligence.shadow.decide({ body, agentId, budget, candidates, protocol });
//   intelligence.recorder.recordTraditional(requestId, { finalModel, ... });
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { DecisionEngine } from './decision-engine.js';
import { ShadowRecorder } from './shadow-recorder.js';

/**
 * 智能层（Shadow 版）。
 */
export class IntelligenceLayer {
  /**
   * @param {object} config 已加载配置（intelligence.mode: 'off' | 'shadow'）
   */
  constructor(config) {
    this.config = config || {};
    const intel = this.config.intelligence || {};
    this.mode = intel.mode === 'shadow' ? 'shadow' : 'off';

    // Shadow 模式配置
    const shadowCfg = intel.shadow || {};
    this.enabled = this.mode === 'shadow';

    this.decisionEngine = new DecisionEngine(this.config, {
      policy: shadowCfg.policy,
    });
    this.recorder = new ShadowRecorder({ enabled: this.enabled });

    // Shadow 观测记录存储（供查询接口与报告）
    this._observations = [];
  }

  /**
   * 是否处于 shadow 模式。
   */
  isShadow() {
    return this.enabled;
  }

  /**
   * 生成智能建议（仅 shadow 模式有效；off 模式返回 null）。
   *
   * @param {object} params { body, agentId, budget, candidates, protocol, requestId }
   * @returns {object|null} Decision Engine 输出；off 模式返回 null
   */
  suggest(params) {
    if (!this.enabled) return null;
    const decision = this.decisionEngine.decide({
      body: params.body,
      agentId: params.agentId || 'generic',
      budget: params.budget,
      candidates: params.candidates || [],
      protocol: params.protocol,
    });
    // 记录（绑定 requestId，三协议同一内部 id）
    if (params.requestId) {
      this.recorder.record({
        requestId: params.requestId,
        protocol: params.protocol,
        agentId: params.agentId || 'generic',
        requestedModel: params.body?.model || null,
        task: decision.task,
        intelligence: {
          recommendation: decision.recommendation,
          ranked: decision.ranked,
          predictions: decision.predictions,
          explanation: decision.explanation,
        },
      });
    }
    return decision;
  }

  /**
   * 记录传统路由真实结果（执行后调用；仅 shadow 模式）。
   */
  recordTraditional(requestId, result) {
    if (!this.enabled || !requestId) return;
    this.recorder.recordTraditional(requestId, result);
  }

  /**
   * 获取全部 Shadow 记录。
   */
  getRecords() {
    return this.recorder.getAll();
  }

  /**
   * 获取 Off/Shadow 对照摘要。
   */
  getComparison() {
    return this.recorder.summarizeComparison();
  }

  /**
   * 状态摘要（供探活/报告）。
   */
  status() {
    return {
      mode: this.mode,
      enabled: this.enabled,
      records: this.recorder.size,
    };
  }
}

export default { IntelligenceLayer };
