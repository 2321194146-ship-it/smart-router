// src/intelligence/task-analyzer.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Task Analyzer：分析请求消息，输出任务画像（类型、复杂度、上下文规模、工具需求等）。
//
// Shadow 约束：
//   - 纯本地计算，不发起任何上游调用
//   - 只读请求体，不修改消息内容（禁止用户消息改写）
//   - 输出机器可执行元数据（JSON），不附加任何 System Prompt
//
// 仅使用 Node.js 内置模块，无第三方依赖。

export const TaskType = {
  CODING: 'coding',
  CHAT: 'chat',
  ANALYSIS: 'analysis',
  EXTRACTION: 'extraction',
  TOOL_ORCHESTRATION: 'tool_orchestration',
  VISION: 'vision',
  OTHER: 'other',
};

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

const CODING_HINTS = [
  'function', 'class ', 'def ', 'import ', 'const ', 'let ', 'var ',
  'bug', 'debug', 'compile', 'syntax', 'refactor', 'code', 'api',
  'json', 'sql', 'regex', 'error', 'exception', 'implement', 'write a script',
  '代码', '函数', '调试', '编译', '修复', '报错',
];

const ANALYSIS_HINTS = [
  'calculate', 'compute', 'explain why', 'compare', 'summarize the', 'analyze',
  'reason', 'prove', 'solve', 'mathematical', 'logic',
  '计算', '解释', '比较', '分析', '推理', '证明', '解决',
];

const EXTRACTION_HINTS = [
  'extract', 'summarize', 'rewrite', 'translate', 'format',
  'shorten', 'paraphrase',
  '提取', '摘要', '改写', '翻译', '精简',
];

const TOOL_HINTS = [
  'use the tool', 'call the function', 'calculator', 'search', 'tool_calls',
  '使用工具', '调用函数', '计算器',
];

const IMAGE_HINTS = ['image_url', 'type: "image"', 'input_image', 'attachment', '图片', '图像'];

/**
 * 分析请求，输出任务画像。
 * @param {object} body 协议请求体（chat / anthropic / responses 兼容）
 * @param {object} [options] { protocol }
 * @returns {object} 任务画像
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
    }) || IMAGE_HINTS.some((h) => low.includes(h));
  if (needsVision) signals.push('vision');

  const codeRelated = CODING_HINTS.some((h) => low.includes(h));
  if (codeRelated) signals.push('coding');

  let taskType = TaskType.CHAT;
  if (needsVision) taskType = TaskType.VISION;
  else if (needsToolUse) taskType = TaskType.TOOL_ORCHESTRATION;
  else if (codeRelated) taskType = TaskType.CODING;
  else if (ANALYSIS_HINTS.some((h) => low.includes(h))) {
    taskType = TaskType.ANALYSIS;
    signals.push('analysis');
  } else if (EXTRACTION_HINTS.some((h) => low.includes(h))) {
    taskType = TaskType.EXTRACTION;
    signals.push('extraction');
  }

  const charLen = allText.length;
  const estimatedInputTokens = Math.ceil(charLen / 3.5);
  const hasLongContext = estimatedInputTokens > 6000 || messages.length > 12;

  const typeWeight = {
    [TaskType.VISION]: 0.9,
    [TaskType.TOOL_ORCHESTRATION]: 0.8,
    [TaskType.CODING]: 0.7,
    [TaskType.ANALYSIS]: 0.6,
    [TaskType.EXTRACTION]: 0.4,
    [TaskType.CHAT]: 0.3,
    [TaskType.OTHER]: 0.3,
  }[taskType];
  const sizeFactor = Math.min(1, estimatedInputTokens / 20000);
  const turnsFactor = Math.min(1, (messages.length - 1) / 20);
  const complexity = Math.min(1, typeWeight * 0.6 + sizeFactor * 0.25 + turnsFactor * 0.15);

  return {
    taskType,
    complexity: Number(complexity.toFixed(3)),
    estimatedInputTokens,
    needsToolUse,
    needsVision,
    codeRelated,
    hasLongContext,
    messageCount: messages.length,
    lastUserText: lastUser.slice(0, 200),
    signals,
    model: body?.model || null,
    protocol,
  };
}

export default { TaskType, analyzeTask };
