// src/intelligence/shadow-recorder.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Shadow Recorder：记录「传统路由真实选择」与「智能建议」，绑定同一 requestId。
//
// 记录内容：
//   - requestId（三协议同一内部 sr_ id）
//   - 协议 / agent / 请求模型
//   - 传统路由真实选择（final provider/model、attempts、usage、cost、outcome）
//   - 智能建议（recommendation、ranked、predictions、explanation）
//   - 选择与淘汰原因
//
// Shadow 约束：
//   - 只读记录，不改变执行路径，不触发上游调用
//   - 内存存储 + 可选持久化钩子（本版为内存，附快照接口）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

/**
 * Shadow Recorder（内存版）。
 */
export class ShadowRecorder {
  constructor(options = {}) {
    this.options = options;
    this._records = new Map(); // requestId -> record
    this._enabled = options.enabled !== false;
  }

  /**
   * 记录一条 Shadow 观测（幂等：同 requestId 覆盖更新）。
   *
   * @param {object} entry
   * @param {string} entry.requestId
   * @param {string} [entry.protocol]
   * @param {string} [entry.agentId]
   * @param {object} [entry.task] Task Analyzer 输出
   * @param {object} [entry.intelligence] 智能建议（Decision Engine 输出）
   * @param {object} [entry.traditional] 传统路由真实结果（final provider/model/outcome/usage/cost）
   */
  record(entry) {
    if (!this._enabled) return;
    if (!entry || !entry.requestId) return;
    const prev = this._records.get(entry.requestId) || {};
    this._records.set(entry.requestId, {
      requestId: entry.requestId,
      protocol: entry.protocol ?? prev.protocol ?? null,
      agentId: entry.agentId ?? prev.agentId ?? null,
      requestedModel: entry.requestedModel ?? prev.requestedModel ?? null,
      task: entry.task ?? prev.task ?? null,
      intelligence: entry.intelligence ?? prev.intelligence ?? null,
      traditional: entry.traditional ?? prev.traditional ?? null,
      recordedAt: new Date().toISOString(),
    });
  }

  /**
   * 记录传统路由真实结果（通常在执行后调用）。
   */
  recordTraditional(requestId, result) {
    this.record({ requestId, traditional: result });
  }

  /**
   * 获取单条记录。
   */
  get(requestId) {
    const r = this._records.get(requestId);
    return r ? { ...r } : null;
  }

  /**
   * 获取全部记录。
   */
  getAll() {
    return [...this._records.values()];
  }

  /**
   * 记录数量。
   */
  get size() {
    return this._records.size;
  }

  /**
   * 生成 Off/Shadow 对照摘要：
   * 对每条记录比较「智能建议 top1」与「传统真实选择」。
   *
   * @returns {{
   *   total: number,
   *   agree: number,        // 智能建议与真实选择一致
   *   differ: number,       // 不一致
   *   suggestionAccepted: number, // 建议模型 == 真实模型
   *   comparison: object[]
   * }}
   */
  summarizeComparison() {
    const comparison = [];
    let agree = 0;
    for (const r of this._records.values()) {
      const recModel = r.intelligence?.recommendation?.modelId ?? null;
      const realModel = r.traditional?.finalModel ?? null;
      const realProvider = r.traditional?.finalProvider ?? null;
      const same = recModel !== null && recModel === realModel;
      if (same) agree++;
      comparison.push({
        requestId: r.requestId,
        protocol: r.protocol,
        agentId: r.agentId,
        suggested: recModel,
        suggestedScore: r.intelligence?.recommendation?.score ?? null,
        real: realModel ? `${realProvider}/${realModel}` : null,
        realOutcome: r.traditional?.outcome ?? null,
        agree: same,
        realLatencyMs: r.traditional?.latencyMs ?? null,
        predictedLatencyMs: r.intelligence?.predictions?.latency ?? null,
        predictedCost: r.intelligence?.predictions?.cost ?? null,
        realCost: r.traditional?.cost ?? null,
        explanationSummary: r.intelligence?.explanation?.summary ?? null,
      });
    }
    return {
      total: this._records.size,
      agree,
      differ: this._records.size - agree,
      suggestionAccepted: agree,
      comparison,
    };
  }

  /**
   * 清空（测试用）。
   */
  clear() {
    this._records.clear();
  }
}

export default { ShadowRecorder };
