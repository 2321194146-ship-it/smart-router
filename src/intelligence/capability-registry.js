// src/intelligence/capability-registry.js
// Smart Router Mainline - Phase 2-A (Shadow)
// Capability Registry：模型能力注册与查询。
//
// 从 config.models 构建能力索引（Shadow 版只读；不做在线更新、不修改生产配置）。
// 查询能力：capability（chat/tool_use/vision/streaming）、tier、provider、
// max_tokens、price、paid、enabled。
//
// 仅使用 Node.js 内置模块，无第三方依赖。

// ----------------------------------------------------------------------------
// 标准能力集
// ----------------------------------------------------------------------------

export const Capability = Object.freeze({
  CHAT: 'chat',
  TOOL_USE: 'tool_use',
  VISION: 'vision',
  STREAMING: 'streaming',
  REASONING: 'reasoning', // 推理能力（如 DeepSeek-R1 / reasoning 模型）
});

/**
 * 判断模型是否具备指定能力。
 */
export function hasCapability(model, capability) {
  if (!capability) return true;
  if (!model || !Array.isArray(model.capability)) return false;
  return model.capability.some(
    (c) => String(c).toLowerCase() === String(capability).toLowerCase(),
  );
}

/**
 * 判断模型是否可用（enabled 且非空 id）。
 */
export function isEnabled(model) {
  return !!model && typeof model.id === 'string' && model.id.length > 0 && model.enabled !== false;
}

// ----------------------------------------------------------------------------
// Registry
// ----------------------------------------------------------------------------

/**
 * 模型能力注册表（Shadow 版）。
 */
export class CapabilityRegistry {
  /**
   * @param {object} config 已加载配置（含 models 数组）
   */
  constructor(config) {
    this.models = Array.isArray(config?.models) ? config.models : [];
    this._byId = new Map();
    for (const m of this.models) {
      if (!m || typeof m.id !== 'string' || !m.id) continue;
      const entry = this._byId.get(m.id);
      if (!entry) this._byId.set(m.id, []);
      this._byId.get(m.id).push(m);
    }
  }

  /**
   * 按模型 id 查询（支持同 id 多 provider）。
   * @param {string} modelId
   * @returns {object[]} 匹配的模型条目
   */
  getByModelId(modelId) {
    if (!modelId) return [];
    return this._byId.get(modelId) || [];
  }

  /**
   * 查询所有已启用模型。
   * @returns {object[]}
   */
  getEnabledModels() {
    return this.models.filter(isEnabled);
  }

  /**
   * 模型是否支持某能力（任一匹配条目支持即 true）。
   */
  supports(modelId, capability) {
    if (!capability) return true;
    return this.getByModelId(modelId).some((m) => hasCapability(m, capability));
  }

  /**
   * 获取模型的能力摘要（合并同 id 多 provider 的能力）。
   * @param {string} modelId
   * @returns {{capabilities: string[], tiers: number[], providers: string[], maxTokens: number|null, paid: boolean}|null}
   */
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

  /**
   * 按任务需求筛选候选（仅本地计算，不改变生产候选顺序）。
   * @param {object} task 任务画像（task-analyzer 输出）
   * @param {object} [opts] { allowedModels, allowedProviders, allowPaid }
   * @returns {object[]} 排序后的模型摘要（分数降序）
   */
  match(task, opts = {}) {
    const allowedModels = opts.allowedModels || [];
    const allowedProviders = opts.allowedProviders || [];
    const results = [];
    for (const m of this.getEnabledModels()) {
      if (allowedModels.length > 0 && !allowedModels.includes(m.id)) continue;
      if (allowedProviders.length > 0 && !allowedProviders.includes(m.provider)) continue;
      if (m.paid && opts.allowPaid === false) continue;
      // 能力匹配
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
    // 按 tier 排序（tier1 > tier2 > tier3）
    const tierRank = { tier1: 0, tier2: 1, tier3: 2 };
    results.sort((a, b) => (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9));
    return results;
  }
}

export default { Capability, CapabilityRegistry, hasCapability, isEnabled };
