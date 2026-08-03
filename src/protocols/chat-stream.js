// src/protocols/chat-stream.js
// Smart Router Mainline - Phase 1
// Chat Completions 流式 SSE 协议处理：处理 OpenAI 兼容的 /v1/chat/completions 流式请求。
//
// 设计要点：
//   - 透传上游 SSE 流：逐 chunk 读取上游响应体，原样写入客户端
//   - 首字节后禁止切换模型：首字节到达后标记 firstByteReceived（由执行引擎保证）
//   - 客户端取消立即停止上游：cancelToken.signal 传递给 fetch，客户端断开时上游立即 abort
//   - 异常 EOF 不记为 completed：流未正常结束（无 [DONE] 或连接断开）标记 incomplete
//   - [DONE] 正确检测：SSE 流的最后一个 data 为 [DONE]
//   - tool_calls 正确透传：不修改 SSE chunk 格式
//   - usage 信息提取：从最后一个含 usage 的 chunk 提取
//   - strict 模型不被改变：buildCandidates 中 strictModel=true
//   - 在流末尾收尾（finalize）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { buildCandidates } from '../router/candidates.js';
import { applyClaudeCodePatches } from '../agent/compatibility.js';
import { AttemptLog } from '../runtime/attempts.js';
import { Outcome } from '../runtime/outcomes.js';
import { getAgentModels, getAgentBudget } from '../agent/identity.js';
import { isAbortError } from '../runtime/cancellation.js';
import { buildErrorResponse } from './chat.js';

// ----------------------------------------------------------------------------
// 日志
// ----------------------------------------------------------------------------

function protocolLog(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[chat-stream-protocol][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// 辅助函数（与 chat.js 共享逻辑的本地副本，保持模块独立性）
// ----------------------------------------------------------------------------

/**
 * 从请求体中检测所需能力（如 vision）。
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

    if (a.error) {
      record.setError(a.error.type || null, a.error.message || null);
    }

    if (a.usage || a.cost) {
      record.setUsage(a.usage || null, a.cost || null);
    }

    if (a.outcome === 'budget_blocked') {
      record.markBudgetBlocked();
    }
  }

  return attemptLog;
}

/**
 * 将执行引擎的 outcome 映射为 Outcome 枚举值。
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
    default:
      return 500;
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
 * 设置 SSE 响应头。
 */
function setSSEResponseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

/**
 * 以 SSE 格式发送错误事件。
 * 用于流已开始（SSE 头已发送）后需要发送错误的情况。
 */
function sendSSEError(res, error) {
  if (!res || res.writableEnded) return;
  const errorData = JSON.stringify({
    error: {
      message: error?.message || 'Stream error',
      type: 'stream_error',
      code: null,
      param: null,
    },
  });
  try {
    res.write(`data: ${errorData}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch {
    // 写入失败（客户端可能已断开）
  }
}

/**
 * 检查 res 是否可写。
 */
function isResWritable(res) {
  return res && !res.writableEnded && !res.destroyed;
}

// ----------------------------------------------------------------------------
// SSE 解析工具
// ----------------------------------------------------------------------------

/**
 * 解析 SSE chunk，返回事件数组。
 *
 * 将 Buffer 或字符串解析为 SSE 事件。按双换行（\n\n）分隔事件块，
 * 每个块内按行解析字段（data / event / id）。
 *
 * 多行 data 字段会拼接为换行分隔的字符串（符合 SSE 规范）。
 * 以冒号开头的行视为注释，跳过。
 *
 * @param {Buffer|string} chunk SSE 数据块
 * @returns {Array<{ data: string|null, event: string|null, id: string|null }>}
 */
export function parseSSEChunk(chunk) {
  if (!chunk) return [];

  const text = Buffer.isBuffer(chunk)
    ? chunk.toString('utf8')
    : String(chunk);

  if (!text) return [];

  // 统一换行符
  const normalized = text.replace(/\r\n/g, '\n');

  // 按双换行分隔事件块
  const blocks = normalized.split('\n\n');
  const events = [];

  for (const block of blocks) {
    if (!block.trim()) continue;

    const event = { data: null, event: null, id: null };
    const lines = block.split('\n');

    for (const line of lines) {
      // 空行或注释行跳过
      if (!line || line.startsWith(':')) continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const field = line.slice(0, colonIdx);
      let value = line.slice(colonIdx + 1);
      // 移除值的前导空格（SSE 规范）
      if (value.startsWith(' ')) value = value.slice(1);

      switch (field) {
        case 'data':
          // 多行 data 拼接（换行分隔，符合 SSE 规范）
          event.data = event.data === null ? value : event.data + '\n' + value;
          break;
        case 'event':
          event.event = value;
          break;
        case 'id':
          event.id = value;
          break;
        // 其他字段（retry 等）忽略
      }
    }

    // 仅返回有实际内容的事件
    if (event.data !== null || event.event !== null) {
      events.push(event);
    }
  }

  return events;
}

/**
 * 检测 [DONE] 标记。
 *
 * SSE 流的最后一个 data 行为 [DONE] 时表示流结束。
 *
 * @param {string|null} data SSE 事件的 data 字段
 * @returns {boolean}
 */
export function isDoneMarker(data) {
  if (!data) return false;
  const trimmed = String(data).trim();
  return trimmed === '[DONE]';
}

// ----------------------------------------------------------------------------
// SSE 流透传
// ----------------------------------------------------------------------------

/**
 * 异步迭代器：统一读取 Web ReadableStream 和 Node.js readable stream。
 */
async function* iterateBody(body) {
  if (!body) return;

  if (typeof body.getReader === 'function') {
    // Web ReadableStream（Node.js 20+ fetch 返回的类型）
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 忽略释放锁异常
      }
    }
  } else if (typeof body[Symbol.asyncIterator] === 'function') {
    // Node.js readable stream（兼容旧版或非标准实现）
    yield* body;
  } else {
    throw new Error('unsupported response body type');
  }
}

/**
 * 透传 SSE 流：逐 chunk 读取上游响应体，原样写入客户端。
 *
 * 功能：
 *   - 逐 chunk 读取上游响应体
 *   - 透传给客户端（不修改 chunk 内容，tool_calls 原样透传）
 *   - 检测 [DONE] 标记
 *   - 检测异常 EOF（流未正常结束就断开）
 *   - 首字节回调（onFirstByte）
 *   - 完成回调（onComplete）
 *   - 错误回调（onError）
 *   - 客户端取消检测（cancelToken）
 *   - 从含 usage 的 chunk 提取 usage 信息
 *
 * @param {Response} upstreamResponse 上游 fetch Response
 * @param {import('http').ServerResponse} res 客户端响应对象
 * @param {object} [options]
 * @param {() => void} [options.onFirstByte] 首字节回调
 * @param {(result: object) => void} [options.onComplete] 完成回调
 * @param {(error: Error) => void} [options.onError] 错误回调
 * @param {object} [options.cancelToken] CancelToken 实例
 * @returns {Promise<{ completed: boolean, bytesTransferred: number, hadDone: boolean, hadError: boolean, lastUsage: object|null, clientAborted: boolean }>}
 */
export async function pipeSSEStream(upstreamResponse, res, options = {}) {
  const { onFirstByte, onComplete, onError, cancelToken } = options;

  let bytesTransferred = 0;
  let hadDone = false;
  let hadError = false;
  let completed = false;
  let firstByteReceived = false;
  let lastUsage = null;
  let clientAborted = false;
  let sseBuffer = '';

  // 注册取消监听
  const cancelUnsub = cancelToken?.onCancel(() => {
    clientAborted = true;
  });

  try {
    const body = upstreamResponse?.body;
    if (!body) {
      hadError = true;
      const err = new Error('upstream response has no body');
      if (onError) onError(err);
      return {
        completed: false,
        bytesTransferred,
        hadDone,
        hadError,
        lastUsage,
        clientAborted,
      };
    }

    // 逐 chunk 读取上游响应体
    for await (const value of iterateBody(body)) {
      // 客户端已取消：停止读取
      if (clientAborted || cancelToken?.isAborted()) {
        protocolLog('client aborted during SSE piping, stopping');
        break;
      }

      // 首字节回调
      if (!firstByteReceived) {
        firstByteReceived = true;
        if (onFirstByte) onFirstByte();
      }

      // 转换为 Buffer
      const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);

      // 透传给客户端（不修改内容）
      try {
        res.write(buf);
      } catch (writeErr) {
        // 写入失败：客户端可能已断开
        protocolLog(`write error during SSE piping: ${writeErr.message}`);
        clientAborted = true;
        break;
      }
      bytesTransferred += buf.length;

      // 解析 SSE 事件以检测 [DONE] 和提取 usage
      const chunkStr = buf.toString('utf8');
      sseBuffer += chunkStr;

      // 提取完整事件（以 \n\n 分隔）
      while (true) {
        const idx = sseBuffer.indexOf('\n\n');
        if (idx === -1) break;

        const block = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);

        const events = parseSSEChunk(block);
        for (const evt of events) {
          // 检测 [DONE]
          if (isDoneMarker(evt.data)) {
            hadDone = true;
          }

          // 提取 usage（从含 usage 字段的 chunk 中提取，保留最后一个）
          if (evt.data && !isDoneMarker(evt.data)) {
            try {
              const parsed = JSON.parse(evt.data);
              if (parsed.usage) {
                lastUsage = parsed.usage;
              }
            } catch {
              // 非 JSON 数据，跳过
            }
          }
        }
      }
    }

    // 处理缓冲区中剩余的不完整事件
    if (sseBuffer.trim()) {
      const events = parseSSEChunk(sseBuffer);
      for (const evt of events) {
        if (isDoneMarker(evt.data)) {
          hadDone = true;
        }
        if (evt.data && !isDoneMarker(evt.data)) {
          try {
            const parsed = JSON.parse(evt.data);
            if (parsed.usage) {
              lastUsage = parsed.usage;
            }
          } catch {
            // 非 JSON 数据，跳过
          }
        }
      }
    }

    // 判断流是否正常完成
    if (!clientAborted && !hadError) {
      // 流正常结束（reader 返回 done）且未出错
      // completed = true 表示流正常结束（不论是否有 [DONE]）
      // hadDone 单独标记是否检测到 [DONE]
      completed = true;
    }
  } catch (err) {
    // 区分客户端取消和其他错误
    if (clientAborted || cancelToken?.isAborted() || isAbortError(err)) {
      clientAborted = true;
      protocolLog(`SSE piping aborted: ${err.message}`);
    } else {
      hadError = true;
      protocolLog(`SSE piping error: ${err.message}`);
      if (onError) onError(err);
    }
  } finally {
    // 注销取消监听
    if (cancelUnsub) cancelUnsub();
  }

  // 客户端取消的流不标记为 completed
  if (clientAborted) {
    completed = false;
  }

  // 完成回调
  if (onComplete) {
    onComplete({
      completed,
      bytesTransferred,
      hadDone,
      hadError,
      lastUsage,
      clientAborted,
    });
  }

  return {
    completed,
    bytesTransferred,
    hadDone,
    hadError,
    lastUsage,
    clientAborted,
  };
}

// ----------------------------------------------------------------------------
// 主处理函数
// ----------------------------------------------------------------------------

/**
 * 处理 Chat Completions 流式 SSE 请求。
 *
 * 流程：
 *   1. 解析请求体
 *   2. 应用 Claude Code 兼容补丁
 *   3. 构建候选列表
 *   4. 执行（executionEngine.execute）
 *   5. 设置 SSE 响应头
 *   6. 透传上游 SSE 流（pipeSSEStream）
 *   7. 处理 [DONE] / 异常 EOF / 客户端取消
 *   8. 提取 usage，计算成本
 *   9. 在流末尾收尾（finalize）
 *
 * @param {import('http').IncomingMessage} req HTTP 请求对象
 * @param {import('http').ServerResponse} res HTTP 响应对象
 * @param {object} body 已解析的请求体
 * @param {object} context 上下文（含 config, executionEngine, finalizer, costTracker, cancelToken, agentInfo）
 */
export async function handleChatCompletionStream(req, res, body, context) {
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
    const requestedModel = patchedBody?.model || null;

    protocolLog(
      `[${requestId}] stream agent=${agentId} model=${requestedModel || 'auto'} ` +
      `claudeCode=${patchResult.isClaudeCode}`,
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


    // 5. 构建 AttemptLog
    const attemptLog = buildAttemptLogFromResult(executionResult, requestId);

    // 6. 处理执行结果
    if (executionResult.success) {
      await handleStreamSuccess(
        res, executionResult, attemptLog, context, requestId, agentId,
        finalizer, costTracker, cancelToken,
      );
    } else {
      await handleStreamFailure(
        res, executionResult, attemptLog, finalizer, requestId, agentId,
        cancelToken,
      );
    }
  } catch (err) {
    protocolLog(`[${requestId}] unhandled error: ${err.message}\n${err.stack}`);

    // 尝试收尾
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
        // SSE 头未发送：发送 HTTP 错误响应
        sendJsonResponse(res, 500, buildErrorResponse(err, requestId));
      } else {
        // SSE 头已发送：以 SSE 错误事件通知客户端
        sendSSEError(res, err);
        res.end();
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 流式成功处理
// ----------------------------------------------------------------------------

/**
 * 处理流式执行成功的结果：设置 SSE 头、透传流、提取 usage、收尾。
 *
 * 关键设计：
 *   - 首字节后禁止切换模型：由执行引擎保证（收到 Response 即标记 firstByteReceived）
 *   - 客户端取消立即停止上游：cancelToken.signal 已传递给 fetch
 *   - 异常 EOF 不记为 completed：流未正常结束标记 incomplete
 *   - [DONE] 正确检测：SSE 流的最后一个 data 为 [DONE]
 *   - usage 从最后一个含 usage 的 chunk 提取
 */
async function handleStreamSuccess(
  res, executionResult, attemptLog, context, requestId, agentId,
  finalizer, costTracker, cancelToken,
) {
  let firstByteReceived = false;

  // 设置 SSE 响应头
  setSSEResponseHeaders(res);

  // 透传上游 SSE 流
  const pipeResult = await pipeSSEStream(executionResult.response, res, {
    onFirstByte: () => {
      firstByteReceived = true;
      protocolLog(`[${requestId}] first byte received, model switching disabled`);
    },
    cancelToken,
  });

  // 结束响应
  if (isResWritable(res)) {
    try {
      res.end();
    } catch {
      // 客户端可能已断开
    }
  }

  // 确定最终 outcome
  let outcome;
  if (pipeResult.clientAborted || cancelToken?.isAborted()) {
    // 客户端取消
    outcome = Outcome.CLIENT_ABORTED;
    protocolLog(`[${requestId}] stream client aborted, bytes=${pipeResult.bytesTransferred}`);
  } else if (pipeResult.hadError) {
    // 流错误
    outcome = Outcome.INCOMPLETE;
    protocolLog(`[${requestId}] stream error, bytes=${pipeResult.bytesTransferred}`);
  } else if (pipeResult.completed && pipeResult.hadDone) {
    // 流正常完成且检测到 [DONE]
    outcome = Outcome.COMPLETED;
    protocolLog(
      `[${requestId}] stream completed, bytes=${pipeResult.bytesTransferred} ` +
      `done=${pipeResult.hadDone}`,
    );
  } else {
    // 流结束但未检测到 [DONE]（异常 EOF）
    outcome = Outcome.INCOMPLETE;
    protocolLog(
      `[${requestId}] stream incomplete (no [DONE]), bytes=${pipeResult.bytesTransferred}`,
    );
  }

  // 从 SSE 流提取 usage，更新 AttemptLog 并计算成本
  if (pipeResult.lastUsage) {
    const successfulAttempt = attemptLog.getSuccessful();
    if (successfulAttempt) {
      const modelForCost = executionResult.finalCandidate?.model
        || executionResult.finalCandidate?.modelId;
      const calculatedCost = costTracker
        ? costTracker.calculateCost(modelForCost, pipeResult.lastUsage)
        : null;
      successfulAttempt.setUsage(pipeResult.lastUsage, calculatedCost);
      protocolLog(
        `[${requestId}] usage extracted from stream: ` +
        `prompt=${pipeResult.lastUsage.prompt_tokens ?? pipeResult.lastUsage.input_tokens ?? 0} ` +
        `completion=${pipeResult.lastUsage.completion_tokens ?? pipeResult.lastUsage.output_tokens ?? 0}`,
      );
    }
  } else {
    protocolLog(`[${requestId}] no usage found in SSE stream`);
  }

  // 更新最后一个成功 attempt 的 validatedOutcome 以匹配最终结果
  const lastAttempt = attemptLog.getLast();
  if (lastAttempt && lastAttempt.transportOutcome === 'success') {
    if (outcome === Outcome.COMPLETED) {
      lastAttempt.setValidatedResult('completed');
    } else if (outcome === Outcome.INCOMPLETE) {
      lastAttempt.setValidatedResult('incomplete');
    } else if (outcome === Outcome.CLIENT_ABORTED) {
      lastAttempt.setValidatedResult('incomplete');
      lastAttempt.transportOutcome = 'aborted';
    }
  }

  // 收尾（幂等：以 requestId 去重）
  const finalizeMethod = (typeof finalizer.finalizeRequestTransaction === 'function')
    ? finalizer.finalizeRequestTransaction.bind(finalizer)
    : finalizer.finalize.bind(finalizer);
  await finalizeMethod(requestId, attemptLog, outcome, {
    model: executionResult.finalCandidate?.modelId,
    provider: executionResult.finalCandidate?.provider,
    agentId,
    protocol: context.protocol || 'chat',
    responseSize: pipeResult.bytesTransferred,
  });
}

// ----------------------------------------------------------------------------
// 流式失败处理
// ----------------------------------------------------------------------------

/**
 * 处理流式执行失败的结果：收尾、发送错误响应。
 *
 * 执行失败时 SSE 头尚未发送，可以发送 HTTP 错误响应（JSON 格式）。
 */
async function handleStreamFailure(
  res, executionResult, attemptLog, finalizer, requestId, agentId,
  cancelToken,
) {
  const outcome = mapExecutionOutcome(executionResult.outcome);

  // 收尾
  const finalizeMethod = (typeof finalizer.finalizeRequestTransaction === 'function')
    ? finalizer.finalizeRequestTransaction.bind(finalizer)
    : finalizer.finalize.bind(finalizer);
  await finalizeMethod(requestId, attemptLog, outcome, {
    model: executionResult.finalCandidate?.modelId,
    provider: executionResult.finalCandidate?.provider,
    agentId,
    protocol: context.protocol || 'chat',
  });

  // 客户端已断开：不发送响应
  if (executionResult.outcome === 'client_aborted') {
    protocolLog(`[${requestId}] client aborted before stream start`);
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

  // 发送错误响应（SSE 头未发送，使用 JSON 格式）
  const status = outcomeToHttpStatus(executionResult.outcome);
  const error = executionResult.error || {
    message: `Request failed: ${executionResult.outcome}`,
    type: 'internal_error',
  };
  sendJsonResponse(res, status, buildErrorResponse(error, requestId));
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  handleChatCompletionStream,
  pipeSSEStream,
  parseSSEChunk,
  isDoneMarker,
};
