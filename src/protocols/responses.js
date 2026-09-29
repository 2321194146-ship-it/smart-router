/**
 * protocols/responses.js — OpenAI Responses API adapter (non-streaming + request shaping)
 *
 * This module is a SELF-CONTAINED re-implementation of the Responses<->Chat Completions
 * conversion used by Codex, grounded in the old 7878 gateway's behaviour and the official
 * OpenAI Responses spec. It does NOT import any provider/routing internals (those live in
 * provider-client.js); the router calls into this module after fetching an upstream result.
 *
 * Responsibilities:
 *   - validateResponsesRequest   : structural request validation -> standard 4xx
 *   - responsesToChat            : Responses request -> Chat Completions body (adapter mode)
 *   - chatToResponses            : Chat Completions JSON -> Responses result (adapter mode)
 *   - responsesError             : uniform Responses error envelope
 *
 * Streaming lives in protocols/responses-stream.js.
 */

function randHex(n) {
  let s = '';
  const chars = '0123456789abcdef';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

export function responsesError(status, type, message, param = null) {
  return { error: { message, type, param, code: null } };
}

/**
 * Structural validation of a Responses request. Returns { ok:true } or
 * { ok:false, status, type, message }. Does NOT perform adapter-only field checks
 * (those happen in responsesToChat, which can tell adapter/native apart per candidate).
 */
export function validateResponsesRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, type: 'invalid_request_error', message: 'request body must be a JSON object' };
  }
  if (body.input === undefined || body.input === null) {
    // OpenAI allows omitting input for some flows; treat null as empty. Missing is still required.
    if (body.input === undefined) {
      return { ok: false, status: 400, type: 'invalid_request_error', message: "missing required field 'input'" };
    }
  }
  if (body.input !== undefined && body.input !== null) {
    if (typeof body.input !== 'string' && !Array.isArray(body.input)) {
      return { ok: false, status: 400, type: 'invalid_request_error', message: "'input' must be a string or an array of items" };
    }
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return { ok: false, status: 400, type: 'invalid_request_error', message: "'stream' must be a boolean" };
  }
  if (body.model !== undefined && typeof body.model !== 'string') {
    return { ok: false, status: 400, type: 'invalid_request_error', message: "'model' must be a string" };
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return { ok: false, status: 400, type: 'invalid_request_error', message: "'tools' must be an array" };
  }
  if (body.tool_choice !== undefined && typeof body.tool_choice !== 'string' && typeof body.tool_choice !== 'object') {
    return { ok: false, status: 400, type: 'invalid_request_error', message: "'tool_choice' must be a string or object" };
  }
  if (body.previous_response_id !== undefined && typeof body.previous_response_id !== 'string') {
    return { ok: false, status: 400, type: 'invalid_request_error', message: "'previous_response_id' must be a string" };
  }
  return { ok: true };
}

const DEV_ROLE_MAP = { developer: 'developer', system: 'system', user: 'user', assistant: 'assistant' };

function inputItemToMessages(item) {
  // Plain { role, content } object (no explicit type) -> normalise then handle as message
  // so that content-part arrays (input_text / input_image) are still converted.
  if (item && typeof item === 'object' && !item.type && item.role) {
    return inputItemToMessages({ type: 'message', role: item.role, content: item.content });
  }
  if (!item || typeof item !== 'object') {
    if (typeof item === 'string') return [{ role: 'user', content: item }];
    throw new Error('unsupported input item');
  }
  switch (item.type) {
    case 'message': {
      const role = DEV_ROLE_MAP[item.role] || item.role;
      let content = item.content;
      if (Array.isArray(content)) {
        content = content.map((part) => {
          if (part.type === 'input_text' || part.type === 'text') return { type: 'text', text: part.text };
          if (part.type === 'input_image') {
            const url = part.image_url?.url || part.image_url;
            if (!url) throw new Error('input_image is missing image_url.url');
            const image_url = { url };
            const detail = part.detail || part.image_url?.detail;
            if (detail) image_url.detail = detail; // preserve detail when safe to map
            return { type: 'image_url', image_url };
          }
          if (part.type === 'input_file') throw new Error("input_file is not supported by chat-adapter mode (use a native Responses provider)");
          throw new Error(`unsupported message content part type '${part.type}'`);
        });
      }
      return [{ role, content }];
    }
    case 'input_text':
      return [{ role: 'user', content: item.text }];
    case 'input_image': {
      const url = item.image_url?.url || item.image_url;
      if (!url) throw new Error('input_image is missing image_url.url');
      const image_url = { url };
      const detail = item.detail || item.image_url?.detail;
      if (detail) image_url.detail = detail;
      return [{ role: 'user', content: [{ type: 'image_url', image_url }] }];
    }
    case 'function_call':
      return [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments || '{}' },
        }],
      }];
    case 'function_call_output':
      return [{ role: 'tool', tool_call_id: item.call_id, content: item.output }];
    default:
      throw new Error(`unsupported input item type '${item.type}'`);
  }
}

/**
 * Convert an OpenAI Responses request into a Chat Completions request body.
 * Throws a clear Error for any field the chat-adapter cannot safely serve, so the
 * caller can drop this candidate and fall back to a native provider (or surface a 422).
 */
export function responsesToChat(body) {
  const messages = [];
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const msgs = inputItemToMessages(item);
      for (const m of msgs) messages.push(m);
    }
  }

  const chat = {
    model: body.model,
    messages,
    stream: !!body.stream,
  };
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens;

  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools.map((t) => {
      if (t.type && t.type !== 'function') {
        throw new Error(`Unsupported tool type '${t.type}' in chat-adapter mode (only 'function' tools are supported; use a native Responses provider for '${t.type}')`);
      }
      const fn = { name: t.name, description: t.description || '', parameters: t.parameters || {} };
      if (t.strict !== undefined) fn.strict = t.strict; // preserve strict, never drop
      return { type: 'function', function: fn };
    });
    if (body.tool_choice !== undefined) {
      if (typeof body.tool_choice === 'string') {
        chat.tool_choice = body.tool_choice; // auto | none | required
      } else if (body.tool_choice && body.tool_choice.type === 'function' && body.tool_choice.name) {
        chat.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
      } else {
        // Unsupported tool_choice object type (allowed_tools / custom / mcp / etc.) must NOT
        // be passed raw to a Chat provider — surface a clear 422 instead.
        const err = new Error(`Unsupported tool_choice object type '${body.tool_choice && body.tool_choice.type}' in chat-adapter mode`);
        err.responsesValidationError = true;
        throw err;
      }
    }
  }

  if (body.text && body.text.format) {
    const f = body.text.format;
    if (f.type === 'json_schema') {
      // Accept BOTH the current flat shape ({type,name,description,schema,strict}) and the
      // legacy nested shape ({type,json_schema:{...}}). Normalize to Chat's nested form and
      // never silently drop the schema.
      const js = f.json_schema && typeof f.json_schema === 'object'
        ? { ...f.json_schema }
        : {
            name: f.name,
            description: f.description,
            schema: f.schema,
            strict: f.strict,
          };
      if (js.name === undefined) delete js.name;
      if (js.description === undefined) delete js.description;
      if (js.strict === undefined) delete js.strict;
      if (js.schema === undefined || js.schema === null) {
        throw new Error("text.format.type 'json_schema' requires a 'schema' object (schema must not be dropped)");
      }
      chat.response_format = { type: 'json_schema', json_schema: js };
    } else if (f.type === 'json_object') {
      chat.response_format = { type: 'json_object' };
    } else if (f.type === 'text') {
      chat.response_format = { type: 'text' };
    } else {
      throw new Error(`Unsupported text.format.type '${f.type}' (chat-adapter supports 'json_schema', 'json_object', 'text')`);
    }
  }

  // Fields that chat-adapter cannot safely serve -> clear error (never silently dropped).
  if (body.reasoning) {
    throw new Error('reasoning is only supported by native Responses providers in chat-adapter mode');
  }
  if (body.previous_response_id) {
    throw new Error('previous_response_id requires a native Responses provider or full input context (chat-adapter has no conversation store)');
  }

  return chat;
}

/**
 * Convert a Chat Completions JSON response into an OpenAI Responses result object.
 * `finalModel` is the provider apiModel actually used (for the `model` field).
 */
export function chatToResponses(chatJson, originalBody, finalModel) {
  const choice = chatJson.choices && chatJson.choices[0];
  const id = `resp_${randHex(24)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const output = [];

  if (choice && Array.isArray(choice.message && choice.message.tool_calls) && choice.message.tool_calls.length) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: 'function_call',
        id: tc.id,
        call_id: tc.id,
        status: 'completed',
        name: tc.function && tc.function.name,
        arguments: (tc.function && tc.function.arguments) || '',
      });
    }
  } else {
    const text = (choice && choice.message && choice.message.content) || '';
    const msgId = `msg_${randHex(24)}`;
    output.push({
      type: 'message',
      id: msgId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  const u = chatJson.usage || {};
  const inputTokens = u.prompt_tokens || 0;
  const outputTokens = u.completion_tokens || 0;
  const totalTokens = u.total_tokens || (inputTokens + outputTokens);
  const usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens };
  if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens != null) {
    usage.input_tokens_details = { cached_tokens: u.prompt_tokens_details.cached_tokens };
  }
  if (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens != null) {
    usage.output_tokens_details = { reasoning_tokens: u.completion_tokens_details.reasoning_tokens };
  }

  const finishReason = choice && choice.finish_reason;
  const incomplete = finishReason === 'length' ? { reason: 'max_output_tokens' } : null;

  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: finishReason === 'length' ? 'incomplete' : 'completed',
    model: finalModel || (chatJson.model || originalBody.model),
    output,
    error: null,
    usage,
    incomplete_details: incomplete,
  };
}
