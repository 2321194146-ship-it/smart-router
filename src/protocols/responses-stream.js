// src/protocols/responses-stream.js
// Smart Router Mainline - Phase 1
// Responses API 流式 SSE 协议处理：处理 OpenAI 兼容的 /v1/responses 流式请求。
//
// 设计要点：
//   - 上游 Provider 返回 Chat Completions SSE 流，需转换为 Responses API SSE 事件流
//   - 逐 chunk 读取上游 Chat SSE 流，通过状态机转换为 Responses 事件
//   - 事件类型：response.created / response.output_item.added / response.output_item.done /
//     response.content_part.added / response.content_part.done /
//     response.output_text.delta / response.output_text.done /
//     response.function_call_arguments.delta / response.function_call_arguments.done /
//     response.completed / response.incomplete
//   - 首字节后禁止切换模型（由执行引擎保证）
//   - 客户端取消立即停止上游（cancelToken.signal 传递给 fetch）
//   - 异常 EOF 时发送 response.incomplete 事件
//   - usage 信息从 Chat 格式转换为 Responses 格式
//   - 在流末尾收尾（finalize）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { buildCandidates } from '../router/candidates.js';
import { applyClaudeCodePatches } from '../agent/compatibility.js';
import { AttemptLog } from '../runtime/attempts.js';
import { Outcome } from '../runtime/outcomes.js';
import { getAgentModels, getAgentBudget } from '../agent/identity.js';
import { isAbortError } from '../runtime/cancellation.js';
import { parseSSEChunk, isDoneMarker } from './chat-stream.js';
import { responsesToChat, buildResponsesError } from './responses.js';

// ----------------------------------------------------------------------------
// 日志
// ----------------------------------------------------------------------------

function protocolLog(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[responses-stream-protocol][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// 辅助函数
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
 * 检查 res 是否可写。
 */
function isResWritable(res) {
  return res && !res.writableEnded && !res.destroyed;
}

/**
 * 生成简短唯一 ID。
 */
function generateItemId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ----------------------------------------------------------------------------
// SSE 流读取
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
    // Node.js readable stream
    yield* body;
  } else {
    throw new Error('unsupported response body type');
  }
}

// ----------------------------------------------------------------------------
// Responses SSE 事件格式化
// ----------------------------------------------------------------------------

/**
 * 将 Responses 事件对象格式化为 SSE 字符串。
 *
 * 格式：
 *   event: {type}\n
 *   data: {json}\n\n
 *
 * @param {object} event - 事件对象（包含 type 字段和其他数据）
 * @returns {string} SSE 格式字符串
 */
function formatResponsesSSE(event) {
  const type = event.type;
  const data = JSON.stringify(event);
  return `event: ${type}\ndata: ${data}\n\n`;
}

// ----------------------------------------------------------------------------
// 流转换状态机
// ----------------------------------------------------------------------------

/**
 * 创建流转换状态。
 *
 * 状态字段说明：
 *   - responseCreated: response.created 事件是否已发送
 *   - responseId: 响应 ID（从上游 SSE chunk 的 id 字段获取）
 *   - model: 模型名称（从上游 SSE chunk 的 model 字段获取）
 *   - createdAt: 响应创建时间戳
 *   - currentMessageIndex: 当前打开的 message output item 的索引（-1 = 未打开）
 *   - currentContentIndex: 当前打开的 content part 的索引（-1 = 未打开）
 *   - messageId: 当前 message item 的 ID
 *   - accumulatedText: 当前 content part 累积的文本
 *   - toolCallStates: Map<toolCallIndex, { outputIndex, itemId, callId, name, arguments, done }>
 *   - currentToolCallIndex: 当前正在流式传输的 tool call 索引（-1 = 无）
 *   - nextOutputIndex: 下一个 output item 的索引
 *   - outputItems: 所有已完成的 output items（用于 response.completed/incomplete）
 *   - finishReason: finish_reason
 *   - usage: 从上游提取的 usage
 *   - completed: response.completed 是否已发送
 *   - incomplete: response.incomplete 是否已发送
 *
 * @returns {object} 初始状态对象
 */
function createStreamState() {
  return {
    responseCreated: false,
    responseId: null,
    model: null,
    createdAt: Math.floor(Date.now() / 1000),
    currentMessageIndex: -1,
    currentContentIndex: -1,
    messageId: null,
    accumulatedText: '',
    toolCallStates: new Map(),
    currentToolCallIndex: -1,
    nextOutputIndex: 0,
    outputItems: [],
    finishReason: null,
    usage: null,
    completed: false,
    incomplete: false,
  };
}

/**
 * 关闭当前打开的 message output item。
 *
 * 生成以下事件：
 *   - response.output_text.done
 *   - response.content_part.done
 *   - response.output_item.done
 *
 * 并将完成的 item 添加到 state.outputItems。
 *
 * @param {object} state - 流转换状态
 * @param {Array} events - 事件输出数组
 */
function closeCurrentMessage(state, events) {
  if (state.currentMessageIndex === -1) return;

  const text = state.accumulatedText;
  const outputIndex = state.currentMessageIndex;
  const contentIndex = state.currentContentIndex;

  events.push({
    type: 'response.output_text.done',
    output_index: outputIndex,
    content_index: contentIndex,
    text,
  });

  events.push({
    type: 'response.content_part.done',
    output_index: outputIndex,
    content_index: contentIndex,
    part: { type: 'output_text', text },
  });

  const messageItem = {
    type: 'message',
    id: state.messageId,
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };

  events.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: messageItem,
  });

  state.outputItems.push(messageItem);

  // 重置 message 状态
  state.currentMessageIndex = -1;
  state.currentContentIndex = -1;
  state.messageId = null;
  state.accumulatedText = '';
}

/**
 * 关闭当前打开的 tool call output item。
 *
 * 生成以下事件：
 *   - response.function_call_arguments.done
 *   - response.output_item.done
 *
 * 并将完成的 item 添加到 state.outputItems。
 *
 * @param {object} state - 流转换状态
 * @param {Array} events - 事件输出数组
 */
function closeCurrentToolCall(state, events) {
  if (state.currentToolCallIndex === -1) return;

  const tcState = state.toolCallStates.get(state.currentToolCallIndex);
  if (!tcState || tcState.done) {
    state.currentToolCallIndex = -1;
    return;
  }

  events.push({
    type: 'response.function_call_arguments.done',
    output_index: tcState.outputIndex,
    arguments: tcState.arguments,
  });

  const fcItem = {
    type: 'function_call',
    id: tcState.itemId,
    call_id: tcState.callId,
    name: tcState.name,
    arguments: tcState.arguments,
  };

  events.push({
    type: 'response.output_item.done',
    output_index: tcState.outputIndex,
    item: fcItem,
  });

  state.outputItems.push(fcItem);
  tcState.done = true;
  state.currentToolCallIndex = -1;
}

/**
 * 关闭所有未完成的 tool call。
 *
 * @param {object} state - 流转换状态
 * @param {Array} events - 事件输出数组
 */
function closeAllToolCalls(state, events) {
  for (const [idx, tcState] of state.toolCallStates) {
    if (!tcState.done) {
      state.currentToolCallIndex = idx;
      closeCurrentToolCall(state, events);
    }
  }
  state.currentToolCallIndex = -1;
}

// ----------------------------------------------------------------------------
// 核心转换：Chat SSE delta → Responses 事件
// ----------------------------------------------------------------------------

/**
 * 将 Chat SSE chunk 转换为 Responses 事件数组。
 *
 * 状态机逻辑：
 *   1. 第一个 chunk（含 role / content / tool_calls）：
 *      - 发送 response.created
 *      - 若有 content：发送 output_item.added (message) + content_part.added + output_text.delta
 *      - 若有 tool_calls：发送 output_item.added (function_call) + function_call_arguments.delta
 *   2. 后续 content delta：发送 output_text.delta
 *   3. tool_call delta（新 index）：
 *      - 关闭当前 message（如有）
 *      - 关闭前一个 tool call（如有）
 *      - 发送 output_item.added (function_call) + function_call_arguments.delta
 *   4. tool_call delta（同 index）：发送 function_call_arguments.delta
 *   5. finish_reason：
 *      - 关闭当前 message（如有）
 *      - 关闭所有 tool call（如有）
 *      - 发送 response.completed
 *
 * @param {object} chunk - 解析后的 Chat SSE 数据（含 choices[0].delta, finish_reason, usage 等）
 * @param {object} state - 流转换状态（会被修改）
 * @param {object} [context] - 上下文（含 originalBody）
 * @returns {Array<object>} Responses 事件数组
 */
export function chatDeltaToResponsesEvents(chunk, state, context = {}) {
  const events = [];
  const { originalBody } = context;

  // 提取 delta 信息
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta;
  const finishReason = choice?.finish_reason;

  // 更新 state 中的元信息
  if (chunk?.id) state.responseId = chunk.id;
  if (chunk?.model) state.model = chunk.model;
  if (chunk?.usage) state.usage = chunk.usage;

  const effectiveResponseId = state.responseId || generateItemId('resp');
  const effectiveModel = state.model || originalBody?.model || 'unknown';

  // ----------------------------------------------------------
  // 1. 首次收到 chunk：发送 response.created
  // ----------------------------------------------------------
  if (!state.responseCreated) {
    state.responseCreated = true;
    events.push({
      type: 'response.created',
      response: {
        id: effectiveResponseId,
        object: 'response',
        created_at: state.createdAt,
        model: effectiveModel,
        output: [],
        status: 'in_progress',
        usage: null,
      },
    });
  }

  // ----------------------------------------------------------
  // 2. 处理 content delta
  // ----------------------------------------------------------
  if (delta && delta.content !== undefined && delta.content !== null) {
    // 如果当前没有打开的 message，创建一个新的
    if (state.currentMessageIndex === -1) {
      state.currentMessageIndex = state.nextOutputIndex++;
      state.currentContentIndex = 0;
      state.accumulatedText = '';
      state.messageId = generateItemId('msg');

      events.push({
        type: 'response.output_item.added',
        output_index: state.currentMessageIndex,
        item: {
          type: 'message',
          id: state.messageId,
          role: 'assistant',
          content: [],
        },
      });

      events.push({
        type: 'response.content_part.added',
        output_index: state.currentMessageIndex,
        content_index: state.currentContentIndex,
        part: { type: 'output_text', text: '' },
      });
    }

    // 发送 text delta
    const textDelta = String(delta.content);
    state.accumulatedText += textDelta;

    events.push({
      type: 'response.output_text.delta',
      output_index: state.currentMessageIndex,
      content_index: state.currentContentIndex,
      delta: textDelta,
    });
  }

  // ----------------------------------------------------------
  // 3. 处理 tool_calls delta
  // ----------------------------------------------------------
  if (delta && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;

      const tcIndex = typeof tc.index === 'number' ? tc.index : 0;

      // 如果当前有打开的 message，先关闭它
      if (state.currentMessageIndex !== -1) {
        closeCurrentMessage(state, events);
      }

      // 检查是否是新 tool call
      let tcState = state.toolCallStates.get(tcIndex);
      if (!tcState) {
        // 如果有前一个未关闭的 tool call，先关闭它
        if (state.currentToolCallIndex !== -1 && state.currentToolCallIndex !== tcIndex) {
          closeCurrentToolCall(state, events);
        }

        // 创建新的 tool call
        const outputIndex = state.nextOutputIndex++;
        tcState = {
          outputIndex,
          itemId: generateItemId('fc'),
          callId: tc.id || generateItemId('call'),
          name: tc.function?.name || '',
          arguments: '',
          done: false,
        };
        state.toolCallStates.set(tcIndex, tcState);
        state.currentToolCallIndex = tcIndex;

        events.push({
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            type: 'function_call',
            id: tcState.itemId,
            call_id: tcState.callId,
            name: tcState.name,
            arguments: '',
          },
        });
      } else {
        // 已存在的 tool call：确保 currentToolCallIndex 指向它
        if (state.currentToolCallIndex !== tcIndex) {
          // 关闭前一个 tool call
          if (state.currentToolCallIndex !== -1) {
            closeCurrentToolCall(state, events);
          }
          state.currentToolCallIndex = tcIndex;
        }
      }

      // 更新 tool call 信息（id 和 name 可能在后续 delta 中补充）
      if (tc.id) tcState.callId = tc.id;
      if (tc.function?.name) tcState.name = tc.function.name;

      // 发送 arguments delta
      if (tc.function?.arguments) {
        tcState.arguments += tc.function.arguments;
        events.push({
          type: 'response.function_call_arguments.delta',
          output_index: tcState.outputIndex,
          delta: tc.function.arguments,
        });
      }
    }
  }

  // ----------------------------------------------------------
  // 4. 处理 finish_reason
  // ----------------------------------------------------------
  if (finishReason) {
    state.finishReason = finishReason;

    // 关闭当前打开的 message
    if (state.currentMessageIndex !== -1) {
      closeCurrentMessage(state, events);
    }

    // 关闭所有打开的 tool calls
    closeAllToolCalls(state, events);

    // 构建 usage（从 Chat 格式转换为 Responses 格式）
    const responsesUsage = state.usage
      ? {
          input_tokens: state.usage.prompt_tokens ?? state.usage.input_tokens ?? 0,
          output_tokens: state.usage.completion_tokens ?? state.usage.output_tokens ?? 0,
        }
      : null;

    // 确定状态
    const status =
      finishReason === 'length' || finishReason === 'content_filter'
        ? 'incomplete'
        : 'completed';

    if (status === 'completed') {
      // 发送 response.completed
      state.completed = true;
      events.push({
        type: 'response.completed',
        response: {
          id: effectiveResponseId,
          object: 'response',
          created_at: state.createdAt,
          model: effectiveModel,
          output: [...state.outputItems],
          status: 'completed',
          usage: responsesUsage,
        },
      });
    } else {
      // finish_reason 为 length/content_filter 时发送 response.incomplete
      state.incomplete = true;
      events.push({
        type: 'response.incomplete',
        response: {
          id: effectiveResponseId,
          object: 'response',
          created_at: state.createdAt,
          model: effectiveModel,
          output: [...state.outputItems],
          status: 'incomplete',
          usage: responsesUsage,
        },
      });
    }
  }

  return events;
}

// ----------------------------------------------------------------------------
// 事件检测
// ----------------------------------------------------------------------------

/**
 * 检测事件是否为 response.completed。
 *
 * @param {object} event - Responses 事件对象
 * @returns {boolean}
 */
export function isResponseCompleted(event) {
  return event?.type === 'response.completed';
}

/**
 * 检测事件是否为 response.incomplete。
 *
 * @param {object} event - Responses 事件对象
 * @returns {boolean}
 */
export function isResponseIncomplete(event) {
  return event?.type === 'response.incomplete';
}

// ----------------------------------------------------------------------------
// 构建 response.incomplete 事件
// ----------------------------------------------------------------------------

/**
 * 构建 response.incomplete 事件（用于异常 EOF 或流错误）。
 *
 * 关闭所有打开的 output items，然后生成 response.incomplete 事件。
 * 关闭事件也会被添加到 events 数组中返回。
 *
 * @param {object} state - 流转换状态
 * @param {object} [originalBody] - 原始请求体
 * @returns {Array<object>} 事件数组（含关闭事件和 response.incomplete 事件）
 */
function buildIncompleteEvents(state, originalBody) {
  const events = [];

  // 关闭当前打开的 message
  if (state.currentMessageIndex !== -1) {
    closeCurrentMessage(state, events);
  }

  // 关闭所有打开的 tool calls
  closeAllToolCalls(state, events);

  const effectiveResponseId = state.responseId || generateItemId('resp');
  const effectiveModel = state.model || originalBody?.model || 'unknown';

  // 构建 usage
  const responsesUsage = state.usage
    ? {
        input_tokens: state.usage.prompt_tokens ?? state.usage.input_tokens ?? 0,
        output_tokens: state.usage.completion_tokens ?? state.usage.output_tokens ?? 0,
      }
    : null;

  state.incomplete = true;
  events.push({
    type: 'response.incomplete',
    response: {
      id: effectiveResponseId,
      object: 'response',
      created_at: state.createdAt,
      model: effectiveModel,
      output: [...state.outputItems],
      status: 'incomplete',
      usage: responsesUsage,
    },
  });

  return events;
}

// ----------------------------------------------------------------------------
// 流转换：Chat SSE → Responses SSE
// ----------------------------------------------------------------------------

/**
 * 将 Chat Completions SSE 流转换为 Responses SSE 事件流。
 *
 * 功能：
 *   - 逐 chunk 读取上游 Chat SSE 流
 *   - 通过状态机转换为 Responses 事件
 *   - 写入客户端（Responses SSE 格式）
 *   - 检测 [DONE] 标记
 *   - 检测异常 EOF（流未正常结束就断开）
 *   - 首字节回调（onFirstByte）
 *   - 完成回调（onComplete）
 *   - 错误回调（onError）
 *   - 客户端取消检测（cancelToken）
 *   - 从含 usage 的 chunk 提取 usage 信息
 *   - 异常 EOF 时发送 response.incomplete 事件
 *
 * @param {Response} upstreamResponse 上游 fetch Response
 * @param {import('http').ServerResponse} res 客户端响应对象
 * @param {object} [options]
 * @param {() => void} [options.onFirstByte] 首字节回调
 * @param {(result: object) => void} [options.onComplete] 完成回调
 * @param {(error: Error) => void} [options.onError] 错误回调
 * @param {object} [options.cancelToken] CancelToken 实例
 * @param {object} [options.originalBody] 原始 Responses API 请求体
 * @returns {Promise<{ completed: boolean, bytesTransferred: number, hadError: boolean, lastUsage: object|null, clientAborted: boolean }>}
 */
export async function pipeChatStreamToResponses(upstreamResponse, res, options = {}) {
  const { onFirstByte, onComplete, onError, cancelToken, originalBody } = options;

  const state = createStreamState();
  if (originalBody?.model) state.model = originalBody.model;

  let bytesTransferred = 0;
  let hadError = false;
  let clientAborted = false;
  let lastUsage = null;
  let firstByteReceived = false;
  let sseBuffer = '';

  // 注册取消监听
  const cancelUnsub = cancelToken?.onCancel(() => {
    clientAborted = true;
  });

  /**
   * 将事件数组写入客户端。
   * @returns {boolean} 是否成功（false 表示写入失败/客户端断开）
   */
  function writeEvents(events) {
    for (const evt of events) {
      if (evt.type === 'response.completed') {
        state.completed = true;
      }
      if (evt.type === 'response.incomplete') {
        state.incomplete = true;
      }

      const eventStr = formatResponsesSSE(evt);
      try {
        res.write(eventStr);
        bytesTransferred += Buffer.byteLength(eventStr);
      } catch {
        clientAborted = true;
        return false;
      }
    }
    return true;
  }

  try {
    const body = upstreamResponse?.body;
    if (!body) {
      hadError = true;
      if (onError) onError(new Error('upstream response has no body'));
      return {
        completed: false,
        bytesTransferred,
        hadError,
        lastUsage,
        clientAborted,
      };
    }

    // 逐 chunk 读取上游响应体
    for await (const chunk of iterateBody(body)) {
      // 客户端已取消：停止读取
      if (clientAborted || cancelToken?.isAborted()) {
        protocolLog('client aborted during responses stream piping, stopping');
        break;
      }

      // 首字节回调
      if (!firstByteReceived) {
        firstByteReceived = true;
        if (onFirstByte) onFirstByte();
      }

      // 转换为 Buffer
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sseBuffer += buf.toString('utf8');

      // 解析完整 SSE 事件（以 \n\n 分隔）
      while (true) {
        const idx = sseBuffer.indexOf('\n\n');
        if (idx === -1) break;

        const block = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);

        const events = parseSSEChunk(block);
        for (const evt of events) {
          // 检测 [DONE]
          if (isDoneMarker(evt.data)) {
            // [DONE] 标记：流应正常结束
            // response.completed 应已由 finish_reason 触发
            continue;
          }

          if (!evt.data) continue;

          let parsed;
          try {
            parsed = JSON.parse(evt.data);
          } catch {
            // 非 JSON 数据，跳过
            continue;
          }

          // 检测上游错误事件
          if (parsed.error) {
            hadError = true;
            if (onError) onError(new Error(parsed.error.message || 'Stream error'));
            continue;
          }

          // 提取 usage（保留最后一个含 usage 的 chunk）
          if (parsed.usage) {
            lastUsage = parsed.usage;
          }

          // 转换为 Responses 事件
          const responsesEvents = chatDeltaToResponsesEvents(parsed, state, {
            originalBody,
          });

          // 写入客户端
          if (!writeEvents(responsesEvents)) {
            break;
          }
        }
      }

      if (clientAborted) break;
    }

    // 处理缓冲区中剩余的不完整事件
    if (sseBuffer.trim() && !clientAborted) {
      const events = parseSSEChunk(sseBuffer);
      for (const evt of events) {
        if (isDoneMarker(evt.data)) continue;
        if (!evt.data) continue;

        let parsed;
        try {
          parsed = JSON.parse(evt.data);
        } catch {
          continue;
        }

        if (parsed.error) {
          hadError = true;
          continue;
        }

        if (parsed.usage) {
          lastUsage = parsed.usage;
        }

        const responsesEvents = chatDeltaToResponsesEvents(parsed, state, {
          originalBody,
        });

        if (!writeEvents(responsesEvents)) {
          break;
        }
      }
      sseBuffer = '';
    }

    // 如果流结束但未发送 response.completed 且未发送 response.incomplete
    // 说明异常 EOF（无 finish_reason 或连接断开）
    if (!clientAborted && !state.completed && !state.incomplete) {
      if (state.responseCreated) {
        // 已发送 response.created，需要发送 response.incomplete
        protocolLog('stream ended without completion, sending response.incomplete');
        const incompleteEvents = buildIncompleteEvents(state, originalBody);
        writeEvents(incompleteEvents);
      } else {
        // 连 response.created 都没发送（空流），发送最小化的 response.incomplete
        state.responseCreated = true;
        const minimalEvents = [
          {
            type: 'response.created',
            response: {
              id: state.responseId || generateItemId('resp'),
              object: 'response',
              created_at: state.createdAt,
              model: state.model || originalBody?.model || 'unknown',
              output: [],
              status: 'in_progress',
              usage: null,
            },
          },
          ...buildIncompleteEvents(state, originalBody),
        ];
        writeEvents(minimalEvents);
      }
    }
  } catch (err) {
    // 区分客户端取消和其他错误
    if (clientAborted || cancelToken?.isAborted() || isAbortError(err)) {
      clientAborted = true;
      protocolLog(`responses stream piping aborted: ${err.message}`);
    } else {
      hadError = true;
      protocolLog(`responses stream piping error: ${err.message}`);
      if (onError) onError(err);

      // 发送 response.incomplete（如果尚未完成）
      if (!state.completed && !state.incomplete && !clientAborted) {
        if (isResWritable(res)) {
          if (!state.responseCreated) {
            state.responseCreated = true;
            try {
              const createdStr = formatResponsesSSE({
                type: 'response.created',
                response: {
                  id: state.responseId || generateItemId('resp'),
                  object: 'response',
                  created_at: state.createdAt,
                  model: state.model || originalBody?.model || 'unknown',
                  output: [],
                  status: 'in_progress',
                  usage: null,
                },
              });
              res.write(createdStr);
              bytesTransferred += Buffer.byteLength(createdStr);
            } catch {
              clientAborted = true;
            }
          }

          if (!clientAborted && isResWritable(res)) {
            const incompleteEvents = buildIncompleteEvents(state, originalBody);
            writeEvents(incompleteEvents);
          }
        }
      }
    }
  } finally {
    // 注销取消监听
    if (cancelUnsub) cancelUnsub();
  }

  // 客户端取消的流不标记为 completed
  if (clientAborted) {
    state.completed = false;
  }

  // 完成回调
  if (onComplete) {
    onComplete({
      completed: state.completed,
      bytesTransferred,
      hadError,
      lastUsage,
      clientAborted,
    });
  }

  return {
    completed: state.completed,
    bytesTransferred,
    hadError,
    lastUsage,
    clientAborted,
  };
}

// ----------------------------------------------------------------------------
// 主处理函数
// ----------------------------------------------------------------------------

/**
 * 处理 Responses API 流式 SSE 请求。
 *
 * 流程：
 *   1. 解析请求体
 *   2. 将 Responses 请求转换为 Chat Completions 格式（stream=true）
 *   3. 应用 Claude Code 兼容补丁（对 Codex 不生效）
 *   4. 构建候选列表
 *   5. 执行（串行 Fallback）
 *   6. 成功：设置 SSE 响应头，pipeChatStreamToResponses 转换并透传
 *   7. 失败：发送错误响应
 *   8. 在流末尾收尾（finalize）
 *
 * @param {import('http').IncomingMessage} req HTTP 请求对象
 * @param {import('http').ServerResponse} res HTTP 响应对象
 * @param {object|string} body 已解析的请求体（Responses API 格式）
 * @param {object} context 上下文（含 config, executionEngine, finalizer, costTracker, cancelToken, agentInfo）
 */
export async function handleResponseStream(req, res, body, context) {
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
      sendJsonResponse(res, 400, buildResponsesError(
        { message: 'Invalid JSON in request body', type: 'invalid_request_error' },
        requestId,
      ));
      return;
    }
  }

  try {
    // 1. 将 Responses 请求转换为 Chat Completions 格式
    const chatBody = responsesToChat(parsedBody);
    chatBody.stream = true;

    // 2. 应用 Claude Code 兼容补丁
    const headers = req?.headers || {};
    const pathname = req?.url || '';
    const patchResult = applyClaudeCodePatches(headers, chatBody, pathname);
    const patchedBody = patchResult.body;
    const requestedModel = patchedBody?.model || null;

    protocolLog(
      `[${requestId}] responses stream agent=${agentId} model=${requestedModel || 'auto'} ` +
      `claudeCode=${patchResult.isClaudeCode}`,
    );

    // 3. 构建候选列表
    const agentModels = getAgentModels(agentId, config);
    const budget = getAgentBudget(agentId, config);
    const capability = detectCapability(patchedBody);

    let candidates = buildCandidates(requestedModel, config, {
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
        const decision = await context.intelligence.suggest({
          requestId,
          body: patchedBody,
          agentId,
          budget,
          candidates,
          protocol: context.protocol || 'chat',
        });
        // Phase2-C：Active Canary 重排（仅 active_canary 模式；Fail Open → 保持 Phase1 顺序）
        if (decision && decision.canary && decision.canary.active
          && Array.isArray(decision.canary.orderedCandidates)
          && decision.canary.orderedCandidates.length > 0) {
          candidates = decision.canary.orderedCandidates;
        }
      } catch (_e) {
        // Shadow 层失败不影响主流程；错误必须有明确日志
        if (context.log && typeof context.log === 'function') {
          context.log(`[shadow_error] suggest failed for ${requestId}: ${_e.message}`);
        } else {
          process.stderr.write(`[shadow_error] suggest failed for ${requestId}: ${_e.message}\n`);
        }
      }
    }
    // 4. 无候选可用
    if (candidates.length === 0) {
      protocolLog(`[${requestId}] no candidates available`);
      await finalizer.finalizeRequestTransaction(
        requestId,
        new AttemptLog(requestId),
        Outcome.NO_CANDIDATE,
        {
          agentId,
          protocol: 'responses',
          requestedModel,
          externalRequestId: context.externalRequestId || null,
        }
      );

      if (!cancelToken?.isAborted() && isResWritable(res)) {
        sendJsonResponse(res, 503, buildResponsesError(
          {
            message: `No available models for the requested model: ${requestedModel || 'auto'}`,
            type: 'service_unavailable',
          },
          requestId,
        ));
      }
      return;
    }

    // 5. 执行（串行 Fallback）
    const executionResult = await executionEngine.execute(candidates, patchedBody, {
      agentId,
      abortSignal: cancelToken?.signal || undefined,
      budget,
      protocol: context.protocol || 'responses',
      requestId,
      externalRequestId: context.externalRequestId || null,
      timeoutMs: config?.server?.request_timeout_ms,
    });


    // 6. 构建 AttemptLog
    const attemptLog = buildAttemptLogFromResult(executionResult, requestId);

    // 7. 处理执行结果
    if (executionResult.success) {
      await handleStreamSuccess(
        res, executionResult, attemptLog, context, requestId, agentId,
        finalizer, costTracker, cancelToken, parsedBody,
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
          protocol: 'responses',
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
        sendJsonResponse(res, 500, buildResponsesError(err, requestId));
      } else {
        // SSE 头已发送：以 SSE response.incomplete 事件通知客户端
        try {
          const incompleteStr = formatResponsesSSE({
            type: 'response.incomplete',
            response: {
              id: generateItemId('resp'),
              object: 'response',
              created_at: Math.floor(Date.now() / 1000),
              model: parsedBody?.model || 'unknown',
              output: [],
              status: 'incomplete',
              usage: null,
            },
          });
          res.write(incompleteStr);
        } catch {
          // 客户端可能已断开
        }
        res.end();
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 流式成功处理
// ----------------------------------------------------------------------------

/**
 * 处理流式执行成功的结果：设置 SSE 头、转换流、提取 usage、收尾。
 *
 * 关键设计：
 *   - 首字节后禁止切换模型：由执行引擎保证
 *   - 客户端取消立即停止上游：cancelToken.signal 已传递给 fetch
 *   - 异常 EOF 发送 response.incomplete：由 pipeChatStreamToResponses 处理
 *   - usage 从最后一个含 usage 的 chunk 提取
 */
async function handleStreamSuccess(
  res, executionResult, attemptLog, context, requestId, agentId,
  finalizer, costTracker, cancelToken, originalBody,
) {
  let firstByteReceived = false;

  // 设置 SSE 响应头
  setSSEResponseHeaders(res);

  // 转换并透传上游 SSE 流
  const pipeResult = await pipeChatStreamToResponses(
    executionResult.response,
    res,
    {
      onFirstByte: () => {
        firstByteReceived = true;
        protocolLog(`[${requestId}] first byte received, model switching disabled`);
      },
      cancelToken,
      originalBody,
    },
  );

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
    protocolLog(`[${requestId}] responses stream client aborted, bytes=${pipeResult.bytesTransferred}`);
  } else if (pipeResult.hadError) {
    // 流错误
    outcome = Outcome.INCOMPLETE;
    protocolLog(`[${requestId}] responses stream error, bytes=${pipeResult.bytesTransferred}`);
  } else if (pipeResult.completed) {
    // 流正常完成（response.completed 已发送）
    outcome = Outcome.COMPLETED;
    protocolLog(
      `[${requestId}] responses stream completed, bytes=${pipeResult.bytesTransferred}`,
    );
  } else {
    // 流结束但未完成（异常 EOF，response.incomplete 已发送）
    outcome = Outcome.INCOMPLETE;
    protocolLog(
      `[${requestId}] responses stream incomplete, bytes=${pipeResult.bytesTransferred}`,
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
        `[${requestId}] usage extracted from responses stream: ` +
        `prompt=${pipeResult.lastUsage.prompt_tokens ?? pipeResult.lastUsage.input_tokens ?? 0} ` +
        `completion=${pipeResult.lastUsage.completion_tokens ?? pipeResult.lastUsage.output_tokens ?? 0}`,
      );
    }
  } else {
    protocolLog(`[${requestId}] no usage found in responses SSE stream`);
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
    protocol: 'responses',
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
    protocol: 'responses',
  });

  // 客户端已断开：不发送响应
  if (executionResult.outcome === 'client_aborted') {
    protocolLog(`[${requestId}] client aborted before responses stream start`);
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
  sendJsonResponse(res, status, buildResponsesError(error, requestId));
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  pipeChatStreamToResponses,
  handleResponseStream,
  chatDeltaToResponsesEvents,
  isResponseCompleted,
  isResponseIncomplete,
};
