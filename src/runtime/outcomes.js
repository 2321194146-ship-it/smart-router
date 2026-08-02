// src/runtime/outcomes.js
// Smart Router Mainline - Phase 1
// Outcome 归因：将执行结果归因为有限的 Outcome 类型，区分模型质量与 provider 故障。
//
// 设计要点（参考 6.5.0 的改进）：
//   - Outcome 枚举：8 种结果类型，覆盖所有执行场景
//   - QUALITY_OUTCOMES：只有 completed / incomplete 才回写模型质量反馈
//   - client_aborted 单独归因：不记为模型质量失败
//   - provider 故障与模型质量分开：no_candidate / budget_exceeded /
//     provider_error / client_aborted / client_error / validation_failed
//     都不是模型质量问题
//   - deriveValidatedOutcome：从响应内容推导验证结果（completed / incomplete）
//   - deriveTransportOutcome：从 HTTP 状态码推导传输结果
//   - transport_outcome 与 validated_outcome 分离
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { ErrorType } from '../provider/errors.js';

// ----------------------------------------------------------------------------
// Outcome 枚举
// ----------------------------------------------------------------------------

/**
 * Outcome 枚举：请求的最终结果类型。
 *
 * 分类维度：
 *   - 模型质量相关（QUALITY_OUTCOMES）：completed, incomplete
 *     → 回写模型质量反馈，影响未来路由决策
 *   - 非模型质量相关：no_candidate, client_aborted, budget_exceeded,
 *     provider_error, client_error, validation_failed
 *     → 不回写模型质量反馈（非模型本身的问题）
 */
export const Outcome = Object.freeze({
  COMPLETED: 'completed', // 任务成功完成
  INCOMPLETE: 'incomplete', // 响应不完整（异常EOF、finish_reason=length 等）
  NO_CANDIDATE: 'no_candidate', // 无可用候选
  CLIENT_ABORTED: 'client_aborted', // 客户端主动取消
  BUDGET_EXCEEDED: 'budget_exceeded', // 预算超限
  PROVIDER_ERROR: 'provider_error', // Provider 故障（5xx、网络错误等）
  CLIENT_ERROR: 'client_error', // 客户端 4xx 错误（非取消）
  VALIDATION_FAILED: 'validation_failed', // 验证失败（响应格式不合法）
  INTERNAL_ERROR: 'internal_error', // 协议处理器内部未预期异常（catch 路径，不得冒充 no_candidate）
});

// ----------------------------------------------------------------------------
// 质量相关 Outcome
// ----------------------------------------------------------------------------

/**
 * 质量相关 Outcome 集合。
 * 只有这些 Outcome 才回写模型质量反馈：
 *   - COMPLETED：成功完成，记为质量成功
 *   - INCOMPLETE：响应不完整，记为质量失败（模型输出被截断等）
 */
export const QUALITY_OUTCOMES = Object.freeze(new Set([
  Outcome.COMPLETED,
  Outcome.INCOMPLETE,
]));

/**
 * 判断 outcome 是否应回写模型质量反馈。
 *
 * @param {string} outcome Outcome 枚举值
 * @returns {boolean}
 */
export function shouldRecordQualityFeedback(outcome) {
  return QUALITY_OUTCOMES.has(outcome);
}

// ----------------------------------------------------------------------------
// validated_outcome 推导
// ----------------------------------------------------------------------------

/**
 * 从 ExecutionResult 和响应体推导 validated_outcome。
 *
 * 检查响应内容是否完整有效：
 *   1. 传输失败 → 返回 null（无验证结果）
 *   2. 响应体为空或无法解析 → 'incomplete'
 *   3. OpenAI 格式：检查 choices 是否为空、finish_reason 是否为 length/content_filter
 *   4. Anthropic 格式：检查 content 是否为空、stop_reason 是否为 max_tokens
 *   5. 响应体包含 error 字段 → 'incomplete'
 *   6. 其它 → 'completed'
 *
 * @param {object|null} executionResult 执行结果对象
 *   - success {boolean} 是否成功
 *   - response {Response|null} fetch Response 对象
 *   - transportOutcome {string|null} 传输结果
 * @param {object|string|null} responseBody 响应体（已解析对象或原始字符串）
 * @returns {string|null} 'completed' | 'incomplete' | null（传输失败时）
 */
export function deriveValidatedOutcome(executionResult, responseBody) {
  // 1. 传输失败 → 无验证结果
  if (!executionResult) return null;

  const transportSuccess =
    executionResult.success === true ||
    executionResult.transportOutcome === 'success' ||
    (executionResult.response && typeof executionResult.response.ok === 'boolean'
      ? executionResult.response.ok
      : false);

  if (!transportSuccess) return null;

  // 2. 解析响应体
  let body = responseBody;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return 'incomplete'; // 空响应体
    try {
      body = JSON.parse(trimmed);
    } catch {
      // 无法解析 JSON：非空则视为 completed（可能是纯文本响应），空则 incomplete
      return trimmed ? 'completed' : 'incomplete';
    }
  }

  if (!body || typeof body !== 'object') {
    return 'incomplete'; // 无响应体或非对象
  }

  // 3. 检查响应体中的 error 字段
  if (body.error) {
    return 'incomplete';
  }

  // 4. OpenAI 格式检查：choices 数组
  if (Array.isArray(body.choices)) {
    // 空 choices → 不完整
    if (body.choices.length === 0) return 'incomplete';

    // 检查每个 choice 的 finish_reason
    for (const choice of body.choices) {
      if (!choice) continue;
      const finishReason = choice.finish_reason;
      // finish_reason='length'：输出被 max_tokens 截断
      // finish_reason='content_filter'：内容被过滤
      if (finishReason === 'length' || finishReason === 'content_filter') {
        return 'incomplete';
      }
      // finish_reason 为 null 或 undefined 且无 message → 可能是流式异常中断
      if (finishReason == null && !choice.message && !choice.delta) {
        return 'incomplete';
      }
    }
  }

  // 5. Anthropic 格式检查：content 数组
  if (Array.isArray(body.content)) {
    if (body.content.length === 0) return 'incomplete';
  }

  // 6. Anthropic 格式检查：stop_reason
  const stopReason = body.stop_reason;
  if (stopReason === 'max_tokens' || stopReason === 'content_filter') {
    return 'incomplete';
  }

  // 7. 流式响应检查：检查是否有 data 数组为空（SSE 格式）
  if (Array.isArray(body.data) && body.data.length === 0) {
    return 'incomplete';
  }

  // 8. 默认：传输成功且未检测到不完整信号 → completed
  return 'completed';
}

// ----------------------------------------------------------------------------
// transport_outcome 推导
// ----------------------------------------------------------------------------

/**
 * 从 HTTP 状态码和错误推导 transport_outcome。
 *
 * 推导规则：
 *   - AbortError → 'aborted'（客户端取消）
 *   - TimeoutError → 'timeout'（请求超时）
 *   - HTTP 2xx → 'success'（传输成功）
 *   - HTTP 4xx/5xx → 'error'（HTTP 错误）
 *   - 网络错误（有 error 无 httpStatus）→ 'error'
 *   - 无 error 且无 httpStatus → 'error'（未知失败）
 *
 * @param {number|null} httpStatus HTTP 状态码
 * @param {Error|null} error 错误对象
 * @returns {string} 'success' | 'error' | 'aborted' | 'timeout'
 */
export function deriveTransportOutcome(httpStatus, error) {
  // 1. 错误优先检查
  if (error) {
    // AbortError（客户端取消）
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      return 'aborted';
    }
    // TimeoutError（超时）
    if (error.name === 'TimeoutError') {
      return 'timeout';
    }
    // cause 链中的 AbortError
    if (error.cause && (error.cause.name === 'AbortError' || error.cause.code === 'ABORT_ERR')) {
      return 'aborted';
    }
    // cause 链中的 TimeoutError
    if (error.cause && error.cause.name === 'TimeoutError') {
      return 'timeout';
    }
  }

  // 2. HTTP 状态码检查
  if (typeof httpStatus === 'number') {
    if (httpStatus >= 200 && httpStatus < 300) {
      return 'success';
    }
    // 4xx（含 429）和 5xx 都属于传输错误
    if (httpStatus >= 400 && httpStatus < 600) {
      return 'error';
    }
  }

  // 3. 有错误但无 HTTP 状态码 → 网络错误
  if (error) {
    return 'error';
  }

  // 4. 无错误且无 HTTP 状态码 → 未知失败
  return 'error';
}

// ----------------------------------------------------------------------------
// 客户端取消判断
// ----------------------------------------------------------------------------

/**
 * 判断是否是客户端取消。
 *
 * 检查范围（兼容多种错误形态）：
 *   - ProviderError.type === ErrorType.CLIENT_ABORTED
 *   - AttemptRecord.errorType === ErrorType.CLIENT_ABORTED
 *   - error.name === 'AbortError'
 *   - error.message 包含 'aborted'
 *
 * @param {object|Error|null} error 错误对象（ProviderError、普通 Error 或 AttemptRecord）
 * @returns {boolean}
 */
export function isClientAborted(error) {
  if (!error) return false;
  // ProviderError 的 .type 字段
  if (error.type === ErrorType.CLIENT_ABORTED) return true;
  // AttemptRecord 的 .errorType 字段
  if (error.errorType === ErrorType.CLIENT_ABORTED) return true;
  // 标准 AbortError
  if (error.name === 'AbortError') return true;
  // Node.js 内部 abort 错误码
  if (error.code === 'ABORT_ERR') return true;
  // 消息包含 'aborted'（大小写不敏感）
  if (error.message && typeof error.message === 'string') {
    const msg = error.message.toLowerCase();
    if (msg.includes('aborted')) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Provider 故障判断
// ----------------------------------------------------------------------------

/**
 * 判断是否是 provider 故障（非模型质量）。
 *
 * provider 故障包括：
 *   - no_candidate：无可用候选
 *   - client_aborted：客户端取消
 *   - budget_exceeded：预算超限
 *   - provider_error：Provider 故障
 *   - client_error：客户端 4xx 错误
 *   - validation_failed：验证失败
 *
 * 模型质量问题（非 provider 故障）：
 *   - completed：成功完成
 *   - incomplete：响应不完整
 *
 * @param {string} outcome Outcome 枚举值
 * @param {object|Error|null} error 错误对象（可选，保留用于未来扩展）
 * @returns {boolean} true 表示是 provider 故障（非模型质量），false 表示是模型质量问题
 */
export function isProviderFault(outcome, error) {
  // 非 QUALITY_OUTCOMES 的都是 provider 故障
  return !QUALITY_OUTCOMES.has(outcome);
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  Outcome,
  QUALITY_OUTCOMES,
  shouldRecordQualityFeedback,
  deriveValidatedOutcome,
  deriveTransportOutcome,
  isClientAborted,
  isProviderFault,
};
