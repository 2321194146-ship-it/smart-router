// src/router/candidates.js
// Smart Router Mainline - Phase 1
// 候选模型列表构建：根据请求模型、Agent 绑定、预算约束、能力需求等，
// 构建有序候选模型列表，供 Fallback 链使用。
//
// 设计要点（参考 7878 SmartRouter.next 和 6.5.0 buildCandidates）：
//   - 模型 id 小写索引，支持别名匹配（如 deepseek-v4-flash → deepseek-ai/DeepSeek-V4-Flash）
//   - strictModel=true 时仅返回精确匹配模型（不存在则返回空数组）
//   - agentModels 不为 null 时仅从 agent 模型池中选择
//   - 过滤 excludeModels / excludeProviders / 不可用 provider / 熔断模型
//   - 按 tier 分组排序（tier1 优先），同 tier 内免费优先
//   - 同 id 多 provider：同 id 的模型在不同 provider 都有条目时，都保留
//   - 免费优先：free 模型排在 paid 模型前面
//
// intelligence.mode=off：简单按 tier 排序，不做加权随机选择。
//
// 仅使用 Node.js 内置模块，无第三方依赖。

// Phase2-C：统一能力数据源（Capability Registry）
import { extractCapabilities, BINARY_CAPABILITY_THRESHOLD } from '../intelligence/capability-registry.js';

// ----------------------------------------------------------------------------
// 日志（避免与 config/loader 产生静态循环依赖）
// ----------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[candidates][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// 工具函数
// ----------------------------------------------------------------------------

/**
 * 将字符串规范化为小写并移除分隔符（- _ . /），用于模糊匹配。
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[-_.\/]/g, '');
}

/**
 * 将 tier 字符串转换为数值，用于排序（tier1 < tier2 < tier3）。
 * @param {string} tier
 * @returns {number}
 */
function tierValue(tier) {
  if (!tier) return 99;
  const m = String(tier).match(/tier(\d+)/i);
  if (m) return Number(m[1]);
  return 99;
}

/**
 * 判断模型是否具备请求所需能力（Phase2-C：统一数据源）。
 * 兼容两种配置形态：
 *   - legacy：capability: ["vision", "chat"]
 *   - 新：capabilities: { vision: 100, chat: 95 }
 * 阈值与 Phase2 Policy 的 binaryThreshold 一致（默认 0.9）。
 * @param {object} model 模型配置
 * @param {string} capability 请求能力（如 'vision'）
 * @returns {boolean}
 */
function hasCapability(model, capability) {
  if (!capability) return true;
  if (!model || typeof model !== 'object') return false;
  const caps = extractCapabilities(model);
  return (caps[capability] || 0) >= BINARY_CAPABILITY_THRESHOLD;
}

/**
 * 判断模型是否已启用。
 * @param {object} model
 * @returns {boolean}
 */
function isModelEnabled(model) {
  if (!model) return false;
  if (model.enabled === undefined) return true;
  return model.enabled === true;
}

// ----------------------------------------------------------------------------
// 模型索引构建（支持别名匹配）
// ----------------------------------------------------------------------------

/**
 * 构建模型查找索引。
 *
 * 索引策略（优先级从高到低）：
 *   1. 精确 id（区分大小写）→ model
 *   2. 小写 id → model
 *   3. 规范化 id（小写 + 去分隔符）→ model
 *   4. 别名：id 中 "/" 后的部分 → model
 *   5. 别名：apiModel 小写 → model
 *
 * 同一索引键只保留第一个匹配（配置顺序优先）。
 *
 * @param {object[]} models 配置中的 models 数组
 * @returns {{ exact: Map, lower: Map, normalized: Map }}
 */
export function buildModelIndex(models) {
  const exact = new Map();
  const lower = new Map();
  const normalized = new Map();

  const list = Array.isArray(models) ? models : [];
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;

    if (!exact.has(m.id)) {
      exact.set(m.id, m);
    }

    const lid = m.id.toLowerCase();
    if (!lower.has(lid)) {
      lower.set(lid, m);
    }

    const nid = normalize(m.id);
    if (!normalized.has(nid)) {
      normalized.set(nid, m);
    }

    // 别名：id 中 "/" 后的部分
    if (m.id.includes('/')) {
      const alias = m.id.split('/').pop();
      const aliasLower = alias.toLowerCase();
      if (!lower.has(aliasLower)) {
        lower.set(aliasLower, m);
      }
      const aliasNorm = normalize(alias);
      if (!normalized.has(aliasNorm)) {
        normalized.set(aliasNorm, m);
      }
    }

    // 别名：apiModel
    if (typeof m.apiModel === 'string' && m.apiModel) {
      const apiLower = m.apiModel.toLowerCase();
      if (!lower.has(apiLower)) {
        lower.set(apiLower, m);
      }
      const apiNorm = normalize(m.apiModel);
      if (!normalized.has(apiNorm)) {
        normalized.set(apiNorm, m);
      }
    }
  }

  return { exact, lower, normalized };
}

/**
 * 根据 requestedModel 解析模型配置（支持别名匹配）。
 *
 * @param {string|null} requestedModel 请求的模型 id（'auto' 或 null 表示自动选择）
 * @param {{ exact: Map, lower: Map, normalized: Map }} modelIndex 模型索引
 * @returns {object|null} 匹配到的模型配置，未匹配返回 null
 */
export function resolveModelId(requestedModel, modelIndex) {
  if (!requestedModel || requestedModel === 'auto') return null;

  // 精确匹配
  if (modelIndex.exact.has(requestedModel)) {
    return modelIndex.exact.get(requestedModel);
  }

  // 小写匹配
  const lid = requestedModel.toLowerCase();
  if (modelIndex.lower.has(lid)) {
    return modelIndex.lower.get(lid);
  }

  // 规范化匹配
  const nid = normalize(requestedModel);
  if (modelIndex.normalized.has(nid)) {
    return modelIndex.normalized.get(nid);
  }

  // 别名：requestedModel 中 "/" 后的部分
  if (requestedModel.includes('/')) {
    const alias = requestedModel.split('/').pop();
    const aliasLower = alias.toLowerCase();
    if (modelIndex.lower.has(aliasLower)) {
      return modelIndex.lower.get(aliasLower);
    }
    const aliasNorm = normalize(alias);
    if (modelIndex.normalized.has(aliasNorm)) {
      return modelIndex.normalized.get(aliasNorm);
    }
  }

  return null;
}

// ----------------------------------------------------------------------------
// 候选构建主函数
// ----------------------------------------------------------------------------

/**
 * 构建候选模型列表。
 *
 * 逻辑：
 *   1. 如果 strictModel=true，只返回精确匹配的模型（不存在则返回空数组）
 *   2. 如果 requestedModel 是 'auto' 或 null，从所有模型中选择
 *   3. 如果 agentModels 不为 null，只从 agent 模型池中选择
 *   4. 过滤 excludeModels 和 excludeProviders
 *   5. 过滤不可用的 provider（health.isAvailable）
 *   6. 过滤熔断的模型（circuitBreaker.allow）
 *   7. 按 tier 分组（tier 1 优先）
 *   8. 同模型跨 Provider：同 id 的模型在不同 provider 都有条目时，都保留
 *   9. 免费优先：free 模型排在 paid 模型前面
 *
 * @param {string|null} requestedModel 客户端请求的模型 id（'auto' 或 null 表示自动选择）
 * @param {object} config 已加载的配置对象
 * @param {object} [options]
 * @param {string} [options.agentId] Agent 标识
 * @param {string[]|null} [options.agentModels] Agent 的模型池（null 表示不限制）
 * @param {object} [options.budget] Agent 预算配置（含 allowPaid, strictModel 等）
 * @param {string} [options.capability] 请求能力（如 'vision'）
 * @param {string[]} [options.excludeModels] 需排除的模型 id 列表
 * @param {string[]} [options.excludeProviders] 需排除的 provider 名称列表
 * @param {boolean} [options.strictModel] 是否锁定模型（不允许切换到其他模型）
 * @param {object} [options.health] ProviderHealth 实例（用于过滤不可用 provider）
 * @param {object} [options.circuitBreaker] CircuitBreaker 实例（用于过滤熔断模型）
 * @param {object} [options.keyPool] KeyPool 实例（用于检查 key 可用性）
 * @returns {Array<object>} 候选数组，每个候选含：
 *   { model, modelId, provider, keyPool, paid, tier, capability, budgetBlocked, source }
 */
export function buildCandidates(requestedModel, config, options = {}) {
  const models = Array.isArray(config?.models) ? config.models : [];
  if (models.length === 0) {
    log('no models configured');
    return [];
  }

  // 1. 构建模型索引
  const modelIndex = buildModelIndex(models);

  // 2. 解析 strictModel
  const strictModel = options.strictModel === true ||
    (options.budget && options.budget.strictModel === true);

  // 3. 解析 requestedModel
  const isAuto = !requestedModel || requestedModel === 'auto';
  const requestedModelConfig = isAuto ? null : resolveModelId(requestedModel, modelIndex);

  // 4. strictModel 处理：只返回精确匹配的模型
  if (strictModel) {
    if (isAuto) {
      log('strictModel=true but requestedModel is auto; returning empty candidates');
      return [];
    }
    if (!requestedModelConfig) {
      log(`strictModel=true and model "${requestedModel}" not found; returning empty candidates`);
      return [];
    }
    // 只返回精确匹配的模型（含同 id 多 provider）
    return _buildFromModel(requestedModelConfig, config, options, 'requested');
  }

  // 5. 非 strictModel：确定候选模型范围
  if (!isAuto && requestedModelConfig) {
    // 请求了特定模型且找到了：以该模型为主，同 id 多 provider 都保留
    const sameIdModels = _findSameIdModels(requestedModelConfig, models);
    return _buildCandidatesFromModels(sameIdModels, config, options, 'requested');
  }

  // auto 或未找到精确匹配：从更大范围选择
  // 5a. 如果 agentModels 不为 null，只从 agent 模型池中选择
  const agentModels = options.agentModels;
  if (Array.isArray(agentModels) && agentModels.length > 0) {
    const candidateModels = models.filter((m) =>
      isModelEnabled(m) && agentModels.includes(m.id)
    );
    if (candidateModels.length === 0) {
      log('agent model pool is non-empty but no enabled models match');
    }
    return _buildCandidatesFromModels(candidateModels, config, options, 'agent_pool');
  }

  // 5b. 从所有启用的模型中选择
  const candidateModels = models.filter((m) => isModelEnabled(m));
  return _buildCandidatesFromModels(candidateModels, config, options, isAuto ? 'auto' : 'global');
}

// ----------------------------------------------------------------------------
// 内部：从单个模型构建候选（strictModel 场景）
// ----------------------------------------------------------------------------

function _buildFromModel(modelConfig, config, options, source) {
  const models = Array.isArray(config?.models) ? config.models : [];
  const sameIdModels = _findSameIdModels(modelConfig, models);
  return _buildCandidatesFromModels(sameIdModels, config, options, source);
}

/**
 * 查找同 id 的所有模型条目（含不同 provider）。
 * 同 id 多 provider：同 id 的模型在不同 provider 都有条目时，都保留。
 */
function _findSameIdModels(modelConfig, allModels) {
  if (!modelConfig || !modelConfig.id) return [];
  return allModels.filter(
    (m) => m && m.id === modelConfig.id && isModelEnabled(m)
  );
}

// ----------------------------------------------------------------------------
// 内部：从模型列表构建候选列表（含过滤、排序）
// ----------------------------------------------------------------------------

function _buildCandidatesFromModels(modelList, config, options, source) {
  if (!modelList || modelList.length === 0) return [];

  const excludeModels = new Set(
    Array.isArray(options.excludeModels) ? options.excludeModels : []
  );
  const excludeProviders = new Set(
    Array.isArray(options.excludeProviders) ? options.excludeProviders : []
  );
  const capability = options.capability || null;
  const health = options.health || null;
  const circuitBreaker = options.circuitBreaker || null;
  const keyPool = options.keyPool || null;
  const budget = options.budget || {};

  const allowPaid =
    typeof budget.allowPaid === 'boolean' ? budget.allowPaid : true;

  const candidates = [];

  for (const model of modelList) {
    if (!model || !model.id || !model.provider) continue;

    // 过滤 excludeModels
    if (excludeModels.has(model.id)) continue;

    // 过滤 excludeProviders
    if (excludeProviders.has(model.provider)) continue;

    // 过滤 capability
    if (!hasCapability(model, capability)) continue;

    // 过滤不可用 provider（health.isAvailable）
    if (health && typeof health.isAvailable === 'function') {
      if (!health.isAvailable(model.provider)) {
        log(`provider "${model.provider}" not available (health), skipping model "${model.id}"`);
        continue;
      }
    }

    // 过滤熔断的模型（circuitBreaker.allow）
    const cbKey = `${model.provider}:${model.id}`;
    if (circuitBreaker && typeof circuitBreaker.allow === 'function') {
      if (!circuitBreaker.allow(cbKey)) {
        log(`circuit breaker open for "${cbKey}", skipping`);
        continue;
      }
    }

    // 检查 key 可用性（如果有 keyPool）
    if (keyPool && typeof keyPool.getKeys === 'function') {
      const keys = keyPool.getKeys(model.provider);
      if (keys.length === 0) {
        log(`no available keys for provider "${model.provider}", skipping model "${model.id}"`);
        continue;
      }
    }

    const paid = model.paid === true;
    const budgetBlocked = paid && !allowPaid;

    candidates.push({
      model,
      modelId: model.id,
      provider: model.provider,
      keyPool: keyPool || null,
      paid,
      tier: model.tier || 'tier3',
      capability: Array.isArray(model.capability) ? [...model.capability] : [],
      budgetBlocked,
      source,
    });
  }

  // 排序：按 tier 分组（tier1 优先），同 tier 内免费优先
  _sortCandidates(candidates);

  return candidates;
}

// ----------------------------------------------------------------------------
// 内部：候选排序
// ----------------------------------------------------------------------------

/**
 * 排序候选列表。
 *
 * 排序规则（优先级从高到低）：
 *   1. tier 数值升序（tier1 < tier2 < tier3）
 *   2. 同 tier 内，免费模型（paid=false）排在付费模型（paid=true）前面
 *   3. 同 tier 同付费状态内，保持原始顺序（稳定排序）
 */
function _sortCandidates(candidates) {
  candidates.sort((a, b) => {
    const ta = tierValue(a.tier);
    const tb = tierValue(b.tier);
    if (ta !== tb) return ta - tb;

    if (a.paid !== b.paid) {
      return a.paid ? 1 : -1;
    }

    return 0;
  });
}

export default {
  buildCandidates,
  buildModelIndex,
  resolveModelId,
};
