// src/runtime/attempts.js
// Smart Router Mainline - Phase 1
// Attempt 记录管理：单次尝试记录 + Attempt 记录集合。
//
// 设计要点（参考 6.5.0 的改进）：
//   - AttemptRecord：记录单次尝试的完整信息
//     - transportOutcome：传输层结果（HTTP 请求是否成功）
//     - validatedOutcome：模型质量结果（响应内容是否有效）
//     - 两者分离：transport success 不等于 validated success
//   - AttemptLog：Attempt 记录集合，支持审计链回溯
//   - budgetBlocked：标记预算屏蔽的尝试（未实际执行）
//   - 完整审计信息：model, provider, keyId, errorType, httpStatus, latency, usage, cost
//
// 仅使用 Node.js 内置模块，无第三方依赖。

// ----------------------------------------------------------------------------
// AttemptRecord：单次尝试记录
// ----------------------------------------------------------------------------

/**
 * 单次尝试记录。
 *
 * 记录一次上游 provider 调用的完整信息，包括：
 *   - 传输层结果（transportOutcome）：HTTP 请求是否成功
 *   - 验证层结果（validatedOutcome）：响应内容是否有效完整
 *   - 错误信息（errorType, errorMessage）
 *   - 性能指标（httpStatus, latencyMs, firstByteMs）
 *   - 用量与成本（usage, cost）
 *   - 预算屏蔽标记（budgetBlocked）
 *
 * transportOutcome 与 validatedOutcome 分离的设计：
 *   - transport='success' + validated='completed'：完全成功
 *   - transport='success' + validated='incomplete'：传输成功但响应不完整（异常EOF等）
 *   - transport='error' + validated=null：传输失败（HTTP 错误）
 *   - transport='aborted' + validated=null：客户端取消
 *   - transport=null + budgetBlocked=true：预算屏蔽，未执行
 */
export class AttemptRecord {
  /**
   * @param {number} attemptNumber 尝试序号（从 1 开始）
   * @param {string} model 模型 id
   * @param {string} provider provider 名称
   * @param {string|null} keyId 使用的 key id
   */
  constructor(attemptNumber, model, provider, keyId) {
    this.attemptNumber = attemptNumber;
    this.model = model || null;
    this.provider = provider || null;
    this.keyId = keyId || null;

    // 传输层结果：'success' | 'error' | 'aborted' | 'timeout' | null
    this.transportOutcome = null;

    // 验证层结果：'completed' | 'incomplete' | 'error' | null
    this.validatedOutcome = null;

    // 错误信息
    this.errorType = null; // ErrorType 枚举值
    this.errorMessage = null;

    // HTTP 状态码
    this.httpStatus = null;

    // 性能指标
    this.latencyMs = 0;
    this.firstByteMs = null;

    // 用量与成本
    this.usage = null; // { prompt_tokens, completion_tokens }
    this.cost = null; // { inputCost, outputCost, totalCost }

    // 预算屏蔽标记
    this.budgetBlocked = false;

    // 时间戳
    this.timestamp = Date.now();
  }

  /**
   * 设置传输层结果。
   *
   * @param {string} outcome 传输结果：'success' | 'error' | 'aborted' | 'timeout'
   * @param {number|null} httpStatus HTTP 状态码
   * @param {number} latencyMs 总延迟（毫秒）
   * @param {number|null} firstByteMs 首字节延迟（毫秒）
   */
  setTransportResult(outcome, httpStatus, latencyMs, firstByteMs) {
    this.transportOutcome = outcome || null;
    this.httpStatus = typeof httpStatus === 'number' ? httpStatus : null;
    this.latencyMs = typeof latencyMs === 'number' ? latencyMs : 0;
    this.firstByteMs = typeof firstByteMs === 'number' ? firstByteMs : null;
  }

  /**
   * 设置验证层结果。
   *
   * @param {string} outcome 验证结果：'completed' | 'incomplete' | 'error'
   */
  setValidatedResult(outcome) {
    this.validatedOutcome = outcome || null;
  }

  /**
   * 设置错误信息。
   *
   * @param {string} errorType ErrorType 枚举值
   * @param {string|null} errorMessage 错误消息
   */
  setError(errorType, errorMessage) {
    this.errorType = errorType || null;
    this.errorMessage = errorMessage || null;
  }

  /**
   * 设置用量与成本。
   *
   * @param {object} usage token 用量 { prompt_tokens, completion_tokens }
   * @param {object} cost 成本 { inputCost, outputCost, totalCost }
   */
  setUsage(usage, cost) {
    this.usage = usage || null;
    this.cost = cost || null;
  }

  /**
   * 标记预算屏蔽。
   * 预算屏蔽的尝试不会设置 transportOutcome/validatedOutcome（保持 null），
   * 仅标记 budgetBlocked = true，表示该尝试因预算限制未实际执行。
   */
  markBudgetBlocked() {
    this.budgetBlocked = true;
  }

  /**
   * 判断该尝试是否传输成功。
   * @returns {boolean}
   */
  isTransportSuccess() {
    return this.transportOutcome === 'success';
  }

  /**
   * 判断该尝试是否完全成功（传输成功 + 验证通过）。
   * @returns {boolean}
   */
  isCompleted() {
    return this.transportOutcome === 'success' && this.validatedOutcome === 'completed';
  }

  /**
   * 判断该尝试是否因客户端取消而终止。
   * @returns {boolean}
   */
  isAborted() {
    return this.transportOutcome === 'aborted';
  }

  /**
   * 转为 JSON（用于审计记录序列化）。
   * @returns {object}
   */
  toJSON() {
    return {
      attemptNumber: this.attemptNumber,
      model: this.model,
      provider: this.provider,
      keyId: this.keyId,
      transportOutcome: this.transportOutcome,
      validatedOutcome: this.validatedOutcome,
      errorType: this.errorType,
      errorMessage: this.errorMessage,
      httpStatus: this.httpStatus,
      latencyMs: this.latencyMs,
      firstByteMs: this.firstByteMs,
      usage: this.usage,
      cost: this.cost,
      budgetBlocked: this.budgetBlocked,
      timestamp: new Date(this.timestamp).toISOString(),
    };
  }
}

// ----------------------------------------------------------------------------
// AttemptLog：Attempt 记录集合
// ----------------------------------------------------------------------------

/**
 * Attempt 记录集合，管理一次请求的所有尝试记录。
 *
 * 提供审计链管理：
 *   - addAttempt：创建并添加新记录
 *   - getSuccessful：获取传输成功的记录（用于成本记录和质量反馈）
 *   - hasSuccess：判断是否有任何成功的尝试
 *   - toJSON：转为 JSON 数组（用于审计序列化）
 *
 * @example
 * const log = new AttemptLog('req-123');
 * const attempt = log.addAttempt('gpt-4', 'openai', 'key-1');
 * attempt.setTransportResult('success', 200, 350, 120);
 * attempt.setValidatedResult('completed');
 * attempt.setUsage({ prompt_tokens: 100, completion_tokens: 50 }, { totalCost: 0.002 });
 */
export class AttemptLog {
  /**
   * @param {string} requestId 请求唯一标识
   */
  constructor(requestId) {
    this.requestId = requestId || null;
    this.records = [];
  }

  /**
   * 创建并添加新的尝试记录。
   *
   * @param {string} model 模型 id
   * @param {string} provider provider 名称
   * @param {string|null} keyId 使用的 key id
   * @returns {AttemptRecord} 新创建的记录（调用方可继续设置字段）
   */
  addAttempt(model, provider, keyId) {
    const record = new AttemptRecord(
      this.records.length + 1,
      model,
      provider,
      keyId
    );
    this.records.push(record);
    return record;
  }

  /**
   * 获取所有记录。
   * @returns {AttemptRecord[]}
   */
  getAll() {
    return [...this.records];
  }

  /**
   * 获取最后一条记录。
   * @returns {AttemptRecord|null}
   */
  getLast() {
    if (this.records.length === 0) return null;
    return this.records[this.records.length - 1];
  }

  /**
   * 获取传输成功的记录（第一个 transportOutcome === 'success' 的记录）。
   *
   * 用于成本记录和质量反馈：
   *   - 成本记录：传输成功的尝试才有 usage 数据
   *   - 质量反馈：传输成功的尝试才有 validatedOutcome
   *
   * @returns {AttemptRecord|null}
   */
  getSuccessful() {
    return this.records.find((r) => r.transportOutcome === 'success') || null;
  }

  /**
   * 获取记录数量。
   * @returns {number}
   */
  getCount() {
    return this.records.length;
  }

  /**
   * 是否有任何传输成功的尝试。
   * @returns {boolean}
   */
  hasSuccess() {
    return this.records.some((r) => r.transportOutcome === 'success');
  }

  /**
   * 是否有任何客户端取消的尝试。
   * @returns {boolean}
   */
  hasAborted() {
    return this.records.some((r) => r.transportOutcome === 'aborted');
  }

  /**
   * 获取所有被预算屏蔽的记录。
   * @returns {AttemptRecord[]}
   */
  getBudgetBlocked() {
    return this.records.filter((r) => r.budgetBlocked);
  }

  /**
   * 转为 JSON 数组（用于审计序列化）。
   * @returns {object[]}
   */
  toJSON() {
    return this.records.map((r) => r.toJSON());
  }
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  AttemptRecord,
  AttemptLog,
};
