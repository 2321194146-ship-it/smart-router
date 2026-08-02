// src/protocols/anthropic-stream.js
// Smart Router Mainline - Phase 1
// Anthropic Messages 流式 SSE 协议处理：处理 Anthropic /v1/messages 流式请求。
//
// 设计要点：
//   - 将 Chat Completions SSE 流转换为 Anthropic Messages SSE 事件流
//   - Anthropic SSE 事件序列：
//     message_start → content_block_start → content_block_delta(×N) →
//     content_block_stop → [更多 content_block...] → message_delta → message_stop
//   - 流式状态机：正确处理 text 和 tool_use 块的切换
//   - tool_use 的 input_json_delta 正确拼接
//   - 空响应时补发空的 text block
//   - finish_reason 到 stop_reason 的映射
//   - 首字节后禁止切换模型（由执行引擎保证）
//   - 客户端取消立即停止上游（cancelToken.signal 传递给 fetch）
//   - 异常 EOF 发送 message_delta + message_stop
//   - thinking 内容块清洗：reasoning_content 不转发
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
import { anthropicToOpenAI, buildAnthropicError } from './anthropic.js';

// ----------------------------------------------------------------------------
// 日志
// ----------------------------------------------------------------------------

function protocolLog(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[anthropic-stream-protocol][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// 辅助函数（与 chat-stream.js 共享逻辑的本地副本，保持模块独立性）
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

/**
 * 将 OpenAI finish_reason 映射为 Anthropic stop_reason。
 */
function mapFinishReasonToStop(finishReason) {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/**
 * 将 Anthropic SSE 事件格式化为 SSE 文本。
 *
 * 格式：event: <type>\ndata: <json>\n\n
 *
 * @param {object} event Anthropic SSE 事件对象
 * @returns {string} SSE 格式文本
 */
function formatAnthropicSSE(event) {
  const eventType = event.type;
  const data = JSON.stringify(event);
  return `event: ${eventType}\ndata: ${data}\n\n`;
}

/**
 * 从 usage 对象中提取 output_tokens（兼容 OpenAI 和 Anthropic 格式）。
 */
function extractOutputTokens(usage) {
  if (!usage) return 0;
  return usage.completion_tokens ?? usage.output_tokens ?? 0;
}

/**
 * 从 usage 对象中提取 input_tokens（兼容 OpenAI 和 Anthropic 格式）。
 */
function extractInputTokens(usage) {
  if (!usage) return 0;
  return usage.prompt_tokens ?? usage.input_tokens ?? 0;
}

// ----------------------------------------------------------------------------
// 流式转换状态机
// ----------------------------------------------------------------------------

/**
 * 创建流式转换状态机。
 *
 * 跟踪：
 *   - messageStarted: 是否已发送 message_start
 *   - currentBlock: 当前内容块 { index, type, text, toolName, toolId, toolArgs, toolCallIndex }
 *   - contentBlocks: 已完成的内容块数组
 *   - lastUsage: 最后的 usage
 *   - totalText: 累计文本内容
 *   - hasContent: 是否有任何内容
 *   - nextBlockIndex: 下一个内容块的索引
 *   - messageStopped: 是否已发送 message_stop
 *   - stopReason: 停止原因
 *   - messageId: 消息 ID
 *
 * @returns {object} 流式状态机对象
 */
export function createStreamState() {
  return {
    messageStarted: false,
    currentBlock: null,
    contentBlocks: [],
    lastUsage: null,
    totalText: '',
    hasContent: false,
    nextBlockIndex: 0,
    messageStopped: false,
    stopReason: null,
    messageId: null,
    validTerminalReceived: false,
  };
}

// ----------------------------------------------------------------------------
// 单个 Chat SSE chunk → Anthropic SSE 事件
// ----------------------------------------------------------------------------

/**
 * 将单个 Chat SSE chunk 转换为 Anthropic SSE 事件数组。
 *
 * 处理逻辑：
 *   1. 第一个 chunk：发送 message_start + content_block_start(text)
 *   2. text delta：发送 content_block_delta(text_delta)
 *   3. tool_call delta：
 *      - 先关闭当前 text block（如果有）
 *      - 发送 content_block_start(tool_use)
 *      - 发送 content_block_delta(input_json_delta)
 *   4. finish_reason：
 *      - 关闭当前 block
 *      - 发送 message_delta(stop_reason 映射)
 *      - 发送 message_stop
 *   5. usage 更新
 *
 * stop_reason 映射：
 *   'stop' → 'end_turn'
 *   'length' → 'max_tokens'
 *   'tool_calls' → 'tool_use'
 *   'content_filter' → 'end_turn'
 *
 * @param {object} chunk Chat SSE chunk（已解析的 JSON）
 * @param {object} state 流式状态机
 * @param {object} [context] 上下文，含 model
 * @returns {Array<object>} Anthropic SSE 事件数组
 */
export function chatChunkToAnthropicEvents(chunk, state, context = {}) {
  const events = [];
  const model = context.model || chunk?.model || '';

  if (!chunk || typeof chunk !== 'object') {
    return events;
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  const finishReason = choice?.finish_reason;

  // 提取 usage（如果有）
  if (chunk.usage) {
    state.lastUsage = {
      input_tokens: extractInputTokens(chunk.usage),
      output_tokens: extractOutputTokens(chunk.usage),
      raw: { ...chunk.usage },
    };
  }

  // --------------------------------------------------------------------------
  // 1. 首次收到 chunk：发送 message_start
  // --------------------------------------------------------------------------

  if (!state.messageStarted) {
    state.messageStarted = true;
    state.messageId = chunk.id || `msg_${Date.now()}`;

    const inputTokens = state.lastUsage
      ? state.lastUsage.input_tokens
      : 0;

    events.push({
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
        },
      },
    });
  }

  // --------------------------------------------------------------------------
  // 2. 处理 text delta
  // --------------------------------------------------------------------------

  // 忽略 reasoning_content（不转发给 Anthropic 客户端）
  if (delta && delta.content != null && typeof delta.content === 'string') {
    // 如果当前块不是 text 类型，关闭当前块并开始新的 text 块
    if (!state.currentBlock || state.currentBlock.type !== 'text') {
      // 关闭当前块（如果有）
      if (state.currentBlock) {
        events.push({
          type: 'content_block_stop',
          index: state.currentBlock.index,
        });
        state.contentBlocks.push(state.currentBlock);
      }

      // 开始新的 text 块
      state.currentBlock = {
        index: state.nextBlockIndex++,
        type: 'text',
        text: '',
      };
      events.push({
        type: 'content_block_start',
        index: state.currentBlock.index,
        content_block: { type: 'text', text: '' },
      });
    }

    // 发送 text_delta
    state.currentBlock.text += delta.content;
    state.totalText += delta.content;
    state.hasContent = true;

    events.push({
      type: 'content_block_delta',
      index: state.currentBlock.index,
      delta: { type: 'text_delta', text: delta.content },
    });
  }

  // --------------------------------------------------------------------------
  // 3. 处理 tool_call delta
  // --------------------------------------------------------------------------

  if (delta && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;

      // 如果有 id，表示新的 tool call
      if (tc.id) {
        // 关闭当前块（如果有）
        if (state.currentBlock) {
          events.push({
            type: 'content_block_stop',
            index: state.currentBlock.index,
          });
          state.contentBlocks.push(state.currentBlock);
        }

        // 开始新的 tool_use 块
        state.currentBlock = {
          index: state.nextBlockIndex++,
          type: 'tool_use',
          toolId: tc.id,
          toolName: tc.function?.name || '',
          toolArgs: '',
          toolCallIndex: tc.index ?? 0,
        };

        events.push({
          type: 'content_block_start',
          index: state.currentBlock.index,
          content_block: {
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || '',
            input: {},
          },
        });
        state.hasContent = true;

        // 如果首个 chunk 中有 arguments，发送 input_json_delta
        if (tc.function?.arguments && typeof tc.function.arguments === 'string' && tc.function.arguments.length > 0) {
          state.currentBlock.toolArgs += tc.function.arguments;
          events.push({
            type: 'content_block_delta',
            index: state.currentBlock.index,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          });
        }
      } else if (
        tc.function?.arguments &&
        typeof tc.function.arguments === 'string' &&
        tc.function.arguments.length > 0
      ) {
        // 续接 tool call arguments
        // 检查 index 是否匹配当前块
        const tcIndex = tc.index ?? 0;
        if (
          state.currentBlock &&
          state.currentBlock.type === 'tool_use' &&
          state.currentBlock.toolCallIndex === tcIndex
        ) {
          state.currentBlock.toolArgs += tc.function.arguments;
          events.push({
            type: 'content_block_delta',
            index: state.currentBlock.index,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          });
        }
        // 如果 index 不匹配，跳过（无法重开已关闭的块）
      }
    }
  }

  // --------------------------------------------------------------------------
  // 4. 处理 finish_reason
  // --------------------------------------------------------------------------

  if (finishReason) {
    // 关闭当前块（如果有）
    if (state.currentBlock) {
      events.push({
        type: 'content_block_stop',
        index: state.currentBlock.index,
      });
      state.contentBlocks.push(state.currentBlock);
      state.currentBlock = null;
    }

    // 映射 finish_reason → stop_reason
    const stopReason = mapFinishReasonToStop(finishReason);
    state.stopReason = stopReason;

    // 获取 output_tokens
    const outputTokens = state.lastUsage
      ? state.lastUsage.output_tokens
      : 0;

    events.push({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });

    events.push({ type: 'message_stop' });
    state.messageStopped = true;
    state.validTerminalReceived = true;
  }

  return events;
}

// ----------------------------------------------------------------------------
// message_stop 检测
// ----------------------------------------------------------------------------

/**
 * 检测事件是否为 message_stop。
 *
 * @param {object|string} event Anthropic SSE 事件（对象或 JSON 字符串）
 * @returns {boolean}
 */
export function isMessageStop(event) {
  if (!event) return false;

  let parsed = event;
  if (typeof event === 'string') {
    try {
      parsed = JSON.parse(event);
    } catch {
      return false;
    }
  }

  if (!parsed || typeof parsed !== 'object') return false;
  return parsed.type === 'message_stop';
}

// ----------------------------------------------------------------------------
// SSE 流转换：Chat SSE → Anthropic SSE
// ----------------------------------------------------------------------------

/**
 * 将 Chat Completions SSE 流转换为 Anthropic Messages SSE 事件流。
 *
 * 功能：
 *   - 逐 chunk 读取上游 Chat SSE 流
 *   - 使用状态机将每个 Chat chunk 转换为 Anthropic SSE 事件
 *   - 写入客户端（Anthropic SSE 格式）
 *   - 检测 [DONE] 标记
 *   - 检测异常 EOF（流未正常结束就断开）
 *   - 首字节回调（onFirstByte）
 *   - 完成回调（onComplete）
 *   - 错误回调（onError）
 *   - 客户端取消检测（cancelToken）
 *   - 从含 usage 的 chunk 提取 usage 信息
 *   - 空响应时补发空的 text block
 *   - 异常 EOF 时发送 message_delta + message_stop
 *
 * Anthropic SSE 事件序列：
 *   1. message_start
 *   2. content_block_start (text)
 *   3. content_block_delta (text_delta) × N
 *   4. content_block_stop
 *      (如果有 tool_calls:)
 *      content_block_start (tool_use)
 *      content_block_delta (input_json_delta) × N
 *      content_block_stop
 *   5. message_delta (stop_reason, output_tokens)
 *   6. message_stop
 *
 * @param {Response} upstreamResponse 上游 fetch Response
 * @param {import('http').ServerResponse} res 客户端响应对象
 * @param {object} [options]
 * @param {() => void} [options.onFirstByte] 首字节回调
 * @param {(result: object) => void} [options.onComplete] 完成回调
 * @param {(error: Error) => void} [options.onError] 错误回调
 * @param {object} [options.cancelToken] CancelToken 实例
 * @param {object} [options.originalBody] 原始 Anthropic 请求体
 * @param {string} [options.model] 模型名称
 * @returns {Promise<{ completed: boolean, bytesTransferred: number, hadError: boolean, lastUsage: object|null, clientAborted: boolean }>}
 */
export async function openaiSSEToAnthropicSSE(upstreamResponse, res, options = {}) {
  const {
    onFirstByte,
    onComplete,
    onError,
    cancelToken,
    originalBody,
    model,
  } = options;

  const state = createStreamState();
  let bytesTransferred = 0;
  let hadError = false;
  let completed = false;
  let clientAborted = false;
  let firstByteReceived = false;
  let sseBuffer = '';
  let doneMarkerReceived = false;
  let missingTerminalEvent = false;

  // 注册取消监听
  const cancelUnsub = cancelToken?.onCancel(() => {
    clientAborted = true;
  });

  /**
   * 将 Anthropic SSE 事件写入客户端。
   * @param {object} event Anthropic SSE 事件
   * @returns {boolean} 是否写入成功
   */
  function writeEvent(event) {
    if (!res || res.writableEnded || res.destroyed) return false;
    const sseData = formatAnthropicSSE(event);
    try {
      res.write(sseData);
      bytesTransferred += Buffer.byteLength(sseData);
      return true;
    } catch {
      clientAborted = true;
      return false;
    }
  }

  /**
   * 发送流的收尾事件（message_delta + message_stop）。
   * 用于正常结束或异常 EOF。
   * @param {string} stopReason 停止原因
   * @param {number} outputTokens 输出 token 数
   */
  function sendStreamEnd(stopReason, outputTokens) {
    if (state.messageStopped) return;

    // 关闭当前打开的块（如果有）
    if (state.currentBlock) {
      writeEvent({
        type: 'content_block_stop',
        index: state.currentBlock.index,
      });
      state.contentBlocks.push(state.currentBlock);
      state.currentBlock = null;
    }

    // 如果消息已开始但没有内容，补发空的 text block
    if (state.messageStarted && !state.hasContent) {
      const blockIndex = state.nextBlockIndex++;
      writeEvent({
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      });
      writeEvent({
        type: 'content_block_stop',
        index: blockIndex,
      });
    }

    // 发送 message_delta
    writeEvent({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });

    // 发送 message_stop
    writeEvent({ type: 'message_stop' });
    state.messageStopped = true;
  }

  try {
    const body = upstreamResponse?.body;
    if (!body) {
      hadError = true;
      const err = new Error('upstream response has no body');
      if (onError) onError(err);
      return {
        completed: false,
        bytesTransferred,
        hadError,
        lastUsage: state.lastUsage,
        clientAborted,
      };
    }

    // 逐 chunk 读取上游响应体
    for await (const value of iterateBody(body)) {
      // 客户端已取消：停止读取
      if (clientAborted || cancelToken?.isAborted()) {
        protocolLog('client aborted during SSE conversion, stopping');
        break;
      }

      // 首字节回调
      if (!firstByteReceived) {
        firstByteReceived = true;
        if (onFirstByte) onFirstByte();
      }

      // 转换为 Buffer
      const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
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
            doneMarkerReceived = true;
            continue;
          }

          if (!evt.data) continue;

          // 解析 Chat SSE chunk
          let chunk;
          try {
            chunk = JSON.parse(evt.data);
          } catch {
            // 非 JSON 数据，跳过
            continue;
          }

          // 转换为 Anthropic SSE 事件
          const anthropicEvents = chatChunkToAnthropicEvents(chunk, state, { model });

          // 写入客户端
          for (const anthEvt of anthropicEvents) {
            if (!writeEvent(anthEvt)) {
              clientAborted = true;
              break;
            }
          }

          if (clientAborted) break;
        }

        if (clientAborted) break;
      }

      if (clientAborted) break;
    }

    // 处理缓冲区中剩余的不完整事件
    if (!clientAborted && sseBuffer.trim()) {
      const events = parseSSEChunk(sseBuffer);
      for (const evt of events) {
        if (isDoneMarker(evt.data)) {
          doneMarkerReceived = true;
          continue;
        }
        if (!evt.data) continue;

        let chunk;
        try {
          chunk = JSON.parse(evt.data);
        } catch {
          continue;
        }

        const anthropicEvents = chatChunkToAnthropicEvents(chunk, state, { model });
        for (const anthEvt of anthropicEvents) {
          if (!writeEvent(anthEvt)) {
            clientAborted = true;
            break;
          }
        }
        if (clientAborted) break;
      }
    }

    // 判断流是否正常完成
    if (!clientAborted && !hadError) {
      const hasValidTerminal = state.validTerminalReceived || doneMarkerReceived;

      if (state.messageStarted && !state.messageStopped) {
        if (!hasValidTerminal) {
          // 异常 EOF：不伪造 end_turn，标记为 incomplete
          missingTerminalEvent = true;
          completed = false;
          if (res && !res.writableEnded && !res.destroyed) {
            try {
              writeEvent({
                type: 'error',
                error: {
                  type: 'api_error',
                  message: 'upstream stream ended without a valid terminal event',
                },
              });
            } catch { /* client may have disconnected */ }
          }
        } else {
          const stopReason = state.stopReason || 'end_turn';
          const outputTokens = state.lastUsage ? state.lastUsage.output_tokens : 0;
          sendStreamEnd(stopReason, outputTokens);
          completed = true;
        }
      } else if (!state.messageStarted) {
        if (!hasValidTerminal) {
          missingTerminalEvent = true;
          completed = false;
        } else {
          const fakeChunk = {
            id: `msg_${Date.now()}`,
            model: model || originalBody?.model || '',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          };
          const anthropicEvents = chatChunkToAnthropicEvents(fakeChunk, state, { model });
          for (const anthEvt of anthropicEvents) { writeEvent(anthEvt); }
          completed = true;
        }
      } else {
        completed = true;
      }
    }
  } catch (err) {
    // 区分客户端取消和其他错误
    if (clientAborted || cancelToken?.isAborted() || isAbortError(err)) {
      clientAborted = true;
      protocolLog(`SSE conversion aborted: ${err.message}`);
    } else {
      hadError = true;
      protocolLog(`SSE conversion error: ${err.message}`);

      // 异常错误：不伪造 end_turn
      missingTerminalEvent = true;
      completed = false;
      if (!clientAborted && res && !res.writableEnded && !res.destroyed) {
        if (state.messageStarted && !state.messageStopped) {
          try {
            writeEvent({
              type: 'error',
              error: { type: 'api_error', message: 'stream error: ' + (err.message || 'unknown') },
            });
          } catch { /* client may have disconnected */ }
        }
      }

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
      hadError,
      lastUsage: state.lastUsage,
      clientAborted,
      missingTerminalEvent,
    });
  }

  return {
    completed,
    bytesTransferred,
    hadError,
    lastUsage: state.lastUsage,
    clientAborted,
    missingTerminalEvent,
  };
}

// ----------------------------------------------------------------------------
// 主处理函数
// ----------------------------------------------------------------------------

/**
 * 处理 Anthropic Messages 流式 SSE 请求。
 *
 * 流程：
 *   1. 解析请求体
 *   2. 应用 Claude Code 兼容补丁
 *   3. 转换为 Chat 格式
 *   4. 构建候选列表
 *   5. 执行（executionEngine.execute）
 *   6. 设置 SSE 响应头
 *   7. 转换并透传上游 SSE 流（openaiSSEToAnthropicSSE）
 *   8. 处理 [DONE] / 异常 EOF / 客户端取消
 *   9. 提取 usage，计算成本
 *   10. 在流末尾收尾（finalize）
 *
 * @param {import('http').IncomingMessage} req HTTP 请求对象
 * @param {import('http').ServerResponse} res HTTP 响应对象
 * @param {object} body 已解析的 Anthropic 请求体
 * @param {object} context 上下文（含 config, executionEngine, finalizer, costTracker, cancelToken, agentInfo）
 */
export async function handleAnthropicMessageStream(req, res, body, context) {
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
  const agentId = agentInfo?.agentId || 'claude-code';

  // 解析请求体（兼容字符串传入）
  let parsedBody = body;
  if (typeof body === 'string') {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      protocolLog(`[${requestId}] invalid JSON body`);
      sendJsonResponse(res, 400, buildAnthropicError(
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

    // 2. 转换为 Chat 格式
    const chatBody = anthropicToOpenAI(patchedBody);
    // 流式请求：确保 stream 为 true
    chatBody.stream = true;

    const requestedModel = chatBody.model || patchedBody?.model || null;

    protocolLog(
      `[${requestId}] stream agent=${agentId} model=${requestedModel || 'auto'} ` +
      `claudeCode=${patchResult.isClaudeCode}`,
    );

    // 3. 构建候选列表
    const agentModels = getAgentModels(agentId, config);
    const budget = getAgentBudget(agentId, config);
    const capability = detectCapability(chatBody);

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

    // 无候选可用
    if (candidates.length === 0) {
      protocolLog(`[${requestId}] no candidates available`);
      await finalizer.finalizeRequestTransaction(
        requestId,
        new AttemptLog(requestId),
        Outcome.NO_CANDIDATE,
        {
          agentId,
          protocol: 'anthropic',
          requestedModel,
          externalRequestId: context.externalRequestId || null,
        }
      );

      if (!cancelToken?.isAborted() && isResWritable(res)) {
        sendJsonResponse(res, 503, buildAnthropicError(
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
    const executionResult = await executionEngine.execute(candidates, chatBody, {
      agentId,
      abortSignal: cancelToken?.signal || undefined,
      budget,
      protocol: context.protocol || 'anthropic',
      requestId,
      externalRequestId: context.externalRequestId || null,
      timeoutMs: config?.server?.request_timeout_ms,
    });

    // 4b. Shadow 观测：智能建议 + 传统路由真实结果（不改变任何行为；off 模式 no-op）
    if (context.intelligence && typeof context.intelligence.suggest === 'function') {
      try {
        context.intelligence.suggest({
          requestId,
          body: patchedBody,
          agentId,
          budget,
          candidates,
          protocol: context.protocol || 'chat',
        });
        const _lastAtt = Array.isArray(executionResult?.attempts) && executionResult.attempts.length > 0
          ? executionResult.attempts[executionResult.attempts.length - 1]
          : null;
        context.intelligence.recordTraditional(requestId, {
          finalModel: executionResult?.finalCandidate?.modelId ?? null,
          finalProvider: executionResult?.finalCandidate?.provider ?? null,
          outcome: executionResult?.outcome ?? null,
          latencyMs: _lastAtt?.latencyMs ?? null,
          usage: _lastAtt?.usage ?? null,
          cost: _lastAtt?.cost ?? null,
        });
      } catch (_e) {
        // Shadow 层失败不影响主流程
      }
    }

    // 5. 构建 AttemptLog
    const attemptLog = buildAttemptLogFromResult(executionResult, requestId);

    // 6. 处理执行结果
    if (executionResult.success) {
      await handleStreamSuccess(
        res, executionResult, attemptLog, context, requestId, agentId,
        finalizer, costTracker, cancelToken, patchedBody,
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
          protocol: 'anthropic',
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
        sendJsonResponse(res, 500, buildAnthropicError(err, requestId));
      } else {
        // SSE 头已发送：结束响应
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
 *   - 异常 EOF 发送 message_delta + message_stop
 *   - usage 从含 usage 的 chunk 提取
 */
async function handleStreamSuccess(
  res, executionResult, attemptLog, context, requestId, agentId,
  finalizer, costTracker, cancelToken, originalBody,
) {
  let firstByteReceived = false;

  // 确定模型名称（用于 message_start 事件）
  const modelName =
    executionResult.finalCandidate?.modelId ||
    executionResult.finalCandidate?.model ||
    originalBody?.model ||
    '';

  // 设置 SSE 响应头
  setSSEResponseHeaders(res);

  // 转换并透传上游 SSE 流
  const convertResult = await openaiSSEToAnthropicSSE(
    executionResult.response,
    res,
    {
      onFirstByte: () => {
        firstByteReceived = true;
        protocolLog(`[${requestId}] first byte received, model switching disabled`);
      },
      cancelToken,
      originalBody,
      model: modelName,
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
  if (convertResult.clientAborted || cancelToken?.isAborted()) {
    // 客户端取消
    outcome = Outcome.CLIENT_ABORTED;
    protocolLog(`[${requestId}] stream client aborted, bytes=${convertResult.bytesTransferred}`);
  } else if (convertResult.hadError) {
    // 流错误
    outcome = Outcome.INCOMPLETE;
    protocolLog(`[${requestId}] stream error, bytes=${convertResult.bytesTransferred}`);
  } else if (convertResult.missingTerminalEvent) {
    // 异常 EOF：上游未发送合法终止事件
    outcome = Outcome.INCOMPLETE;
    protocolLog(`[${requestId}] stream incomplete (missing terminal event), bytes=${convertResult.bytesTransferred}`);
  } else if (convertResult.completed) {
    // 流正常完成
    outcome = Outcome.COMPLETED;
    protocolLog(
      `[${requestId}] stream completed, bytes=${convertResult.bytesTransferred}`,
    );
  } else {
    // 流未正常结束（异常 EOF）
    outcome = Outcome.INCOMPLETE;
    protocolLog(
      `[${requestId}] stream incomplete, bytes=${convertResult.bytesTransferred}`,
    );
  }

  // 从 SSE 流提取 usage，更新 AttemptLog 并计算成本
  if (convertResult.lastUsage) {
    const successfulAttempt = attemptLog.getSuccessful();
    if (successfulAttempt) {
      // 将 usage 归一化为 OpenAI 格式（CostTracker 期望的格式）
      const normalizedUsage = {
        prompt_tokens: convertResult.lastUsage.input_tokens ?? 0,
        completion_tokens: convertResult.lastUsage.output_tokens ?? 0,
        total_tokens:
          (convertResult.lastUsage.input_tokens ?? 0) +
          (convertResult.lastUsage.output_tokens ?? 0),
      };
      const modelForCost = executionResult.finalCandidate?.model
        || executionResult.finalCandidate?.modelId;
      const calculatedCost = costTracker
        ? costTracker.calculateCost(modelForCost, normalizedUsage)
        : null;
      successfulAttempt.setUsage(normalizedUsage, calculatedCost);
      protocolLog(
        `[${requestId}] usage extracted from stream: ` +
        `input=${normalizedUsage.prompt_tokens} ` +
        `output=${normalizedUsage.completion_tokens}`,
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
    protocol: 'anthropic',
    responseSize: convertResult.bytesTransferred,
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
    protocol: 'anthropic',
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
    type: 'api_error',
  };
  sendJsonResponse(res, status, buildAnthropicError(error, requestId));
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  openaiSSEToAnthropicSSE,
  handleAnthropicMessageStream,
  createStreamState,
  chatChunkToAnthropicEvents,
  isMessageStop,
};
