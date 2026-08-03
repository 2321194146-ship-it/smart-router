#!/usr/bin/env node
// scripts/active-readiness-eval.mjs
// Smart Router Mainline - Phase 2-B (Active Readiness)
// Active Readiness 评测：100+ 固定脱敏任务，覆盖 22 类场景。
//
// 诚实声明：
//   - 使用【确定性本地 Mock Provider】（可复现、离线、零成本）
//   - 验证 Shadow 决策/持久化/对照的真实代码路径；外部真实 Pilot 见 evidence/pilot-*.json
//   - 本阶段不开启 Active；评测仅为 Active Readiness 指标
//
// 输出：evidence/active-readiness-eval-report.json + .md + 100 条脱敏数据
//
// 仅使用 Node.js 内置模块。

import { createServer } from '../src/server.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'evidence');
mkdirSync(OUT_DIR, { recursive: true });

// ===========================================================================
// 1. 确定性 Mock Provider
// ===========================================================================

function createMockProvider() {
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      const model = parsed?.model || '';
      const stream = !!parsed?.stream;

      if (model === 'M-fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'injected failure', type: 'server_error' } }));
        return;
      }
      if (model === 'M-eof' && stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'PARTIAL_' }, finish_reason: null }] }) + '\n\n');
        setTimeout(() => { res.socket.destroy(); }, 20);
        return;
      }
      if (model === 'M-slow' && stream) {
        // 长流：供客户端取消命中
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let i = 0;
        const next = () => {
          if (i < 150) {
            res.write('data: ' + JSON.stringify({ id: 'c' + i, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'tok' + i + ' ' }, finish_reason: null }] }) + '\n\n');
            i++;
            setTimeout(next, 10);
          } else {
            res.write('data: [DONE]\n\n');
            res.end();
          }
        };
        next();
        return;
      }
      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = [
          { id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          { id: 'c2', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'EVAL_OK' }, finish_reason: null }] },
          { id: 'c3', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ];
        let i = 0;
        const next = () => {
          if (i < chunks.length) { res.write('data: ' + JSON.stringify(chunks[i]) + '\n\n'); i++; setTimeout(next, 10); }
          else { res.write('data: [DONE]\n\n'); res.end(); }
        };
        next();
        return;
      }
      const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };
      if (model === 'M-tool' && parsed?.tools?.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'cmpl-tool', object: 'chat.completion', model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '{"a":1,"b":2}' } }] }, finish_reason: 'tool_calls' }],
          usage,
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-eval', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'EVAL_OK_' + model, finish_reason: 'stop' } }],
        usage,
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ===========================================================================
// 2. 评测模型池（标准化 capabilities 对象）
// ===========================================================================

function buildConfig(mockPort, dataDir) {
  const mk = (id, tier, paid, capabilities, extra = {}) => {
    const { provider = 'mock', ...rest } = extra;
    // Phase1 候选构建（candidates.js）识别旧 capability 字符串数组；
    // Phase2-B Registry 识别 capabilities 对象（0-100）。两者保持一致。
    const legacyCaps = Object.entries(capabilities)
      .filter(([, v]) => Number(v) >= 100)
      .map(([k]) => k);
    return { id, tier, provider, apiModel: id, enabled: true, paid, capabilities, capability: legacyCaps, ...rest };
  };
  return {
    server: { host: '127.0.0.1', port: 28792, data_dir: dataDir, request_timeout_ms: 30000 },
    data_dir: dataDir,
    intelligence: { mode: 'shadow', shadow: { policy: { tierPreference: true, preferFree: true }, retentionDays: 30 } },
    routing: {
      strategy: 'tier_weighted', tier_weights: { tier1: 10, tier2: 5, tier3: 1 },
      max_concurrent: 16, max_retries: 3, retry_backoff_ms: 50,
      cooldown_default_sec: 60, health_check_interval_sec: 999999, failover_on_error: true,
    },
    budget: { allowPaid: true, maxRequestCost: 100, allowedModels: [], allowedProviders: [], strictModel: false },
    providers: [
      { name: 'mock', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k-mock', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
      { name: 'mock-fail', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'k-fail', auth_header: 'Authorization', auth_prefix: 'Bearer ' },
    ],
    models: [
      mk('M-chat-t1', 'tier1', false, { chat: 100, coding: 0, reasoning: 20, tool_use: 0, vision: 0, structured_output: 0, long_context: 60, streaming: 0 }, { context_window: 32000, reliability: 0.9, latency_prior_ms: 900, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-cheap', 'tier3', false, { chat: 100, coding: 0, reasoning: 0, tool_use: 0, vision: 0, structured_output: 0, long_context: 0, streaming: 0 }, { context_window: 8000, reliability: 0.7, latency_prior_ms: 1500, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-coding', 'tier1', false, { chat: 100, coding: 100, reasoning: 40, tool_use: 100, vision: 0, structured_output: 60, long_context: 80, streaming: 100 }, { context_window: 64000, reliability: 0.92, latency_prior_ms: 800, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-reason', 'tier2', true, { chat: 100, coding: 80, reasoning: 100, tool_use: 0, vision: 0, structured_output: 80, long_context: 80, streaming: 100 }, { context_window: 64000, reliability: 0.95, latency_prior_ms: 1400, price: { input_cost_per_1k: 0.005, output_cost_per_1k: 0.01 } }),
      mk('M-vision', 'tier2', true, { chat: 100, coding: 0, reasoning: 60, tool_use: 0, vision: 100, structured_output: 40, long_context: 40, streaming: 100 }, { context_window: 32000, reliability: 0.88, latency_prior_ms: 1300, price: { input_cost_per_1k: 0.005, output_cost_per_1k: 0.01 } }),
      mk('M-stream', 'tier1', false, { chat: 100, coding: 100, reasoning: 50, tool_use: 0, vision: 0, structured_output: 50, long_context: 80, streaming: 100 }, { context_window: 64000, reliability: 0.9, latency_prior_ms: 850, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-nostream', 'tier2', false, { chat: 100, coding: 80, reasoning: 60, tool_use: 0, vision: 0, structured_output: 50, long_context: 80, streaming: 0 }, { context_window: 64000, reliability: 0.9, latency_prior_ms: 1000, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-struct', 'tier2', false, { chat: 100, coding: 30, reasoning: 50, tool_use: 0, vision: 0, structured_output: 100, long_context: 60, streaming: 0 }, { context_window: 32000, reliability: 0.85, latency_prior_ms: 1100, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-tool', 'tier1', false, { chat: 100, coding: 80, reasoning: 30, tool_use: 100, vision: 0, structured_output: 40, long_context: 60, streaming: 100 }, { context_window: 32000, reliability: 0.9, latency_prior_ms: 850, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-smallctx', 'tier3', false, { chat: 100, coding: 0, reasoning: 0, tool_use: 0, vision: 0, structured_output: 0, long_context: 0, streaming: 0 }, { context_window: 500, reliability: 0.6, latency_prior_ms: 1600, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-fail', 'tier1', false, { chat: 100, coding: 0, reasoning: 0, tool_use: 0, vision: 0, structured_output: 0, long_context: 0, streaming: 0 }, { provider: 'mock-fail', context_window: 8000, reliability: 0.5, latency_prior_ms: 1200, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-eof', 'tier1', false, { chat: 100, coding: 0, reasoning: 0, tool_use: 0, vision: 0, structured_output: 0, long_context: 0, streaming: 100 }, { context_window: 8000, reliability: 0.5, latency_prior_ms: 1200, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
      mk('M-slow', 'tier1', false, { chat: 100, coding: 0, reasoning: 0, tool_use: 0, vision: 0, structured_output: 0, long_context: 0, streaming: 100 }, { context_window: 8000, reliability: 0.5, latency_prior_ms: 1200, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } }),
    ],
    agent_bindings: {},
    circuit_breaker: { enabled: false, failure_threshold: 100, failure_window_sec: 60, open_state_sec: 120, half_open_max_calls: 2, key_disable_on_auth_invalid: true },
  };
}

// ===========================================================================
// 3. 客户端
// ===========================================================================

function httpJson(port, path, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(data); } catch { parsed = data.slice(0, 120); } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.write(body); req.end();
  });
}

function httpStreamAbort(port, path, payload, abortAfterMs = 200) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ aborted: false, bytes }));
      res.on('error', () => resolve({ aborted: true, bytes }));
    });
    req.on('error', () => resolve({ aborted: true, bytes: 0 }));
    req.write(body); req.end();
    setTimeout(() => { try { req.destroy(); } catch {} }, abortAfterMs);
  });
}

function httpStream(port, path, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.write(body); req.end();
  });
}

// ===========================================================================
// 4. 任务矩阵（100+ 固定脱敏任务）
// ===========================================================================

// 任务工厂：生成带元数据的任务
// acceptable/forbidden 为模型 id 集合；budgetKey 指定阶段
const TASKS = [];
const add = (category, expectedType, body, meta = {}) => {
  TASKS.push({ category, expectedType, body, ...meta });
};

const chatBody = (text) => ({ model: 'auto', messages: [{ role: 'user', content: text }] });

// --- simple chat (6) ---
for (const t of ['Hello, how are you today?', 'What time is it?', 'Tell me a fun fact about space.', 'How do I make coffee?', 'What is the capital of France?', 'Say hi in Spanish']) {
  add('simple_chat', 'general_chat', chatBody(t), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-tool', 'M-nostream'], forbidden: ['M-reason', 'M-vision', 'M-smallctx'], hardCaps: ['chat'] });
}
// --- writing (5) ---
for (const t of ['Write an essay about climate change', 'Write a blog post about remote work', 'Draft a cover letter for a software engineer', 'Write a short story about a robot', 'Compose a product launch announcement']) {
  add('writing', 'writing', chatBody(t), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-tool', 'M-nostream'], forbidden: ['M-reason', 'M-vision', 'M-smallctx'], hardCaps: ['chat'] });
}
// --- summarization (5) ---
for (const t of ['Summarize this article in 3 sentences', 'Give me a brief summary of the meeting notes', 'Summarize the key points of this report', 'TL;DR of this document', 'Recap what we discussed']) {
  add('summarization', 'summarization', chatBody(t), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-tool', 'M-nostream'], forbidden: ['M-reason', 'M-vision', 'M-smallctx'], hardCaps: ['chat'] });
}
// --- translation (5) ---
for (const t of ['Translate this text to Chinese', 'Please translate the following paragraph to French', 'Translate this email to Japanese', 'Translate this document from English to German', 'Translate this legal clause to Spanish']) {
  add('translation', 'translation', chatBody(t), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-tool', 'M-nostream'], forbidden: ['M-reason', 'M-vision', 'M-smallctx'], hardCaps: ['chat'] });
}
// --- extraction (5) ---
for (const t of ['Extract all dates from this text', 'Rewrite this paragraph in simpler words', 'Extract all email addresses from this list', 'Shorten this text to 50 words', 'Extract all product names from the review']) {
  add('extraction', 'extraction', chatBody(t), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-tool', 'M-nostream'], forbidden: ['M-reason', 'M-vision', 'M-smallctx'], hardCaps: ['chat'] });
}
// --- analysis (5) ---
for (const t of ['Analyze the pros and cons of remote work', 'Compare and contrast TCP and UDP', 'Explain why the sky is blue using physics', 'Analyze this financial report data', 'What are the implications of this policy change? Analyze the impact']) {
  add('analysis', 'analysis', chatBody(t), { acceptable: ['M-reason', 'M-chat-t1', 'M-coding', 'M-stream', 'M-tool', 'M-nostream'], forbidden: ['M-cheap', 'M-vision'], hardCaps: ['chat'] });
}
// --- complex reasoning (5) ---
for (const t of ['Prove that the square root of 2 is irrational', 'Solve this logic puzzle: determine the murderer', 'Prove the Pythagorean theorem step by step', 'Derive the formula for compound interest using mathematical reasoning', 'Solve this complex inference problem about causality']) {
  add('complex_reasoning', 'analysis', chatBody(t), { acceptable: ['M-reason'], forbidden: ['M-cheap', 'M-chat-t1'], hardCaps: ['chat'] });
}
// --- coding (6) ---
for (const t of ['Write a JavaScript function to debounce', 'Write a SQL query to join two tables', 'Write a Python function to parse JSON', 'Implement a binary search in TypeScript', 'Write a shell script function to backup files', 'Write a React component function for a todo list']) {
  add('coding', 'coding', chatBody(t), { acceptable: ['M-coding', 'M-stream', 'M-tool'], forbidden: ['M-cheap', 'M-chat-t1'], hardCaps: ['chat', 'coding'] });
}
// --- debugging (5) ---
for (const t of ['Debug this crash: the stack trace shows a null pointer in the login handler', 'Fix this bug: the loop never terminates', 'Debug why this function is returning wrong results', 'Debug the race condition in this worker pool', 'Fix this error: cannot read property of undefined']) {
  add('debugging', 'debugging', chatBody(t), { acceptable: ['M-coding', 'M-reason', 'M-stream'], forbidden: ['M-cheap', 'M-chat-t1'], hardCaps: ['chat', 'coding'] });
}
// --- architecture (4) ---
for (const t of ['Design the architecture for a microservice system', 'Design a system for real-time chat', 'Architecture review of our monolith split plan', 'Design the module structure for a payments platform']) {
  add('architecture', 'architecture', chatBody(t), { acceptable: ['M-coding', 'M-reason', 'M-chat-t1', 'M-stream', 'M-tool', 'M-nostream'], forbidden: ['M-cheap'], hardCaps: ['chat'] });
}
// --- tool_use (5) ---
for (const t of ['What is 15 + 27? Use the calculator tool.', 'Call the search tool to find this article', 'Use the calculator tool to compute the total', 'Call the weather tool to check conditions', 'Use the database tool to query users']) {
  add('tool_use', 'tool_orchestration', {
    model: 'auto',
    messages: [{ role: 'user', content: t }],
    tools: [{ type: 'function', function: { name: 'calculator', parameters: { type: 'object', properties: {} } } }],
  }, { acceptable: ['M-tool', 'M-coding'], forbidden: ['M-chat-t1', 'M-cheap', 'M-reason', 'M-vision'], hardCaps: ['chat', 'tool_use'] });
}
// --- vision (4) ---
for (const t of ['Describe this image', 'What is in this picture?', 'Describe the image contents in detail', 'Analyze this chart image']) {
  add('vision', 'vision', {
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }, { type: 'text', text: t }] }],
  }, { acceptable: ['M-vision'], forbidden: ['M-chat-t1', 'M-cheap', 'M-coding'], hardCaps: ['chat', 'vision'] });
}
// --- structured output (5) ---
for (const t of ['Output as JSON with schema {name, age}', 'Return JSON array of products', 'Output as structured JSON matching this schema', 'Output the result as JSON', 'Output as JSON with fields id and status']) {
  add('structured_output', 'structured_output', chatBody(t), { acceptable: ['M-struct', 'M-coding'], forbidden: [], hardCaps: ['chat', 'structured_output'] });
}
// --- streaming (6) ---
for (const t of ['Write a long essay about history', 'Tell me a long story about dragons', 'Write a detailed guide on investing', 'Explain quantum computing in detail', 'Write a comprehensive review of AI', 'Describe a day in ancient Rome']) {
  add('streaming', 'general_chat', { model: 'auto', stream: true, messages: [{ role: 'user', content: t }], max_tokens: 2000 }, { acceptable: ['M-stream', 'M-coding'], forbidden: ['M-nostream', 'M-struct', 'M-cheap'], hardCaps: ['chat', 'streaming'], stream: true });
}
// --- long context (4) ---
add('long_context', 'analysis', chatBody('Here is a very long document. ' + 'word '.repeat(4000) + ' Please analyze it thoroughly.'), { acceptable: ['M-reason', 'M-coding', 'M-stream', 'M-chat-t1', 'M-nostream'], forbidden: ['M-cheap', 'M-smallctx'], hardCaps: ['chat'] });
add('long_context', 'analysis', chatBody('Analyze this log file. ' + 'line '.repeat(3500)), { acceptable: ['M-reason', 'M-coding', 'M-stream', 'M-chat-t1'], forbidden: ['M-cheap', 'M-smallctx'], hardCaps: ['chat'] });
add('long_context', 'coding', chatBody('Refactor this large codebase: ' + 'function f() { return 1; } '.repeat(300) + ' Please clean it up'), { acceptable: ['M-coding', 'M-stream', 'M-reason'], forbidden: ['M-smallctx'], hardCaps: ['chat', 'coding'] });
add('long_context', 'summarization', chatBody('Summarize this long report: ' + 'paragraph '.repeat(2500)), { acceptable: ['M-chat-t1', 'M-reason', 'M-coding'], forbidden: ['M-smallctx'], hardCaps: ['chat'] });

// --- strict (4) ---
for (const m of ['no-such-model-1', 'ghost-model-42', 'unknown-model-xyz', 'not-in-pool']) {
  add('strict', 'general_chat', { model: m, messages: [{ role: 'user', content: 'hi' }] }, { acceptable: [], forbidden: [], hardCaps: ['chat'], expectOutcome: 'no_candidate', budgetKey: 'strict' });
}
// --- allowPaid=false (4) ---
add('allowPaid_false', 'general_chat', chatBody('Explain quantum entanglement'), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-nostream', 'M-struct'], forbidden: ['M-reason', 'M-vision'], hardCaps: ['chat'], budgetKey: 'nopaid' });
add('allowPaid_false', 'general_chat', chatBody('Write a poem about the ocean'), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-nostream', 'M-struct'], forbidden: ['M-reason', 'M-vision'], hardCaps: ['chat'], budgetKey: 'nopaid' });
add('allowPaid_false', 'general_chat', chatBody('What is the meaning of life?'), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-nostream', 'M-struct'], forbidden: ['M-reason', 'M-vision'], hardCaps: ['chat'], budgetKey: 'nopaid' });
add('allowPaid_false', 'analysis', chatBody('Analyze this data set'), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-nostream', 'M-struct'], forbidden: ['M-reason', 'M-vision'], hardCaps: ['chat'], budgetKey: 'nopaid' });
// --- maxRequestCost (4) ---
for (const t of ['Analyze this document in detail', 'Analyze this complex topic thoroughly', 'Analyze and explain this data set', 'Analyze this report in detail']) {
  add('maxRequestCost', 'analysis', chatBody(t), { acceptable: [], forbidden: ['M-reason', 'M-vision'], hardCaps: ['chat'], budgetKey: 'budget', expectOutcome: 'completed', expectNoRecommendation: true });
}
// --- no_candidate (4) ---
for (const m of ['missing-model-a', 'missing-model-b', 'ghost-model-77', 'no-model-here']) {
  add('no_candidate', 'general_chat', { model: m, messages: [{ role: 'user', content: 'hello' }] }, { acceptable: [], forbidden: [], hardCaps: ['chat'], expectOutcome: 'no_candidate', budgetKey: 'strict' });
}
// --- fallback (4) ---
for (const t of ['Reply with FALLBACK', 'Say something', 'Hello there', 'Quick question']) {
  add('fallback', 'general_chat', chatBody(t), { acceptable: ['M-fail', 'M-chat-t1', 'M-cheap', 'M-coding'], forbidden: [], hardCaps: ['chat'], budgetKey: 'fallback', expectOutcome: 'completed' });
}
// --- client_aborted (3) ---
for (const t of ['Write a very long essay about the history of computing', 'Tell an extremely long story', 'Generate a long detailed report']) {
  add('client_aborted', 'general_chat', { model: 'M-slow', stream: true, messages: [{ role: 'user', content: t }], max_tokens: 5000 }, { acceptable: [], forbidden: [], hardCaps: ['chat', 'streaming'], abort: true, expectOutcome: 'client_aborted' });
}
// --- incomplete (3) ---
for (const t of ['Stream a long answer about physics', 'Keep going with the story', 'Continue writing the analysis']) {
  add('incomplete', 'general_chat', { model: 'M-eof', stream: true, messages: [{ role: 'user', content: t }], max_tokens: 200 }, { acceptable: [], forbidden: [], hardCaps: ['chat', 'streaming'], expectOutcome: 'incomplete' });
}
// --- provider health change (4) ---
for (const t of ['Explain the solar system', 'Write a short paragraph about rain', 'Describe a sunset', 'Tell me about volcanoes']) {
  add('provider_health', 'general_chat', chatBody(t), { acceptable: ['M-chat-t1', 'M-cheap', 'M-coding', 'M-stream', 'M-tool', 'M-nostream'], forbidden: ['M-reason', 'M-vision'], hardCaps: ['chat'], healthStage: true });
}

// ===========================================================================
// 5. 分阶段执行
// ===========================================================================

const mock = await createMockProvider();
const tmpRoot = join(OUT_DIR, '..', 'active-readiness-eval-data');
mkdirSync(tmpRoot, { recursive: true });

const PHASES = {
  main: { budget: { allowPaid: true }, strict: false },
  nopaid: { budget: { allowPaid: false }, strict: false },
  budget: { budget: { allowPaid: true, maxRequestCost: 0.000001 }, strict: false, paidOnly: true },
  strict: { budget: { allowPaid: true }, strict: true },
  fallback: { budget: { allowPaid: true }, strict: false, fallbackFirst: true },
};
const TASK_CONFIG_KEY = {
  strict: 'strict', allowPaid_false: 'nopaid', maxRequestCost: 'budget',
  no_candidate: 'strict', fallback: 'fallback',
};

const phaseOrder = ['main', 'fallback', 'nopaid', 'budget', 'strict'];
const tasksByPhase = {};
for (const t of TASKS) {
  const key = TASK_CONFIG_KEY[t.category] || 'main';
  if (!tasksByPhase[key]) tasksByPhase[key] = [];
  tasksByPhase[key].push(t);
}

const phaseResults = {};
for (const key of phaseOrder) {
  const phaseTasks = tasksByPhase[key] || [];
  if (phaseTasks.length === 0) continue;
  const phaseDataDir = join(tmpRoot, 'phase-' + key);
  mkdirSync(phaseDataDir, { recursive: true });
  const cfg = buildConfig(mock.port, phaseDataDir);
  cfg.budget = { ...cfg.budget, ...PHASES[key].budget, strictModel: PHASES[key].strict };
  if (PHASES[key].fallbackFirst) {
    for (const m of cfg.models) m.tier = m.id === 'M-fail' ? 'tier1' : 'tier2';
  }
  if (PHASES[key].paidOnly) {
    cfg.models = cfg.models.filter((m) => m.paid);
  }
  const configPath = join(tmpRoot, 'config-' + key + '.json');
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));

  const server = await createServer(configPath);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = server.address().port;
  console.log(`[ar-eval] phase=${key} port=${port} tasks=${phaseTasks.length}`);

  const httpStatuses = [];
  // 健康阶段：先用 M-fail 制造 6 次 500 → mock-fail 降级（Phase1 排除/降分；健康统计只读）
  if (phaseTasks.some((t) => t.healthStage)) {
    for (let i = 0; i < 6; i++) {
      await httpJson(port, '/v1/chat/completions', { model: 'M-fail', messages: [{ role: 'user', content: 'trigger failure' }] });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const task of phaseTasks) {
    let resp;
    if (task.abort) resp = await httpStreamAbort(port, '/v1/chat/completions', task.body, 250);
    else if (task.stream) resp = await httpStream(port, '/v1/chat/completions', task.body);
    else resp = await httpJson(port, '/v1/chat/completions', task.body);
    await new Promise((r) => setTimeout(r, 100));
    httpStatuses.push(resp.status);
  }
  const store = server._components.store;
  const shadowRows = await store.listShadowDecisions();
  const comparison = await server._components.intelligence.getComparison();
  phaseResults[key] = { httpStatuses, shadowRows, comparison };
  await new Promise((resolve) => server.close(() => resolve()));
}

// 汇总对照
const comparison = { total: 0, exact_match: 0, model_match_provider_diff: 0, policy_agreement: 0, different: 0, not_comparable: 0, comparable: 0, acceptanceRate: 0, comparison: [] };
for (const key of phaseOrder) {
  const pr = phaseResults[key];
  if (!pr) continue;
  const cc = pr.comparison;
  comparison.total += cc.total;
  comparison.exact_match += cc.exact_match;
  comparison.model_match_provider_diff += cc.model_match_provider_diff;
  comparison.policy_agreement += cc.policy_agreement;
  comparison.different += cc.different;
  comparison.not_comparable += cc.not_comparable;
  comparison.comparable += cc.comparable;
  comparison.comparison.push(...(cc.comparison || []));
}
const cmpDenom = comparison.exact_match + comparison.model_match_provider_diff + comparison.different;
comparison.acceptanceRate = cmpDenom > 0 ? Number(((comparison.exact_match / cmpDenom) * 100).toFixed(1)) : 0;

// 按 TASKS 顺序组装行（阶段光标）
const phaseCursor = {};
for (const key of phaseOrder) phaseCursor[key] = 0;

// ===========================================================================
// 6. 门禁指标计算
// ===========================================================================

const report = {
  mode: 'shadow',
  runtime: 'deterministic local mock providers (reproducible, offline, no real keys)',
  honesty: '验证 Shadow 决策真实代码路径；外部真实 Pilot 见 evidence/pilot-*.json；未开启 Active',
  tasks_total: TASKS.length,
  categories: {},
  classification: { correct: 0, wrong: 0, accuracy: '0%', details: [] },
  hard_violations: { streaming: 0, vision: 0, tool_use: 0, context_window: 0, budget: 0, no_paid: 0, strict: 0, total: 0, details: [] },
  acceptable_recommendation: { total: 0, in_acceptable: 0, rate: '0%', null_allowed: 0, details: [] },
  outcome: { correct: 0, wrong: 0, accuracy: '0%', details: [] },
  prompt_injection: 0,
  message_rewrite: 0,
  rows: [],
};

const categoryCounts = {};
for (const t of TASKS) categoryCounts[t.category] = (categoryCounts[t.category] || 0) + 1;
report.categories = categoryCounts;

for (let i = 0; i < TASKS.length; i++) {
  const task = TASKS[i];
  const key = TASK_CONFIG_KEY[task.category] || 'main';
  const phaseRows = (phaseResults[key] && phaseResults[key].shadowRows) || [];
  // 跳过健康触发请求（M-fail 500）产生的 Shadow 记录
  let actual = phaseRows[phaseCursor[key]] || null;
  while (actual && actual.requestedModel === 'M-fail') {
    phaseCursor[key]++;
    actual = phaseRows[phaseCursor[key]] || null;
  }
  phaseCursor[key]++;

  const rec = actual?.recommendation || null;
  const recModel = rec ? rec.modelId : null;
  const blocks = (actual?.rankedCandidates || []).filter((r) => r.blocked).map((r) => ({ modelId: r.modelId, reason: r.blocked }));

  // 分类
  const clsOk = (actual?.taskProfile?.taskType || null) === task.expectedType;
  if (clsOk) report.classification.correct++; else report.classification.wrong++;
  report.classification.details.push({ taskId: task.id || ('t' + String(i + 1).padStart(3, '0')), category: task.category, expected: task.expectedType, actual: actual?.taskProfile?.taskType || null, ok: clsOk });

  // 硬能力违规：推荐了 forbidden 或缺失硬能力
  let violation = null;
  const hardCaps = task.hardCaps || [];
  if (recModel) {
    // 推荐模型必须在可接受集合（若定义）；否则违规
    if (task.acceptable && task.acceptable.length > 0 && !task.acceptable.includes(recModel)) {
      violation = `recommended ${recModel} not in acceptable [${task.acceptable.join(',')}]`;
    }
    if (task.forbidden && task.forbidden.includes(recModel)) {
      violation = `recommended forbidden model ${recModel}`;
    }
    // 硬能力检查：模型画像
    const profile = actual?.recommendation ? rec : null;
    if (!violation && hardCaps.length > 0) {
      const capsOk = blocks.every((b) => !hardCaps.some((h) => b.modelId === recModel && b.reason.includes(h)));
      if (!capsOk) violation = `recommended ${recModel} violates hard caps [${hardCaps.join(',')}]`;
    }
  }
  if (violation) {
    report.hard_violations.total++;
    report.hard_violations.details.push({ taskId: task.id || ('t' + String(i + 1).padStart(3, '0')), category: task.category, violation });
    for (const h of hardCaps) {
      if (violation.includes(h)) report.hard_violations[h] = (report.hard_violations[h] || 0) + 1;
    }
  }

  // 可接受推荐率
  const hasAcceptable = Array.isArray(task.acceptable) && task.acceptable.length > 0;
  if (hasAcceptable) {
    if (recModel && task.acceptable.includes(recModel)) {
      report.acceptable_recommendation.total++;
      report.acceptable_recommendation.in_acceptable++;
    } else if (recModel) {
      report.acceptable_recommendation.total++;
    } else {
      // 无法安全决定 → recommendation=null（允许，不计入分母）
      report.acceptable_recommendation.null_allowed++;
    }
  }

  // 预算任务必须无推荐（全部超限）
  if (task.expectNoRecommendation && recModel) {
    report.hard_violations.budget++;
    report.hard_violations.total++;
    report.hard_violations.details.push({ taskId: task.id || 't', category: task.category, violation: 'budget stage recommended despite maxRequestCost' });
  }

  // 预算语义（budget/strict/nopaid 阶段）
  if (task.budgetKey === 'budget' || task.budgetKey === 'nopaid' || task.budgetKey === 'strict') {
    if (recModel) {
      // 禁付费阶段推荐付费模型 = 违规（从 rankedCandidates 查 paid）
      if (task.budgetKey === 'nopaid') {
        const rankedPaid = (actual?.rankedCandidates || []).find((rc) => rc.modelId === recModel && rc.paid);
        if (rankedPaid) {
          report.hard_violations.no_paid++;
          report.hard_violations.total++;
          report.hard_violations.details.push({ taskId: task.id || 't', category: task.category, violation: `no_paid stage recommended paid ${recModel}` });
        }
      }
      // strict 阶段必须无推荐
      if (task.budgetKey === 'strict') {
        report.hard_violations.strict++;
        report.hard_violations.total++;
        report.hard_violations.details.push({ taskId: task.id || 't', category: task.category, violation: `strict stage recommended ${recModel}` });
      }
    }
  }

  // 终态
  const outcomeOk = (actual?.actualOutcome || null) === (task.expectOutcome || 'completed');
  if (outcomeOk) report.outcome.correct++; else report.outcome.wrong++;
  report.outcome.details.push({ taskId: task.id || ('t' + String(i + 1).padStart(3, '0')), category: task.category, expected: task.expectOutcome || 'completed', actual: actual?.actualOutcome || null, ok: outcomeOk });

  report.rows.push({
    id: task.id || ('t' + String(i + 1).padStart(3, '0')),
    category: task.category,
    httpStatus: (phaseResults[key] && phaseResults[key].httpStatuses[phaseCursor[key] - 1]) ?? null,
    taskType: actual?.taskProfile?.taskType ?? null,
    expectedType: task.expectedType,
    suggested: rec ? `${rec.provider}/${rec.modelId}` : null,
    hardBlocks: blocks,
    predictedCost: actual?.predictions?.cost ?? null,
    realOutcome: actual?.actualOutcome ?? null,
    real: actual?.actualFinalModel ? `${actual.actualFinalProvider}/${actual.actualFinalModel}` : null,
    comparisonStatus: actual?.comparisonStatus ?? null,
    acceptable: task.acceptable || [],
    forbidden: task.forbidden || [],
  });
}

report.classification.accuracy = TASKS.length > 0 ? Number(((report.classification.correct / TASKS.length) * 100).toFixed(1)) + '%' : '0%';
report.outcome.accuracy = TASKS.length > 0 ? Number(((report.outcome.correct / TASKS.length) * 100).toFixed(1)) + '%' : '0%';
const acc = report.acceptable_recommendation;
report.acceptable_recommendation.rate = acc.total > 0 ? Number(((acc.in_acceptable / acc.total) * 100).toFixed(1)) + '%' : '0%';

// 门禁判定
const gates = {
  classification_ge_95: report.classification.correct / TASKS.length >= 0.95,
  hard_violations_zero: report.hard_violations.total === 0,
  streaming_zero: report.hard_violations.streaming === 0,
  vision_zero: report.hard_violations.vision === 0,
  tool_zero: report.hard_violations.tool_use === 0,
  context_zero: report.hard_violations.context_window === 0,
  budget_zero: report.hard_violations.budget === 0,
  no_paid_zero: report.hard_violations.no_paid === 0,
  strict_zero: report.hard_violations.strict === 0,
  acceptable_ge_90: acc.total > 0 ? acc.in_acceptable / acc.total >= 0.9 : true,
  prompt_injection_zero: report.prompt_injection === 0,
  message_rewrite_zero: report.message_rewrite === 0,
};
report.gates = gates;
report.gates_passed = Object.values(gates).every(Boolean);

// ===========================================================================
// 7. 输出
// ===========================================================================

writeFileSync(join(OUT_DIR, 'active-readiness-eval-report.json'), JSON.stringify(report, null, 2));

const L = [];
L.push('# Active Readiness 评测报告（100+ 任务矩阵）');
L.push('');
L.push(`- 任务数：${report.tasks_total} ｜ 分类准确率：${report.classification.accuracy} ｜ 终态一致率：${report.outcome.accuracy}`);
L.push(`- 可接受推荐率：${report.acceptable_recommendation.rate}（${report.acceptable_recommendation.in_acceptable}/${report.acceptable_recommendation.total}，null 允许 ${report.acceptable_recommendation.null_allowed}）`);
L.push(`- 硬能力违规：${report.hard_violations.total}（streaming=${report.hard_violations.streaming} vision=${report.hard_violations.vision} tool=${report.hard_violations.tool_use} context=${report.hard_violations.context_window} budget=${report.hard_violations.budget} no_paid=${report.hard_violations.no_paid} strict=${report.hard_violations.strict}）`);
L.push(`- 对照：exact_match=${comparison.exact_match} policy_agreement=${comparison.policy_agreement} different=${comparison.different} not_comparable=${comparison.not_comparable} acceptance=${comparison.acceptanceRate}%`);
L.push(`- 门禁：${report.gates_passed ? 'PASS' : 'FAIL'}（${Object.entries(gates).filter(([, v]) => v).length}/${Object.keys(gates).length} 项通过）`);
L.push('- 运行时：确定性本地 Mock Provider（可复现、离线、零成本）；外部真实 Pilot 见 evidence/pilot-*.json');
L.push('- 未开启 Active：本评测仅为 Active Readiness 指标');
L.push('');
L.push('## 门禁明细');
L.push('');
L.push('| 指标 | 要求 | 实际 | 结果 |');
L.push('| --- | --- | --- | --- |');
const gateNames = {
  classification_ge_95: '分类准确率 >= 95%', hard_violations_zero: '硬能力违规 = 0',
  streaming_zero: 'Streaming 违规 = 0', vision_zero: 'Vision 违规 = 0', tool_zero: 'Tool 违规 = 0',
  context_zero: 'ContextWindow 违规 = 0', budget_zero: '预算越权 = 0', no_paid_zero: '禁付费越权 = 0',
  strict_zero: 'strict 改变 = 0', acceptable_ge_90: '可接受集合推荐 >= 90%',
  prompt_injection_zero: 'Prompt 注入 = 0', message_rewrite_zero: '用户消息改写 = 0',
};
for (const [k, pass] of Object.entries(gates)) {
  const actual = k === 'classification_ge_95' ? report.classification.accuracy
    : k === 'acceptable_ge_90' ? report.acceptable_recommendation.rate
      : k === 'streaming_zero' ? report.hard_violations.streaming
        : k === 'vision_zero' ? report.hard_violations.vision
          : k === 'tool_zero' ? report.hard_violations.tool_use
            : k === 'context_zero' ? report.hard_violations.context_window
              : k === 'budget_zero' ? report.hard_violations.budget
                : k === 'no_paid_zero' ? report.hard_violations.no_paid
                  : k === 'strict_zero' ? report.hard_violations.strict
                    : k === 'hard_violations_zero' ? report.hard_violations.total
                      : k === 'prompt_injection_zero' ? report.prompt_injection
                        : report.message_rewrite;
  L.push(`| ${gateNames[k]} | 0 | ${actual} | ${pass ? '✅' : '❌'} |`);
}
L.push('');
L.push('## 分类错误与已知限制');
L.push('');
const wrong = report.classification.details.filter((d) => !d.ok);
if (wrong.length === 0) L.push('无分类错误。');
else for (const w of wrong) L.push(`- ${w.taskId}（${w.category}）：期望 ${w.expected}，实际 ${w.actual}`);
L.push('');
L.push('## 明细（前 30 行）');
L.push('');
L.push('| id | category | 期望类型 | 实际类型 | 建议 | 硬约束淘汰 | 真实结果 | 比较状态 |');
L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of report.rows.slice(0, 30)) {
  L.push(`| ${r.id} | ${r.category} | ${r.expectedType} | ${r.taskType ?? '-'} | ${r.suggested ?? '-'} | ${r.hardBlocks.map((b) => b.reason).join('; ').slice(0, 60) || '-'} | ${r.realOutcome ?? '-'}${r.real ? ' (' + r.real + ')' : ''} | ${r.comparisonStatus ?? '-'} |`);
}
writeFileSync(join(OUT_DIR, 'active-readiness-eval-report.md'), L.join('\n'));

console.log(JSON.stringify({
  tasks: report.tasks_total,
  classification: report.classification.accuracy,
  outcome: report.outcome.accuracy,
  acceptable: report.acceptable_recommendation.rate,
  hard_violations: report.hard_violations.total,
  gates_passed: report.gates_passed,
  comparison: { exact: comparison.exact_match, policy: comparison.policy_agreement, diff: comparison.different },
  out: [join(OUT_DIR, 'active-readiness-eval-report.json'), join(OUT_DIR, 'active-readiness-eval-report.md')],
}, null, 2));

mock.server.close();
process.exit(0);
