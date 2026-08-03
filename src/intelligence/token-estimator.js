// src/intelligence/token-estimator.js
// Smart Router Mainline - Phase 2-C
// 确定性保守上下文 Token 估算器（协议感知，无第三方依赖）。
//
// 取代旧的 allText.length / 3.5（该估算对 CJK 严重低估：1.3 万中文字符只估 ~3715）。
//
// 规则（保守方向 = 高估 token）：
//   - CJK 字符：每字 1.5 token（中文实际约 1.2-2 token/字）
//   - 其他字符：每 3.5 字符 1 token（标准英文约 4 字符/token，保守取 3.5）
//   - 每条消息（含 role 等结构）附加 4 token
//   - 图片内容块：预分配 800 token
//   - tool_use / tool_result / function_call 内容块计入文本 + 结构开销
//   - tool schemas：按 JSON 长度 / 3 字符每 token + 每工具 8 token 开销
//   - response_format / text.json_schema / output_config：按 JSON 长度 + 固定开销
//   - 输出预留：max_tokens / max_output_tokens / max_completion_tokens（默认 500）
//   - 总估算（输入 + 输出）再乘 1.1 安全余量
//
// 输出：{ input, output, total, breakdown }
//   - input ：输入侧估算（已含各结构项）
//   - output：输出预留
//   - total ：ceil((input + output) * 1.1)，用于 contextWindow 硬约束判定

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const CJK_TOKENS_PER_CHAR = 1.5;
const CHARS_PER_TOKEN = 3.5;
const MESSAGE_OVERHEAD = 4;
const IMAGE_TOKENS = 800;
const TOOL_SCHEMA_CHARS_PER_TOKEN = 3;
const TOOL_OVERHEAD = 8;
const JSON_FIXED_OVERHEAD = 16;
const DEFAULT_OUTPUT_RESERVE = 500;
const SAFETY_MARGIN = 1.1;

function countCJK(s) {
  const m = String(s == null ? '' : s).match(CJK_RE);
  return m ? m.length : 0;
}

export function estimateTextTokens(s) {
  const str = String(s == null ? '' : s);
  const cjk = countCJK(str);
  const other = str.length - cjk;
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other / CHARS_PER_TOKEN);
}

export function estimateJsonTokens(obj) {
  if (obj == null) return 0;
  try {
    return Math.ceil(JSON.stringify(obj).length / TOOL_SCHEMA_CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

/** 估算 content 字段（string 或内容块数组；含 image/tool_use/tool_result） */
export function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const type = b.type || '';
    if (type === 'image_url' || type === 'image' || type === 'input_image') {
      n += IMAGE_TOKENS;
    } else if (type === 'tool_result') {
      n += MESSAGE_OVERHEAD + estimateContentTokens(b.content);
      if (b.tool_use_id) n += 2;
    } else if (type === 'tool_use') {
      n += MESSAGE_OVERHEAD + estimateTextTokens(b.name) + estimateJsonTokens(b.input);
    } else if (type === 'function_call') {
      n += MESSAGE_OVERHEAD + estimateTextTokens(b.name) + estimateJsonTokens(b.arguments);
    } else if (type === 'function_call_output') {
      n += MESSAGE_OVERHEAD + estimateContentTokens(b.output);
    } else if (b.text != null) {
      n += estimateTextTokens(b.text);
    } else if (b.content != null) {
      n += estimateContentTokens(b.content);
    } else {
      n += estimateJsonTokens(b);
    }
  }
  return n;
}

function collectSystemTokens(body) {
  let n = 0;
  const sys = body?.system;
  if (typeof sys === 'string' && sys) {
    n += estimateTextTokens(sys) + MESSAGE_OVERHEAD;
  } else if (Array.isArray(sys)) {
    for (const s of sys) {
      n += MESSAGE_OVERHEAD + estimateTextTokens(typeof s === 'string' ? s : (s && s.text));
    }
  }
  const dev = body?.developer;
  if (typeof dev === 'string' && dev) {
    n += estimateTextTokens(dev) + MESSAGE_OVERHEAD;
  } else if (Array.isArray(dev)) {
    for (const d of dev) {
      n += MESSAGE_OVERHEAD + estimateTextTokens(typeof d === 'string' ? d : (d && d.content));
    }
  }
  return n;
}

function collectMessagesTokens(body) {
  let n = 0;
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    n += MESSAGE_OVERHEAD;
    n += estimateContentTokens(m.content);
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        n += MESSAGE_OVERHEAD + estimateTextTokens(tc?.function?.name) + estimateJsonTokens(tc?.function?.arguments);
      }
    }
    if (m.name) n += 2;
  }
  return n;
}

function collectInputTokens(body) {
  const input = body?.input;
  if (input == null || Array.isArray(body?.messages)) return 0;
  if (typeof input === 'string') return estimateTextTokens(input) + MESSAGE_OVERHEAD;
  if (!Array.isArray(input)) return 0;
  let n = 0;
  for (const item of input) {
    if (typeof item === 'string') {
      n += MESSAGE_OVERHEAD + estimateTextTokens(item);
    } else if (item && typeof item === 'object') {
      const type = item.type || '';
      if (type === 'message') {
        n += MESSAGE_OVERHEAD + estimateContentTokens(item.content);
      } else if (type === 'function_call') {
        n += MESSAGE_OVERHEAD + estimateTextTokens(item.name) + estimateJsonTokens(item.arguments);
      } else if (type === 'function_call_output') {
        n += MESSAGE_OVERHEAD + estimateContentTokens(item.output);
      } else if (item.content != null) {
        n += MESSAGE_OVERHEAD + estimateContentTokens(item.content);
      } else {
        n += estimateJsonTokens(item);
      }
    }
  }
  return n;
}

function collectToolSchemaTokens(body) {
  const tools = body?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return tools.reduce((s, t) => s + estimateJsonTokens(t) + TOOL_OVERHEAD, 0);
}

function collectStructuredTokens(body) {
  let n = 0;
  const rf = body?.response_format;
  if (rf && typeof rf === 'object') n += estimateJsonTokens(rf) + JSON_FIXED_OVERHEAD;
  const txt = body?.text;
  if (txt && typeof txt === 'object') {
    if (txt.json_schema && typeof txt.json_schema === 'object') {
      n += estimateJsonTokens(txt.json_schema) + JSON_FIXED_OVERHEAD;
    } else if (txt.format && txt.format !== 'text' && txt.format !== 'plain_text') {
      n += estimateJsonTokens(txt) + JSON_FIXED_OVERHEAD;
    }
  }
  const oc = body?.output_config;
  if (oc && typeof oc === 'object') n += estimateJsonTokens(oc) + JSON_FIXED_OVERHEAD;
  return n;
}

/**
 * 确定性保守 Token 估算（协议感知）。
 * @param {object} body 协议请求体
 * @param {object} [options] { protocol }
 * @returns {{ input: number, output: number, total: number, breakdown: object }}
 */
export function estimateTokens(body, options = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const breakdown = {
    system: collectSystemTokens(b),
    messages: collectMessagesTokens(b),
    input_array: collectInputTokens(b),
    tool_schemas: collectToolSchemaTokens(b),
    structured: collectStructuredTokens(b),
  };
  const input = Object.values(breakdown).reduce((s, x) => s + (typeof x === 'number' ? x : 0), 0);

  let output = DEFAULT_OUTPUT_RESERVE;
  for (const key of ['max_tokens', 'max_output_tokens', 'max_completion_tokens']) {
    const v = b[key];
    if (typeof v === 'number' && v > 0) { output = v; break; }
  }
  const total = Math.ceil((input + output) * SAFETY_MARGIN);
  return { input: Math.ceil(input), output: Math.ceil(output), total, breakdown };
}

export default { estimateTokens, estimateTextTokens, estimateJsonTokens, estimateContentTokens };
