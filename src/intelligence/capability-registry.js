// src/intelligence/capability-registry.js
// Smart Router Mainline - Phase 2-B (Active Readiness)
// Capability Registry：模型能力注册与查询（以 modelId + provider 为统一身份）。
//
// Phase2-B 扩展：
//   - 标准化 Model Capability Profile：
//     { modelId, provider, capabilities: {chat,coding,reasoning,tool_use,vision,
//       structured_output,long_context,streaming}(0-1), contextWindow, price, tier,
//       paid, reliability, latencyPriorMs, protocols }
//   - 兼容旧配置字符串能力数组（chat/tool_use/vision/streaming → 1.0，其余按配置）
//   - 管理员可用 0-1 或 0-100 能力分，内部统一规范化为 0-1
//   - 同一个 modelId 不同 Provider 保留独立画像
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { CAPABILITY_KEYS } from './task-analyzer.js';

export const Capability = Object.freeze({
  CHAT: 'chat',
  TOOL_USE: 'tool_use',
  VISION: 'vision',
  STREAMING: 'streaming',
  REASONING: 'reasoning',
});

// 二元能力统一判定阈值（与 policy.binaryThreshold 默认一致：0.9）
// vision=95（0.95）视为支持；vision=60（0.6）视为不支持。
export const BINARY_CAPABILITY_THRESHOLD = 0.9;

/** 旧字符串能力数组 → 能力对象（字符串=1.0） */
const LEGACY_STRING_CAPS = new Set(['chat', 'coding', 'reasoning', 'tool_use', 'vision', 'structured_output', 'long_context', 'streaming']);

/**
 * 规范化能力值：0-1 或 0-100 → 0-1。
 */
export function normalizeCapabilityScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1 && n <= 1) return 1;
  if (n > 1) return Math.min(1, n / 100); // 0-100 分制
  return Math.min(1, Math.max(0, n)); // 0-1 分制
}

/**
 * 从模型配置条目提取规范化能力对象。
 * 兼容：capability 数组（字符串）或 capabilities 对象（0-1/0-100）。
 */
export function extractCapabilities(model) {
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = 0;

  const obj = model?.capabilities && typeof model.capabilities === 'object'
    ? model.capabilities
    : null;
  if (obj) {
    for (const k of CAPABILITY_KEYS) {
      if (obj[k] !== undefined) out[k] = normalizeCapabilityScore(obj[k]);
    }
  }
  if (Array.isArray(model?.capability)) {
    for (const c of model.capability) {
      const key = String(c).toLowerCase();
      if (LEGACY_STRING_CAPS.has(key)) out[key] = Math.max(out[key], 1.0);
    }
  }
  // 默认 chat：未声明能力数组/对象时视为仅 chat
  const declared = (Array.isArray(model?.capability) && model.capability.length > 0) || !!obj;
  if (!declared) out.chat = 1.0;
  return out;
}

/**
 * 布尔支持视图：能力分 >= threshold 视为支持（二元能力判定用，默认 0.9）。
 * 例如 vision=95（0.95）→ true，不得误作"不支持视觉"。
 */
export function buildSupportsView(capabilities, threshold = 0.9) {
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = (capabilities[k] || 0) >= threshold;
  return out;
}

/**
 * 0-100 等级分视图（展示/报告用）。
 */
export function buildScoresView(capabilities) {
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = Math.round((capabilities[k] || 0) * 100);
  return out;
}

export function hasCapability(model, capability) {
  if (!capability) return true;
  const caps = extractCapabilities(model);
  return (caps[capability] || 0) >= BINARY_CAPABILITY_THRESHOLD;
}

export function isEnabled(model) {
  return !!model && typeof model.id === 'string' && model.id.length > 0 && model.enabled !== false;
}

/**
 * 推导模型支持的协议（native 或 adapter 兼容）。
 */
export function deriveProtocols(model) {
  const caps = extractCapabilities(model);
  const provider = model?.provider || '';
  const protocols = [];
  if (caps.chat >= 1.0) {
    protocols.push('chat', 'responses', 'anthropic');
  } else if (provider === 'gateway') {
    protocols.push('responses', 'anthropic');
  }
  return protocols;
}

export class CapabilityRegistry {
  constructor(config) {
    this.models = Array.isArray(config?.models) ? config.models : [];
    this._byId = new Map();
    this._byIdProvider = new Map();
    for (const m of this.models) {
      if (!m || typeof m.id !== 'string' || !m.id) continue;
      if (!this._byId.has(m.id)) this._byId.set(m.id, []);
      this._byId.get(m.id).push(m);
      if (m.provider) {
        this._byIdProvider.set(`${m.id}::${m.provider}`, m);
      }
    }
  }

  getByModelId(modelId) {
    if (!modelId) return [];
    return this._byId.get(modelId) || [];
  }

  getByModelAndProvider(modelId, provider) {
    if (!modelId) return null;
    if (provider) {
      const hit = this._byIdProvider.get(`${modelId}::${provider}`);
      if (hit) return hit;
    }
    const entries = this.getByModelId(modelId);
    if (entries.length === 1) return entries[0];
    if (entries.length > 1) return entries[0];
    return null;
  }

  getEnabledModels() {
    return this.models.filter(isEnabled);
  }

  supports(modelId, provider, capability) {
    if (!capability) return true;
    const profile = this.getProfile(modelId, provider);
    return profile ? (profile.capabilities[capability] || 0) >= 1.0 : false;
  }

  /**
   * 标准化 Model Capability Profile（Decision Engine 唯一数据源）。
   * @param {string} modelId
   * @param {string} provider
   * @returns {object|null} {
   *   modelId, provider, capabilities, contextWindow, price, tier, paid,
   *   reliability, latencyPriorMs, protocols, enabled
   * }
   */
  getProfile(modelId, provider) {
    const entry = this.getByModelAndProvider(modelId, provider);
    if (!entry) return null;
    const capabilities = extractCapabilities(entry);
    const contextWindow =
      typeof entry.context_window === 'number' && entry.context_window > 0
        ? entry.context_window
        : (typeof entry.max_tokens === 'number' && entry.max_tokens > 0 ? entry.max_tokens : 0);
    return {
      modelId: entry.id,
      provider: entry.provider,
      capabilities,
      supports: buildSupportsView(capabilities),
      scores: buildScoresView(capabilities),
      contextWindow,
      price: entry.price && typeof entry.price === 'object' ? { ...entry.price } : null,
      tier: entry.tier || 'tier3',
      paid: !!entry.paid,
      reliability: normalizeCapabilityScore(entry.reliability ?? 0),
      latencyPriorMs:
        typeof entry.latency_prior_ms === 'number' && entry.latency_prior_ms > 0
          ? entry.latency_prior_ms
          : (typeof entry.latencyPriorMs === 'number' && entry.latencyPriorMs > 0
            ? entry.latencyPriorMs
            : 0),
      protocols: deriveProtocols(entry),
      enabled: isEnabled(entry),
    };
  }

  summarize(modelId) {
    const entries = this.getByModelId(modelId);
    if (entries.length === 0) return null;
    const caps = new Set();
    const tiers = new Set();
    const providers = new Set();
    let maxTokens = null;
    let paid = false;
    for (const m of entries) {
      const cc = extractCapabilities(m);
      for (const k of CAPABILITY_KEYS) if (cc[k] >= 1.0) caps.add(k);
      if (m.tier !== undefined) tiers.add(m.tier);
      if (m.provider) providers.add(m.provider);
      if (typeof m.max_tokens === 'number') maxTokens = Math.max(maxTokens || 0, m.max_tokens);
      if (m.paid) paid = true;
    }
    return { modelId, capabilities: [...caps], tiers: [...tiers], providers: [...providers], maxTokens, paid, enabled: entries.some(isEnabled) };
  }
}

export default {
  Capability,
  CapabilityRegistry,
  hasCapability,
  isEnabled,
  deriveProtocols,
  extractCapabilities,
  normalizeCapabilityScore,
  buildSupportsView,
  buildScoresView,
  BINARY_CAPABILITY_THRESHOLD,
};
