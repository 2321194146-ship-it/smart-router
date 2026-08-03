// src/intelligence/task-analyzer.js
// Smart Router Mainline - Phase 2-B (Active Readiness)
// Task Analyzer：分析请求消息，输出任务画像（类型、能力需求、复杂度、上下文规模等）。
//
// Shadow 约束：
//   - 纯本地计算，不发起任何上游调用
//   - 只读请求体，不修改消息内容（禁止用户消息改写）
//   - 输出机器可执行元数据（JSON），不附加任何 System Prompt
//
// Phase2-B 新增：
//   - requiredCapabilities：统一任务能力需求画像（chat/coding/reasoning/tool_use/
//     vision/structured_output/long_context/streaming，0-1 需求强度）
//   - 13 种任务类型：general_chat/coding/debugging/architecture/analysis/research/
//     writing/summarization/translation/extraction/tool_orchestration/vision/structured_output
//   - stream=true → streaming 为硬性要求（requiredCapabilities.streaming = 1.0）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { estimateTokens } from './token-estimator.js';

export const TaskType = {
  GENERAL_CHAT: 'general_chat',
  CODING: 'coding',
  DEBUGGING: 'debugging',
  ARCHITECTURE: 'architecture',
  ANALYSIS: 'analysis',
  RESEARCH: 'research',
  WRITING: 'writing',
  SUMMARIZATION: 'summarization',
  TRANSLATION: 'translation',
  EXTRACTION: 'extraction',
  TOOL_ORCHESTRATION: 'tool_orchestration',
  VISION: 'vision',
  STRUCTURED_OUTPUT: 'structured_output',
  OTHER: 'other',
};

// 标准能力键（与 Model Capability Profile 对齐）
export const CapabilityKey = Object.freeze({
  CHAT: 'chat',
  CODING: 'coding',
  REASONING: 'reasoning',
  TOOL_USE: 'tool_use',
  VISION: 'vision',
  STRUCTURED_OUTPUT: 'structured_output',
  LONG_CONTEXT: 'long_context',
  STREAMING: 'streaming',
});

export const CAPABILITY_KEYS = Object.freeze(Object.values(CapabilityKey));

// 二元硬能力：必须满足的硬性要求（缺失即 blocked）。
// 仅包含 streaming/vision/tool_use/structured_output；protocol/contextWindow 在 policy 层单独检查。
// Phase2-C：chat/coding/reasoning 等等级能力【不再】因 >=1.0 而进入硬阻断。
export const HARD_CAPABILITY_KEYS = Object.freeze([
  CapabilityKey.STREAMING,
  CapabilityKey.VISION,
  CapabilityKey.TOOL_USE,
  CapabilityKey.STRUCTURED_OUTPUT,
]);

// 等级软能力：参与评分匹配，不作为硬阻断（除非显式配置 gradedSafetyThreshold）。
export const SOFT_CAPABILITY_KEYS = Object.freeze([
  CapabilityKey.CHAT,
  CapabilityKey.CODING,
  CapabilityKey.REASONING,
]);

/** 空能力需求画像（全 0） */
export function emptyRequiredCapabilities() {
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = 0;
  return out;
}

function lower(s) {
  return s == null ? '' : String(s).toLowerCase();
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b || typeof b !== 'object') return '';
        if (typeof b.text === 'string') return b.text;
        if (b.type === 'image_url' || b.type === 'image' || b.type === 'input_image') {
          return '[IMAGE]';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

function collectMessages(body) {
  const msgs = [];
  if (body && Array.isArray(body.messages)) msgs.push(...body.messages);
  if (body && typeof body.input === 'string') {
    msgs.push({ role: 'user', content: body.input });
  } else if (body && Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item && typeof item === 'object') {
        if (item.role && item.content) msgs.push(item);
        else if (item.type === 'message' && Array.isArray(item.content)) {
          msgs.push({ role: 'user', content: item.content.map((c) => c.text || '').join('') });
        }
      }
    }
  }
  if (body && typeof body.system === 'string' && body.system) {
    msgs.push({ role: 'system', content: body.system });
  } else if (body && Array.isArray(body.system)) {
    msgs.push({
      role: 'system',
      content: body.system.map((s) => (typeof s === 'string' ? s : s.text || '')).join('\n'),
    });
  }
  return msgs;
}

// ----------------------------------------------------------------------------
// 关键词特征（分类 + 能力信号）
// ----------------------------------------------------------------------------

const CODING_HINTS = [
  'function', 'class ', 'def ', 'import ', 'const ', 'var ',
  'bug', 'debug', 'compile', 'syntax', 'refactor', 'code', 'rest api',
  'sql', 'regex', 'error', 'exception', 'implement', 'write a script',
  '代码', '函数', '调试', '编译', '修复', '报错', 'write a function', 'write code',
  // Phase2-C 同义词增强（移除裸 'let ' 避免 "let me think" 误判）
  'react', '组件', '算法', '实现一个', '编写', 'python', 'typescript',
  'program', 'query', 'loop', 'algorithm', '循环', '程序',
];

const DEBUG_HINTS = [
  'debug', 'bug', 'traceback', 'stack trace', 'fix this error', 'why is this failing',
  'debugging', 'exception', 'crash', '报错', '异常', '崩溃', '为什么失败',
  // Phase2-C 同义词增强（命令式排障表达）
  'returns garbage', 'program hangs', 'query times out', 'never seems to terminate',
  'null error', '排查', '闪退', '调试',
];

const ARCHITECTURE_HINTS = [
  'architecture', 'design a system', 'system design', 'microservice', 'module structure',
  'architecture review', '架构', '系统设计', '模块设计',
];

const REASONING_HINTS = [
  'prove', 'mathematical proof', 'logic puzzle', 'complex reasoning', 'deduce',
  'inference', 'explain why', 'compare and contrast', 'reason',
  '推理', '证明', '逻辑', '推导',
  // Phase2-C 含蓄推理增强
  'tallest', 'are all', 'calculate', 'justify',
];

const ANALYSIS_HINTS = [
  'calculate', 'compute', 'compare', 'summarize the', 'analyze', 'reason',
  'prove', 'solve', 'mathematical', 'logic', 'explain why',
  '计算', '解释', '比较', '分析', '推理', '证明', '解决',
  // Phase2-C 同义词增强
  'weigh the', 'break down', 'assess', 'reason through', 'tradeoffs', 'evaluate',
  '权衡', '拆解', '评估', '取舍', '判断',
];

const RESEARCH_HINTS = [
  'research', 'investigate', 'literature', 'survey', 'study the',
  '研究', '调研', '文献',
  // Phase2-C 同义词增强
  'dig into', 'look into', '查一下', '找找', '资料',
];

const WRITING_HINTS = [
  'write an essay', 'write an article', 'write a blog', 'draft', 'compose',
  'write a report', 'write a story', 'write a short story', 'short story',
  '撰写', '写一篇', '起草', '作文',
  // Phase2-C 同义词增强
  'compose a', 'pen a', 'fashion a', 'create a', '写一段', '写一封', '作一首', '想一句', '广告语', '感谢信',
];

const SUMMARIZATION_HINTS = [
  'summarize', 'summary', 'summarise', 'brief summary', 'tl;dr', 'recap',
  '摘要', '总结', '概括', '提炼',
  // Phase2-C 同义词增强
  'condense', 'gist', 'takeaways', 'boil down', 'boil this down', 'boil it down',
  'distill', 'tldr', 'wrap up', 'highlights', '浓缩', '要点', '重点内容',
];

const TRANSLATION_HINTS = [
  'translate', 'translation', 'translate to', 'translate from',
  '翻译', '译文',
  // Phase2-C 同义词增强
  'convert this', 'render this', 'version of this', 'turn this text', 'write this in',
  '翻成', '转成', '用德语写', '用英语写', '用日语写', '用法语写', '用中文写', '用英语表达',
];

const EXTRACTION_HINTS = [
  'extract', 'rewrite', 'shorten', 'paraphrase', 'extract all',
  '提取', '改写', '精简',
  // Phase2-C 同义词增强（移除裸 'format'，避免 "JSON format" 名词短语误判）
  'pull out', 'list every', 'pick out', 'grab the', 'find all',
  '抓出', '找出', '整理出', '挑出来',
];

// Phase2-C：工具必需信号（高置信度）。
// 仅当用户【显式要求】执行工具或协议字段强制时，才判定 toolsRequired=true；
// tools 仅存在（可用）不会自动升级为必需，也不得据此把普通问题归类为 tool_orchestration。
const TOOL_REQUIRED_HINTS = [
  'use the tool', 'use a tool', 'call a tool', 'call the function', 'tool_calls',
  '调用函数', '使用工具', '调用工具', '用工具',
];
// 命令式模式：call/use/invoke/run/trigger + [the|a] + <name> + tool（单数）
const TOOL_REQUIRED_PATTERNS = [
  /\b(call|use|invoke|run|trigger)\s+(the\s+|a\s+)?[a-z0-9_-]+\s+tool\b/i,
  /(调用|使用)[\u4e00-\u9fff\w]{0,6}工具/, // 中文命令式：调用/使用 + <名> + 工具（\w 不含中文，需显式含中文字符类）
];

/**
 * tool_choice 是否强制工具调用（协议级结构化要求）。
 * - 'auto' / 'none'（或 {type:'auto'|'none'}）→ 不强制
 * - 'required' / 'any' / 具体函数对象 → 强制
 */
function isToolChoiceRequired(tc) {
  if (tc == null) return false;
  if (typeof tc === 'string') {
    const s = tc.toLowerCase();
    return s !== 'auto' && s !== 'none';
  }
  if (typeof tc === 'object') {
    const t = tc.type ? String(tc.type).toLowerCase() : '';
    if (t === 'auto' || t === 'none') return false;
    if (t === 'function' || t === 'tool' || t === 'any' || t === 'required') return true;
    return !!(tc.function || tc.name || tc.tool); // 无 type 但指定了具体工具
  }
  return false;
}

/**
 * 协议级结构化输出要求（Phase2-C）：
 * - OpenAI Chat：response_format.type = json_object | json_schema
 * - OpenAI Responses：text.format = json_object | json_schema | json；text.json_schema
 * - Anthropic：output_config（结构化输出配置）
 * 仅靠正文出现 "JSON" 等关键词不算协议级要求。
 */
function detectProtocolStructuredOutput(body) {
  if (!body || typeof body !== 'object') return false;
  const rf = body.response_format;
  if (rf && typeof rf === 'object') {
    const t = String(rf.type || '').toLowerCase();
    if (t === 'json_object' || t === 'json_schema') return true;
    if (rf.json_schema && typeof rf.json_schema === 'object') return true;
  }
  const txt = body.text;
  if (txt && typeof txt === 'object') {
    const f = txt.format ? String(txt.format).toLowerCase() : '';
    if (f === 'json_object' || f === 'json_schema' || f === 'json') return true;
    if (txt.json_schema && typeof txt.json_schema === 'object') return true;
  }
  if (body.output_config && typeof body.output_config === 'object') return true;
  return false;
}

const STRUCTURED_OUTPUT_HINTS = [
  'output as json', 'return json', 'structured output',
  'output a list', 'schema', 'output json array', 'result as json',
  '返回json', '结构化输出',
];

const VISION_HINTS = [
  'image_url', 'type: "image"', 'input_image', 'attachment',
  'describe this image', 'describe the image', 'describe this picture', 'describe the picture',
  '图片', '图像', '照片',
];

// 调试相关上下文信号（"error", "exception", "trace" 出现时提升 debugging/reasoning）
function countHits(text, hints) {
  let n = 0;
  for (const h of hints) {
    let idx = 0;
    while ((idx = text.indexOf(h, idx)) !== -1) { n++; idx += h.length; }
  }
  return n;
}

// ----------------------------------------------------------------------------
// 任务能力需求模板（13 种任务 + 兜底）
// ----------------------------------------------------------------------------

const TASK_REQUIREMENTS = {
  [TaskType.GENERAL_CHAT]: { chat: 1.0 },
  [TaskType.CODING]: { chat: 1.0, coding: 1.0 },
  [TaskType.DEBUGGING]: { chat: 1.0, coding: 1.0, reasoning: 0.85 },
  [TaskType.ARCHITECTURE]: { chat: 1.0, coding: 0.8, reasoning: 0.8 },
  [TaskType.ANALYSIS]: { chat: 1.0, reasoning: 0.85 },
  [TaskType.RESEARCH]: { chat: 1.0, reasoning: 0.8 },
  [TaskType.WRITING]: { chat: 1.0 },
  [TaskType.SUMMARIZATION]: { chat: 1.0, reasoning: 0.3 },
  [TaskType.TRANSLATION]: { chat: 1.0 },
  [TaskType.EXTRACTION]: { chat: 1.0, structured_output: 0.3 },
  [TaskType.TOOL_ORCHESTRATION]: { chat: 1.0, tool_use: 1.0 },
  [TaskType.VISION]: { chat: 1.0, vision: 1.0 },
  [TaskType.STRUCTURED_OUTPUT]: { chat: 1.0, structured_output: 1.0 },
  [TaskType.OTHER]: { chat: 1.0 },
};

/**
 * 由任务类型生成能力需求画像（0-1）。
 * 叠加规则：
 *   - stream=true → streaming=1.0（硬性）
 *   - 长上下文 → long_context=1.0
 *   - 工具调用 → tool_use=1.0
 *   - 视觉内容 → vision=1.0
 *   - 结构化输出提示 → structured_output 提高
 *   - 调试/复杂推理 → reasoning 提高
 */
export function buildRequiredCapabilities(taskType, signals = {}) {
  const req = emptyRequiredCapabilities();
  const base = TASK_REQUIREMENTS[taskType] || TASK_REQUIREMENTS[TaskType.OTHER];
  for (const k of Object.keys(base)) req[k] = Math.max(req[k], base[k]);

  if (signals.stream) req.streaming = 1.0; // streaming 硬性要求
  if (signals.longContext) req.long_context = 1.0;
  if (signals.toolUse) req.tool_use = 1.0;
  if (signals.vision) req.vision = 1.0;
  if (signals.structuredOutputRequired) req.structured_output = 1.0; // 协议级强制（硬）
  else if (signals.structuredOutput) req.structured_output = Math.max(req.structured_output, 0.8);
  if (signals.highReasoning) req.reasoning = Math.max(req.reasoning, 0.8);
  return req;
}

// ----------------------------------------------------------------------------
// 主分析函数
// ----------------------------------------------------------------------------

/**
 * 分析请求，输出任务画像（Phase2-B 版）。
 *
 * @param {object} body 协议请求体（chat / anthropic / responses 兼容）
 * @param {object} [options] { protocol }
 * @returns {{
 *   taskType: string,
 *   requiredCapabilities: object,
 *   hardCapabilities: string[],   // 需求=1.0 的硬能力（缺失即 blocked）
 *   complexity: number,
 *   estimatedInputTokens: number,
 *   needsToolUse: boolean,
 *   needsVision: boolean,
 *   needsStreaming: boolean,
 *   needsStructuredOutput: boolean,
 *   needsLongContext: boolean,
 *   codeRelated: boolean,
 *   hasLongContext: boolean,
 *   messageCount: number,
 *   signals: string[],
 *   model: string|null,
 *   protocol: string|null
 * }}
 */
export function analyzeTask(body, options = {}) {
  const protocol = options.protocol || null;
  const messages = collectMessages(body);
  const userMsgs = messages.filter((m) => m.role === 'user');
  const allText = messages.map((m) => extractTextFromContent(m.content)).join('\n');
  const lastUser = userMsgs.length > 0
    ? extractTextFromContent(userMsgs[userMsgs.length - 1].content)
    : '';
  const low = lower(allText);
  const signals = [];

  // 能力需求信号
  const needsStreaming = body?.stream === true || body?.stream === 'true';
  if (needsStreaming) signals.push('streaming');

  // Phase2-C：区分「工具可用」与「工具必需」
  //   - toolsAvailable：请求体携带 tools（仅表明可用）
  //   - toolsRequired：tool_choice 强制 / 协议字段要求 / 用户显式要求工具（高置信度）
  const toolsAvailable = Array.isArray(body?.tools) && body.tools.length > 0;
  const toolChoice = body?.tool_choice;
  const toolChoiceRequired = isToolChoiceRequired(toolChoice);
  const explicitToolRequest =
    TOOL_REQUIRED_HINTS.some((h) => low.includes(h)) ||
    TOOL_REQUIRED_PATTERNS.some((re) => re.test(low));
  const toolsRequired = toolChoiceRequired || explicitToolRequest;
  if (toolsAvailable) signals.push('tools_available');
  if (toolsRequired) signals.push('tool_use');
  const needsToolUse = toolsRequired;

  const needsVision =
    messages.some((m) => {
      const c = m.content;
      if (Array.isArray(c)) {
        return c.some((b) => b && (b.type === 'image_url' || b.type === 'image' || b.type === 'input_image'));
      }
      return false;
    }) || VISION_HINTS.some((h) => low.includes(h));
  if (needsVision) signals.push('vision');

  const structuredOutputRequired = detectProtocolStructuredOutput(body);
  const needsStructuredOutput =
    structuredOutputRequired || STRUCTURED_OUTPUT_HINTS.some((h) => low.includes(h));
  if (structuredOutputRequired) signals.push('structured_output_required');
  if (needsStructuredOutput && !structuredOutputRequired) signals.push('structured_output');

  const codeRelated = CODING_HINTS.some((h) => low.includes(h));
  if (codeRelated) signals.push('coding');

  const debugRelated = DEBUG_HINTS.some((h) => low.includes(h));
  const archRelated = ARCHITECTURE_HINTS.some((h) => low.includes(h));
  const researchRelated = RESEARCH_HINTS.some((h) => low.includes(h));
  const writingRelated = WRITING_HINTS.some((h) => low.includes(h));
  const summRelated = SUMMARIZATION_HINTS.some((h) => low.includes(h));
  const transRelated = TRANSLATION_HINTS.some((h) => low.includes(h));
  const extractRelated = EXTRACTION_HINTS.some((h) => low.includes(h));
  const reasonRelated = REASONING_HINTS.some((h) => low.includes(h)) || ANALYSIS_HINTS.some((h) => low.includes(h));

  // 任务类型判定（优先级：vision > tool > structured > debug > arch > coding > research > analysis > writing > summ > trans > extract > chat）
  let taskType = TaskType.GENERAL_CHAT;
  if (needsVision) taskType = TaskType.VISION;
  else if (needsToolUse) taskType = TaskType.TOOL_ORCHESTRATION;
  else if (structuredOutputRequired || (needsStructuredOutput && !codeRelated && !summRelated && !transRelated && !extractRelated)) {
    taskType = TaskType.STRUCTURED_OUTPUT;
  } else if (debugRelated && codeRelated) taskType = TaskType.DEBUGGING;
  else if (archRelated) taskType = TaskType.ARCHITECTURE;
  else if (codeRelated) taskType = TaskType.CODING;
  else if (researchRelated) taskType = TaskType.RESEARCH;
  else if (reasonRelated && !summRelated && !transRelated && !extractRelated) taskType = TaskType.ANALYSIS;
  else if (writingRelated) taskType = TaskType.WRITING;
  else if (summRelated) taskType = TaskType.SUMMARIZATION;
  else if (transRelated) taskType = TaskType.TRANSLATION;
  else if (extractRelated) taskType = TaskType.EXTRACTION;

  // 上下文规模（Phase2-C：确定性保守协议感知估算器，取代 charLen/3.5）
  const tokenEstimate = estimateTokens(body, { protocol });
  const estimatedInputTokens = tokenEstimate.input;
  const estimatedOutputTokens = tokenEstimate.output;
  const estimatedTotalTokens = tokenEstimate.total;
  const hasLongContext = estimatedInputTokens > 6000 || messages.length > 12;

  // 复杂度（0-1）
  const typeWeight = {
    [TaskType.VISION]: 0.9,
    [TaskType.TOOL_ORCHESTRATION]: 0.8,
    [TaskType.DEBUGGING]: 0.85,
    [TaskType.ARCHITECTURE]: 0.8,
    [TaskType.CODING]: 0.7,
    [TaskType.ANALYSIS]: 0.7,
    [TaskType.RESEARCH]: 0.6,
    [TaskType.WRITING]: 0.5,
    [TaskType.STRUCTURED_OUTPUT]: 0.6,
    [TaskType.SUMMARIZATION]: 0.4,
    [TaskType.TRANSLATION]: 0.4,
    [TaskType.EXTRACTION]: 0.4,
    [TaskType.GENERAL_CHAT]: 0.3,
    [TaskType.OTHER]: 0.3,
  }[taskType];
  const sizeFactor = Math.min(1, estimatedInputTokens / 20000);
  const turnsFactor = Math.min(1, (messages.length - 1) / 20);
  const complexity = Math.min(1, typeWeight * 0.6 + sizeFactor * 0.25 + turnsFactor * 0.15);

  // 统一能力需求画像
  const requiredCapabilities = buildRequiredCapabilities(taskType, {
    stream: needsStreaming,
    longContext: hasLongContext,
    toolUse: needsToolUse,
    vision: needsVision,
    structuredOutput: needsStructuredOutput && !structuredOutputRequired,
    structuredOutputRequired,
    highReasoning: debugRelated || reasonRelated,
  });
  const hardCapabilities = HARD_CAPABILITY_KEYS.filter((k) => requiredCapabilities[k] >= 1.0);

  return {
    taskType,
    requiredCapabilities,
    hardCapabilities,
    complexity: Number(complexity.toFixed(3)),
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens,
    needsToolUse,
    toolsAvailable,
    toolsRequired,
    toolChoice,
    needsVision,
    needsStreaming,
    needsStructuredOutput,
    structuredOutputRequired,
    needsLongContext: hasLongContext,
    codeRelated,
    hasLongContext,
    messageCount: messages.length,
    lastUserText: lastUser.slice(0, 200),
    signals,
    model: body?.model || null,
    protocol,
  };
}

export default {
  TaskType,
  CapabilityKey,
  CAPABILITY_KEYS,
  HARD_CAPABILITY_KEYS,
  SOFT_CAPABILITY_KEYS,
  emptyRequiredCapabilities,
  buildRequiredCapabilities,
  analyzeTask,
};
