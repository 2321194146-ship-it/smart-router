// src/agent/identity.js
// Smart Router Mainline - Phase 1
// Agent 识别模块：从请求头/路径解析调用方身份，绑定模型池与预算配置。
//
// 识别规则（参考 7878 resolveAgentKey）：
//   1. Claude Code : UA 含 claude-cli/* 或 Claude* ；路径含 /v1/messages
//   2. Codex       : UA 含 codex* ；或路径含 /v1/responses
//   3. OpenAI SDK  : UA 含 OpenAI/*
//   4. 通用客户端 : 兜底
//
// 仅使用 Node.js 内置模块，无第三方依赖。

// ----------------------------------------------------------------------------
// Agent 类型枚举
// ----------------------------------------------------------------------------

export const AgentType = {
  CLAUDE_CODE: 'claude-code',
  CODEX: 'codex',
  OPENAI_SDK: 'openai-sdk',
  GENERIC: 'generic',
};

// 默认 Agent 身份（未识别时的兜底）
const DEFAULT_AGENT = {
  agentId: 'generic',
  agentType: AgentType.GENERIC,
  isClaudeCode: false,
  isCodex: false,
  isOpenAISdk: false,
  isGeneric: true,
  rawUserAgent: '',
  path: null,
  source: 'default',
};

// ----------------------------------------------------------------------------
// 工具
// ----------------------------------------------------------------------------

function lowerHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[String(k).toLowerCase()] = v;
  }
  return out;
}

function pickPath(input) {
  // 兼容：直接传字符串路径，或传 { url } / { path }
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    if (typeof input.path === 'string') return input.path;
    if (typeof input.url === 'string') {
      try {
        return new URL(input.url, 'http://localhost').pathname;
      } catch {
        return input.url;
      }
    }
  }
  return '';
}

// ----------------------------------------------------------------------------
// Agent 识别主函数
// ----------------------------------------------------------------------------

/**
 * 从请求头与请求体解析调用方 Agent 身份。
 *
 * @param {object} headers HTTP 请求头（键名大小写不敏感）
 * @param {object|string} [body] 请求体（用于辅助判断，如 model 字段、system 字段）
 * @param {object} [options]
 * @param {string} [options.path] 请求路径（如 /v1/responses）
 * @returns {{
 *   agentId: string,
 *   agentType: string,
 *   isClaudeCode: boolean,
 *   isCodex: boolean,
 *   isOpenAISdk: boolean,
 *   isGeneric: boolean,
 *   rawUserAgent: string,
 *   path: string|null,
 *   source: string
 * }}
 */
export function resolveAgent(headers, body, options = {}) {
  const h = lowerHeaders(headers || {});
  const ua = String(h['user-agent'] || '');
  const path = options.path ? String(options.path) : '';

  // 1. Claude Code
  //    - UA: claude-cli/<ver> 或 Claude Code/* 或以 Claude 开头
  //    - 路径: /v1/messages
  if (
    /^claude-cli\//i.test(ua) ||
    /^claude[- ]code\//i.test(ua) ||
    /^claude/i.test(ua) ||
    /\/v1\/messages(\/|$|\?)/i.test(path)
  ) {
    return {
      ...DEFAULT_AGENT,
      agentId: AgentType.CLAUDE_CODE,
      agentType: AgentType.CLAUDE_CODE,
      isClaudeCode: true,
      isCodex: false,
      isOpenAISdk: false,
      isGeneric: false,
      rawUserAgent: ua,
      path: path || null,
      source: 'user-agent',
    };
  }

  // 2. Codex
  //    - UA: codex* （codex-cli / codex/<ver> / Codex CLI 等）
  //    - 路径: /v1/responses
  if (
    /^codex/i.test(ua) ||
    /\bcodex\b/i.test(ua) ||
    /\/v1\/responses(\/|$|\?)/i.test(path)
  ) {
    return {
      ...DEFAULT_AGENT,
      agentId: AgentType.CODEX,
      agentType: AgentType.CODEX,
      isClaudeCode: false,
      isCodex: true,
      isOpenAISdk: false,
      isGeneric: false,
      rawUserAgent: ua,
      path: path || null,
      source: 'user-agent',
    };
  }

  // 3. OpenAI SDK
  //    - UA: OpenAI/<ver> 或 OpenAI-Node / OpenAI-Python 等
  if (/^openai(\/|-|\s|$)/i.test(ua) || /\bopenai[- ](?:node|python|go|java)\b/i.test(ua)) {
    return {
      ...DEFAULT_AGENT,
      agentId: AgentType.OPENAI_SDK,
      agentType: AgentType.OPENAI_SDK,
      isClaudeCode: false,
      isCodex: false,
      isOpenAISdk: true,
      isGeneric: false,
      rawUserAgent: ua,
      path: path || null,
      source: 'user-agent',
    };
  }

  // 4. 兜底：通用客户端
  return {
    ...DEFAULT_AGENT,
    rawUserAgent: ua,
    path: path || null,
    source: ua ? 'user-agent' : 'default',
  };
}

/**
 * 仅依据 agentId 判断是否为 Claude Code。
 */
export function isClaudeCode(agentId) {
  return agentId === AgentType.CLAUDE_CODE;
}

/**
 * 仅依据 agentId 判断是否为 Codex。
 */
export function isCodex(agentId) {
  return agentId === AgentType.CODEX;
}

// ----------------------------------------------------------------------------
// Agent 模型池绑定
// ----------------------------------------------------------------------------

/**
 * 获取 Agent 绑定的模型池。
 *
 * @param {string} agentId Agent 标识（如 'claude-code'）
 * @param {object} config 已加载的配置
 * @returns {string[]|null} 模型 id 数组；空池返回 null（表示不限制，使用全局模型池）
 */
export function getAgentModels(agentId, config) {
  if (!config || !config.agent_bindings) return null;
  const binding = config.agent_bindings[agentId];
  if (!binding) return null; // 未绑定 → 不限制

  // 显式空数组表示「空池」语义：返回 null（不限制）
  if (Array.isArray(binding.model_ids)) {
    if (binding.model_ids.length === 0) return null;
    return [...binding.model_ids];
  }
  // model_ids 缺失 → 不限制
  return null;
}

/**
 * Agent 是否绑定了模型池（即配置中存在该 agent 且 model_ids 非空）。
 */
export function hasAgentModelPool(agentId, config) {
  const models = getAgentModels(agentId, config);
  return Array.isArray(models) && models.length > 0;
}

// ----------------------------------------------------------------------------
// Agent 预算配置
// ----------------------------------------------------------------------------

/**
 * 默认全局预算字段（与 config.budget 结构一致）。
 */
const DEFAULT_BUDGET = Object.freeze({
  allowPaid: true,
  maxRequestCost: Infinity,
  allowedModels: [], // 空 = 不限制
  allowedProviders: [], // 空 = 不限制
  strictModel: false,
});

/**
 * 获取 Agent 的预算配置：合并「全局 budget 默认值」与「agent 级 budget 覆盖」。
 * agent 级未定义的字段回退到全局；全局未定义的字段回退到内置默认值。
 *
 * 合并语义（字段级覆盖，非整体替换）：
 *   - allowPaid: agent 显式 > global > default(true)
 *   - maxRequestCost: agent 显式 > global > default(Infinity)
 *   - allowedModels/allowedProviders: agent 显式 > global > default([])
 *     （空数组视为「不限制」；非空数组取并集还是覆盖？此处采用覆盖语义：
 *       agent 显式非空数组直接覆盖 global；agent 显式空数组则回退 global；
 *       这样 agent 可通过 [] 表示「沿用全局」。）
 *   - strictModel: agent 显式 > global > default(false)
 *
 * @param {string} agentId
 * @param {object} config
 * @returns {object} 合并后的 budget（allowPaid, maxRequestCost, allowedModels,
 *                   allowedProviders, strictModel）
 */
export function getAgentBudget(agentId, config) {
  const globalBudget = (config && config.budget) || {};
  const agentBinding =
    config && config.agent_bindings ? config.agent_bindings[agentId] : null;
  const agentBudget = agentBinding ? agentBinding.budget : null;

  // allowPaid
  const allowPaid =
    agentBudget && typeof agentBudget.allowPaid === 'boolean'
      ? agentBudget.allowPaid
      : typeof globalBudget.allowPaid === 'boolean'
        ? globalBudget.allowPaid
        : DEFAULT_BUDGET.allowPaid;

  // maxRequestCost
  const maxRequestCost =
    agentBudget && typeof agentBudget.maxRequestCost === 'number'
      ? agentBudget.maxRequestCost
      : typeof globalBudget.maxRequestCost === 'number'
        ? globalBudget.maxRequestCost
        : DEFAULT_BUDGET.maxRequestCost;

  // allowedModels: agent 非空数组覆盖；agent 空数组/缺失回退 global；global 缺失回退默认
  let allowedModels;
  if (Array.isArray(agentBudget?.allowedModels) && agentBudget.allowedModels.length > 0) {
    allowedModels = [...agentBudget.allowedModels];
  } else if (Array.isArray(globalBudget.allowedModels)) {
    allowedModels = [...globalBudget.allowedModels];
  } else {
    allowedModels = [...DEFAULT_BUDGET.allowedModels];
  }

  // allowedProviders: 同上
  let allowedProviders;
  if (Array.isArray(agentBudget?.allowedProviders) && agentBudget.allowedProviders.length > 0) {
    allowedProviders = [...agentBudget.allowedProviders];
  } else if (Array.isArray(globalBudget.allowedProviders)) {
    allowedProviders = [...globalBudget.allowedProviders];
  } else {
    allowedProviders = [...DEFAULT_BUDGET.allowedProviders];
  }

  // strictModel
  const strictModel =
    agentBudget && typeof agentBudget.strictModel === 'boolean'
      ? agentBudget.strictModel
      : typeof globalBudget.strictModel === 'boolean'
        ? globalBudget.strictModel
        : DEFAULT_BUDGET.strictModel;

  return {
    allowPaid,
    maxRequestCost,
    allowedModels,
    allowedProviders,
    strictModel,
  };
}

/**
 * 检查给定模型是否在 Agent 的预算允许列表内。
 * - allowedModels 为空数组 → 不限制（允许）
 * - 非空 → 模型 id 必须在列表内
 * - strictModel=false 时，若不在列表内则回退到「不限制」语义（仅告警）
 *
 * @param {string} modelId
 * @param {string} agentId
 * @param {object} config
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function isModelAllowedForAgent(modelId, agentId, config) {
  const budget = getAgentBudget(agentId, config);
  if (!Array.isArray(budget.allowedModels) || budget.allowedModels.length === 0) {
    return { allowed: true, reason: null };
  }
  if (budget.allowedModels.includes(modelId)) {
    return { allowed: true, reason: null };
  }
  // strictModel=false → 允许但提示
  if (!budget.strictModel) {
    return {
      allowed: true,
      reason: `model "${modelId}" not in allowedModels but strictModel=false`,
    };
  }
  return {
    allowed: false,
    reason: `model "${modelId}" not in allowedModels (strictModel=true)`,
  };
}

/**
 * 检查 provider 是否在 Agent 的预算允许列表内。
 */
export function isProviderAllowedForAgent(providerName, agentId, config) {
  const budget = getAgentBudget(agentId, config);
  if (!Array.isArray(budget.allowedProviders) || budget.allowedProviders.length === 0) {
    return { allowed: true, reason: null };
  }
  if (budget.allowedProviders.includes(providerName)) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason: `provider "${providerName}" not in allowedProviders`,
  };
}

/**
 * 检查付费模型是否被 Agent 预算允许。
 */
export function isPaidAllowedForAgent(agentId, config) {
  const budget = getAgentBudget(agentId, config);
  return { allowed: budget.allowPaid, reason: budget.allowPaid ? null : 'allowPaid=false' };
}

export default {
  AgentType,
  resolveAgent,
  isClaudeCode,
  isCodex,
  getAgentModels,
  hasAgentModelPool,
  getAgentBudget,
  isModelAllowedForAgent,
  isProviderAllowedForAgent,
  isPaidAllowedForAgent,
};
