// src/protocols/chat.js
// Smart Router Mainline - Phase 1
// Chat Completions 非流式协议处理：处理 OpenAI 兼容的 /v1/chat/completions 非流式请求。
//
// 设计要点：
//   - Chat Completions 是原生协议，功能最完整
//   - 应用 Claude Code 兼容补丁（仅当 agent 为 Claude Code 时生效）
//   - 构建候选列表后交由 ExecutionEngine 串行 Fallback 执行
//   - 成功时读取上游响应体，清理 reasoning_content / thinking 泄漏（Claude Code）
//   - 从响应体提取 usage 信息，计算成本并写入审计记录
//   - 失败时按 outcome 映射 HTTP 状态码，返回 OpenAI 兼容错误响应
//   - 客户端取消时不发送响应（连接已断），仅收尾
//   - 无候选返回 503
//   - 所有请求经 finalizer 幂等收尾（以 requestId 去重）
//   - tool_calls 原样透传，不修改格式
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { buildCandidates } from '../router/candidates.js';
import {
  applyClaudeCodePatches,
  cleanReasoningContent,
  cleanThinkingProcessLeak,
} from '../agent/compatibility.js';
import { AttemptLog } from '../runtime/attempts.js';
import { Outcome, deriveValidatedOutcome } from '../runtime/outcomes.js';
import { getAgentModels, getAgentBudget } from '../agent/identity.js';
import { log } from '../config/loader.js';

// ----------------------------------------------------------------------------
// 日志
// ----------------------------------------------------------------------------

function protocolLog(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[chat-protocol][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------------------

/**
 * 从请求体中检测所需能力（如 vision）。
 * 遍历 messages，若任一 content block 为 image 类型则返回 'vision'。
 */
function detectCapability(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (
          block.type === 'image_url' ||
          block.type === 'image' ||
          block.type === 'input_image'
        ) {
          return 'vision';
        }
      }
    }
  }
  return null;
}

/**
 * 将 ExecutionResult.attempts（纯对象数组）转换为 AttemptLog 实例。
 *
 * 执行引擎返回的 attempts 是纯对象，而 Finalizer.finalize 需要 AttemptLog 实例
 * （调用 getSuccessful() / toJSON() / getCount()）。
 * 此函数做字段映射：
 *   - transportOutcome: 'success' -> 'success', 'error' -> 'error', 'skipped' -> null
 *   - validatedOutcome: 'success' -> 'completed', 'error' -> 'error', 'pending' -> null
 *   - error: { type, message, httpStatus } -> errorType + errorMessage + httpStatus
 *   - budgetBlocked: outcome === 'budget_blocked'
 */
function buildAttemptLogFromResult(executionResult, requestId) {
  const attemptLog = new AttemptLog(requestId);

  if (!executionResult || !Array.isArray(executionResult.attempts)) {
    return attemptLog;
  }

  for (const a of executionResult.attempts) {
    const record = attemptLog.addAttempt(
      a.model || null,
      a.provider || null,
      a.keyId || null,
    );

    // 传输层结果映射
    const transportOutcome =
      a.transportOutcome === 'success'
        ? 'success'
        : a.transportOutcome === 'error'
          ? 'error'
          : a.transportOutcome === 'aborted'
            ? 'aborted'
            : null;

    const httpStatus = a.error?.httpStatus ?? null;
    record.setTransportResult(transportOutcome, httpStatus, a.latencyMs || 0, null);

    // 验证层结果映射
    const validatedOutcome =
      a.validatedOutcome === 'success'
        ? 'completed'
        : a.validatedOutcome === 'error'
          ? 'error'
          : a.validatedOutcome === 'incomplete'
            ? 'incomplete'
            : null;
    if (validatedOutcome) {
      record.setValidatedResult(validatedOutcome);
    }

    // 错误信息
    if (a.error) {
      record.setError(a.error.type || null, a.error.message || null);
    }

    // 用量与成本
    if (a.usage || a.cost) {
      record.setUsage(a.usage || null, a.cost || null);
    }

    // 预算屏蔽标记
    if (a.outcome === 'budget_blocked') {
      record.markBudgetBlocked();
    }
  }

  return attemptLog;
}

/**
 * 将执行引擎的 outcome 映射为 Finalizer 使用的 Outcome 枚举值。
 */
function mapExecutionOutcome(executionOutcome) {
  switch (executionOutcome) {
    case 'completed':
      return Outcome.COMPLETED;
    case 'incomplete':
      return Outcome.INCOMPLETE;
    case 'no_candidate':
      return Outcome.NO_CANDIDATE;
    case 'client_aborted':
      return Outcome.CLIENT_ABORTED;
    case 'budget_exceeded':
      return Outcome.BUDGET_EXCEEDED;
    case 'provider_error':
      return Outcome.PROVIDER_ERROR;
    default:
      return Outcome.PROVIDER_ERROR;
  }
}

/**
 * 将 outcome 映射为 HTTP 状态码。
 */
function outcomeToHttpStatus(outcome) {
  switch (outcome) {
    case 'completed':
      return 200;
    case 'incomplete':
      return 502;
    case 'no_candidate':
      return 503;
    case 'client_aborted':
      return 499;
    case 'budget_exceeded':
      return 402;
    case 'provider_error':
      return 502;
    case 'client_error':
      return 400;
    case 'validation_failed':
      return 422;
    default:
      return 500;
  }
}

/**
 * 将内部错误类型映射为 OpenAI 兼容的 error.type。
 */
function errorToOpenAIType(errorType) {
  switch (errorType) {
    case 'auth_invalid':
      return 'authentication_error';
    case 'forbidden_key':
    case 'forbidden_model':
    case 'forbidden_provider':
    case 'forbidden_region':
    case 'forbidden_temp':
      return 'permission_denied';
    case 'rate_limit_transient':
    case 'rate_limit_quota':
      return 'rate_limit_exceeded';
    case 'server_error':
    case 'network_error':
      return 'server_error';
    case 'client_aborted':
      return 'client_closed';
    case 'budget_exceeded':
      return 'budget_exceeded';
    case 'service_unavailable':
      return 'service_unavailable';
    case 'invalid_request_error':
      return 'invalid_request_error';
    default:
      return 'internal_error';
  }
}

/**
 * 发送 JSON 响应。若响应头已发送或已结束则跳过。
 */
function sendJsonResponse(res, statusCode, data) {
  if (!res || res.headersSent || res.writableEnded) return;
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 从响应体中提取 usage 信息（OpenAI / Anthropic 格式兼容）。
 * 返回归一化后的 usage，含 prompt_tokens / completion_tokens / total_tokens。
 */
function extractUsageFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  const usage = body.usage;
  if (!usage || typeof usage !== 'object') return null;

  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    raw: { ...usage },
  };
}

/**
 * 检查 res 是否可写（未结束且未销毁）。
 */
function isResWritable(res) {
  return res && !res.writableEnded && !res.destroyed;
}

// ----------------------------------------------------------------------------
// 构建错误响应
// ----------------------------------------------------------------------------

/**
 * 构建 OpenAI 兼容的错误响应。
 *
 * 格式：{ error: { message, type, code, param } }
 *
 * @param {Error|object|null} error 错误对象（ProviderError、普通 Error 或纯对象）
 * @param {string} [requestId] 请求唯一标识（附加到错误响应中）
 * @returns {{ error: { message: string, type: string, code: string|null, param: null } }}
 */
export function buildErrorResponse(error, requestId) {
  if (!error) {
    return {
      error: {
        message: 'An unexpected error occurred',
        type: 'internal_error',
        code: null,
        param: null,
      },
    };
  }

  const message = error.message || String(error) || 'Unknown error';
  const errorType = error.type || error.errorType || 'unknown';
  const openaiType = errorToOpenAIType(errorType);
  const code = error.code || error.errorCode || null;

  return {
    error: {
      message,
      type: openaiType,
      code,
      param: null,
    },
  };
}

// ----------------------------------------------------------------------------
// 主处理函数
// ----------------------------------------------------------------------------

/**
 * 处理 Chat Completions 非流式请求。
 *
 * 流程：
 *   1. 解析请求体（model, messages, tools, stream 等）
 *   2. 应用 Claude Code 兼容补丁（如果 agent 是 Claude Code）
 *   3. 构建候选列表（buildCandidates）
 *   4. 执行（executionEngine.execute）
 *   5. 处理结果：成功 / 失败 / 取消 / 无候选
 *   6. 收尾（finalizer.finalize）
 *   7. 返回响应给客户端
 *
 * @param {import('http').IncomingMessage} req HTTP 请求对象
 * @param {import('http').ServerResponse} res HTTP 响应对象
 * @param {object} body 已解析的请求体（OpenAI 格式，含 model, messages, tools 等）
 * @param {object} context 上下文，含：
 *   - config {object} 已加载的配置
 *   - executionEngine {object} ExecutionEngine 实例
 *   - finalizer {object} Finalizer 实例
 *   - costTracker {object} CostTracker 实例
 *   - cancelToken {object} CancelToken 实例
 *   - agentInfo {object} Agent 身份信息
 */
export async function handleChatCompletion(req, res, body, context) {
  const {
    config,
    executionEngine,
    finalizer,
    costTracker,
    cancelToken,
    agentInfo,
  } = context;

  const requestId = context.requestId;
  const externalRequestId = req?.headers?.['x-request-id'] || req?.headers?.['x-correlation-id'] || null;
  const agentId = agentInfo?.agentId || 'generic';

  // 解析请求体（兼容字符串传入）
  let parsedBody = body;
  if (typeof body === 'string') {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      protocolLog(`[${requestId}] invalid JSON body`);
      sendJsonResponse(res, 400, buildErrorResponse(
        { message: 'Invalid JSON in request body', type: 'invalid_request_error' },
        requestId,
      ));
      return;
    }
  }

  try {
    // 1. 应用 Claude Code 兼容补丁
    const headers = req?.headers || {};
    const pathname = req?.url || '';
    const patchResult = applyClaudeCodePatches(headers, parsedBody, pathname);
    const patchedBody = patchResult.body;
    const isClaudeCode = patchResult.isClaudeCode;
    const requestedModel = patchedBody?.model || null;

    protocolLog(
      `[${requestId}] agent=${agentId} model=${requestedModel || 'auto'} ` +
      `claudeCode=${isClaudeCode} patches=[${patchResult.patches.join(',')}]`,
    );

    // 2. 构建候选列表
    const agentModels = getAgentModels(agentId, config);
    const budget = getAgentBudget(agentId, config);
    const capability = detectCapability(patchedBody);

    const candidates = buildCandidates(requestedModel, config, {
      agentId,
      agentModels,
      budget,
      capability,
      strictModel: budget.strictModel,
      health: executionEngine.health,
      circuitBreaker: executionEngine.circuitBreaker,
      keyPool: executionEngine.keyPool,
    });

    // 3b. Shadow 智能建议（执行前生成；await 保证建议落库后才执行；off 模式 no-op）
    //     无候选/预算拦截也记录；真实结果由 Finalizer 事务成功后观察钩子回填
    //     异步异常隔离（方案A）：await + try/catch + log shadow_error
    if (context.intelligence && typeof context.intelligence.suggest === 'function') {
      try {
        await context.intelligence.suggest({
          requestId,
          body: patchedBody,
          agentId,
          budget,
          candidates,
          protocol: context.protocol || 'chat',
        });
      } catch (_e) {
        // Shadow 层失败不影响主流程；错误必须有明确日志
        if (context.log && typeof context.log === 'function') {
          context.log(`[shadow_error] suggest failed for ${requestId}: ${_e.message}`);
        } else {
          process.stderr.write(`[shadow_error] suggest failed for ${requestId}: ${_e.message}\n`);
        }
      }
    }
    // 3. 无候选可用
    if (candidates.length === 0) {
      protocolLog(`[${requestId}] no candidates available`);
      await finalizer.finalizeRequestTransaction(
        requestId,
        new AttemptLog(requestId),
        Outcome.NO_CANDIDATE,
        {
          agentId,
          protocol: context.protocol || 'chat',
          requestedModel,
          externalRequestId: context.externalRequestId || null,
        }
      );

      if (!cancelToken?.isAborted() && isResWritable(res)) {
        sendJsonResponse(res, 503, buildErrorResponse(
          {
            message: `No available models for the requested model: ${requestedModel || 'auto'}`,
            type: 'service_unavailable',
          },
          requestId,
        ));
      }
      return;
    }

    // 4. 执行（串行 Fallback）
    const executionResult = await executionEngine.execute(candidates, patchedBody, {
      agentId,
      abortSignal: cancelToken?.signal || undefined,
      budget,
      protocol: context.protocol || 'chat',
      requestId,
      externalRequestId: context.externalRequestId || null,
      timeoutMs: config?.server?.request_timeout_ms,
    });


    // 5. 构建 AttemptLog（从执行引擎的纯对象数组转换为 AttemptLog 实例）
    const attemptLog = buildAttemptLogFromResult(executionResult, requestId);

    // 6. 处理执行结果
    if (executionResult.success) {
      await handleSuccess(
        res, executionResult, attemptLog, context, requestId, agentId,
        isClaudeCode, finalizer, costTracker, cancelToken,
      );
    } else {
      await handleFailure(
        res, executionResult, attemptLog, finalizer, requestId, agentId,
        cancelToken, context,
      );
    }
  } catch (err) {
    protocolLog(`[${requestId}] unhandled error: ${err.message}\n${err.stack}`);

    // 尝试收尾（防止审计记录丢失）
    try {
      await finalizer.finalizeRequestTransaction(
        requestId,
        new AttemptLog(requestId),
        Outcome.INTERNAL_ERROR,
        {
          agentId,
          protocol: context.protocol || 'chat',
          requestedModel: parsedBody?.model,
          externalRequestId: context.externalRequestId || null,
        }
      );
    } catch {
      // 收尾失败不影响错误响应
    }

    // 发送错误响应
    if (isResWritable(res)) {
      if (!res.headersSent) {
        sendJsonResponse(res, 500, buildErrorResponse(err, requestId));
      } else {
        res.end();
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 成功处理
// ----------------------------------------------------------------------------

/**
 * 处理执行成功的结果：读取响应体、清理、收尾、发送响应。
 *
 * 步骤：
 *   1. 读取上游响应体
 *   2. 解析 JSON
 *   3. Claude Code 响应清理（reasoning_content / thinking 泄漏）
 *   4. 推导验证结果（completed / incomplete）
 *   5. 提取 usage 并更新 AttemptLog
 *   6. 收尾（finalizer.finalize）
 *   7. 发送响应给客户端
 */
async function handleSuccess(
  res, executionResult, attemptLog, context, requestId, agentId,
  isClaudeCode, finalizer, costTracker, cancelToken,
) {
  let responseBodyText = '';
  let responseJson = null;
  let responseSize = 0;

  // 读取上游响应体
  try {
    responseBodyText = await executionResult.response.text();
    responseSize = Buffer.byteLength(responseBodyText);
    responseJson = JSON.parse(responseBodyText);
  } catch {
    // 响应体非 JSON，保留原始文本
    protocolLog(`[${requestId}] response body is not valid JSON, sending raw text`);
  }

  // Claude Code 响应清理
  if (isClaudeCode && responseJson && typeof responseJson === 'object') {
    // 清理 reasoning_content 字段
    responseJson = cleanReasoningContent(responseJson);

    // 清理思维链泄漏（"Thinking Process:" 等）
    if (Array.isArray(responseJson.choices)) {
      for (const choice of responseJson.choices) {
        if (choice?.message?.content && typeof choice.message.content === 'string') {
          choice.message.content = cleanThinkingProcessLeak(choice.message.content);
        }
      }
    }
  }

  // 推导验证结果（completed / incomplete）
  const validatedOutcome = deriveValidatedOutcome(executionResult, responseJson);
  const outcome = validatedOutcome === 'incomplete'
    ? Outcome.INCOMPLETE
    : Outcome.COMPLETED;

  // 从响应体提取 usage（使用正确格式，覆盖执行引擎可能不准确的 usage）
  const extractedUsage = extractUsageFromBody(responseJson);
  if (extractedUsage) {
    const successfulAttempt = attemptLog.getSuccessful();
    if (successfulAttempt) {
      const modelForCost = executionResult.finalCandidate?.model
        || executionResult.finalCandidate?.modelId;
      const calculatedCost = costTracker
        ? costTracker.calculateCost(modelForCost, extractedUsage)
        : null;
      successfulAttempt.setUsage(extractedUsage, calculatedCost);
    }
  }

  // 收尾（使用事务：finalizeRequestTransaction 或回退到 finalize）
  const finalizeMethod = (typeof finalizer.finalizeRequestTransaction === 'function')
    ? finalizer.finalizeRequestTransaction.bind(finalizer)
    : finalizer.finalize.bind(finalizer);
  await finalizeMethod(requestId, attemptLog, outcome, {
    model: executionResult.finalCandidate?.modelId,
    provider: executionResult.finalCandidate?.provider,
    agentId,
    protocol: context.protocol || 'chat',
    responseSize,
  });

  // 发送响应给客户端
  if (!cancelToken?.isAborted() && isResWritable(res)) {
    const responseStr = responseJson
      ? JSON.stringify(responseJson)
      : responseBodyText;
    const statusCode = executionResult.response.status || 200;
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(responseStr),
    });
    res.end(responseStr);
  }
}

// ----------------------------------------------------------------------------
// 失败处理
// ----------------------------------------------------------------------------

/**
 * 处理执行失败的结果：收尾、发送错误响应。
 *
 * - client_aborted：客户端已断开，不发送响应
 * - no_candidate：503 Service Unavailable
 * - budget_exceeded：402 Payment Required
 * - provider_error / incomplete：502 Bad Gateway
 */
async function handleFailure(
  res, executionResult, attemptLog, finalizer, requestId, agentId,
  cancelToken, context,
) {
  const outcome = mapExecutionOutcome(executionResult.outcome);

  // 收尾（使用事务）
  const finalizeMethod = (typeof finalizer.finalizeRequestTransaction === 'function')
    ? finalizer.finalizeRequestTransaction.bind(finalizer)
    : finalizer.finalize.bind(finalizer);
  await finalizeMethod(requestId, attemptLog, outcome, {
    model: executionResult.finalCandidate?.modelId,
    provider: executionResult.finalCandidate?.provider,
    agentId,
    protocol: context?.protocol || 'chat',
  });

  // 客户端已断开：不发送响应
  if (executionResult.outcome === 'client_aborted') {
    protocolLog(`[${requestId}] client aborted, not sending response`);
    if (isResWritable(res)) {
      res.end();
    }
    return;
  }

  // 客户端在收尾期间断开
  if (cancelToken?.isAborted() || !isResWritable(res)) {
    protocolLog(`[${requestId}] client disconnected before error response`);
    return;
  }

  // 发送错误响应
  const status = outcomeToHttpStatus(executionResult.outcome);
  const error = executionResult.error || {
    message: `Request failed: ${executionResult.outcome}`,
    type: outcomeToOpenAIType(executionResult.outcome),
  };
  sendJsonResponse(res, status, buildErrorResponse(error, requestId));
}

/**
 * 将 execution outcome 映射为 OpenAI 兼容的 error.type（无上游 error 时的兜底归因）。
 */
function outcomeToOpenAIType(outcome) {
  switch (outcome) {
    case 'budget_exceeded':
      return 'budget_exceeded';
    case 'no_candidate':
      return 'service_unavailable';
    case 'provider_error':
    case 'incomplete':
      return 'server_error';
    case 'client_aborted':
      return 'client_closed';
    default:
      return 'internal_error';
  }
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  handleChatCompletion,
  buildErrorResponse,
};
