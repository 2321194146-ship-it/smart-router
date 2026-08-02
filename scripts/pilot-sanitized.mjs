#!/usr/bin/env node
// Smart Router Mainline - Phase 1
// 可复跑真实 Pilot 的脱敏脚本（不含任何 Key）。
//
// 用法：
//   export SMARTROUTER_CONFIG=/path/to/config/local.json   # 含 Key 的本地配置（.gitignore 排除）
//   node scripts/pilot-sanitized.mjs --config "$SMARTROUTER_CONFIG" --out pilot-evidence.json
//
// 也可直接连一个已在运行的 Router：
//   node scripts/pilot-sanitized.mjs --url http://127.0.0.1:28788 --out pilot-evidence.json
//
// 安全约束：
//   - 脚本内不出现任何 Key；Key 只从环境变量或外部配置文件读取
//   - 输出证据会截断 content 与工具入参，绝不输出 api_key / Authorization 头
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

function sanitize(text, maxLen = 120) {
  if (typeof text !== 'string') return text;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...(truncated)';
}

async function httpJson(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { body = sanitize(raw, 200); }
  return { status: res.status, body };
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = process.env.SMARTROUTER_CONFIG || args.config;
  const outPath = args.out || 'pilot-evidence.json';

  let base = args.url || null;
  let apiKeys = null;

  if (!base && configPath && existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    // Key 从外部配置文件读取；本脚本不打印、不写入任何 Key
    apiKeys = (cfg.providers || []).reduce((m, p) => {
      m[p.name] = { key: p.api_key, authHeader: p.auth_header || 'Authorization', authPrefix: p.auth_prefix || 'Bearer ' };
      return m;
    }, {});
    const host = cfg.server?.host || '127.0.0.1';
    const port = cfg.server?.port || 28788;
    base = 'http://' + host + ':' + port;
  }

  if (!base) {
    console.error('[pilot] 需要 --url <router> 或 --config <含Key的本地配置> 或 SMARTROUTER_CONFIG 环境变量');
    process.exit(2);
  }

  const startTime = new Date().toISOString();
  const tests = [];
  const openaiKey = (apiKeys && (apiKeys['openai'] || apiKeys['deepseek']))?.key || null;
  const chatHeaders = openaiKey ? { Authorization: 'Bearer ' + openaiKey } : {};
  const anthropicHeaders = apiKeys && apiKeys['anthropic']
    ? { 'x-api-key': apiKeys['anthropic'].key, 'anthropic-version': '2023-06-01' }
    : {};

  const record = (name, result) => tests.push({ name, timestamp: new Date().toISOString(), ...result });

  // 1. chat 非流式
  try {
    const r = await httpJson(base + '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Reply with exactly: PILOT_OK' }],
      max_tokens: 20,
    }, chatHeaders);
    record('chat-non-streaming', {
      status: r.status,
      success: r.status === 200,
      details: {
        model: r.body?.model ?? null,
        finish_reason: r.body?.choices?.[0]?.finish_reason ?? null,
        content_preview: sanitize(r.body?.choices?.[0]?.message?.content ?? null),
        usage: r.body?.usage ?? null,
      },
    });
  } catch (e) { record('chat-non-streaming', { status: 0, success: false, error: e.message }); }

  // 2. chat 流式（SSE）
  try {
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...chatHeaders },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'Count from 1 to 3.' }], max_tokens: 50 }),
    });
    const text = await res.text();
    const doneCount = (text.match(/data: \[DONE\]/g) || []).length;
    record('chat-streaming', {
      status: res.status,
      success: res.status === 200 && doneCount > 0,
      details: { hasDone: doneCount > 0, bytes: text.length, firstLine: sanitize(text.split('\n')[0] || '', 160) },
    });
  } catch (e) { record('chat-streaming', { status: 0, success: false, error: e.message }); }

  // 3. chat tool_calls
  try {
    const r = await httpJson(base + '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'What is 2+2? Use the calculator tool if available.' }],
      tools: [{ type: 'function', function: { name: 'calculator', description: 'Add two numbers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } } }],
      max_tokens: 100,
    }, chatHeaders);
    record('chat-tool-calls', {
      status: r.status,
      success: r.status === 200,
      details: {
        finish_reason: r.body?.choices?.[0]?.finish_reason ?? null,
        has_tool_calls: !!(r.body?.choices?.[0]?.message?.tool_calls?.length),
        tool_calls_count: r.body?.choices?.[0]?.message?.tool_calls?.length ?? 0,
        content_preview: sanitize(r.body?.choices?.[0]?.message?.content ?? null),
      },
    });
  } catch (e) { record('chat-tool-calls', { status: 0, success: false, error: e.message }); }

  // 4. anthropic 非流式
  try {
    const r = await httpJson(base + '/v1/messages', {
      model: 'auto',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with exactly: PILOT_OK' }],
    }, anthropicHeaders);
    record('anthropic-non-streaming', {
      status: r.status,
      success: r.status === 200,
      details: {
        type: r.body?.type ?? null,
        stop_reason: r.body?.stop_reason ?? null,
        model: r.body?.model ?? null,
        content_preview: sanitize(Array.isArray(r.body?.content) ? r.body.content.map((c) => c.text || '').join('') : null),
      },
    });
  } catch (e) { record('anthropic-non-streaming', { status: 0, success: false, error: e.message }); }

  // 5. responses 非流式
  try {
    const r = await httpJson(base + '/v1/responses', {
      model: 'auto',
      input: 'Reply with exactly: PILOT_OK',
      max_output_tokens: 20,
    }, chatHeaders);
    record('responses-non-streaming', {
      status: r.status,
      success: r.status === 200,
      details: {
        id: r.body?.id ? String(r.body.id).slice(0, 24) + '...' : null,
        model: r.body?.model ?? null,
        output_text: sanitize(Array.isArray(r.body?.output) ? r.body.output.map((o) => o.content?.[0]?.text || '').join('') : null),
      },
    });
  } catch (e) { record('responses-non-streaming', { status: 0, success: false, error: e.message }); }

  const passed = tests.filter((t) => t.success).length;
  const evidence = {
    startTime,
    endTime: new Date().toISOString(),
    router: base,
    summary: { total: tests.length, passed, failed: tests.length - passed, passRate: tests.length ? ((passed / tests.length) * 100).toFixed(1) + '%' : '0%' },
    note: '脱敏证据：内容已截断，不含任何 API Key / Authorization 头',
    tests,
  };
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ summary: evidence.summary, out: outPath }, null, 2));
  process.exit(passed === tests.length ? 0 : 1);
}

main().catch((e) => { console.error('[pilot] fatal:', e.message); process.exit(1); });
