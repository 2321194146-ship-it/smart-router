// src/intelligence/capability-registry.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Capability Registry：模型能力注册与查询（以 modelId + provider 为统一身份）。
//
// Shadow 版只读；从 config.models 构建索引。查询能力：capability / tier / provider /
// contextWindow / price / paid / protocols / enabled。
//
// 统一候选身份：modelId + provider（同一模型在不同 Provider 可能有不同价格、
// 上下文、协议、稳定性、能力，必须分开处理）。
//
// 仅使用 Node.js 内置模块，无第三方依赖。

export const Capability = Object.freeze({
  CHAT: 'chat',
  TOOL_USE: 'tool_use',
  VISION: 'vision',
  STREAMING: 'streaming',
  REASONING: 'reasoning',
});

export function hasCapability(model, capability) {
  if (!capability) return true;
  if (!model || !Array.isArray(model.capability)) return false;
  return model.capability.some(
    (c) => String(c).toLowerCase() === String(capability).toLowerCase(),
  );
}

export function isEnabled(model) {
  return !!model && typeof model.id === 'string' && model.id.length > 0 && model.enabled !== false;
}

/**
 * 推导模型支持的协议（无显式 protocols 字段时）。
 * 规则（native 或 adapter 兼容）：
 *   - chat 能力（或未声明能力）→ 经协议适配层可服务全部三协议
 *     （responses / anthropic 协议处理器内部转换为 chat 兼容执行，属于 adapter 兼容）
 *   - provider 为 gateway → 原生支持 responses / anthropic（无需适配）
 * 无法适配的模型（无 chat 能力且无 gateway）→ 协议阻塞由硬约束负责。
 */
export function deriveProtocols(model) {
  const caps = Array.isArray(model?.capability) ? model.capability.map(String) : [];
  const provider = model?.provider || '';
  const protocols = [];
  if (caps.includes('chat') || caps.length === 0) {
    // adapter 兼容：chat 能力（或未声明能力，默认 chat）经转换服务三协议
    protocols.push('chat', 'responses', 'anthropic');
  } else if (provider === 'gateway') {
    protocols.push('responses', 'anthropic');
  }
  return protocols;
}

export class CapabilityRegistry {
  constructor(config) {
    this.models = Array.isArray(config?.models) ? config.models : [];
    this._byId = new Map(); // modelId -> [entry]
    this._byIdProvider = new Map(); // "modelId::provider" -> entry
    for (const m of this.models) {
      if (!m || typeof m.id !== 'string' || !m.id) continue;
      if (!this._byId.has(m.id)) this._byId.set(m.id, []);
      this._byId.get(m.id).push(m);
      if (m.provider) {
        this._byIdProvider.set(`${m.id}::${m.provider}`, m);
      }
    }
  }

  /**
   * 按 modelId 查询（同 id 多 provider）。
   */
  getByModelId(modelId) {
    if (!modelId) return [];
    return this._byId.get(modelId) || [];
  }

  /**
   * 按 modelId + provider 查询标准化条目（统一候选身份）。
   * @returns {object|null} 配置条目（含 id / provider / tier / paid / capability /
   *                        context_window / max_tokens / price / protocols / enabled）
   */
  getByModelAndProvider(modelId, provider) {
    if (!modelId) return null;
    if (provider) {
      const hit = this._byIdProvider.get(`${modelId}::${provider}`);
      if (hit) return hit;
    }
    const entries = this.getByModelId(modelId);
    if (entries.length === 1) return entries[0];
    if (entries.length > 1) {
      // 多 provider 且未指定 provider：按配置顺序返回第一个（调用方应显式指定 provider）
      return entries[0];
    }
    return null;
  }

  getEnabledModels() {
    return this.models.filter(isEnabled);
  }

  supports(modelId, provider, capability) {
    if (!capability) return true;
    const entry = this.getByModelAndProvider(modelId, provider);
    return entry ? hasCapability(entry, capability) : false;
  }

  /**
   * 标准化候选画像（Decision Engine 使用）。
   * @param {string} modelId
   * @param {string} provider
   * @returns {object|null} {
   *   modelId, provider, tier, paid, capabilities, contextWindow, price, protocols, enabled
   * }
   */
  getProfile(modelId, provider) {
    const entry = this.getByModelAndProvider(modelId, provider);
    if (!entry) return null;
    const capabilities = Array.isArray(entry.capability) ? [...entry.capability] : [];
    const contextWindow =
      typeof entry.context_window === 'number' && entry.context_window > 0
        ? entry.context_window
        : (typeof entry.max_tokens === 'number' && entry.max_tokens > 0 ? entry.max_tokens : 0);
    return {
      modelId: entry.id,
      provider: entry.provider,
      tier: entry.tier || 'tier3',
      paid: !!entry.paid,
      capabilities,
      contextWindow,
      price: entry.price && typeof entry.price === 'object' ? { ...entry.price } : null,
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
      if (Array.isArray(m.capability)) m.capability.forEach((c) => caps.add(String(c)));
      if (m.tier !== undefined) tiers.add(m.tier);
      if (m.provider) providers.add(m.provider);
      if (typeof m.max_tokens === 'number') maxTokens = Math.max(maxTokens || 0, m.max_tokens);
      if (m.paid) paid = true;
    }
    return {
      modelId,
      capabilities: [...caps],
      tiers: [...tiers],
      providers: [...providers],
      maxTokens,
      paid,
      enabled: entries.some(isEnabled),
    };
  }

  match(task, opts = {}) {
    const allowedModels = opts.allowedModels || [];
    const allowedProviders = opts.allowedProviders || [];
    const results = [];
    for (const m of this.getEnabledModels()) {
      if (allowedModels.length > 0 && !allowedModels.includes(m.id)) continue;
      if (allowedProviders.length > 0 && !allowedProviders.includes(m.provider)) continue;
      if (m.paid && opts.allowPaid === false) continue;
      if (task?.needsToolUse && !hasCapability(m, Capability.TOOL_USE)) continue;
      if (task?.needsVision && !hasCapability(m, Capability.VISION)) continue;
      results.push({
        modelId: m.id,
        provider: m.provider,
        apiModel: m.apiModel || m.id,
        tier: m.tier || 'tier3',
        paid: !!m.paid,
        capability: Array.isArray(m.capability) ? [...m.capability] : [],
      });
    }
    const tierRank = { tier1: 0, tier2: 1, tier3: 2 };
    results.sort((a, b) => (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9));
    return results;
  }
}

export default { Capability, CapabilityRegistry, hasCapability, isEnabled, deriveProtocols };
