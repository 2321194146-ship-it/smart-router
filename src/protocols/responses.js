// src/protocols/responses.js
// Smart Router Mainline - Phase 1
// Responses API 非流式协议处理：处理 OpenAI 兼容的 /v1/responses 非流式请求。
//
// 设计要点：
//   - Responses API 是 Codex 使用的协议，上游 Provider 通常只支持 Chat Completions
//   - 在边界做格式转换：Responses ↔ Chat Completions
//   - 复用 Chat 协议的执行逻辑（handleChatCompletion）
//   - 使用响应拦截器捕获 Chat 响应，转换为 Responses 格式后返回
//   - input 字段支持字符串和数组两种格式
//   - function_call / function_call_output 正确映射到 tool_calls / tool_result
//   - usage 格式转换：prompt_tokens → input_tokens, completion_tokens → output_tokens
//   - 客户端取消不发送响应
//   - 所有请求经 finalizer 幂等收尾（由 handleChatCompletion 内部完成）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { handleChatCompletion } from './chat.js';
import { normalizeChatCompletionResponse } from './response-normalization.js';
import { randomUUID } from 'node:crypto';

// ----------------------------------------------------------------------------
// 日志
// ----------------------------------------------------------------------------

function protocolLog(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[responses-protocol][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------------------

/**
 * 检查 res 是否可写（未结束且未销毁）。
 */
function isResWritable(res) {
  return res && !res.writableEnded && !res.destroyed;
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
 * 生成简短唯一 ID（用于 output item 的 id 字段）。
 */
function generateItemId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

// ----------------------------------------------------------------------------
// 请求转换：Responses → Chat Completions
// ----------------------------------------------------------------------------

/**
 * 将 Responses API 的 content parts 转换为 Chat Completions 的 content parts。
 *
 * Responses content parts:
 *   - { type: 'input_text', text }
 *   - { type: 'output_text', text }
 *   - { type: 'input_image', image_url, detail? }
 *
 * Chat content parts:
 *   - { type: 'text', text }
 *   - { type: 'image_url', image_url: { url, detail? } }
 *
 * @param {Array} parts - Responses content parts 数组
 * @returns {Array} Chat content parts 数组
 */
function convertContentPartsToChat(parts) {
  if (!Array.isArray(parts)) return parts;

  const converted = parts.map((part) => {
    if (!part || typeof part !== 'object') return part;

    switch (part.type) {
      case 'input_text':
      case 'output_text':
        return { type: 'text', text: part.text || '' };

      case 'input_image': {
        const imageUrl =
          typeof part.image_url === 'string'
            ? { url: part.image_url }
            : part.image_url || {};
        const result = { type: 'image_url', image_url: imageUrl };
        if (part.detail) result.image_url.detail = part.detail;
        return result;
      }

      case 'image_url':
        // 已经是 Chat 格式，原样返回
        return part;

      case 'text':
        // 已经是 Chat 格式，原样返回
        return part;

      default:
        // 未知类型，原样透传（不丢弃数据）
        return part;
    }
  });

  // Chat Completions API：纯文本消息的 content 应为字符串，而非数组。
  // 若全部为文本部分，合并为字符串；含图片时保留数组格式。
  const allText = converted.length > 0 && converted.every(
    (p) => p && typeof p === 'object' && p.type === 'text'
  );
  if (allText) {
    return converted.map((p) => p.text || '').join('');
  }

  return converted;
}

/**
 * 将 Responses API 的 tool_choice 转换为 Chat Completions 的 tool_choice。
 *
 * Responses tool_choice:
 *   - 'auto' | 'none' | 'required'
 *   - { type: 'function', name: 'fn_name' }
 *
 * Chat tool_choice:
 *   - 'auto' | 'none' | 'required'
 *   - { type: 'function', function: { name: 'fn_name' } }
 *
 * @param {string|object} toolChoice
 * @returns {string|object}
 */
function convertToolChoice(toolChoice) {
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }

  if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'function' && toolChoice.name) {
      return {
        type: 'function',
        function: { name: toolChoice.name },
      };
    }
    // 已经是 Chat 格式或未知格式，原样返回
    return toolChoice;
  }

  return toolChoice;
}

/**
 * 将 Responses API 的 tools 转换为 Chat Completions 的 tools。
 *
 * Responses tools:
 *   { type: 'function', name, description, parameters, strict? }
 *
 * Chat tools:
 *   { type: 'function', function: { name, description, parameters, strict? } }
 *
 * @param {Array} tools - Responses tools 数组
 * @returns {Array} Chat tools 数组
 */
function convertToolsToChat(tools) {
  if (!Array.isArray(tools)) return tools;

  // 只保留上游普遍支持的 function 类型工具；web_search/file_search/custom
  // 等特殊类型原样透传给智谱/bai 等上游会触发 400（tools[N].type invalid）。
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;

    // 已经是 Chat 格式（有 function 嵌套）
    if (tool.function && typeof tool.function === 'object') {
      out.push(tool);
      continue;
    }

    // Responses 格式：扁平结构
    if (tool.type === 'function') {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        },
      });
      continue;
    }

    // 其他类型（web_search, file_search, custom 等）：过滤，避免上游 400
    // 保留 function 类型工具即可满足编码 Agent 的核心工具调用需求。
  }
  return out;
}

/**
 * 将 Responses API 请求转换为 Chat Completions 格式。
 *
 * 转换规则：
 *   - input（字符串）→ 单条 user message
 *   - input（数组）→ 多条 messages：
 *     - type='message' → 对应 role 的 message
 *     - type='function_call' → assistant message with tool_calls
 *     - type='function_call_output' → tool message with tool_call_id
 *     - type='reasoning' → 跳过（Chat Completions 无对应概念）
 *   - instructions → 前置 system message
 *   - tools → Chat 格式 tools（function 嵌套）
 *   - tool_choice → Chat 格式 tool_choice
 *   - max_output_tokens → max_tokens
 *   - temperature, top_p → 原样透传
 *   - parallel_tool_calls → 原样透传
 *   - stream → 强制 false（非流式模块）
 *
 * @param {object} body - Responses API 请求体
 * @returns {object} Chat Completions 格式的请求体
 */
export function responsesToChat(body) {
  if (!body || typeof body !== 'object') {
    return { messages: [], stream: false };
  }

  const chatBody = {};

  // model
  if (body.model) chatBody.model = body.model;

  // 构建 messages
  let messages = [];

  // instructions → system message（前置）
  if (body.instructions && typeof body.instructions === 'string') {
    messages.push({ role: 'system', content: body.instructions });
  }

  // input → messages
  // input 可以是字符串或数组
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;

      switch (item.type) {
        case 'message': {
          // Responses message item → Chat message
          // developer 角色（OpenAI Responses 新角色，替代 system）上游普遍不支持，转为 system
          const rawRole = item.role || 'user';
          const msg = { role: rawRole === 'developer' ? 'system' : rawRole };

          // content 可以是字符串或数组
          if (typeof item.content === 'string') {
            msg.content = item.content;
          } else if (Array.isArray(item.content)) {
            msg.content = convertContentPartsToChat(item.content);
          } else if (item.content !== undefined) {
            msg.content = item.content;
          } else {
            msg.content = '';
          }

          messages.push(msg);
          break;
        }

        case 'function_call': {
          // Responses function_call → Chat assistant message with tool_calls
          // 表示对话历史中助手之前的函数调用
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: item.call_id || generateItemId('call'),
                type: 'function',
                function: {
                  name: item.name || '',
                  arguments: item.arguments || '',
                },
              },
            ],
          });
          break;
        }

        case 'function_call_output': {
          // Responses function_call_output → Chat tool message
          // 表示函数调用的返回结果
          let outputContent;
          if (typeof item.output === 'string') {
            outputContent = item.output;
          } else if (item.output !== undefined && item.output !== null) {
            try {
              outputContent = JSON.stringify(item.output);
            } catch {
              outputContent = String(item.output);
            }
          } else {
            outputContent = '';
          }

          messages.push({
            role: 'tool',
            tool_call_id: item.call_id || '',
            content: outputContent,
          });
          break;
        }

        case 'reasoning': {
          // Responses reasoning item → 跳过
          // Chat Completions 无直接对应的推理项概念
          break;
        }

        default:
          // 未知类型，跳过
          break;
      }
    }
  }

  // 合并多条 system message 为一条（上游普遍只支持单条 system，多条会返回空）
  const sysMsgs = messages.filter((m) => m.role === 'system');
  if (sysMsgs.length > 1) {
    const mergedContent = sysMsgs
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n\n');
    const otherMsgs = messages.filter((m) => m.role !== 'system');
    messages = [{ role: 'system', content: mergedContent }, ...otherMsgs];
  }

  chatBody.messages = messages;

  // tools → Chat 格式
  if (Array.isArray(body.tools)) {
    const chatTools = convertToolsToChat(body.tools);
    if (chatTools.length > 0) {
      chatBody.tools = chatTools;
    }
  }

  // tool_choice 转换
  if (body.tool_choice !== undefined) {
    chatBody.tool_choice = convertToolChoice(body.tool_choice);
  }

  // 透传参数
  if (body.temperature !== undefined) {
    chatBody.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    chatBody.top_p = body.top_p;
  }

  // max_output_tokens → max_tokens
  if (body.max_output_tokens !== undefined) {
    chatBody.max_tokens = body.max_output_tokens;
  } else if (body.max_completion_tokens !== undefined) {
    // 兼容 OpenAI Responses 的旧字段；明确优先 max_output_tokens。
    chatBody.max_tokens = body.max_completion_tokens;
  }

  // Responses 的结构化输出语义映射为 Chat response_format。
  // 这既让 Decision Engine 正确识别 structured_output 硬需求，
  // 也让支持该能力的 OpenAI-compatible Provider 收到原始约束。
  if (body.response_format && typeof body.response_format === 'object') {
    chatBody.response_format = body.response_format;
  } else if (body.text?.format && typeof body.text.format === 'object') {
    const format = body.text.format;
    if (format.type === 'json_object') {
      chatBody.response_format = { type: 'json_object' };
    } else if (format.type === 'json_schema' && format.schema && typeof format.schema === 'object') {
      chatBody.response_format = {
        type: 'json_schema',
        json_schema: {
          name: format.name || 'response_schema',
          description: format.description,
          strict: format.strict,
          schema: format.schema,
        },
      };
    }
  }

  // 兼容 reasoning effort 和调用方标识；未知字段不透传，避免把 Responses
  // 专有结构误发给 Chat Provider。
  if (body.reasoning?.effort !== undefined) {
    chatBody.reasoning_effort = body.reasoning.effort;
  }
  if (body.user !== undefined) chatBody.user = body.user;

  // parallel_tool_calls 透传
  if (body.parallel_tool_calls !== undefined) {
    chatBody.parallel_tool_calls = body.parallel_tool_calls;
  }

  // stop 透传
  if (body.stop !== undefined) {
    chatBody.stop = body.stop;
  }

  // presence_penalty / frequency_penalty 透传
  if (body.presence_penalty !== undefined) {
    chatBody.presence_penalty = body.presence_penalty;
  }
  if (body.frequency_penalty !== undefined) {
    chatBody.frequency_penalty = body.frequency_penalty;
  }

  // seed 透传
  if (body.seed !== undefined) {
    chatBody.seed = body.seed;
  }

  // 非流式模块：强制 stream=false
  chatBody.stream = false;

  return chatBody;
}

// ----------------------------------------------------------------------------
// 响应转换：Chat Completions → Responses API
// ----------------------------------------------------------------------------

/**
 * 将 Chat Completions 的 tool_calls 转换为 Responses 的 function_call items。
 *
 * @param {Array} toolCalls - Chat tool_calls 数组
 * @returns {Array} Responses function_call items
 */
function convertToolCallsToResponses(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls.map((tc) => ({
    type: 'function_call',
    id: generateItemId('fc'),
    call_id: tc.id || generateItemId('call'),
    name: tc.function?.name || '',
    arguments: tc.function?.arguments || '',
  }));
}

/**
 * 将 Chat Completions 响应转换为 Responses API 格式。
 *
 * 转换规则：
 *   - choices[0].message.content → message output item（含 output_text content part）
 *   - choices[0].message.tool_calls → function_call output items
 *   - usage.prompt_tokens → usage.input_tokens
 *   - usage.completion_tokens → usage.output_tokens
 *   - 返回 { id, object: 'response', created_at, model, output, status, usage }
 *
 * @param {object} chatResponse - Chat Completions 响应体
 * @param {object} [originalBody] - 原始 Responses API 请求体（用于回填 model 等）
 * @returns {object} Responses API 格式的响应体
 */
export function chatToResponses(chatResponse, originalBody) {
  if (!chatResponse || typeof chatResponse !== 'object') {
    return {
      id: generateItemId('resp'),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: originalBody?.model || 'unknown',
      output: [],
      status: 'completed',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const output = [];
  const choice = chatResponse.choices?.[0];

  if (choice?.message) {
    const msg = choice.message;

    // text content → message output item
    if (msg.content !== undefined && msg.content !== null && msg.content !== '') {
      output.push({
        type: 'message',
        id: generateItemId('msg'),
        role: 'assistant',
        content: [
          { type: 'output_text', text: String(msg.content) },
        ],
      });
    }

    // tool_calls → function_call items
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const functionCalls = convertToolCallsToResponses(msg.tool_calls);
      output.push(...functionCalls);
    }
  }

  // usage 转换：prompt_tokens → input_tokens, completion_tokens → output_tokens
  const rawUsage = chatResponse.usage;
  const usage = rawUsage
    ? {
        input_tokens: rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0,
        output_tokens: rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0,
        ...(rawUsage.total_tokens !== undefined
          ? { total_tokens: rawUsage.total_tokens }
          : {
              total_tokens:
                (rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0) +
                (rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0),
            }),
      }
    : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  // 确定状态：finish_reason='length' 或 'content_filter' 时为 incomplete
  let status = 'completed';
  const finishReason = choice?.finish_reason;
  if (finishReason === 'length' || finishReason === 'content_filter') {
    status = 'incomplete';
  }

  return {
    id: chatResponse.id || generateItemId('resp'),
    object: 'response',
    created_at: chatResponse.created || Math.floor(Date.now() / 1000),
    model: chatResponse.model || originalBody?.model || 'unknown',
    output,
    status,
    usage,
  };
}

// ----------------------------------------------------------------------------
// 错误响应构建
// ----------------------------------------------------------------------------

/**
 * 构建 Responses API 格式的错误响应。
 *
 * 格式：{ error: { message, type, code } }
 *
 * @param {Error|object|null} error - 错误对象
 * @param {string} [requestId] - 请求唯一标识
 * @returns {{ error: { message: string, type: string, code: string|null } }}
 */
export function buildResponsesError(error, requestId) {
  if (!error) {
    return {
      error: {
        message: 'An unexpected error occurred',
        type: 'internal_error',
        code: null,
      },
    };
  }

  const message = error.message || String(error) || 'Unknown error';
  const errorType = error.type || error.errorType || 'unknown';
  const code = error.code || error.errorCode || null;

  // 映射错误类型到 Responses API 的 type
  let responseType;
  switch (errorType) {
    case 'auth_invalid':
      responseType = 'authentication_error';
      break;
    case 'forbidden_key':
    case 'forbidden_model':
    case 'forbidden_provider':
    case 'forbidden_region':
    case 'forbidden_temp':
      responseType = 'permission_denied';
      break;
    case 'rate_limit_transient':
    case 'rate_limit_quota':
      responseType = 'rate_limit_exceeded';
      break;
    case 'server_error':
    case 'network_error':
      responseType = 'server_error';
      break;
    case 'client_aborted':
      responseType = 'client_closed';
      break;
    case 'budget_exceeded':
      responseType = 'insufficient_quota';
      break;
    case 'service_unavailable':
      responseType = 'service_unavailable';
      break;
    case 'invalid_request_error':
      responseType = 'invalid_request_error';
      break;
    default:
      responseType = 'internal_error';
      break;
  }

  return {
    error: {
      message,
      type: responseType,
      code,
    },
  };
}

// ----------------------------------------------------------------------------
// 响应拦截器：捕获 handleChatCompletion 的输出
// ----------------------------------------------------------------------------

/**
 * 创建响应拦截器。
 *
 * 拦截 handleChatCompletion 写入的响应数据，而不是发送给客户端。
 * 调用方在 handleChatCompletion 返回后，从拦截器读取捕获的响应，
 * 转换为 Responses 格式后发送给真正的客户端。
 *
 * 拦截器实现了 ServerResponse 所需的最小接口：
 *   - headersSent / writableEnded / destroyed 属性
 *   - writeHead(statusCode, headers) 方法
 *   - end(data) 方法
 *   - flushHeaders / setHeader / getHeader 等空实现
 *
 * @returns {object} 拦截器对象
 */
function createResponseInterceptor() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    headersSent: false,
    writableEnded: false,
    destroyed: false,

    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      if (headers && typeof headers === 'object') {
        this.headers = { ...headers };
      }
      this.headersSent = true;
    },

    end(data) {
      if (data !== undefined && data !== null) {
        this.body = typeof data === 'string' ? data : String(data);
      }
      this.writableEnded = true;
    },

    write(chunk) {
      if (this.body === null) this.body = '';
      this.body += typeof chunk === 'string' ? chunk : String(chunk);
    },

    flushHeaders() {},

    setHeader() { return this; },
    getHeader() { return undefined; },
    removeHeader() {},

    on() { return this; },
    off() { return this; },
    once() { return this; },
    emit() { return false; },

    get socket() {
      return { destroyed: false };
    },
  };
}

// ----------------------------------------------------------------------------
// 主处理函数
// ----------------------------------------------------------------------------

/**
 * 处理 Responses API 非流式请求。
 *
 * 流程：
 *   1. 解析请求体
 *   2. 将 Responses 请求转换为 Chat Completions 格式
 *   3. 创建响应拦截器，调用 handleChatCompletion 复用 Chat 协议执行逻辑
 *   4. 从拦截器读取 Chat 响应，转换为 Responses 格式
 *   5. 返回给客户端
 *
 * handleChatCompletion 内部完成：
 *   - Claude Code 兼容补丁（对 Codex 不生效）
 *   - 候选列表构建
 *   - 执行引擎串行 Fallback
 *   - 成本记录与审计收尾
 *   - 错误处理
 *
 * @param {import('http').IncomingMessage} req HTTP 请求对象
 * @param {import('http').ServerResponse} res HTTP 响应对象
 * @param {object|string} body 已解析的请求体（Responses API 格式）
 * @param {object} context 上下文（含 config, executionEngine, finalizer, costTracker, cancelToken, agentInfo）
 */
export async function handleResponse(req, res, body, context) {
  const requestId = context.requestId;
  const externalRequestId = req?.headers?.['x-request-id'] || req?.headers?.['x-correlation-id'] || null;

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

  if (!parsedBody || typeof parsedBody !== 'object') {
    sendJsonResponse(res, 400, buildResponsesError(
      { message: 'Request body must be an object', type: 'invalid_request_error' },
      requestId,
    ));
    return;
  }

  protocolLog(`[${requestId}] responses non-stream model=${parsedBody.model || 'auto'}`);

  // 1. 将 Responses 请求转换为 Chat Completions 格式
  const chatBody = responsesToChat(parsedBody);

  // 2. 创建响应拦截器
  const interceptor = createResponseInterceptor();

  // 3. 调用 handleChatCompletion（复用 Chat 协议的执行逻辑）
  //    handleChatCompletion 内部完成候选构建、执行、收尾等全部逻辑
  try {
    await handleChatCompletion(req, interceptor, chatBody, context);
  } catch (err) {
    protocolLog(`[${requestId}] handleChatCompletion threw: ${err.message}`);
    if (isResWritable(res)) {
      sendJsonResponse(res, 500, buildResponsesError(err, requestId));
    }
    return;
  }

  // 4. 检查客户端是否仍连接
  if (context?.cancelToken?.isAborted() || !isResWritable(res)) {
    protocolLog(`[${requestId}] client disconnected, not sending response`);
    return;
  }

  // 5. 检查拦截器是否捕获到响应
  if (!interceptor.writableEnded || interceptor.body == null) {
    // handleChatCompletion 未发送响应（可能客户端在执行期间断开）
    protocolLog(`[${requestId}] no response captured from handleChatCompletion`);
    if (isResWritable(res)) {
      sendJsonResponse(res, 502, buildResponsesError(
        { message: 'No response from upstream', type: 'server_error' },
        requestId,
      ));
    }
    return;
  }

  // 6. 解析捕获的 Chat 响应
  let chatResponse;
  try {
    const bodyStr = typeof interceptor.body === 'string'
      ? interceptor.body
      : interceptor.body.toString();
    chatResponse = JSON.parse(bodyStr);
    chatResponse = normalizeChatCompletionResponse(chatResponse);
  } catch {
    protocolLog(`[${requestId}] captured response is not valid JSON`);
    sendJsonResponse(res, 502, buildResponsesError(
      { message: 'Invalid response from upstream', type: 'server_error' },
      requestId,
    ));
    return;
  }

  // 7. 检查是否为错误响应
  if (chatResponse.error || (interceptor.statusCode && interceptor.statusCode >= 400)) {
    const statusCode = interceptor.statusCode || 500;
    const error = chatResponse.error || {
      message: `Request failed with status ${statusCode}`,
      type: 'internal_error',
    };
    protocolLog(`[${requestId}] upstream error: ${error.message || 'unknown'}`);
    sendJsonResponse(res, statusCode, buildResponsesError(error, requestId));
    return;
  }

  // 8. 转换为 Responses 格式
  const responsesBody = chatToResponses(chatResponse, parsedBody);

  protocolLog(
    `[${requestId}] responses completed: output_items=${responsesBody.output.length} ` +
    `status=${responsesBody.status}`,
  );

  // 9. 发送给客户端
  sendJsonResponse(res, 200, responsesBody);
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  responsesToChat,
  chatToResponses,
  handleResponse,
  buildResponsesError,
};
