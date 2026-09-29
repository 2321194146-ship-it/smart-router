/**
 * Responses API (Codex compatible) tests — 6.2.0
 *
 * Covers: request validation, Responses<->Chat conversion, non-stream/stream,
 * native passthrough, chat-adapter, tool-call round-trip, error semantics,
 * 401 gate, and Provider/Model/Key fallback at the HTTP layer.
 *
 * Run with: node --test test/responses.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { TextEncoder } from 'node:util';

// ---- environment setup (temp config + temp db) before importing server ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-resp-'));
const CFG_PATH = path.join(TMP, 'config.json');
const DB_PATH = path.join(TMP, 's.db');
fs.writeFileSync(CFG_PATH, JSON.stringify({
  providers: {
    adapter: { display: 'Adapter', base_url: 'http://adapter.test/v1', api_type: 'openai', keys: [{ api_key: 'adapter-key' }], responses_mode: 'chat-adapter' },
    native: { display: 'Native', base_url: 'http://native.test/v1', api_type: 'openai', keys: [{ api_key: 'native-key' }], responses_mode: 'native' },
    failing: { display: 'Failing', base_url: 'http://failing.test/v1', api_type: 'openai', keys: [{ api_key: 'failing-key' }], responses_mode: 'chat-adapter' },
  },
  models: [
    { id: 'resp-adapter', provider: 'adapter', tier: 0 },
    { id: 'resp-native', provider: 'native', tier: 0 },
    { id: 'resp-fb', provider: 'failing', tier: 0 },
    { id: 'resp-fb', provider: 'adapter', tier: 1 },
  ],
  agents: [],
}));
process.env.CONFIG_FILE = CFG_PATH;
process.env.DB_PATH = DB_PATH;

const { reloadConfig, getConfig, loadConfig } = await import('../src/config.js');
reloadConfig();
const { createServer, authenticate } = await import('../src/server.js');
const RES = await import('../src/protocols/responses.js');
const { pipeChatStreamToResponses, forwardNativeStream } = await import('../src/protocols/responses-stream.js');

// ---- fetch mock infra ----
let fetchHandler = null;
let fetchCalls = [];
const encoder = new TextEncoder();
function mockResp(bodyStr, status, stream = false) {
  const resp = {
    ok: status < 400,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? (stream ? 'text/event-stream' : 'application/json') : null) },
    json: async () => JSON.parse(bodyStr),
    text: async () => bodyStr,
    clone: () => mockResp(bodyStr, status, stream),
  };
  if (stream) {
    resp.body = new ReadableStream({
      start(c) {
        for (const block of bodyStr.split('\n\n')) {
          if (block.trim()) c.enqueue(encoder.encode(block + '\n\n'));
        }
        c.close();
      },
    });
  }
  return resp;
}
function installFetch(handler) {
  fetchHandler = handler;
  return mock.method(globalThis, 'fetch', async (url, opts) => {
    let body = null;
    if (opts && opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    fetchCalls.push({ url, body });
    return fetchHandler(url, opts, body);
  });
}

// ---- http helpers ----
let server, baseURL;
function start() {
  return new Promise((resolve) => {
    server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseURL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}
function postResponses(body, { stream = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${baseURL}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, raw, events: parseSSE(raw) });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
function parseSSE(raw) {
  const out = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch {}
  }
  return out;
}

before(async () => { await start(); });
after(() => { try { server.close(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// ---- stream-reliability test helpers (direct calls, no server) ----
function fakeWritable() {
  return {
    chunks: [], writableEnded: false, destroyed: false,
    write(s) { if (this.writableEnded) return false; this.chunks.push(Buffer.isBuffer(s) ? s.toString('utf8') : String(s)); return true; },
    end() { this.writableEnded = true; },
    text() { return this.chunks.join(''); },
  };
}
function streamFrom(chunks) {
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(encoder.encode(ch)); c.close(); } });
}
function streamThenError(chunks, err) {
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(encoder.encode(ch)); c.error(err || new Error('upstream connection reset')); } });
}
function observableStream(chunks, { close = false } = {}) {
  let canceled = false;
  const stream = new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(encoder.encode(ch)); if (close) c.close(); },
    cancel() { canceled = true; },
  });
  return { stream, wasCanceled: () => canceled };
}
// SSE parser that joins multi-line data blocks (unlike the first-line-only parseSSE helper).
function parseEvents(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const dataLines = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (!dataLines.length) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch {}
  }
  return out;
}

test('Responses API suite', { concurrency: false }, () => {
// =====================================================================
//  Unit: conversion (no server / no fetch)
// =====================================================================
test('U1 responsesToChat: string input + instructions + image', () => {
  const chat = RES.responsesToChat({
    model: 'm', input: 'hi', instructions: 'be brief',
    max_output_tokens: 100, temperature: 0.5, top_p: 0.9,
  });
  assert.strictEqual(chat.model, 'm');
  assert.deepStrictEqual(chat.messages[0], { role: 'system', content: 'be brief' });
  assert.deepStrictEqual(chat.messages[1], { role: 'user', content: 'hi' });
  assert.strictEqual(chat.max_tokens, 100);
  assert.strictEqual(chat.temperature, 0.5);
  assert.strictEqual(chat.stream, false);
});

test('U2 responsesToChat: message array roles + input_image + function tool', () => {
  const chat = RES.responsesToChat({
    model: 'm',
    input: [
      { role: 'developer', content: 'dev note' },
      { role: 'user', content: [{ type: 'input_text', text: 'what is this' }, { type: 'input_image', image_url: { url: 'https://x/y.png' } }] },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'result' },
    ],
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'f' },
    text: { format: { type: 'json_schema', json_schema: { name: 's', schema: {} } } },
  });
  assert.strictEqual(chat.messages[0].role, 'developer');
  assert.strictEqual(chat.messages[1].content[1].type, 'image_url');
  assert.strictEqual(chat.messages[2].role, 'assistant');
  assert.strictEqual(chat.messages[2].tool_calls[0].id, 'c1');
  assert.strictEqual(chat.messages[3].role, 'tool');
  assert.strictEqual(chat.messages[3].tool_call_id, 'c1');
  assert.strictEqual(chat.tools[0].function.name, 'f');
  assert.deepStrictEqual(chat.tool_choice, { type: 'function', function: { name: 'f' } });
  assert.strictEqual(chat.response_format.type, 'json_schema');
});

test('U3 responsesToChat throws on unsupported adapter fields', () => {
  assert.throws(() => RES.responsesToChat({ model: 'm', input: 'x', previous_response_id: 'r1' }), /previous_response_id/);
  assert.throws(() => RES.responsesToChat({ model: 'm', input: 'x', reasoning: { effort: 'low' } }), /reasoning/);
  assert.throws(() => RES.responsesToChat({ model: 'm', input: 'x', tools: [{ type: 'web_search' }] }), /web_search/);
});

test('U4 chatToResponses: text + tool_calls + usage + incomplete', () => {
  const r = RES.chatToResponses({
    model: 'm',
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 1 } },
  }, { model: 'm' }, 'final-model');
  assert.strictEqual(r.object, 'response');
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.model, 'final-model');
  assert.strictEqual(r.output[0].type, 'message');
  assert.strictEqual(r.output[0].content[0].text, 'hello');
  assert.strictEqual(r.usage.input_tokens, 4);
  assert.strictEqual(r.usage.input_tokens_details.cached_tokens, 1);
  assert.strictEqual(r.usage.output_tokens_details.reasoning_tokens, 1);

  const toolResp = RES.chatToResponses({
    model: 'm',
    choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }, { model: 'm' }, 'final-model');
  assert.strictEqual(toolResp.output[0].type, 'function_call');
  assert.strictEqual(toolResp.output[0].call_id, 'call_1');

  const inc = RES.chatToResponses({ model: 'm', choices: [{ message: { content: 'x' }, finish_reason: 'length' }], usage: {} }, { model: 'm' }, 'm');
  assert.strictEqual(inc.status, 'incomplete');
  assert.strictEqual(inc.incomplete_details.reason, 'max_output_tokens');
});

test('U5 validateResponsesRequest: structure', () => {
  assert.strictEqual(RES.validateResponsesRequest({ input: 'hi' }).ok, true);
  assert.strictEqual(RES.validateResponsesRequest({}).ok, false); // missing input
  assert.strictEqual(RES.validateResponsesRequest({ input: 5 }).ok, false);
  assert.strictEqual(RES.validateResponsesRequest({ input: 'hi', stream: 'yes' }).ok, false);
});

test('U6 authenticate gate works for all routes (incl /v1/responses)', async () => {
  // no adminToken: local IP allowed, non-local rejected
  assert.strictEqual(authenticate({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, {}), true);
  assert.strictEqual(authenticate({ socket: { remoteAddress: '203.0.113.5' }, headers: {} }, {}), false);
  // adminToken set via direct config load (avoids loadDotenv override): non-local without
  // token rejected, with correct token allowed.
  process.env.ADMIN_TOKEN = 'secret';
  loadConfig();
  try {
    assert.strictEqual(authenticate({ socket: { remoteAddress: '203.0.113.5' }, headers: {} }, {}), false);
    assert.strictEqual(authenticate({ socket: { remoteAddress: '203.0.113.5' }, headers: { authorization: 'Bearer secret' } }, {}), true);
  } finally {
    delete process.env.ADMIN_TOKEN;
    loadConfig();
  }
});

// =====================================================================
//  Integration: real HTTP via createServer + mocked upstream
// =====================================================================
test('I1 non-stream adapter (string input) -> Responses output_text', async () => {
  installFetch((url) => {
    assert.ok(url.includes('/chat/completions'), 'adapter must hit /chat/completions');
    return mockResp(JSON.stringify({
      model: 'resp-adapter',
      choices: [{ message: { role: 'assistant', content: 'Hi from adapter' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }), 200);
  });
  const res = await postResponses({ model: 'resp-adapter', input: 'hello' });
  assert.strictEqual(res.status, 200);
  const r = JSON.parse(res.raw);
  assert.strictEqual(r.object, 'response');
  assert.strictEqual(r.output[0].content[0].text, 'Hi from adapter');
  assert.strictEqual(r.usage.total_tokens, 8);
  mock.restoreAll();
});

test('I2 adapter function tool -> function_call item with stable call_id', async () => {
  installFetch(() => mockResp(JSON.stringify({
    model: 'resp-adapter',
    choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call_xyz', type: 'function', function: { name: 'get_weather', arguments: '{"city":"BJ"}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), 200));
  const res = await postResponses({
    model: 'resp-adapter',
    input: 'weather?',
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
  });
  const r = JSON.parse(res.raw);
  assert.strictEqual(r.output[0].type, 'function_call');
  assert.strictEqual(r.output[0].name, 'get_weather');
  assert.strictEqual(r.output[0].call_id, 'call_xyz');
  mock.restoreAll();
});

test('I3 tool round-trip: function_call_output -> upstream tool message with call_id', async () => {
  let phase = 0;
  installFetch((url, opts, body) => {
    if (phase === 0) {
      phase = 1;
      return mockResp(JSON.stringify({
        model: 'resp-adapter',
        choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call_rt', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), 200);
    }
    // phase 1: assert the upstream chat request carried the tool result
    const toolMsg = body.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'upstream should contain a tool message');
    assert.strictEqual(toolMsg.tool_call_id, 'call_rt');
    assert.strictEqual(toolMsg.content, '{"temp":20}');
    return mockResp(JSON.stringify({
      model: 'resp-adapter',
      choices: [{ message: { role: 'assistant', content: 'It is 20C' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    }), 200);
  });
  const first = await postResponses({
    model: 'resp-adapter',
    input: 'temp?',
    tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }],
  });
  const callId = JSON.parse(first.raw).output[0].call_id;
  const second = await postResponses({
    model: 'resp-adapter',
    input: [{ type: 'function_call_output', call_id: callId, output: '{"temp":20}' }],
  });
  assert.strictEqual(JSON.parse(second.raw).output[0].content[0].text, 'It is 20C');
  mock.restoreAll();
});

test('I4 native non-stream passthrough', async () => {
  installFetch((url) => {
    assert.ok(url.includes('/responses'), 'native must hit /responses');
    return mockResp(JSON.stringify({
      id: 'resp_n1', object: 'response', created_at: 1, status: 'completed', model: 'resp-native',
      output: [{ type: 'message', id: 'msg_n1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'native hi', annotations: [] }] }],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }, error: null,
    }), 200);
  });
  const res = await postResponses({ model: 'resp-native', input: 'hello' });
  const r = JSON.parse(res.raw);
  assert.strictEqual(r.id, 'resp_n1');
  assert.strictEqual(r.output[0].content[0].text, 'native hi');
  mock.restoreAll();
});

test('I5 native SSE passthrough relays response.completed', async () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_n1","status":"in_progress","output":[]}}',
    'data: {"type":"response.in_progress","response":{"id":"resp_n1","status":"in_progress"}}',
    'data: {"type":"response.completed","response":{"id":"resp_n1","status":"completed","output":[{"type":"message","id":"msg_n1","content":[{"type":"output_text","text":"native stream"}]}],"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
  ].join('\n\n') + '\n\n';
  installFetch((url) => mockResp(sse, 200, true));
  const res = await postResponses({ model: 'resp-native', input: 'hello', stream: true });
  const types = res.events.map((e) => e.type);
  assert.ok(types.includes('response.completed'));
  const completed = res.events.find((e) => e.type === 'response.completed');
  assert.strictEqual(completed.response.id, 'resp_n1');
  mock.restoreAll();
});

test('I6 adapter SSE: text deltas, monotonic sequence_number, completed once', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
  installFetch((url) => mockResp(sse, 200, true));
  const res = await postResponses({ model: 'resp-adapter', input: 'hi', stream: true });
  const seqs = res.events.map((e) => e.sequence_number);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'sequence_number must be strictly increasing');
  const completed = res.events.filter((e) => e.type === 'response.completed');
  assert.strictEqual(completed.length, 1, 'response.completed must appear exactly once');
  const deltas = res.events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  assert.strictEqual(deltas, 'Hello world');
  mock.restoreAll();
});

test('I7 adapter SSE: multiple parallel tool calls get distinct call_id', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"foo","arguments":""}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"x-args"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"bar","arguments":""}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"y-args"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
  installFetch((url) => mockResp(sse, 200, true));
  const res = await postResponses({
    model: 'resp-adapter', input: 'go', stream: true,
    tools: [{ type: 'function', name: 'foo', parameters: {} }, { type: 'function', name: 'bar', parameters: {} }],
  });
  const completed = res.events.find((e) => e.type === 'response.completed');
  const fns = completed.response.output.filter((o) => o.type === 'function_call');
  assert.strictEqual(fns.length, 2);
  assert.notStrictEqual(fns[0].call_id, fns[1].call_id);
  assert.strictEqual(fns[0].name, 'foo');
  assert.strictEqual(fns[1].name, 'bar');
  mock.restoreAll();
});

test('I8 validation 400 on missing input', async () => {
  installFetch(() => mockResp('{}', 200));
  const res = await postResponses({});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(JSON.parse(res.raw).error.type, 'invalid_request_error');
  mock.restoreAll();
});

test('I9 adapter-only request with previous_response_id -> clear 422', async () => {
  installFetch(() => mockResp('{}', 200));
  const res = await postResponses({ model: 'resp-adapter', input: 'hi', previous_response_id: 'r1' });
  assert.strictEqual(res.status, 422);
  assert.match(JSON.parse(res.raw).error.message, /previous_response_id/);
  mock.restoreAll();
});

test('I10 Provider 500 fallback: failing provider -> adapter succeeds', async () => {
  installFetch((url) => {
    if (url.includes('failing.test')) return mockResp(JSON.stringify({ error: 'boom' }), 500);
    return mockResp(JSON.stringify({
      model: 'resp-fb',
      choices: [{ message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), 200);
  });
  const res = await postResponses({ model: 'resp-fb', input: 'hi' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.raw).output[0].content[0].text, 'recovered');
  const hitAdapter = fetchCalls.some((c) => c.url.includes('adapter.test'));
  const hitFailing = fetchCalls.some((c) => c.url.includes('failing.test'));
  assert.ok(hitFailing && hitAdapter, 'should have tried failing then adapter');
  mock.restoreAll();
});

test('I11 strict model not found -> real error (not silent success)', async () => {
  installFetch(() => mockResp('{}', 200));
  const res = await postResponses({ model: 'does-not-exist', input: 'hi' });
  assert.notStrictEqual(res.status, 200);
  mock.restoreAll();
});

// =====================================================================
//  Stream reliability (direct pipeChatStreamToResponses calls) — 6.2.1
// =====================================================================
test('S1 normal text stream -> completed once + correct lifecycle + part structure', async () => {
  const up = streamFrom([
    'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const w = fakeWritable();
  const r = await pipeChatStreamToResponses(up, w, { model: 'm', stallTimeoutMs: 0 });
  assert.strictEqual(r.outcome, 'completed');
  const evs = parseEvents(w.text());
  const types = evs.map((e) => e.type);
  // full lifecycle present & ordered
  const order = ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed'];
  let idx = -1;
  for (const t of order) { const at = types.indexOf(t, idx + 1); assert.ok(at > idx, `event ${t} must appear in order`); idx = at; }
  // content_part.added.part must be output_text with annotations (NOT type:text)
  const added = evs.find((e) => e.type === 'response.content_part.added');
  assert.deepStrictEqual(added.part, { type: 'output_text', text: '', annotations: [] });
  const partDone = evs.find((e) => e.type === 'response.content_part.done');
  assert.strictEqual(partDone.part.type, 'output_text');
  assert.strictEqual(partDone.part.text, 'Hello');
  assert.deepStrictEqual(partDone.part.annotations, []);
  // exactly one terminal event
  assert.strictEqual(evs.filter((e) => e.type === 'response.completed').length, 1);
  assert.strictEqual(evs.filter((e) => e.type === 'response.failed').length, 0);
  // strictly increasing sequence_number
  const seqs = evs.map((e) => e.sequence_number);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
  // usage carried
  const completed = evs.find((e) => e.type === 'response.completed');
  assert.strictEqual(completed.response.usage.total_tokens, 5);
});

test('S2 finish_reason length -> incomplete (never completed)', async () => {
  const up = streamFrom([
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
  ]);
  const w = fakeWritable();
  const r = await pipeChatStreamToResponses(up, w, { model: 'm', stallTimeoutMs: 0 });
  assert.strictEqual(r.outcome, 'incomplete');
  const evs = parseEvents(w.text());
  assert.strictEqual(evs.filter((e) => e.type === 'response.completed').length, 0);
  const incomplete = evs.find((e) => e.type === 'response.incomplete');
  assert.ok(incomplete, 'must emit response.incomplete');
  assert.strictEqual(incomplete.response.status, 'incomplete');
  assert.strictEqual(incomplete.response.incomplete_details.reason, 'max_output_tokens');
});

test('S3 reader throws after some text -> failed, NEVER completed', async () => {
  const up = streamThenError([
    'data: {"choices":[{"delta":{"content":"half"},"finish_reason":null}]}\n\n',
  ], new Error('ECONNRESET'));
  const w = fakeWritable();
  const r = await pipeChatStreamToResponses(up, w, { model: 'm', stallTimeoutMs: 0 });
  assert.strictEqual(r.outcome, 'failed');
  const evs = parseEvents(w.text());
  assert.strictEqual(evs.filter((e) => e.type === 'response.completed').length, 0);
  const failed = evs.find((e) => e.type === 'response.failed');
  assert.ok(failed, 'must emit response.failed');
  assert.strictEqual(failed.response.status, 'failed');
  assert.ok(failed.response.error.code && failed.response.error.message);
});

test('S4 tool args half then connection reset -> tool NOT marked completed', async () => {
  const up = streamThenError([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"foo","arguments":"{\\"a\\":"}}]},"finish_reason":null}]}\n\n',
  ], new Error('socket hang up'));
  const w = fakeWritable();
  const r = await pipeChatStreamToResponses(up, w, { model: 'm', stallTimeoutMs: 0 });
  assert.strictEqual(r.outcome, 'failed');
  const evs = parseEvents(w.text());
  assert.strictEqual(evs.filter((e) => e.type === 'response.completed').length, 0);
  assert.strictEqual(evs.filter((e) => e.type === 'response.function_call_arguments.done').length, 0, 'must NOT finalize tool args');
  assert.ok(evs.find((e) => e.type === 'response.failed'));
});

test('S5 EOF without finish_reason -> failed (not faked success)', async () => {
  const up = streamFrom([
    'data: {"choices":[{"delta":{"content":"text with no finish"},"finish_reason":null}]}\n\n',
  ]);
  const w = fakeWritable();
  const r = await pipeChatStreamToResponses(up, w, { model: 'm', stallTimeoutMs: 0 });
  assert.strictEqual(r.outcome, 'failed');
  const evs = parseEvents(w.text());
  assert.strictEqual(evs.filter((e) => e.type === 'response.completed').length, 0);
  assert.ok(evs.find((e) => e.type === 'response.failed'));
});

test('S6 client disconnect mid-stream -> reader canceled, no completed, client_aborted', async () => {
  const ac = new AbortController();
  const { stream, wasCanceled } = observableStream([
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
  ]); // stays open (not closed)
  const w = fakeWritable();
  const p = pipeChatStreamToResponses(stream, w, { model: 'm', externalSignal: ac.signal, stallTimeoutMs: 0 });
  setTimeout(() => ac.abort(), 60);
  const r = await p;
  assert.strictEqual(r.outcome, 'client_aborted');
  assert.ok(wasCanceled(), 'upstream reader must be canceled on client disconnect');
  const evs = parseEvents(w.text());
  assert.strictEqual(evs.filter((e) => e.type === 'response.completed').length, 0);
});

test('S7 stall timeout -> failed (not completed); and 0 disables watchdog', async () => {
  const { stream } = observableStream([], { close: false }); // never sends, never closes
  const w = fakeWritable();
  const r = await pipeChatStreamToResponses(stream, w, { model: 'm', stallTimeoutMs: 100 });
  assert.strictEqual(r.outcome, 'failed');
  assert.strictEqual(r.code, 'stream_stall_timeout');
  const evs = parseEvents(w.text());
  assert.strictEqual(evs.filter((e) => e.type === 'response.completed').length, 0);
  // 0 disables: a normal stream still completes
  const up2 = streamFrom(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
  const w2 = fakeWritable();
  const r2 = await pipeChatStreamToResponses(up2, w2, { model: 'm', stallTimeoutMs: 0 });
  assert.strictEqual(r2.outcome, 'completed');
});

test('S8 tool name/id/arguments assembled across chunks (no first-chunk assumption)', async () => {
  const up = streamFrom([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"get_"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_z","function":{"name":"weather"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"BJ\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const w = fakeWritable();
  const r = await pipeChatStreamToResponses(up, w, { model: 'm', stallTimeoutMs: 0 });
  assert.strictEqual(r.outcome, 'completed');
  const evs = parseEvents(w.text());
  const completed = evs.find((e) => e.type === 'response.completed');
  const fn = completed.response.output.find((o) => o.type === 'function_call');
  assert.strictEqual(fn.name, 'get_weather', 'name assembled across chunks');
  assert.strictEqual(fn.arguments, '{"city":"BJ"}', 'arguments assembled across chunks');
  const argsDone = evs.find((e) => e.type === 'response.function_call_arguments.done');
  assert.strictEqual(argsDone.arguments, '{"city":"BJ"}');
});

test('S9 text AND tool call together -> neither is silently dropped', async () => {
  const up = streamFrom([
    'data: {"choices":[{"delta":{"content":"thinking"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_m","type":"function","function":{"name":"go","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const w = fakeWritable();
  const r = await pipeChatStreamToResponses(up, w, { model: 'm', stallTimeoutMs: 0 });
  assert.strictEqual(r.outcome, 'completed');
  const completed = parseEvents(w.text()).find((e) => e.type === 'response.completed');
  assert.ok(completed.response.output.find((o) => o.type === 'message'), 'message must be present');
  assert.ok(completed.response.output.find((o) => o.type === 'function_call'), 'function_call must be present');
});

// =====================================================================
//  Native SSE byte-exact passthrough — 6.2.1
// =====================================================================
test('N1 forwardNativeStream is byte-for-byte identical (multi-line data event)', async () => {
  const raw = 'event: custom\ndata: {"a":1,\ndata: "b":2}\n\n';
  const up = streamFrom([raw]);
  const w = fakeWritable();
  await forwardNativeStream(up, w, { stallTimeoutMs: 0 });
  // upstream had no terminal event -> outcome failed, but the forwarded prefix must be byte-exact
  assert.ok(w.text().startsWith(raw), 'forwarded bytes must be identical, no blank line inserted between data lines');
});

test('N2 forwardNativeStream extracts usage without mutating bytes; passes response.completed through', async () => {
  const raw = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}\n\n';
  const up = streamFrom([raw]);
  const w = fakeWritable();
  let usage = null;
  const r = await forwardNativeStream(up, w, { stallTimeoutMs: 0, onUsage: (u) => { usage = u; } });
  assert.strictEqual(r.outcome, 'completed');
  assert.strictEqual(w.text(), raw, 'bytes unchanged');
  assert.strictEqual(usage.total_tokens, 9);
});

test('N3 native upstream mid-stream error -> failed (not silent 200)', async () => {
  const up = streamThenError(['event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n'], new Error('reset'));
  const w = fakeWritable();
  const r = await forwardNativeStream(up, w, { stallTimeoutMs: 0 });
  assert.strictEqual(r.outcome, 'failed');
  assert.strictEqual(r.statusCode, 502);
});

test('N4 native response.failed event passed through', async () => {
  const raw = 'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"x","message":"boom"}}}\n\n';
  const up = streamFrom([raw]);
  const w = fakeWritable();
  await forwardNativeStream(up, w, { stallTimeoutMs: 0 });
  assert.strictEqual(w.text(), raw);
  const evs = parseEvents(w.text());
  assert.ok(evs.find((e) => e.type === 'response.failed'));
});

// =====================================================================
//  Field mapping (responsesToChat) — 6.2.1
// =====================================================================
test('F1 structured output: current flat json_schema format normalized', () => {
  const chat = RES.responsesToChat({
    model: 'm', input: 'x',
    text: { format: { type: 'json_schema', name: 'result', description: 'result schema', schema: { type: 'object' }, strict: true } },
  });
  assert.deepStrictEqual(chat.response_format, {
    type: 'json_schema',
    json_schema: { name: 'result', description: 'result schema', schema: { type: 'object' }, strict: true },
  });
});

test('F2 structured output: legacy nested json_schema format normalized', () => {
  const chat = RES.responsesToChat({
    model: 'm', input: 'x',
    text: { format: { type: 'json_schema', json_schema: { name: 'result', description: 'd', schema: { type: 'object' }, strict: true } } },
  });
  assert.strictEqual(chat.response_format.type, 'json_schema');
  assert.strictEqual(chat.response_format.json_schema.name, 'result');
  assert.strictEqual(chat.response_format.json_schema.strict, true);
  assert.deepStrictEqual(chat.response_format.json_schema.schema, { type: 'object' });
});

test('F3 json_schema without schema throws (schema never silently dropped)', () => {
  assert.throws(() => RES.responsesToChat({ model: 'm', input: 'x', text: { format: { type: 'json_schema', name: 'r' } } }), /schema/);
});

test('F4 function tool strict is preserved', () => {
  const chat = RES.responsesToChat({
    model: 'm', input: 'x',
    tools: [{ type: 'function', name: 'search', description: 'd', parameters: { type: 'object' }, strict: true }],
  });
  assert.deepStrictEqual(chat.tools[0], {
    type: 'function',
    function: { name: 'search', description: 'd', parameters: { type: 'object' }, strict: true },
  });
});

test('F5 input_image detail is preserved', () => {
  const chat = RES.responsesToChat({
    model: 'm',
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: { url: 'https://x/y.png' }, detail: 'high' }] }],
  });
  assert.strictEqual(chat.messages[0].content[0].image_url.url, 'https://x/y.png');
  assert.strictEqual(chat.messages[0].content[0].image_url.detail, 'high');
});

test('F6 unsupported tool_choice object type -> throws (surfaced as 422)', () => {
  assert.throws(() => RES.responsesToChat({
    model: 'm', input: 'x',
    tools: [{ type: 'function', name: 'f', parameters: {} }],
    tool_choice: { type: 'allowed_tools', tools: [] },
  }));
});

test('F7 HTTP: unsupported tool_choice object on adapter-only model -> 422', async () => {
  installFetch(() => mockResp('{}', 200));
  const res = await postResponses({
    model: 'resp-adapter', input: 'x',
    tools: [{ type: 'function', name: 'f', parameters: {} }],
    tool_choice: { type: 'allowed_tools', tools: [] },
  });
  assert.strictEqual(res.status, 422);
  mock.restoreAll();
});
});
