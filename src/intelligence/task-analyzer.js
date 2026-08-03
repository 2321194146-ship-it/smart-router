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
  'function', 'class ', 'def ', 'import ', 'const ', 'let ', 'var ',
  'bug', 'debug', 'compile', 'syntax', 'refactor', 'code', 'rest api',
  'sql', 'regex', 'error', 'exception', 'implement', 'write a script',
  '代码', '函数', '调试', '编译', '修复', '报错', 'write a function', 'write code',
];

const DEBUG_HINTS = [
  'debug', 'bug', 'traceback', 'stack trace', 'fix this error', 'why is this failing',
  'debugging', 'exception', 'crash', '报错', '异常', '崩溃', '为什么失败',
];

const ARCHITECTURE_HINTS = [
  'architecture', 'design a system', 'system design', 'microservice', 'module structure',
  'architecture review', '架构', '系统设计', '模块设计',
];

const REASONING_HINTS = [
  'prove', 'mathematical proof', 'logic puzzle', 'complex reasoning', 'deduce',
  'inference', 'explain why', 'compare and contrast', 'reason',
  '推理', '证明', '逻辑', '推导',
];

const ANALYSIS_HINTS = [
  'calculate', 'compute', 'compare', 'summarize the', 'analyze', 'reason',
  'prove', 'solve', 'mathematical', 'logic', 'explain why',
  '计算', '解释', '比较', '分析', '推理', '证明', '解决',
];

const RESEARCH_HINTS = [
  'research', 'investigate', 'literature', 'survey', 'study the',
  '研究', '调研', '文献',
];

const WRITING_HINTS = [
  'write an essay', 'write an article', 'write a blog', 'draft', 'compose',
  'write a report', 'write a story', 'write a short story', 'short story',
  '撰写', '写一篇', '起草', '作文',
];

const SUMMARIZATION_HINTS = [
  'summarize', 'summary', 'summarise', 'brief summary', 'tl;dr', 'recap',
  '摘要', '总结', '概括', '提炼',
];

const TRANSLATION_HINTS = [
  'translate', 'translation', 'translate to', 'translate from',
  '翻译', '译文',
];

const EXTRACTION_HINTS = [
  'extract', 'rewrite', 'format', 'shorten', 'paraphrase', 'extract all',
  '提取', '改写', '精简',
];

const TOOL_HINTS = [
  'use the tool', 'call the function', 'calculator', 'search tool', 'web search', 'search the web',
  'tool_calls', 'use a tool', 'call a tool',
  '使用工具', '调用函数', '计算器', '搜索工具',
];

const STRUCTURED_OUTPUT_HINTS = [
  'output as json', 'return json', 'json format', 'structured output',
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
  if (signals.structuredOutput) req.structured_output = Math.max(req.structured_output, 0.8);
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

  const needsToolUse =
    Array.isArray(body?.tools) && body.tools.length > 0
      ? true
      : TOOL_HINTS.some((h) => low.includes(h));
  if (needsToolUse) signals.push('tool_use');

  const needsVision =
    messages.some((m) => {
      const c = m.content;
      if (Array.isArray(c)) {
        return c.some((b) => b && (b.type === 'image_url' || b.type === 'image' || b.type === 'input_image'));
      }
      return false;
    }) || VISION_HINTS.some((h) => low.includes(h));
  if (needsVision) signals.push('vision');

  const needsStructuredOutput = STRUCTURED_OUTPUT_HINTS.some((h) => low.includes(h));
  if (needsStructuredOutput) signals.push('structured_output');

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
  else if (needsStructuredOutput && !codeRelated && !summRelated && !transRelated && !extractRelated) {
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

  // 上下文规模
  const charLen = allText.length;
  const estimatedInputTokens = Math.ceil(charLen / 3.5);
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
    structuredOutput: needsStructuredOutput,
    highReasoning: debugRelated || reasonRelated,
  });
  const hardCapabilities = CAPABILITY_KEYS.filter((k) => requiredCapabilities[k] >= 1.0);

  return {
    taskType,
    requiredCapabilities,
    hardCapabilities,
    complexity: Number(complexity.toFixed(3)),
    estimatedInputTokens,
    needsToolUse,
    needsVision,
    needsStreaming,
    needsStructuredOutput,
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
  emptyRequiredCapabilities,
  buildRequiredCapabilities,
  analyzeTask,
};
