/**
 * anthropic.js — Handles Anthropic Messages API requests
 * Converts Anthropic format ↔ OpenAI format for routing through providers.
 * Supports claude-native mode (direct Anthropic API).
 */
import { getConfig } from './config.js';
import { buildCandidates, executeCandidates } from './provider-client.js';

const log = (...args) => console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}]`, ...args);

function sanitize(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/(sk-|nvapi-|ms-|ak_)[a-zA-Z0-9_-]{10,}/g, '$1***');
}

/**
 * Convert Anthropic-style messages to OpenAI-style messages.
 * tool_use content blocks → consolidated assistant message with tool_calls[]
 * tool_result content blocks → role: "tool" messages
 * User messages with mixed content (text + tool_result) → split into separate messages
 */
export function toOpenAIBody(anthropicBody) {
  const { model, max_tokens, system, messages, tools, tool_choice, stream, temperature, top_p, stop_sequences } = anthropicBody;

  const oaiMessages = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const parts = typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : msg.content;

      const textParts = [];
      const toolResults = [];

      for (const block of parts) {
        if (block.type === 'tool_result') {
          toolResults.push(block);
        } else if (block.type === 'text') {
          textParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          textParts.push({ type: 'image_url', image_url: { url: block.source?.data ? `data:${block.source.media_type};base64,${block.source.data}` : '' } });
        }
      }

      if (textParts.length > 0) {
        oaiMessages.push({ role: 'user', content: textParts.length === 1 && textParts[0].type === 'text' ? textParts[0].text : textParts });
      }

      for (const tr of toolResults) {
        oaiMessages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id || '',
          content: typeof tr.content === 'string' ? tr.content : (tr.content?.map?.(c => c.text)?.join('') || ''),
        });
      }
    } else if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string' ? msg.content : msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
      const toolCalls = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input) }
            });
          }
        }
      }
      const oai = { role: 'assistant' };
      if (content) oai.content = content;
      if (toolCalls.length > 0) oai.tool_calls = toolCalls;
      oaiMessages.push(oai);
    } else if (msg.role === 'tool_result') {
      oaiMessages.push({
        role: 'tool',
        tool_call_id: msg.tool_use_id || '',
        content: typeof msg.content === 'string' ? msg.content : (msg.content?.map?.(c => c.text)?.join('') || ''),
      });
    }
  }

  if (system) {
    oaiMessages.unshift({ role: 'system', content: system });
  }

  const oaiTools = tools ? tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} }
  })) : undefined;

  const oaiBody = { model, messages: oaiMessages, stream: stream === true };
  if (max_tokens) oaiBody.max_tokens = max_tokens;
  if (temperature !== undefined) oaiBody.temperature = temperature;
  if (top_p !== undefined) oaiBody.top_p = top_p;
  if (stop_sequences) oaiBody.stop = stop_sequences;
  if (oaiTools) oaiBody.tools = oaiTools;
  if (tool_choice) {
    if (tool_choice.type === 'any') oaiBody.tool_choice = 'required';
    else if (tool_choice.type === 'auto') oaiBody.tool_choice = 'auto';
    else if (tool_choice.type === 'tool' && tool_choice.name) oaiBody.tool_choice = { type: 'function', function: { name: tool_choice.name } };
    else oaiBody.tool_choice = tool_choice.type;
  }
  return { body: oaiBody, costMultiplier: 1 };
}

/**
 * Convert OpenAI streaming SSE chunks to Anthropic streaming event objects.
 * Correct event sequence: message_start → content_block_start → delta → ... → content_block_stop → message_delta → message_stop
 */
export async function* fromOpenAIToAnthropicStream(oaiStream) {
  let contentStarted = false;
  let contentBlockIdx = 0;
  const toolBlocks = new Map();

  for await (const chunk of oaiStream) {
    const delta = chunk.choices?.[0]?.delta;
    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (!delta) {
      if (finishReason) break;
      continue;
    }

    if (delta.content) {
      if (!contentStarted) {
        yield { type: 'content_block_start', index: contentBlockIdx, content_block: { type: 'text', text: '' } };
        contentStarted = true;
      }
      yield { type: 'content_block_delta', index: contentBlockIdx, delta: { type: 'text_delta', text: delta.content } };
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name || tc.id) {
          if (contentStarted) {
            yield { type: 'content_block_stop', index: contentBlockIdx };
            contentStarted = false;
          }
          const idx = tc.index !== undefined ? contentBlockIdx + 1 + parseInt(tc.index) : toolBlocks.size + 1;
          if (!toolBlocks.has(idx)) {
            yield { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id || '', name: tc.function?.name || '' } };
            toolBlocks.set(idx, true);
          }
          if (tc.function?.arguments) {
            yield { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } };
          }
        }
      }
    }

    if (finishReason) {
      if (contentStarted) yield { type: 'content_block_stop', index: contentBlockIdx };
      for (const idx of toolBlocks.keys()) {
        yield { type: 'content_block_stop', index: idx };
      }
      const stopReason = finishReason === 'tool_calls' ? 'tool_use' : (finishReason === 'length' ? 'max_tokens' : 'end_turn');
      yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } };
      yield { type: 'message_stop' };
      return;
    }
  }

  if (contentStarted) yield { type: 'content_block_stop', index: contentBlockIdx };
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } };
  yield { type: 'message_stop' };
}

/**
 * Convert OpenAI-style response to Anthropic-style response body
 */
export function fromOpenAIResponse(oaiResponse, requestModel) {
  const choice = oaiResponse.choices?.[0];
  if (!choice) return { content: [] };
  const content = [];
  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      try {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input: JSON.parse(tc.function?.arguments || '{}') });
      } catch {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input: {} });
      }
    }
  }
  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason || 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: oaiResponse.usage?.prompt_tokens || 0,
      output_tokens: oaiResponse.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Parse an OpenAI SSE stream into async iterable of parsed objects
 */
export async function* parseOAISToStream(readableStream) {
  const decoder = new TextDecoder();
  const reader = readableStream.getReader();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          const line = buffer.trim();
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data !== '[DONE]') { try { yield JSON.parse(data); } catch {} }
          }
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try { yield JSON.parse(data); } catch {}
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch {}
  }
}

/**
 * Pipe raw SSE response directly to the client.
 * For native Anthropic: pass raw bytes unchanged (no filtering, no event reordering).
 * For converted streams: the SSE events are already properly formatted.
 */
export async function pipeAnthropicSSE(readableStream, writable, options = {}) {
  const decoder = new TextDecoder();
  const reader = readableStream.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any remaining bytes
        if (buffer) {
          try { writable.write(buffer); } catch {}
        }
        break;
      }
      const text = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      buffer += text;

      // If the stream uses newline framing, write line by line keeping \n
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        try { writable.write(line + '\n'); } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('[anthropic] SSE pipe error:', sanitize(e.message));
    }
  } finally {
    try { reader.cancel(); } catch {}
  }
}

/**
 * Handle an Anthropic Messages API request.
 *
 * Returns one of:
 *   { error, status, body } - error response
 *   { isStream: true, response: ReadableStream, model, provider, latencyMs, nativeAnthropic: true } - streaming
 *   { isStream: false, body: string|object, model, provider, latencyMs } - non-streaming response
 */
export async function handleAnthropicMessage(body, agent = '', ctx = {}) {
  const config = getConfig();
  const claudeMode = config.claude_code_mode || 'claude-native';
  const startTime = Date.now();

  if (claudeMode === 'claude-native') {
    const providers = config.providers || {};
    const anthropicProvider = providers['anthropic'] || Object.values(providers).find(p =>
      (p.api_type || 'openai') === 'anthropic' || (p.base_url || '').includes('anthropic.com')
    );
    if (!anthropicProvider || !anthropicProvider.api_key) {
      return { error: true, status: 503, body: JSON.stringify({ error: { type: 'configuration_error', message: 'claude-native mode requires an Anthropic provider with api_key configured' } }) };
    }

    const baseUrl = (anthropicProvider.base_url || 'https://api.anthropic.com').replace(/\/+$/, '');
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': anthropicProvider.api_key,
      'anthropic-version': '2023-06-01',
      ...(anthropicProvider.custom_headers || {}),
    };

    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errBody = await response.text().catch(() => '{}');
      return { error: true, status: response.status, body: errBody, provider: 'anthropic', latencyMs };
    }

    if (body.stream === true) {
      return {
        isStream: true, response: response.body,
        model: body.model || 'claude-sonnet-4-20250514',
        provider: 'anthropic', latencyMs, nativeAnthropic: true,
      };
    }

    const text = await response.text();
    return { isStream: false, body: text, model: body.model || 'claude-sonnet-4-20250514', provider: 'anthropic', latencyMs, status: 200 };
  }

  // ── experimental-non-claude-routing mode ──
  const { body: oaiBody } = toOpenAIBody(body);
  const overrides = { requestId: ctx.requestId || `anthropic-${Date.now()}` };
  const candidates = buildCandidates(oaiBody, overrides, config);

  if (candidates.length === 0) {
    return { error: true, status: 503, body: JSON.stringify({ error: { type: 'api_error', message: 'No available candidates' } }) };
  }

  try {
    const result = await executeCandidates(candidates, oaiBody, {
      agent,
      requestId: overrides.requestId,
      maxAttemptsPerCandidate: config.routing?.maxAttemptsPerCandidate || 1,
      maxTotalAttempts: config.routing?.maxRetries || 4,
      timeoutMs: config.routing?.perModelTimeoutMs || 20000,
    });

    const latencyMs = Date.now() - startTime;

    if (result.error) {
      return { error: true, status: result.status || 502, body: result.body, provider: result.provider, model: result.model, latencyMs };
    }

    if (result.isStream) {
      const oaiStream = parseOAISToStream(result.remainingStream);
      const encoder = new TextEncoder();
      const msgId = `msg_${Date.now()}`;
      const convertedStream = new ReadableStream({
        async start(controller) {
          try {
            controller.enqueue(encoder.encode(`data: {"type":"message_start","message":{"id":"${msgId}","type":"message","role":"assistant","content":[],"model":"${result.model}","stop_reason":null,"stop_sequence":null,"usage":{}}}\n\n`));
            for await (const event of fromOpenAIToAnthropicStream(oaiStream)) {
              const isDone = event.type === 'message_stop';
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              if (isDone) break;
            }
          } catch (e) {
            controller.enqueue(encoder.encode(`data: {"type":"error","error":{"type":"stream_error","message":"streaming error"}}\n\n`));
          } finally {
            try { controller.close(); } catch {}
          }
        }
      });
      return {
        isStream: true, response: convertedStream,
        model: result.model, provider: result.provider, latencyMs, nativeAnthropic: true,
      };
    }

    const oaiResponse = JSON.parse(result.body);
    const anthropicResponse = fromOpenAIResponse(oaiResponse, result.model);
    return {
      isStream: false, body: JSON.stringify(anthropicResponse),
      model: result.model, provider: result.provider, latencyMs, status: 200,
    };
  } catch (err) {
    return { error: true, status: 502, body: JSON.stringify({ error: { type: 'api_error', message: sanitize(err.message) } }) };
  }
}
