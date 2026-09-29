/**
 * protocols/responses-stream.js — OpenAI Responses SSE streaming transforms
 *
 *  - pipeChatStreamToResponses : Chat Completions SSE  -> Responses SSE (adapter mode)
 *  - forwardNativeStream       : Responses SSE byte-exact passthrough (native mode)
 *
 * Reliability contract (6.2.1):
 *  - A `response.completed` event is emitted ONLY on an explicit, normal upstream end
 *    (finish_reason stop / tool_calls / content_filter etc.).
 *  - finish_reason === 'length' -> terminal `response.incomplete` (status incomplete +
 *    incomplete_details), NEVER `response.completed`.
 *  - Upstream read error / connection reset / parse failure / premature EOF without a
 *    finish_reason -> terminal `response.failed` (if the client is still connected),
 *    NEVER `response.completed`; half-written text/tool calls are never marked completed.
 *  - Stall (no upstream bytes within streamStallTimeoutMs) -> `response.failed`.
 *  - Client disconnect -> cancel the upstream reader immediately, stop writing, and DO NOT
 *    emit any terminal success event.
 *  - Exactly one terminal event (completed | incomplete | failed) is ever written.
 *  - monotonic sequence_number; stable item_id / call_id / output_index.
 *  - reader / stall timer / abort listener are always cleaned up (no leaks).
 *  - Each function returns a structured result so server.js can persist the true status:
 *      { outcome: 'completed'|'incomplete'|'failed'|'client_aborted',
 *        usage: {input_tokens,output_tokens,total_tokens}|null,
 *        statusCode: number,   // suggested persisted status (200/502/504/499)
 *        code: string|null, message: string|null }
 */

import { TextDecoder } from 'node:util';

const DEFAULT_STALL_MS = 60000;

function randHex(n) {
  let s = '';
  const chars = '0123456789abcdef';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

function log(...a) { console.log('[responses-stream]', ...a); }

function sse(data) { return `data: ${JSON.stringify(data)}\n\n`; }

function safeMessage(err) {
  const m = (err && err.message) || String(err || 'stream error');
  // never leak keys / bearer tokens / long hex secrets
  return m.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***').slice(0, 300);
}

function buildResponseShell(id, model, status, output, usage, incomplete, error) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: output || [],
    error: error || null,
    usage: usage || null,
    incomplete_details: incomplete || null,
  };
}

/**
 * Convert a Chat Completions upstream SSE stream into an OpenAI Responses SSE stream,
 * writing directly to `writable` (the HTTP response).
 */
export async function pipeChatStreamToResponses(upstreamStream, writable, opts = {}) {
  const {
    requestId = 'unknown', model = 'unknown', externalSignal, onUsage,
    stallTimeoutMs = DEFAULT_STALL_MS,
  } = opts;

  const responseId = `resp_${randHex(24)}`;
  const msgId = `msg_${randHex(24)}`;
  let seq = 0;
  const nextSeq = () => ++seq;

  const output = [];
  let messageOpen = false;
  let fullText = '';
  const toolCalls = []; // { index, call_id, item_id, name, args, item }

  let terminalSent = false;   // completed | incomplete | failed already written
  let usageObj = null;

  let clientAborted = false;
  let stalled = false;
  let readError = null;

  const reader = upstreamStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stallTimer = null;
  let lastChunkTime = Date.now();

  const onAbort = () => { clientAborted = true; try { reader.cancel(); } catch {} };
  if (externalSignal) {
    if (externalSignal.aborted) clientAborted = true;
    else { try { externalSignal.addEventListener('abort', onAbort); } catch {} }
  }

  const clientGone = () => clientAborted
    || (writable && (writable.writableEnded || writable.destroyed))
    || (externalSignal && externalSignal.aborted);

  const write = (data) => {
    if (clientGone()) return false;
    try { writable.write(sse(data)); return true; }
    catch { clientAborted = true; return false; }
  };

  const reportUsage = (u) => {
    if (usageObj || !u) return;
    usageObj = {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      total_tokens: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
    };
    if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens != null) {
      usageObj.input_tokens_details = { cached_tokens: u.prompt_tokens_details.cached_tokens };
    }
    if (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens != null) {
      usageObj.output_tokens_details = { reasoning_tokens: u.completion_tokens_details.reasoning_tokens };
    }
    if (onUsage) { try { onUsage(usageObj); } catch {} }
  };

  const outputIndexOf = (item) => output.indexOf(item);

  // Close all open items (text part + tool calls) — shared by success & incomplete paths.
  const closeOpenItems = () => {
    if (messageOpen) {
      const mitem = output.find((o) => o.id === msgId);
      if (mitem) {
        mitem.content = [{ type: 'output_text', text: fullText, annotations: [] }];
        mitem.status = 'completed';
        const oi = outputIndexOf(mitem);
        write({ type: 'response.output_text.done', sequence_number: nextSeq(), item_id: msgId, output_index: oi, content_index: 0, text: fullText });
        write({ type: 'response.content_part.done', sequence_number: nextSeq(), item_id: msgId, output_index: oi, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } });
        write({ type: 'response.output_item.done', sequence_number: nextSeq(), output_index: oi, item: mitem });
      }
      messageOpen = false;
    }
    for (const e of toolCalls) {
      e.item.arguments = e.args;
      e.item.name = e.name;
      e.item.status = 'completed';
      const oi = outputIndexOf(e.item);
      write({ type: 'response.function_call_arguments.done', sequence_number: nextSeq(), item_id: e.item_id, output_index: oi, call_id: e.call_id, arguments: e.args });
      write({ type: 'response.output_item.done', sequence_number: nextSeq(), output_index: oi, item: e.item });
    }
  };

  // Terminal: normal completion or max-token incomplete.
  const emitSuccess = (finishReason) => {
    if (terminalSent) return { outcome: 'completed', usage: usageObj, statusCode: 200, code: null, message: null };
    closeOpenItems();
    const isIncomplete = finishReason === 'length';
    if (isIncomplete) {
      const incomplete = { reason: 'max_output_tokens' };
      write({ type: 'response.incomplete', sequence_number: nextSeq(), response: buildResponseShell(responseId, model, 'incomplete', output, usageObj, incomplete, null) });
      terminalSent = true;
      return { outcome: 'incomplete', usage: usageObj, statusCode: 200, code: 'incomplete', message: 'max_output_tokens' };
    }
    write({ type: 'response.completed', sequence_number: nextSeq(), response: buildResponseShell(responseId, model, 'completed', output, usageObj, null, null) });
    terminalSent = true;
    return { outcome: 'completed', usage: usageObj, statusCode: 200, code: null, message: null };
  };

  // Terminal: failure. Never marks partial output as completed.
  const emitFailure = (code, message, statusCode) => {
    if (!terminalSent && !clientGone()) {
      const err = { code, message: safeMessage({ message }) };
      write({ type: 'response.failed', sequence_number: nextSeq(), response: buildResponseShell(responseId, model, 'failed', output, usageObj, null, err) });
      terminalSent = true;
    }
    return { outcome: 'failed', usage: usageObj, statusCode: statusCode || 502, code, message: safeMessage({ message }) };
  };

  try {
    if (clientGone()) {
      try { reader.cancel(); } catch {}
      return { outcome: 'client_aborted', usage: null, statusCode: 499, code: 'client_aborted', message: 'client disconnected before stream start' };
    }

    write({ type: 'response.created', sequence_number: nextSeq(), response: buildResponseShell(responseId, model, 'in_progress', [], null, null, null) });
    write({ type: 'response.in_progress', sequence_number: nextSeq(), response: buildResponseShell(responseId, model, 'in_progress', [], null, null, null) });

    if (stallTimeoutMs > 0) {
      const tick = Math.max(500, Math.min(2000, stallTimeoutMs));
      stallTimer = setInterval(() => {
        if (Date.now() - lastChunkTime > stallTimeoutMs) { stalled = true; try { reader.cancel(); } catch {} }
      }, tick);
    }

    while (true) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        if (clientAborted || stalled) break;
        readError = e;
        break;
      }
      const { done, value } = r;
      if (done) break;
      lastChunkTime = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.usage) reportUsage(chunk.usage);
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        const finish = choice.finish_reason;

        if (delta.content) {
          if (!messageOpen) {
            const item = { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] };
            output.push(item);
            const oi = outputIndexOf(item);
            write({ type: 'response.output_item.added', sequence_number: nextSeq(), output_index: oi, item });
            write({ type: 'response.content_part.added', sequence_number: nextSeq(), item_id: msgId, output_index: oi, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
            messageOpen = true;
          }
          fullText += delta.content;
          write({ type: 'response.output_text.delta', sequence_number: nextSeq(), item_id: msgId, output_index: outputIndexOf(output.find((o) => o.id === msgId)), content_index: 0, delta: delta.content, logprobs: null });
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = (typeof tc.index === 'number') ? tc.index : toolCalls.length;
            let entry = toolCalls.find((e) => e.index === idx);
            if (!entry) {
              // IDs are locked at creation (events reference them). Later chunks may still
              // extend the name/arguments — we never assume the first chunk is complete.
              const callId = tc.id || `call_${randHex(16)}`;
              const itemId = tc.id ? `fc_${tc.id}` : `fc_${randHex(16)}`;
              const name = (tc.function && tc.function.name) || '';
              const item = { type: 'function_call', id: itemId, call_id: callId, status: 'in_progress', name, arguments: '' };
              entry = { index: idx, call_id: callId, item_id: itemId, name, args: '', item };
              toolCalls.push(entry);
              output.push(item);
              write({ type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndexOf(item), item });
            }
            // cross-chunk name assembly (name may arrive split or after the first chunk)
            if (tc.function && typeof tc.function.name === 'string' && tc.function.name && !entry.name.endsWith(tc.function.name)) {
              entry.name += tc.function.name;
              entry.item.name = entry.name;
            }
            if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) {
              entry.args += tc.function.arguments;
              write({ type: 'response.function_call_arguments.delta', sequence_number: nextSeq(), item_id: entry.item_id, output_index: outputIndexOf(entry.item), call_id: entry.call_id, delta: tc.function.arguments });
            }
          }
        }

        if (finish) {
          return emitSuccess(finish); // exactly-one terminal; upstream tail ignored
        }
      }
    }

    // Loop exited without an inline finish_reason: classify the reason.
    if (clientAborted || (externalSignal && externalSignal.aborted)) {
      return { outcome: 'client_aborted', usage: usageObj, statusCode: 499, code: 'client_aborted', message: 'client disconnected mid-stream' };
    }
    if (stalled) {
      return emitFailure('stream_stall_timeout', `upstream stream stalled (no data within ${stallTimeoutMs}ms)`, 504);
    }
    if (readError) {
      return emitFailure('upstream_stream_error', safeMessage(readError), 502);
    }
    // done === true but no finish_reason ever seen -> abnormal early EOF.
    return emitFailure('incomplete_upstream_response', 'upstream stream ended without a finish_reason', 502);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { outcome: 'client_aborted', usage: usageObj, statusCode: 499, code: 'client_aborted', message: 'aborted' };
    }
    log(`[${requestId}] stream transform error: ${safeMessage(e)}`);
    return emitFailure('stream_transform_error', safeMessage(e), 502);
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    if (externalSignal) { try { externalSignal.removeEventListener('abort', onAbort); } catch {} }
    try { reader.releaseLock(); } catch {}
    try { writable.end(); } catch {}
  }
}

/**
 * Relay a native Responses SSE stream to the client BYTE-FOR-BYTE. The exact upstream
 * bytes (event: / id: / retry: / multiple data: lines / comments / blank-line boundaries)
 * are forwarded unchanged. Usage is extracted by a side-channel parser that never mutates
 * the forwarded bytes.
 */
export async function forwardNativeStream(upstreamStream, writable, opts = {}) {
  const {
    requestId = 'unknown', externalSignal, onUsage,
    stallTimeoutMs = DEFAULT_STALL_MS,
  } = opts;

  const reader = upstreamStream.getReader();
  const decoder = new TextDecoder();
  let sideBuffer = '';       // side-channel accumulation for usage parsing only
  let usageReported = false;
  let sawTerminal = false;   // saw response.completed / response.failed / response.incomplete

  let clientAborted = false;
  let stalled = false;
  let readError = null;
  let stallTimer = null;
  let lastChunkTime = Date.now();

  const onAbort = () => { clientAborted = true; try { reader.cancel(); } catch {} };
  if (externalSignal) {
    if (externalSignal.aborted) clientAborted = true;
    else { try { externalSignal.addEventListener('abort', onAbort); } catch {} }
  }
  const clientGone = () => clientAborted
    || (writable && (writable.writableEnded || writable.destroyed))
    || (externalSignal && externalSignal.aborted);

  // Parse complete SSE event blocks from the side buffer (does NOT affect output bytes).
  const drainSideEvents = (flush) => {
    let idx;
    while ((idx = sideBuffer.indexOf('\n\n')) !== -1) {
      const block = sideBuffer.slice(0, idx);
      sideBuffer = sideBuffer.slice(idx + 2);
      inspectBlock(block);
    }
    if (flush && sideBuffer.trim()) { inspectBlock(sideBuffer); sideBuffer = ''; }
  };
  const inspectBlock = (block) => {
    const dataLines = [];
    for (const raw of block.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(payload); } catch { return; }
    if (ev && (ev.type === 'response.completed' || ev.type === 'response.failed' || ev.type === 'response.incomplete')) {
      sawTerminal = true;
      if (ev.response && ev.response.usage && !usageReported) {
        usageReported = true;
        if (onUsage) { try { onUsage(ev.response.usage); } catch {} }
      }
    }
  };

  try {
    if (clientGone()) {
      try { reader.cancel(); } catch {}
      return { outcome: 'client_aborted', usage: null, statusCode: 499, code: 'client_aborted', message: 'client disconnected before stream start' };
    }
    if (stallTimeoutMs > 0) {
      const tick = Math.max(500, Math.min(2000, stallTimeoutMs));
      stallTimer = setInterval(() => {
        if (Date.now() - lastChunkTime > stallTimeoutMs) { stalled = true; try { reader.cancel(); } catch {} }
      }, tick);
    }

    while (true) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        if (clientAborted || stalled) break;
        readError = e;
        break;
      }
      const { done, value } = r;
      if (done) break;
      lastChunkTime = Date.now();
      // BYTE-EXACT passthrough: write the raw upstream bytes as-is, no trim/reassembly.
      if (!clientGone()) {
        try { writable.write(Buffer.from(value)); }
        catch { clientAborted = true; }
      }
      // side-channel usage parsing only
      sideBuffer += decoder.decode(value, { stream: true });
      drainSideEvents(false);
    }
    drainSideEvents(true);

    if (clientAborted || (externalSignal && externalSignal.aborted)) {
      return { outcome: 'client_aborted', usage: null, statusCode: 499, code: 'client_aborted', message: 'client disconnected mid-stream' };
    }
    if (stalled) {
      if (!sawTerminal && !clientGone()) {
        try { writable.write(sse({ type: 'response.failed', response: { object: 'response', status: 'failed', error: { code: 'stream_stall_timeout', message: `upstream stream stalled (no data within ${stallTimeoutMs}ms)` } } })); } catch {}
      }
      return { outcome: 'failed', usage: null, statusCode: 504, code: 'stream_stall_timeout', message: 'upstream stream stalled' };
    }
    if (readError) {
      if (!sawTerminal && !clientGone()) {
        try { writable.write(sse({ type: 'response.failed', response: { object: 'response', status: 'failed', error: { code: 'upstream_stream_error', message: safeMessage(readError) } } })); } catch {}
      }
      return { outcome: 'failed', usage: null, statusCode: 502, code: 'upstream_stream_error', message: safeMessage(readError) };
    }
    // Natural EOF. If upstream never sent a terminal event, this is abnormal for native.
    if (!sawTerminal) {
      if (!clientGone()) {
        try { writable.write(sse({ type: 'response.failed', response: { object: 'response', status: 'failed', error: { code: 'incomplete_upstream_response', message: 'native stream ended without a terminal event' } } })); } catch {}
      }
      return { outcome: 'failed', usage: null, statusCode: 502, code: 'incomplete_upstream_response', message: 'native stream ended without a terminal event' };
    }
    return { outcome: 'completed', usage: null, statusCode: 200, code: null, message: null };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { outcome: 'client_aborted', usage: null, statusCode: 499, code: 'client_aborted', message: 'aborted' };
    }
    log(`[${requestId}] native stream relay error: ${safeMessage(e)}`);
    return { outcome: 'failed', usage: null, statusCode: 502, code: 'native_relay_error', message: safeMessage(e) };
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    if (externalSignal) { try { externalSignal.removeEventListener('abort', onAbort); } catch {} }
    try { reader.releaseLock(); } catch {}
    try { writable.end(); } catch {}
  }
}
