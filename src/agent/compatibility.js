// src/agent/compatibility.js
// Smart Router Mainline - Phase 1
// Claude Code 兼容补丁模块：处理 Claude Code 客户端的专有行为、字段与协议差异，
// 使其请求可在非 Anthropic 上游（OpenAI 兼容）上正确运行。
//
// 设计原则：
//   1. 每个补丁函数都是纯函数——不修改输入参数，返回新对象/新值。
//   2. 每个补丁可独立测试，无隐式全局状态依赖。
//   3. 不得静默删除字段：凡移除/转换/截断字段，必须产出统一格式的兼容警告。
//   4. 统一警告格式：{ patch, field, action, message }
//      action 取值：'removed' | 'converted' | 'truncated'
//   5. 仅使用 Node.js 内置模块 + 本仓库内 sibling 模块，无第三方依赖。
//
// 依赖：
//   - ./identity.js  : resolveAgent / AgentType
//   - ../config/loader.js : log

import { resolveAgent, AgentType } from './identity.js';
import { log } from '../config/loader.js';

// ----------------------------------------------------------------------------
// 内部工具
// ----------------------------------------------------------------------------

/**
 * 深拷贝（结构化克隆语义，覆盖 JSON 可表达类型）。
 * 用于保证补丁函数不会修改调用方传入的对象。
 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * 大小写不敏感地读取请求头。
 */
function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * 从字符串中提取首个「主版本号」形态的子串（如 2.1.206 / 1.0.7 / 4.0.0）。
 */
function extractVersionToken(str) {
  const m = String(str).match(/(\d+\.\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

/**
 * 用正则从 UA 中提取版本号（捕获组 1）。
 */
function extractVersionByRegex(ua, regex) {
  const m = String(ua).match(regex);
  return m && m[1] ? m[1] : null;
}

/**
 * 构造一条统一格式的兼容警告。
 */
function makeWarning(patch, field, action, message) {
  return { patch, field, action, message };
}

// 思维链泄漏检测模式（大小写不敏感）
const THINKING_LEAK_PATTERNS = [
  /Thinking Process\s*:/i,
  /\bLet me think\b/i,
  /\bLet's analyze\b/i,
  /\bLet me analyze\b/i,
  /\bLet's think\b/i,
];

// ----------------------------------------------------------------------------
// 1. HEAD /v1 探活
// ----------------------------------------------------------------------------

/**
 * Claude Code 启动时会发 HEAD /v1 检查连接可达性。
 * 上游 OpenAI 兼容端点通常不响应 HEAD，需要路由层直接短路返回 200。
 *
 * @param {string} pathname 请求路径
 * @returns {{ handled: true, statusCode: number, headers: object } | { handled: false }}
 */
export function handleHeadRequest(pathname) {
  // 先做路径归一化，兼容 /v1/v1 探活
  const p = normalizePath(pathname);
  if (p === '/v1' || p === '/v1/') {
    return {
      handled: true,
      statusCode: 200,
      headers: {
        'content-length': '0',
        'content-type': 'application/json',
      },
    };
  }
  return { handled: false };
}

// ----------------------------------------------------------------------------
// 2. /v1/v1/ 路径归一化
// ----------------------------------------------------------------------------

/**
 * Claude Code 2.1.206+ 会误发 /v1/v1/messages（双重 /v1 前缀）。
 * 将前导 /v1/v1 归一化为 /v1。
 *
 * 示例：
 *   /v1/v1/messages        -> /v1/messages
 *   /v1/v1/messages?x=1    -> /v1/messages?x=1（仅替换路径前缀）
 *   /v1/messages           -> /v1/messages（无变化）
 *
 * @param {string} pathname
 * @returns {string} 归一化后的 pathname（非字符串原样返回）
 */
export function normalizePath(pathname) {
  if (typeof pathname !== 'string' || pathname === '') return pathname;
  // 仅替换「前导 /v1/v1 且其后紧跟 / 或字符串结尾」的情况，
  // 避免误伤 /v1/v1foo 之类的路径。
  return pathname.replace(/^\/v1\/v1(?=\/|$)/, '/v1');
}

// ----------------------------------------------------------------------------
// 3. count_tokens 兼容
// ----------------------------------------------------------------------------

/**
 * Claude Code 会调 /v1/messages/count_tokens 预估 token 用量。
 * 非 Anthropic 上游不支持该端点，路由层需短路返回估算值。
 *
 * 估算规则（按规格）：JSON.stringify(body.messages).length / 4，向上取整，
 * 且必须返回合理的非零估算值（不能总是返回 0）。
 *
 * @param {string} pathname
 * @param {object} body
 * @returns {{ handled: true, response: { input_tokens: number } } | { handled: false }}
 */
export function handleCountTokens(pathname, body) {
  if (typeof pathname !== 'string' || !/\/count_tokens(?:\/|$|\?)/.test(pathname)) {
    return { handled: false };
  }

  let inputTokens = 0;
  try {
    const messages =
      body && Array.isArray(body.messages) ? body.messages : [];
    const text = JSON.stringify(messages);
    inputTokens = Math.ceil(text.length / 4);
  } catch {
    // JSON.stringify 异常时退回到最小估算
    inputTokens = 0;
  }
  // 保证合理的非零估算：空消息体（"[]"）也应至少计 1
  if (!inputTokens || inputTokens < 1) inputTokens = 1;

  return { handled: true, response: { input_tokens: inputTokens } };
}

// ----------------------------------------------------------------------------
// 4. thinking 参数处理
// ----------------------------------------------------------------------------

/**
 * 将 Anthropic 的 thinking 参数转换为 OpenAI 的 reasoning_effort。
 *
 *   thinking = { type: 'enabled', budget_tokens: N }
 *   budget_tokens > 4000 -> reasoning_effort = 'high'
 *   budget_tokens <= 4000 -> reasoning_effort = 'medium'
 *   thinking 缺失或 type !== 'enabled' -> reasoning_effort = undefined
 *
 * thinkingConfig 保留原始 thinking 值（深拷贝），用于 Anthropic 直通场景。
 *
 * @param {object} body
 * @returns {{ reasoningEffort: string|undefined, thinkingConfig: object|null }}
 */
export function handleThinkingParam(body) {
  const thinking = body && typeof body === 'object' ? body.thinking : undefined;

  if (!thinking || typeof thinking !== 'object') {
    return { reasoningEffort: undefined, thinkingConfig: null };
  }

  const thinkingConfig = deepClone(thinking);

  if (thinking.type !== 'enabled') {
    return { reasoningEffort: undefined, thinkingConfig };
  }

  const budget =
    typeof thinking.budget_tokens === 'number' && Number.isFinite(thinking.budget_tokens)
      ? thinking.budget_tokens
      : 0;
  const reasoningEffort = budget > 4000 ? 'high' : 'medium';

  return { reasoningEffort, thinkingConfig };
}

// ----------------------------------------------------------------------------
// 5. thinking 内容块清洗
// ----------------------------------------------------------------------------

/**
 * 上游模型可能返回 thinking 类型的 content block（Anthropic 扩展）。
 * 非 Anthropic 消费方无法识别，需替换为占位 text block：{ type: 'text', text: '[thinking]' }。
 *
 * 仅处理 content 为数组的 message；字符串 content 原样保留。
 * 纯函数：未发生替换时返回原 message 引用，发生替换时返回新对象。
 *
 * @param {Array} messages
 * @returns {Array} 清洗后的 messages（新数组）
 */
export function cleanThinkingBlocks(messages) {
  if (!Array.isArray(messages)) return messages;

  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const newContent = content.map((block) => {
      if (block && typeof block === 'object' && block.type === 'thinking') {
        changed = true;
        return { type: 'text', text: '[thinking]' };
      }
      return block;
    });

    if (!changed) return msg;
    return { ...msg, content: newContent };
  });
}

// ----------------------------------------------------------------------------
// 6. reasoning_content 清理
// ----------------------------------------------------------------------------

/**
 * 上游（部分 OpenAI 兼容服务商）返回的 reasoning_content 字段会污染响应，
 * 需要从响应体中删除：
 *   - 顶层 reasoning_content（兜底）
 *   - choices[].message.reasoning_content（非流式）
 *   - choices[].delta.reasoning_content（流式）
 *
 * 纯函数：返回新的 body，不修改输入。
 *
 * @param {object} body 响应体
 * @returns {object} 清理后的 body
 */
export function cleanReasoningContent(body) {
  if (!body || typeof body !== 'object') return body;

  const newBody = { ...body };

  // 顶层兜底清理
  if ('reasoning_content' in newBody) {
    delete newBody.reasoning_content;
  }

  if (Array.isArray(newBody.choices)) {
    newBody.choices = newBody.choices.map((choice) => {
      if (!choice || typeof choice !== 'object') return choice;
      const newChoice = { ...choice };

      if (newChoice.message && typeof newChoice.message === 'object') {
        const msg = { ...newChoice.message };
        if ('reasoning_content' in msg) delete msg.reasoning_content;
        newChoice.message = msg;
      }

      if (newChoice.delta && typeof newChoice.delta === 'object') {
        const delta = { ...newChoice.delta };
        if ('reasoning_content' in delta) delete delta.reasoning_content;
        newChoice.delta = delta;
      }

      return newChoice;
    });
  }

  return newBody;
}

// ----------------------------------------------------------------------------
// 7. "Thinking Process:" 泄漏防护
// ----------------------------------------------------------------------------

/**
 * 有些模型会把思维链写进 content 字段（如 "Thinking Process: ..."）。
 * 检测常见泄漏模式并截断：
 *   - "Thinking Process:"
 *   - "Let me think" / "Let's analyze" / "Let me analyze" / "Let's think"
 *
 * 截断策略：定位首个泄漏标记位置，删除从该标记到下一个段落分隔（空行）的内容，
 * 保留标记之前的正文与分隔之后的「真正回答」。若无段落分隔，则删除标记起的全部内容。
 *
 * @param {string} content
 * @returns {string} 清洗后的 content
 */
export function cleanThinkingProcessLeak(content) {
  if (typeof content !== 'string' || content === '') return content;

  // 统一换行，便于段落分隔检测
  const text = content.replace(/\r\n/g, '\n');

  // 定位最早出现的泄漏标记
  let earliestIdx = -1;
  for (const pattern of THINKING_LEAK_PATTERNS) {
    const m = pattern.exec(text);
    if (m && (earliestIdx === -1 || m.index < earliestIdx)) {
      earliestIdx = m.index;
    }
  }

  // 未检测到泄漏，原样返回（不改动原始内容）
  if (earliestIdx === -1) return content;

  const before = text.slice(0, earliestIdx);
  const after = text.slice(earliestIdx);

  // 寻找思维块结束位置：首个空行（段落分隔）
  const sepIdx = after.indexOf('\n\n');

  let result;
  if (sepIdx !== -1) {
    const afterThinking = after.slice(sepIdx + 2);
    result = before + afterThinking;
  } else {
    // 无段落分隔：标记起均为思维链泄漏，仅保留标记前正文
    result = before;
  }

  return result.trim();
}

// ----------------------------------------------------------------------------
// 8. Anthropic 专有字段/Header 清理
// ----------------------------------------------------------------------------

/**
 * 在请求转发到非 Anthropic 上游时，清理 Anthropic 专有字段：
 *   thinking, anthropic_beta, anthropic_version
 *
 * 返回清理后的 body 与被清理字段的兼容警告。
 *
 * @param {object} body
 * @returns {{ cleanedBody: object, warnings: Array }}
 */
export function stripAnthropicFields(body) {
  const warnings = [];
  if (!body || typeof body !== 'object') {
    return { cleanedBody: body, warnings };
  }

  const cleanedBody = { ...body };
  const fieldsToRemove = ['thinking', 'anthropic_beta', 'anthropic_version'];

  for (const field of fieldsToRemove) {
    if (Object.prototype.hasOwnProperty.call(cleanedBody, field)) {
      warnings.push(
        makeWarning(
          'stripAnthropicFields',
          field,
          'removed',
          `Anthropic 专有字段 "${field}" 已移除（目标上游为非 Anthropic）`
        )
      );
      delete cleanedBody[field];
    }
  }

  return { cleanedBody, warnings };
}

// ----------------------------------------------------------------------------
// 9. Agent User-Agent 识别
// ----------------------------------------------------------------------------

/**
 * 依据 User-Agent 识别调用方 Agent 身份并提取版本号。
 *
 *   Claude Code : claude-cli/* / claude-code/* / Claude*
 *   Codex       : codex*
 *   OpenAI SDK  : OpenAI/* / openai-(node|python|js|go|java)
 *   其他        : generic
 *
 * 识别规则与 identity.js 保持一致；版本号从 UA 中提取。
 *
 * @param {string} userAgent
 * @returns {{ agentId: string, agentType: string, version: string|null }}
 */
export function identifyAgentByUA(userAgent) {
  const ua = String(userAgent || '');

  // Claude Code
  if (/^claude-cli\//i.test(ua) || /^claude[- ]code\//i.test(ua)) {
    return {
      agentId: AgentType.CLAUDE_CODE,
      agentType: AgentType.CLAUDE_CODE,
      version: extractVersionByRegex(ua, /claude(?:-cli|-code)?\/(\d[\d.]*)/i),
    };
  }
  if (/^claude/i.test(ua)) {
    return {
      agentId: AgentType.CLAUDE_CODE,
      agentType: AgentType.CLAUDE_CODE,
      version: extractVersionToken(ua),
    };
  }

  // Codex
  if (/^codex/i.test(ua) || /\bcodex\b/i.test(ua)) {
    return {
      agentId: AgentType.CODEX,
      agentType: AgentType.CODEX,
      version: extractVersionByRegex(ua, /codex[\w-]*\/(\d[\d.]*)/i),
    };
  }

  // OpenAI SDK
  if (/^openai(\/|-|\s|$)/i.test(ua) || /\bopenai[- ](?:node|python|js|go|java)\b/i.test(ua)) {
    return {
      agentId: AgentType.OPENAI_SDK,
      agentType: AgentType.OPENAI_SDK,
      version: extractVersionToken(ua),
    };
  }

  return { agentId: AgentType.GENERIC, agentType: AgentType.GENERIC, version: null };
}

// ----------------------------------------------------------------------------
// 额外：context_management 处理
// ----------------------------------------------------------------------------

/**
 * 处理 Claude Code 的新字段 context_management。
 *
 *   - 上游支持（options.upstreamSupports=true）：透传，不产生警告。
 *   - 上游不支持（默认）：记录兼容警告并移除字段。
 *
 * 不得静默删除：移除时必定产出 warning。
 *
 * @param {object} body
 * @param {object} [options]
 * @param {boolean} [options.upstreamSupports=false] 上游是否支持该字段
 * @returns {{ body: object, warnings: Array }}
 */
export function handleContextManagement(body, options = {}) {
  const warnings = [];
  if (!body || typeof body !== 'object') {
    return { body, warnings };
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'context_management')) {
    return { body, warnings };
  }

  const upstreamSupports = options.upstreamSupports === true;
  if (upstreamSupports) {
    // 上游支持：透传
    return { body, warnings };
  }

  // 上游不支持：移除并告警
  const newBody = { ...body };
  delete newBody.context_management;
  warnings.push(
    makeWarning(
      'handleContextManagement',
      'context_management',
      'removed',
      '上游不支持 context_management 字段，已移除（Claude Code 新字段，默认按不支持处理）'
    )
  );
  return { body: newBody, warnings };
}

// ----------------------------------------------------------------------------
// 额外：output_config 处理
// ----------------------------------------------------------------------------

/**
 * 处理 Claude Code 的新字段 output_config。
 *
 *   - 上游支持（options.upstreamSupports=true）：透传，不产生警告。
 *   - 上游不支持（默认）：记录兼容警告并移除字段。
 *
 * 不得静默删除：移除时必定产出 warning。
 *
 * @param {object} body
 * @param {object} [options]
 * @param {boolean} [options.upstreamSupports=false] 上游是否支持该字段
 * @returns {{ body: object, warnings: Array }}
 */
export function handleOutputConfig(body, options = {}) {
  const warnings = [];
  if (!body || typeof body !== 'object') {
    return { body, warnings };
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'output_config')) {
    return { body, warnings };
  }

  const upstreamSupports = options.upstreamSupports === true;
  if (upstreamSupports) {
    return { body, warnings };
  }

  const newBody = { ...body };
  delete newBody.output_config;
  warnings.push(
    makeWarning(
      'handleOutputConfig',
      'output_config',
      'removed',
      '上游不支持 output_config 字段，已移除（Claude Code 新字段，默认按不支持处理）'
    )
  );
  return { body: newBody, warnings };
}

// ----------------------------------------------------------------------------
// 统一入口：应用所有 Claude Code 兼容补丁
// ----------------------------------------------------------------------------

/**
 * 应用所有 Claude Code 兼容补丁（请求侧）。
 *
 * 流程：
 *   1. 识别 Agent（UA + 路径）。
 *   2. 若非 Claude Code：原样返回，不应用任何补丁。
 *   3. 若是 Claude Code，依次应用请求侧补丁：
 *        - normalizePath            路径归一化
 *        - handleThinkingParam      thinking -> reasoning_effort（转换）
 *        - stripAnthropicFields     移除 Anthropic 专有字段
 *        - handleContextManagement  context_management 处理
 *        - handleOutputConfig       output_config 处理
 *   4. 汇总 patches（已应用补丁名）与 warnings（兼容警告）。
 *
 * 响应侧补丁（cleanThinkingBlocks / cleanReasoningContent / cleanThinkingProcessLeak）
 * 作用于上游响应，不在本入口处理，由响应处理流程独立调用。
 *
 * @param {object} headers 请求头
 * @param {object} body 请求体
 * @param {string} pathname 请求路径
 * @returns {{
 *   body: object,
 *   headers: object,
 *   pathname: string,
 *   patches: string[],
 *   warnings: Array,
 *   agent: object,
 *   isClaudeCode: boolean,
 *   reasoningEffort: string|undefined,
 *   thinkingConfig: object|null
 * }}
 */
export function applyClaudeCodePatches(headers, body, pathname) {
  const patches = [];
  const warnings = [];

  // 1. 识别 Agent
  const ua = getHeader(headers, 'user-agent');
  const agentInfo = identifyAgentByUA(ua);
  const agent = resolveAgent(headers, body, { path: pathname });

  const isClaudeCode = agent.isClaudeCode || agentInfo.agentType === AgentType.CLAUDE_CODE;

  // 非 Claude Code：不应用补丁，原样返回
  if (!isClaudeCode) {
    return {
      body,
      headers,
      pathname,
      patches,
      warnings,
      agent: agentInfo,
      isClaudeCode: false,
      reasoningEffort: undefined,
      thinkingConfig: null,
    };
  }

  // 2. 是 Claude Code：基于深拷贝应用补丁，保证不修改入参
  let outBody = deepClone(body);
  let outHeaders = { ...(headers || {}) };
  let outPath = pathname;
  let reasoningEffort;
  let thinkingConfig = null;

  // 2a. 路径归一化
  const normalized = normalizePath(outPath);
  if (normalized !== outPath) {
    patches.push('normalizePath');
    outPath = normalized;
  }

  // 2b. thinking 参数处理
  if (outBody && typeof outBody === 'object' && 'thinking' in outBody) {
    patches.push('handleThinkingParam');
    const tp = handleThinkingParam(outBody);
    reasoningEffort = tp.reasoningEffort;
    thinkingConfig = tp.thinkingConfig;
    if (reasoningEffort) {
      outBody = { ...outBody, reasoning_effort: reasoningEffort };
      warnings.push(
        makeWarning(
          'handleThinkingParam',
          'thinking',
          'converted',
          `thinking 参数已转换为 reasoning_effort="${reasoningEffort}"`
        )
      );
    }
  }

  // 2c. Anthropic 专有字段清理（在 thinking 转换之后，确保先读取再移除）
  const stripResult = stripAnthropicFields(outBody);
  if (stripResult.warnings.length > 0) {
    patches.push('stripAnthropicFields');
    outBody = stripResult.cleanedBody;
    warnings.push(...stripResult.warnings);
  }

  // 2d. context_management 处理
  const cmResult = handleContextManagement(outBody);
  if (cmResult.warnings.length > 0) {
    patches.push('handleContextManagement');
    outBody = cmResult.body;
    warnings.push(...cmResult.warnings);
  }

  // 2e. output_config 处理
  const ocResult = handleOutputConfig(outBody);
  if (ocResult.warnings.length > 0) {
    patches.push('handleOutputConfig');
    outBody = ocResult.body;
    warnings.push(...ocResult.warnings);
  }

  // 3. 记录兼容警告到日志（stderr，不干扰业务流）
  if (warnings.length > 0) {
    for (const w of warnings) {
      log(
        `[compat] patch=${w.patch} field=${w.field} action=${w.action}: ${w.message}`
      );
    }
  }

  return {
    body: outBody,
    headers: outHeaders,
    pathname: outPath,
    patches,
    warnings,
    agent: agentInfo,
    isClaudeCode: true,
    reasoningEffort,
    thinkingConfig,
  };
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  handleHeadRequest,
  normalizePath,
  handleCountTokens,
  handleThinkingParam,
  cleanThinkingBlocks,
  cleanReasoningContent,
  cleanThinkingProcessLeak,
  stripAnthropicFields,
  identifyAgentByUA,
  handleContextManagement,
  handleOutputConfig,
  applyClaudeCodePatches,
};
