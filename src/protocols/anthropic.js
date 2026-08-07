// src/protocols/anthropic.js
// Smart Router Mainline - Phase 1
// Anthropic Messages 非流式协议处理：处理 Anthropic /v1/messages 非流式请求。
//
// 设计要点：
//   - Anthropic Messages API 是 Claude Code 使用的原生协议
//   - 上游 Provider 可能返回 OpenAI Chat 格式，需要双向转换
//   - anthropicToOpenAI：将 Anthropic 请求体转换为 Chat Completions 格式
//   - openaiToAnthropic：将 Chat Completions 响应转换为 Anthropic Messages 格式
//   - 复用执行引擎（ExecutionEngine）进行串行 Fallback 执行
//   - 应用 Claude Code 兼容补丁（thinking 处理、字段清理等）
//   - 客户端取消时不发送响应，仅收尾
//   - 所有请求经 finalizer 幂等收尾（以 requestId 去重）
//   - thinking 内容块清洗：上游返回的 thinking block 替换为 [text]
//   - reasoning_content 清理：从响应中删除 reasoning_content 字段
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { buildCandidates } from '../router/candidates.js';
import {
  applyClaudeCodePatches,
  cleanReasoningContent,
  cleanThinkingProcessLeak,
  handleThinkingParam,
} from '../agent/compatibility.js';
import { AttemptLog } from '../runtime/attempts.js';
import { Outcome, deriveValidatedOutcome } from '../runtime/outcomes.js';
import { getAgentModels, getAgentBudget } from '../agent/identity.js';
import { log } from '../config/loader.js';
import { normalizeChatCompletionResponse } from './response-normalization.js';

// ----------------------------------------------------------------------------
// 日志
// ----------------------------------------------------------------------------

function protocolLog(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[anthropic-protocol][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// 辅助函数（与 chat.js 共享逻辑的本地副本，保持模块独立性）
// ----------------------------------------------------------------------------

/**
 * 从请求体中检测所需能力（如 vision）。
 * 兼容 Anthropic 和 OpenAI 两种 content block 格式。
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
 * 检查 res 是否可写。
 */
function isResWritable(res) {
  return res && !res.writableEnded && !res.destroyed;
}

/**
 * 从响应体中提取 usage 信息（OpenAI / Anthropic 格式兼容）。
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
 * 将 OpenAI finish_reason 映射为 Anthropic stop_reason。
 */
function mapFinishReason(finishReason) {
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
 * 将 Anthropic 图片内容块转换为 OpenAI image_url 格式。
 */
function convertAnthropicImageToOpenAI(block) {
  if (!block || !block.source) return null;
  const source = block.source;
  if (source.type === 'base64') {
    const mediaType = source.media_type || 'image/jpeg';
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === 'url') {
    return source.url;
  }
  return null;
}

/**
 * 从 Anthropic content 数组中提取 tool_result 的文本内容。
 */
function extractToolResultContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}

/**
 * 清洗 Anthropic 响应内容数组中的 thinking 块，替换为 [text] 占位。
 */
function cleanThinkingFromContent(content) {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const newContent = content.map((block) => {
    if (block && typeof block === 'object' && block.type === 'thinking') {
      changed = true;
      return { type: 'text', text: '[thinking]' };
    }
    return block;
  });
  return changed ? newContent : content;
}

// ----------------------------------------------------------------------------
// 协议转换：Anthropic → OpenAI
// ----------------------------------------------------------------------------

/**
 * 将 Anthropic Messages 请求转换为 Chat Completions 格式。
 *
 * 转换规则：
 *   - system → messages[0]（system role）
 *     system 可以是字符串或数组 [{type:'text', text:'...'}]
 *   - messages → messages
 *     user 消息: content 可以是字符串或数组
 *       text → {role:'user', content:'...'}
 *       tool_result → {role:'tool', tool_call_id:..., content:...}
 *       image → {role:'user', content:[{type:'image_url', image_url:{url:...}}]}
 *     assistant 消息: content 可以是字符串或数组
 *       text → 保留
 *       tool_use → 转换为 tool_calls
 *       thinking → 跳过（不转发给非 Anthropic 上游）
 *   - tools → tools（OpenAI 格式: {type:'function', function:{name, description, parameters}}）
 *     input_schema → function.parameters
 *   - tool_choice 转换:
 *     {type:'auto'} → 'auto'
 *     {type:'any'} → 'required'
 *     {type:'tool', name:'xxx'} → {type:'function', function:{name:'xxx'}}
 *   - max_tokens → max_tokens（保留）
 *   - thinking → reasoning_effort（通过 handleThinkingParam）
 *   - stop_sequences → stop
 *   - 删除 Anthropic 专有字段
 *
 * @param {object} body Anthropic Messages 请求体
 * @returns {object} Chat Completions 格式的请求体
 */
export function anthropicToOpenAI(body) {
  if (!body || typeof body !== 'object') return {};

  const chatBody = {};

  // model
  if (body.model) chatBody.model = body.model;

  // max_tokens（Anthropic 必填字段，保留）
  if (body.max_tokens != null) chatBody.max_tokens = body.max_tokens;

  // temperature
  if (body.temperature != null) chatBody.temperature = body.temperature;

  // top_p
  if (body.top_p != null) chatBody.top_p = body.top_p;

  // stop_sequences → stop
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    chatBody.stop = body.stop_sequences;
  }

  // stream（保留原值）
  if (body.stream != null) chatBody.stream = body.stream;

  // thinking → reasoning_effort
  // 如果 body.thinking 仍然存在（非 Claude Code 或补丁未处理），进行转换
  if (body.thinking) {
    const { reasoningEffort } = handleThinkingParam(body);
    if (reasoningEffort) {
      chatBody.reasoning_effort = reasoningEffort;
    }
  }
  // 如果 reasoning_effort 已由补丁设置，保留
  if (body.reasoning_effort) {
    chatBody.reasoning_effort = body.reasoning_effort;
  }

  // ----------------------------------------------------------------------------
  // system → messages[0]（system role）
  // ----------------------------------------------------------------------------

  const messages = [];

  if (body.system) {
    let systemText = '';
    if (typeof body.system === 'string') {
      systemText = body.system;
    } else if (Array.isArray(body.system)) {
      systemText = body.system
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    }
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  // ----------------------------------------------------------------------------
  // messages → messages
  // ----------------------------------------------------------------------------

  for (const msg of body.messages || []) {
    if (!msg || !msg.role) continue;

    if (msg.role === 'user') {
      // content 可以是字符串或数组
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // 处理 content 数组：text、tool_result、image 分别处理
        const textParts = [];

        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_result') {
            // 刷新已积累的文本为 user 消息
            if (textParts.length > 0) {
              messages.push({ role: 'user', content: textParts.join('\n') });
              textParts.length = 0;
            }
            // tool_result → tool 消息
            const toolContent = extractToolResultContent(block.content);
            messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: toolContent,
            });
          } else if (block.type === 'image') {
            // image → image_url
            if (textParts.length > 0) {
              messages.push({ role: 'user', content: textParts.join('\n') });
              textParts.length = 0;
            }
            const imageUrl = convertAnthropicImageToOpenAI(block);
            if (imageUrl) {
              messages.push({
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: imageUrl } }],
              });
            }
          }
        }

        // 刷新剩余文本
        if (textParts.length > 0) {
          messages.push({ role: 'user', content: textParts.join('\n') });
        }
      }
    } else if (msg.role === 'assistant') {
      // content 可以是字符串或数组
      if (typeof msg.content === 'string') {
        messages.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let textContent = '';
        const toolCalls = [];

        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'text') {
            textContent += (textContent ? '\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
            // tool_use → tool_calls
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input || {}),
              },
            });
          }
          // thinking 块跳过（不转发给非 Anthropic 上游）
        }

        const assistantMsg = { role: 'assistant' };
        if (textContent) {
          assistantMsg.content = textContent;
        } else if (toolCalls.length === 0) {
          assistantMsg.content = '';
        } else {
          // 有 tool_calls 但无文本时，content 设为 null（OpenAI 规范允许）
          assistantMsg.content = null;
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        messages.push(assistantMsg);
      }
    }
  }

  chatBody.messages = messages;

  // ----------------------------------------------------------------------------
  // tools → tools（OpenAI 格式）
  // ----------------------------------------------------------------------------

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chatBody.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  // ----------------------------------------------------------------------------
  // tool_choice 转换
  // ----------------------------------------------------------------------------

  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') {
      chatBody.tool_choice = 'auto';
    } else if (body.tool_choice.type === 'any') {
      chatBody.tool_choice = 'required';
    } else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
      chatBody.tool_choice = {
        type: 'function',
        function: { name: body.tool_choice.name },
      };
    }
  }

  // 删除 Anthropic 专有字段（如果仍然存在）
  delete chatBody.thinking;
  delete chatBody.anthropic_beta;
  delete chatBody.anthropic_version;
  delete chatBody.top_k;
  delete chatBody.metadata;
  delete chatBody.context_management;
  delete chatBody.output_config;

  return chatBody;
}

// ----------------------------------------------------------------------------
// 协议转换：OpenAI → Anthropic
// ----------------------------------------------------------------------------

/**
 * 将 Chat Completions 响应转换为 Anthropic Messages 格式。
 *
 * 转换规则：
 *   - choices[0].message → content 数组
 *     text → {type:'text', text:'...'}
 *     tool_calls → {type:'tool_use', id:'...', name:'...', input:{...}}
 *   - finish_reason → stop_reason
 *     'stop' → 'end_turn'
 *     'length' → 'max_tokens'
 *     'tool_calls' → 'tool_use'
 *     'content_filter' → 'end_turn'
 *   - usage → usage
 *     prompt_tokens → input_tokens
 *     completion_tokens → output_tokens
 *
 * @param {object} chatResponse Chat Completions 响应体
 * @param {object} [originalBody] 原始 Anthropic 请求体（用于提取 model 等）
 * @returns {object} Anthropic Messages 格式的响应
 */
export function openaiToAnthropic(chatResponse, originalBody) {
  if (!chatResponse || typeof chatResponse !== 'object') {
    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model: originalBody?.model || '',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const choice = chatResponse.choices?.[0];
  const message = choice?.message;

  const content = [];

  // text 内容
  if (message?.content && typeof message.content === 'string') {
    content.push({ type: 'text', text: message.content });
  }

  // tool_calls → tool_use
  if (message?.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${Date.now()}`,
        name: tc.function?.name || '',
        input,
      });
    }
  }

  // 如果没有任何内容，添加空 text 块
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  // finish_reason → stop_reason
  const stopReason = mapFinishReason(choice?.finish_reason);

  // usage 转换
  const usage = chatResponse.usage || {};
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;

  return {
    id: chatResponse.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: originalBody?.model || chatResponse.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

// ----------------------------------------------------------------------------
// 错误响应构建
// ----------------------------------------------------------------------------

/**
 * 构建 Anthropic 格式的错误响应。
 *
 * 格式：{ type: 'error', error: { type: '...', message: '...' } }
 *
 * 错误类型映射：
 *   rate_limit → 'rate_limit_error'
 *   auth → 'authentication_error'
 *   not_found → 'not_found_error'
 *   server → 'api_error'
 *   其他 → 'api_error'
 *
 * @param {Error|object|null} error 错误对象
 * @param {string} [requestId] 请求唯一标识
 * @returns {{ type: 'error', error: { type: string, message: string } }}
 */
export function buildAnthropicError(error, requestId) {
  if (!error) {
    return {
      type: 'error',
      error: {
        type: 'api_error',
        message: 'An unexpected error occurred',
      },
    };
  }

  const message = error.message || String(error) || 'Unknown error';
  const errorType = error.type || error.errorType || 'unknown';

  let anthropicType;
  switch (errorType) {
    // 速率限制
    case 'rate_limit_transient':
    case 'rate_limit_quota':
    case 'rate_limit':
      anthropicType = 'rate_limit_error';
      break;
    // 认证错误
    case 'auth_invalid':
    case 'auth':
    case 'forbidden_key':
      anthropicType = 'authentication_error';
      break;
    // 未找到
    case 'not_found':
    case 'forbidden_model':
    case 'forbidden_provider':
      anthropicType = 'not_found_error';
      break;
    // 服务器错误
    case 'server_error':
    case 'network_error':
    case 'server':
    case 'service_unavailable':
      anthropicType = 'api_error';
      break;
    // 客户端请求错误
    case 'invalid_request_error':
      anthropicType = 'invalid_request_error';
      break;
    // 预算超限
    case 'budget_exceeded':
      anthropicType = 'invalid_request_error';
      break;
    // 默认
    default:
      anthropicType = 'api_error';
  }

  return {
    type: 'error',
    error: {
      type: anthropicType,
      message,
    },
  };
}

// ----------------------------------------------------------------------------
// 主处理函数
// ----------------------------------------------------------------------------

/**
 * 处理 Anthropic Messages 非流式请求。
 *
 * 流程：
 *   1. 应用 Claude Code 兼容补丁（thinking 处理、字段清理等）
 *   2. 转换为 Chat 格式（anthropicToOpenAI）
 *   3. 复用执行引擎进行串行 Fallback 执行
 *   4. 转换回 Anthropic 格式（openaiToAnthropic）
 *   5. 返回给客户端
 *
 * @param {import('http').IncomingMessage} req HTTP 请求对象
 * @param {import('http').ServerResponse} res HTTP 响应对象
 * @param {object} body 已解析的 Anthropic 请求体
 * @param {object} context 上下文，含 config, executionEngine, finalizer, costTracker, cancelToken, agentInfo
 */
export async function handleAnthropicMessage(req, res, body, context) {
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
    // 兼容补丁面向 OpenAI 兼容上游会清理 output_config；原生 Anthropic
    // 需要保留该字段，由显式 api_type=anthropic_native 的 Provider 接收。
    const nativeRequestBody = parsedBody?.output_config
      ? { ...patchedBody, output_config: parsedBody.output_config }
      : patchedBody;
    const isClaudeCode = patchResult.isClaudeCode;

    // 2. 转换为 Chat 格式
    const chatBody = anthropicToOpenAI(patchedBody);
    // 非流式请求：确保 stream 为 false
    chatBody.stream = false;

    const requestedModel = chatBody.model || patchedBody?.model || null;

    protocolLog(
      `[${requestId}] agent=${agentId} model=${requestedModel || 'auto'} ` +
      `claudeCode=${isClaudeCode} patches=[${patchResult.patches.join(',')}]`,
    );

    // 3. 构建候选列表
    const agentModels = getAgentModels(agentId, config);
    const budget = getAgentBudget(agentId, config);
    const capability = detectCapability(chatBody);

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
      nativeBody: nativeRequestBody,
    });


    // 5. 构建 AttemptLog
    const attemptLog = buildAttemptLogFromResult(executionResult, requestId);

    // 6. 处理执行结果
    if (executionResult.success) {
      await handleSuccess(
        res, executionResult, attemptLog, context, requestId, agentId,
        isClaudeCode, finalizer, costTracker, cancelToken, patchedBody,
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
        sendJsonResponse(res, 500, buildAnthropicError(err, requestId));
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
 * 处理执行成功的结果：读取响应体、清理、转换、收尾、发送响应。
 *
 * 步骤：
 *   1. 读取上游响应体
 *   2. 解析 JSON
 *   3. Claude Code 响应清理（reasoning_content / thinking 泄漏）
 *   4. 转换为 Anthropic 格式（openaiToAnthropic）
 *   5. 清洗 thinking 内容块
 *   6. 推导验证结果
 *   7. 提取 usage 并更新 AttemptLog
 *   8. 收尾（finalizer.finalize）
 *   9. 发送响应给客户端
 */
async function handleSuccess(
  res, executionResult, attemptLog, context, requestId, agentId,
  isClaudeCode, finalizer, costTracker, cancelToken, originalBody,
) {
  let responseBodyText = '';
  let chatResponse = null;
  let responseSize = 0;

  // 读取上游响应体
  try {
    responseBodyText = await executionResult.response.text();
    responseSize = Buffer.byteLength(responseBodyText);
    chatResponse = JSON.parse(responseBodyText);
    chatResponse = normalizeChatCompletionResponse(chatResponse);
  } catch {
    protocolLog(`[${requestId}] response body is not valid JSON, sending raw text`);
  }

  // Claude Code 响应清理
  if (isClaudeCode && chatResponse && typeof chatResponse === 'object') {
    // 清理 reasoning_content 字段
    chatResponse = cleanReasoningContent(chatResponse);

    // 清理思维链泄漏（"Thinking Process:" 等）
    if (Array.isArray(chatResponse.choices)) {
      for (const choice of chatResponse.choices) {
        if (choice?.message?.content && typeof choice.message.content === 'string') {
          choice.message.content = cleanThinkingProcessLeak(choice.message.content);
        }
      }
    }
  }

  // 转换为 Anthropic 格式
  let anthropicResponse;
  if (executionResult.nativeProtocol && chatResponse?.type === 'message') {
    // 原生 Anthropic Provider 已经返回目标协议，保持其完整字段语义。
    anthropicResponse = chatResponse;
  } else if (chatResponse && typeof chatResponse === 'object') {
    anthropicResponse = openaiToAnthropic(chatResponse, originalBody);
  } else {
    // 响应体非 JSON，构造最小 Anthropic 响应
    anthropicResponse = {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: responseBodyText || '' }],
      model: originalBody?.model || '',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  // 清洗 thinking 内容块（替换为 [text] 占位）
  anthropicResponse.content = cleanThinkingFromContent(anthropicResponse.content);

  // 推导验证结果
  const validatedOutcome = deriveValidatedOutcome(executionResult, chatResponse);
  const outcome = validatedOutcome === 'incomplete'
    ? Outcome.INCOMPLETE
    : Outcome.COMPLETED;

  // 从响应体提取 usage，更新 AttemptLog 并计算成本
  const extractedUsage = extractUsageFromBody(chatResponse);
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
  const anthropicResponseStr = JSON.stringify(anthropicResponse);
  const finalizeMethod = (typeof finalizer.finalizeRequestTransaction === 'function')
    ? finalizer.finalizeRequestTransaction.bind(finalizer)
    : finalizer.finalize.bind(finalizer);
  await finalizeMethod(requestId, attemptLog, outcome, {
    model: executionResult.finalCandidate?.modelId,
    provider: executionResult.finalCandidate?.provider,
    agentId,
    protocol: context.protocol || 'anthropic',
    responseSize: Buffer.byteLength(anthropicResponseStr),
  });

  // 发送响应给客户端
  if (!cancelToken?.isAborted() && isResWritable(res)) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(anthropicResponseStr),
    });
    res.end(anthropicResponseStr);
  }
}

// ----------------------------------------------------------------------------
// 失败处理
// ----------------------------------------------------------------------------

/**
 * 处理执行失败的结果：收尾、发送 Anthropic 错误响应。
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
    protocol: (context?.protocol) || 'anthropic',
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
    type: 'api_error',
  };
  sendJsonResponse(res, status, buildAnthropicError(error, requestId));
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  anthropicToOpenAI,
  openaiToAnthropic,
  buildAnthropicError,
  handleAnthropicMessage,
};
