// src/cost/tracker.js
// Smart Router Mainline - Phase 1
// 成本追踪器：预算安全检查 + 请求成本计算 + 日度成本聚合。
//
// 设计原则（intelligence.mode=off，硬性安全接口）：
//   1. 预算检查是硬性安全接口，每次 Attempt 前都必须重新调用 checkBudget。
//      intelligence 关闭时不做智能预算决策，但安全闸门绝不省略。
//   2. strictModel=true 时，不允许将请求切换到与原始请求模型不同的模型。
//   3. allowPaid=false 时，付费模型绝不执行（无条件拒绝）。
//   4. 成本仅扣一次：recordCost 以 requestId 去重，finalize 时调用，不重复扣除。
//   5. 支持 agent 级 budget 覆盖：agent budget 优先于全局 budget；
//      checkBudget 的 options 显式字段优先级最高（调用方可注入已解析的 agent budget）。
//   6. 日度成本按 UTC+8 分桶（dateKey = YYYY-MM-DD，东八区日历日）。
//   7. 仅使用 Node.js 内置能力，无第三方依赖；内存存储，接口预留 SQLite 迁移。
//
// 数据结构（内存版，对应未来 SQLite 表）：
//   records : Map<requestId, CostRecord>  ↔ cost_records(request_id PK, model_id, provider,
//                                    prompt_tokens, completion_tokens, input_cost,
//                                    output_cost, total_cost, currency, date_key, created_at)
//   daily   : Map<dateKey, DailyBucket>   ↔ daily_cost(date_key, model_id, provider, ...)
//   pricing : Map<modelId, PriceInfo>     ↔ model_price(model_id PK, input_cost_per_1k, ...)

// ----------------------------------------------------------------------------
// 内置默认值与枚举
// ----------------------------------------------------------------------------

const DEFAULT_BUDGET = Object.freeze({
  allowPaid: true,
  maxRequestCost: Infinity,
  allowedModels: [], // 空 = 不限制
  allowedProviders: [], // 空 = 不限制
  strictModel: false,
});

const DEFAULT_CURRENCY = 'USD';

// 预算检查拒绝原因枚举（与 BudgetCheck.reason 取值一致）
export const BudgetReason = Object.freeze({
  OK: 'ok',
  PAID_BLOCKED: 'paid_blocked',
  MODEL_NOT_ALLOWED: 'model_not_allowed',
  PROVIDER_NOT_ALLOWED: 'provider_not_allowed',
  STRICT_MODEL_MISMATCH: 'strict_model_mismatch',
  COST_EXCEEDS_MAX: 'cost_exceeds_max',
});

// ----------------------------------------------------------------------------
// 内部工具函数
// ----------------------------------------------------------------------------

/**
 * 规范化 budget 对象：补全缺失字段，过滤非法值。
 * 数组元素仅保留非空字符串；标量取显式值，否则回退默认。
 */
function normalizeBudget(raw) {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    allowPaid:
      typeof b.allowPaid === 'boolean' ? b.allowPaid : DEFAULT_BUDGET.allowPaid,
    maxRequestCost:
      typeof b.maxRequestCost === 'number' && Number.isFinite(b.maxRequestCost)
        ? b.maxRequestCost
        : DEFAULT_BUDGET.maxRequestCost,
    allowedModels: Array.isArray(b.allowedModels)
      ? b.allowedModels.filter((x) => typeof x === 'string' && x.trim())
      : [...DEFAULT_BUDGET.allowedModels],
    allowedProviders: Array.isArray(b.allowedProviders)
      ? b.allowedProviders.filter((x) => typeof x === 'string' && x.trim())
      : [...DEFAULT_BUDGET.allowedProviders],
    strictModel:
      typeof b.strictModel === 'boolean' ? b.strictModel : DEFAULT_BUDGET.strictModel,
  };
}

/**
 * 从模型定义中提取定价信息。
 * price 字段结构：{ input_cost_per_1k, output_cost_per_1k, currency }
 * 缺失 price 时按 0 计费（免费/未配置）。
 */
function extractPrice(model) {
  const price =
    model && model.price && typeof model.price === 'object' && !Array.isArray(model.price)
      ? model.price
      : {};
  return {
    input_cost_per_1k:
      typeof price.input_cost_per_1k === 'number' && Number.isFinite(price.input_cost_per_1k)
        ? price.input_cost_per_1k
        : 0,
    output_cost_per_1k:
      typeof price.output_cost_per_1k === 'number' && Number.isFinite(price.output_cost_per_1k)
        ? price.output_cost_per_1k
        : 0,
    currency:
      typeof price.currency === 'string' && price.currency.trim()
        ? price.currency
        : DEFAULT_CURRENCY,
    paid: typeof model?.paid === 'boolean' ? model.paid : false,
  };
}

/**
 * 从 usage 对象中按候选键顺序取 token 数（兼容多种命名）。
 */
function pickTokens(usage, keys) {
  if (!usage || typeof usage !== 'object') return 0;
  // 兼容下划线（prompt_tokens）与驼峰（promptTokens）两种命名：
  // 为每个候选键额外生成驼峰变体
  for (const k of keys) {
    const camel = k.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
    const v = usage[k] ?? usage[camel];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return 0;
}

/**
 * 成本四舍五入到 8 位小数，避免浮点累积误差。
 */
function roundCost(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 1e8) / 1e8;
}

/**
 * 规范化外部传入的 cost 对象。
 */
function normalizeCost(cost) {
  const inputCost = typeof cost.inputCost === 'number' ? cost.inputCost : 0;
  const outputCost = typeof cost.outputCost === 'number' ? cost.outputCost : 0;
  const totalCost =
    typeof cost.totalCost === 'number' ? cost.totalCost : inputCost + outputCost;
  return {
    inputCost: roundCost(inputCost),
    outputCost: roundCost(outputCost),
    totalCost: roundCost(totalCost),
    currency:
      typeof cost.currency === 'string' && cost.currency.trim()
        ? cost.currency
        : DEFAULT_CURRENCY,
  };
}

/**
 * UTC+8 日期分桶：返回 YYYY-MM-DD（按东八区日历日）。
 * 实现：将时间戳偏移 +8h 后取 ISO 日期部分。
 */
function getUtc8DateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  const utc8Ms = d.getTime() + 8 * 60 * 60 * 1000;
  return new Date(utc8Ms).toISOString().slice(0, 10);
}

/**
 * 将输入归一化为 dateKey（YYYY-MM-DD）。
 * - null/undefined → 今天（UTC+8）
 * - 已是 YYYY-MM-DD 字符串 → 原样返回
 * - 其他字符串/Date → 按 UTC+8 解析
 */
function resolveDateKey(date) {
  if (date == null) return getUtc8DateString();
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return getUtc8DateString(new Date(date));
  }
  return getUtc8DateString(date);
}

/**
 * 将聚合 Map 转为普通对象（浅拷贝值，避免外部篡改内部状态）。
 */
function mapToPlainObject(map) {
  const out = {};
  for (const [k, v] of map.entries()) {
    out[k] = { ...v };
  }
  return out;
}

/**
 * 从 model 参数（id 字符串或对象）解析出 modelId 与模型对象。
 */
function resolveModel(model, modelsMap) {
  if (typeof model === 'string') {
    return { modelId: model, modelObj: modelsMap.get(model) || null };
  }
  if (model && typeof model === 'object') {
    const id = typeof model.id === 'string' ? model.id : null;
    return { modelId: id, modelObj: model };
  }
  return { modelId: null, modelObj: null };
}

/**
 * budget 摘要（用于 details 输出，避免泄露完整引用）。
 */
function summarizeBudget(budget) {
  return {
    allowPaid: budget.allowPaid,
    maxRequestCost: budget.maxRequestCost,
    allowedModels: [...budget.allowedModels],
    allowedProviders: [...budget.allowedProviders],
    strictModel: budget.strictModel,
  };
}

// ----------------------------------------------------------------------------
// BudgetCheck：预算安全检查结果
// ----------------------------------------------------------------------------

/**
 * 预算安全检查结果。
 *
 * @property {boolean} allowed 是否允许执行本次 Attempt
 * @property {string} reason 拒绝原因（见 BudgetReason）；allowed=true 时恒为 'ok'
 * @property {object} details 附加详情（model、provider、budget、预估成本、说明信息等）
 */
export class BudgetCheck {
  constructor(allowed, reason, details = {}) {
    this.allowed = !!allowed;
    // allowed=true 时 reason 强制为 'ok'，避免调用方误传
    this.reason = this.allowed ? BudgetReason.OK : reason || BudgetReason.OK;
    this.details = details && typeof details === 'object' ? details : {};
  }

  toJSON() {
    return {
      allowed: this.allowed,
      reason: this.reason,
      details: this.details,
    };
  }
}

// ----------------------------------------------------------------------------
// CostTracker：成本追踪器
// ----------------------------------------------------------------------------

/**
 * 成本追踪器。
 *
 * 职责：
 *   - 预算安全检查（checkBudget，每次 Attempt 前硬性调用）
 *   - 请求成本计算（calculateCost / estimateCost）
 *   - 成本记录与日度聚合（recordCost / getDailyCost）
 *
 * 内存存储，无外部依赖；接口设计支持未来迁移到 SQLite。
 */
export class CostTracker {
  /**
   * @param {object} config 已加载的配置对象（含 budget / agent_bindings / models）
   */
  constructor(config, store = null) {
    this.store = store || null;

    // 全局 budget（规范化后）
    this.globalBudget = normalizeBudget(config?.budget);

    // agent 级 budget 绑定：Map<agentId, normalizedBudget>
    this.agentBudgets = new Map();
    if (config?.agent_bindings && typeof config.agent_bindings === 'object') {
      for (const [agentId, binding] of Object.entries(config.agent_bindings)) {
        if (binding && typeof binding === 'object' && binding.budget) {
          this.agentBudgets.set(agentId, normalizeBudget(binding.budget));
        }
      }
    }

    // 模型定义表：Map<modelId, modelDef>
    this.models = new Map();
    // 定价表：Map<modelId, PriceInfo>
    this.pricing = new Map();
    if (Array.isArray(config?.models)) {
      for (const m of config.models) {
        if (!m || typeof m.id !== 'string' || !m.id) continue;
        this.models.set(m.id, m);
        this.pricing.set(m.id, extractPrice(m));
      }
    }

    // 请求级成本记录：Map<requestId, CostRecord>
    this.records = new Map();

    // 日度聚合：Map<dateKey, DailyBucket>
    this.daily = new Map();
  }

  async restore() {
    if (!this.store || typeof this.store.getAllCosts !== 'function') return 0;
    const records = await this.store.getAllCosts();
    for (const record of records) this.updateMemoryAggregation(record);
    return records.length;
  }

  // --------------------------------------------------------------------------
  // 预算解析
  // --------------------------------------------------------------------------

  /**
   * 解析生效预算，优先级（高 → 低）：
   *   options 显式字段 > agent 绑定（按 agentId）> 全局 budget > 内置默认
   *
   * 数组语义（与 identity.js getAgentBudget 保持一致）：
   *   - agent 非空数组覆盖 global；agent 空/缺失回退 global
   *   - options 显式数组覆盖一切（含空数组，表示显式不限制）
   *
   * @param {object} [options] checkBudget 传入的 options
   * @returns {object} 生效预算 { allowPaid, maxRequestCost, allowedModels,
   *                              allowedProviders, strictModel, requestedModel }
   */
  resolveBudget(options = {}) {
    const global = this.globalBudget;
    const agent = options.agentId ? this.agentBudgets.get(options.agentId) : null;

    // allowPaid
    const allowPaid =
      typeof options.allowPaid === 'boolean'
        ? options.allowPaid
        : agent
          ? agent.allowPaid
          : global.allowPaid;

    // maxRequestCost
    const maxRequestCost =
      typeof options.maxRequestCost === 'number' && Number.isFinite(options.maxRequestCost)
        ? options.maxRequestCost
        : agent
          ? agent.maxRequestCost
          : global.maxRequestCost;

    // allowedModels
    let allowedModels;
    if (Array.isArray(options.allowedModels)) {
      allowedModels = options.allowedModels.filter((x) => typeof x === 'string' && x);
    } else if (agent && agent.allowedModels.length > 0) {
      allowedModels = agent.allowedModels;
    } else {
      allowedModels = global.allowedModels;
    }

    // allowedProviders
    let allowedProviders;
    if (Array.isArray(options.allowedProviders)) {
      allowedProviders = options.allowedProviders.filter((x) => typeof x === 'string' && x);
    } else if (agent && agent.allowedProviders.length > 0) {
      allowedProviders = agent.allowedProviders;
    } else {
      allowedProviders = global.allowedProviders;
    }

    // strictModel
    const strictModel =
      typeof options.strictModel === 'boolean'
        ? options.strictModel
        : agent
          ? agent.strictModel
          : global.strictModel;

    return {
      allowPaid,
      maxRequestCost,
      allowedModels,
      allowedProviders,
      strictModel,
      requestedModel:
        typeof options.requestedModel === 'string' && options.requestedModel
          ? options.requestedModel
          : null,
    };
  }

  // --------------------------------------------------------------------------
  // 预算安全检查（硬性接口）
  // --------------------------------------------------------------------------

  /**
   * 预算安全检查（每次 Attempt 前必须调用）。
   *
   * 检查顺序（任一失败即短路拒绝）：
   *   1. strictModel：strictModel=true 且 requestedModel 存在 且 model !== requestedModel
   *      → strict_model_mismatch
   *   2. allowedModels：列表非空 且 model 不在列表 → model_not_allowed
   *   3. allowedProviders：列表非空 且 provider 不在列表 → provider_not_allowed
   *   4. allowPaid：model.paid=true 且 allowPaid=false → paid_blocked
   *   5. maxRequestCost：预估成本 > maxRequestCost → cost_exceeds_max
   *
   * @param {string|object} model 模型 id 或模型定义对象
   * @param {string} provider provider 名称
   * @param {object} [options] 预算与估算参数：
   *   - agentId {string} Agent 标识（用于解析 agent 级 budget）
   *   - allowPaid {boolean} 显式覆盖
   *   - maxRequestCost {number} 显式覆盖
   *   - allowedModels {string[]} 显式覆盖
   *   - allowedProviders {string[]} 显式覆盖
   *   - strictModel {boolean} 显式覆盖
   *   - requestedModel {string} 客户端原始请求模型（strictModel 比对基准）
   *   - estimatedInputTokens {number} 预估输入 token（maxRequestCost 检查用）
   *   - estimatedOutputTokens {number} 预估输出 token（maxRequestCost 检查用）
   * @returns {BudgetCheck}
   */
  checkBudget(model, provider, options = {}) {
    const { modelId, modelObj } = resolveModel(model, this.models);
    const priceInfo = modelId ? this.pricing.get(modelId) : null;
    // 付费状态：优先模型对象显式 paid，其次定价表，未知默认 false
    const modelPaid =
      typeof modelObj?.paid === 'boolean'
        ? modelObj.paid
        : priceInfo
          ? priceInfo.paid
          : false;

    const budget = this.resolveBudget(options);

    // 1. strictModel 检查：禁止模型切换
    if (
      budget.strictModel &&
      budget.requestedModel &&
      modelId &&
      budget.requestedModel !== modelId
    ) {
      return new BudgetCheck(false, BudgetReason.STRICT_MODEL_MISMATCH, {
        model: modelId,
        requestedModel: budget.requestedModel,
        provider,
        budget: summarizeBudget(budget),
        message: `strictModel=true：不允许从 "${budget.requestedModel}" 切换到 "${modelId}"`,
      });
    }

    // 2. allowedModels 检查（空列表 = 不限制）
    if (
      budget.allowedModels.length > 0 &&
      modelId &&
      !budget.allowedModels.includes(modelId)
    ) {
      return new BudgetCheck(false, BudgetReason.MODEL_NOT_ALLOWED, {
        model: modelId,
        allowedModels: budget.allowedModels,
        provider,
        budget: summarizeBudget(budget),
        message: `模型 "${modelId}" 不在 allowedModels 列表中`,
      });
    }

    // 3. allowedProviders 检查（空列表 = 不限制）
    if (
      budget.allowedProviders.length > 0 &&
      typeof provider === 'string' &&
      provider &&
      !budget.allowedProviders.includes(provider)
    ) {
      return new BudgetCheck(false, BudgetReason.PROVIDER_NOT_ALLOWED, {
        model: modelId,
        provider,
        allowedProviders: budget.allowedProviders,
        budget: summarizeBudget(budget),
        message: `provider "${provider}" 不在 allowedProviders 列表中`,
      });
    }

    // 4. allowPaid 检查：付费模型在 allowPaid=false 时无条件拒绝
    if (modelPaid && !budget.allowPaid) {
      return new BudgetCheck(false, BudgetReason.PAID_BLOCKED, {
        model: modelId,
        provider,
        paid: true,
        budget: summarizeBudget(budget),
        message: `模型 "${modelId}" 为付费模型，allowPaid=false 禁止执行`,
      });
    }

    // 5. maxRequestCost 检查：预估成本超过上限则拒绝
    const estInput = Number.isFinite(options.estimatedInputTokens)
      ? Math.max(0, options.estimatedInputTokens)
      : 0;
    const estOutput = Number.isFinite(options.estimatedOutputTokens)
      ? Math.max(0, options.estimatedOutputTokens)
      : 0;
    const estimation = this.estimateCost(modelId, estInput, estOutput);

    if (
      Number.isFinite(budget.maxRequestCost) &&
      estimation.totalCost > budget.maxRequestCost
    ) {
      return new BudgetCheck(false, BudgetReason.COST_EXCEEDS_MAX, {
        model: modelId,
        provider,
        estimatedCost: estimation,
        maxRequestCost: budget.maxRequestCost,
        budget: summarizeBudget(budget),
        message: `预估成本 ${estimation.totalCost} ${estimation.currency} 超过 maxRequestCost ${budget.maxRequestCost}`,
      });
    }

    // 全部通过
    return new BudgetCheck(true, BudgetReason.OK, {
      model: modelId,
      provider,
      budget: summarizeBudget(budget),
      estimatedCost: estimation,
    });
  }

  // --------------------------------------------------------------------------
  // 成本计算
  // --------------------------------------------------------------------------

  /**
   * 获取模型定价信息。
   * @param {string} modelId
   * @returns {{ input_cost_per_1k, output_cost_per_1k, currency, paid }}
   *          未知模型返回零定价（免费）兜底，避免抛错阻断流程。
   */
  getModelPrice(modelId) {
    const price = this.pricing.get(modelId);
    if (price) return price;
    return {
      input_cost_per_1k: 0,
      output_cost_per_1k: 0,
      currency: DEFAULT_CURRENCY,
      paid: false,
    };
  }

  /**
   * 获取模型完整定义。
   * @param {string} modelId
   * @returns {object|null}
   */
  getModel(modelId) {
    return this.models.get(modelId) || null;
  }

  /**
   * 预估请求成本（发送前）。
   * @param {string} modelId 模型 id
   * @param {number} estimatedInputTokens 预估输入 token
   * @param {number} estimatedOutputTokens 预估输出 token
   * @returns {{ inputCost, outputCost, totalCost, currency }}
   */
  estimateCost(modelId, estimatedInputTokens, estimatedOutputTokens) {
    const price = this.getModelPrice(modelId);
    const inputTokens = Number.isFinite(estimatedInputTokens)
      ? Math.max(0, estimatedInputTokens)
      : 0;
    const outputTokens = Number.isFinite(estimatedOutputTokens)
      ? Math.max(0, estimatedOutputTokens)
      : 0;

    const inputCost = (inputTokens / 1000) * price.input_cost_per_1k;
    const outputCost = (outputTokens / 1000) * price.output_cost_per_1k;

    return {
      inputCost: roundCost(inputCost),
      outputCost: roundCost(outputCost),
      totalCost: roundCost(inputCost + outputCost),
      currency: price.currency,
    };
  }

  /**
   * 计算单次请求成本（基于实际 usage）。
   * @param {string|object} model 模型 id 或模型对象
   * @param {object} usage { prompt_tokens, completion_tokens }（兼容 input_tokens/output_tokens）
   * @returns {{ inputCost, outputCost, totalCost, currency }}
   */
  calculateCost(model, usage = {}) {
    const { modelId } = resolveModel(model, this.models);
    const price = this.getModelPrice(modelId);

    const promptTokens = pickTokens(usage, ['prompt_tokens', 'input_tokens']);
    const completionTokens = pickTokens(usage, [
      'completion_tokens',
      'output_tokens',
    ]);

    const inputCost = (promptTokens / 1000) * price.input_cost_per_1k;
    const outputCost = (completionTokens / 1000) * price.output_cost_per_1k;

    return {
      inputCost: roundCost(inputCost),
      outputCost: roundCost(outputCost),
      totalCost: roundCost(inputCost + outputCost),
      currency: price.currency,
    };
  }

  // --------------------------------------------------------------------------
  // 成本记录与日度聚合
  // --------------------------------------------------------------------------

  /**
   * 纯计算方法：生成 costRecord 但不写内存、不写数据库。
   *
   * 用于事务收尾场景：在事务开启前预计算 costRecord，
   * 事务成功后才通过 updateMemoryAggregation 更新内存。
   *
   * @param {string} requestId 请求唯一标识
   * @param {string|object} model 模型 id 或模型对象
   * @param {string} provider provider 名称
   * @param {object} usage token 用量
   * @param {object} [cost] 预计算成本（优先于 usage 自动计算）
   * @returns {object} costRecord（含 requestId, modelId, provider, usage, cost, dateKey, timestamp）
   */
  calculateCostRecord(requestId, model, provider, usage, cost) {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('[tracker] calculateCostRecord: requestId 必须为非空字符串');
    }

    const { modelId } = resolveModel(model, this.models);
    const finalCost =
      cost && typeof cost === 'object'
        ? normalizeCost(cost)
        : this.calculateCost(model, usage);

    const now = new Date();
    const dateKey = getUtc8DateString(now);

    return {
      requestId,
      modelId,
      provider: typeof provider === 'string' ? provider : null,
      usage: {
        prompt_tokens: pickTokens(usage, ['prompt_tokens', 'input_tokens']),
        completion_tokens: pickTokens(usage, [
          'completion_tokens',
          'output_tokens',
        ]),
      },
      cost: finalCost,
      dateKey,
      timestamp: now.toISOString(),
    };
  }

  /**
   * 更新内存聚合（事务成功后调用）。
   *
   * 将已计算的 costRecord 写入内存 records Map 和 daily 聚合。
   * 不写数据库（数据库写入由事务内部完成）。
   *
   * @param {object} costRecord calculateCostRecord 返回的记录
   */
  updateMemoryAggregation(costRecord) {
    if (!costRecord || !costRecord.requestId) return;
    if (this.records.has(costRecord.requestId)) return;
    this.records.set(costRecord.requestId, costRecord);
    this._addToDaily(costRecord.dateKey, costRecord.modelId, costRecord.provider, costRecord.cost);
  }

  /**
   * 记录请求成本（finalize 时调用，以 requestId 去重，不重复扣除）。
   *
   * 兼容旧调用路径：同时写内存和 store。
   * 新代码应使用 calculateCostRecord + updateMemoryAggregation 分离计算与写入。
   *
   * @param {string} requestId 请求唯一标识（去重键）
   * @param {string|object} model 模型 id 或模型对象
   * @param {string} provider provider 名称
   * @param {object} usage { prompt_tokens, completion_tokens }
   * @param {object} [cost] 预计算成本 { inputCost, outputCost, totalCost, currency }；
   *                        未提供则按 usage 自动计算
   * @returns {{ recorded: boolean, record: object }}
   *          recorded=false 表示该 requestId 已记录过，本次跳过（成本仅扣一次）
   */
  recordCost(requestId, model, provider, usage, cost) {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('[tracker] recordCost: requestId 必须为非空字符串');
    }

    if (this.records.has(requestId)) {
      return { recorded: false, record: this.records.get(requestId) };
    }

    const record = this.calculateCostRecord(requestId, model, provider, usage, cost);
    this.updateMemoryAggregation(record);

    if (this.store && typeof this.store.saveCost === 'function') {
      this.store.saveCost(record).catch(() => {});
    }

    return { recorded: true, record };
  }

  /**
   * 是否已记录该请求的成本（用于外部确认「仅扣一次」）。
   */
  hasRecord(requestId) {
    return this.records.has(requestId);
  }

  /**
   * 获取单条成本记录。
   * @returns {object|null}
   */
  getRecord(requestId) {
    return this.records.get(requestId) || null;
  }

  /**
   * 将一条成本累加进日度聚合桶。
   * @param {string} dateKey YYYY-MM-DD（UTC+8）
   * @param {string|null} modelId
   * @param {string|null} provider
   * @param {object} cost { inputCost, outputCost, totalCost, currency }
   */
  _addToDaily(dateKey, modelId, provider, cost) {
    let bucket = this.daily.get(dateKey);
    if (!bucket) {
      bucket = {
        date: dateKey,
        currency: cost.currency || DEFAULT_CURRENCY,
        totalCost: 0,
        totalInputCost: 0,
        totalOutputCost: 0,
        requests: 0,
        byModel: new Map(),
        byProvider: new Map(),
      };
      this.daily.set(dateKey, bucket);
    }

    bucket.totalCost = roundCost(bucket.totalCost + cost.totalCost);
    bucket.totalInputCost = roundCost(bucket.totalInputCost + (cost.inputCost || 0));
    bucket.totalOutputCost = roundCost(bucket.totalOutputCost + (cost.outputCost || 0));
    bucket.requests += 1;

    // 按模型聚合
    if (modelId) {
      const m = bucket.byModel.get(modelId) || {
        cost: 0,
        inputCost: 0,
        outputCost: 0,
        requests: 0,
      };
      m.cost = roundCost(m.cost + cost.totalCost);
      m.inputCost = roundCost(m.inputCost + (cost.inputCost || 0));
      m.outputCost = roundCost(m.outputCost + (cost.outputCost || 0));
      m.requests += 1;
      bucket.byModel.set(modelId, m);
    }

    // 按 provider 聚合
    if (provider) {
      const p = bucket.byProvider.get(provider) || {
        cost: 0,
        inputCost: 0,
        outputCost: 0,
        requests: 0,
      };
      p.cost = roundCost(p.cost + cost.totalCost);
      p.inputCost = roundCost(p.inputCost + (cost.inputCost || 0));
      p.outputCost = roundCost(p.outputCost + (cost.outputCost || 0));
      p.requests += 1;
      bucket.byProvider.set(provider, p);
    }
  }

  /**
   * 获取日度成本报告。
   * @param {string|Date} [date] 日期（YYYY-MM-DD 字符串或 Date 对象）；默认今天（UTC+8）
   * @returns {{ date, currency, totalCost, totalInputCost, totalOutputCost,
   *            requests, byModel: object, byProvider: object }}
   */
  getDailyCost(date) {
    const dateKey = resolveDateKey(date);
    const bucket = this.daily.get(dateKey);
    if (!bucket) {
      return {
        date: dateKey,
        currency: DEFAULT_CURRENCY,
        totalCost: 0,
        totalInputCost: 0,
        totalOutputCost: 0,
        requests: 0,
        byModel: {},
        byProvider: {},
      };
    }
    return {
      date: bucket.date,
      currency: bucket.currency,
      totalCost: bucket.totalCost,
      totalInputCost: bucket.totalInputCost,
      totalOutputCost: bucket.totalOutputCost,
      requests: bucket.requests,
      byModel: mapToPlainObject(bucket.byModel),
      byProvider: mapToPlainObject(bucket.byProvider),
    };
  }

  /**
   * 列出所有存在记录的日期（UTC+8 dateKey，升序）。
   * @returns {string[]}
   */
  listDailyKeys() {
    return [...this.daily.keys()].sort();
  }

  /**
   * 获取成本报告：按指定维度聚合过去 N 天的成本。
   * @param {'model'|'provider'|'date'|'user'} groupBy 聚合维度
   * @param {number} days 天数
   * @param {string|null} [userId] 可选：按用户过滤
   * @returns {{ groupBy, days, totalCost, totalRequests, items: Array }}
   */
  getReport(groupBy, days, userId = null) {
    const results = [];
    let totalCost = 0;
    let totalRequests = 0;
    const now = Date.now();
    const cutoffMs = now - days * 86400000;

    for (const record of this.records.values()) {
      // 时间过滤
      const recordTs = record.timestamp || record._createdAt;
      if (recordTs) {
        const ts = typeof recordTs === 'number' ? recordTs : new Date(recordTs).getTime();
        if (!Number.isNaN(ts) && ts < cutoffMs) continue;
      }

      // 用户过滤
      if (userId && record.userId && record.userId !== userId) continue;

      const cost = normalizeCost(record.cost || {});
      totalCost += cost.totalCost || 0;
      totalRequests++;

      // 按维度聚合
      const key = groupBy === 'date'
        ? resolveDateKey(recordTs)
        : groupBy === 'model'
          ? record.modelId || 'unknown'
          : groupBy === 'provider'
            ? record.provider || 'unknown'
            : groupBy === 'user'
              ? record.userId || 'anonymous'
              : record.modelId || 'unknown';

      const existing = results.find((r) => r.name === key);
      if (existing) {
        existing.cost += cost.totalCost || 0;
        existing.inputCost += cost.inputCost || 0;
        existing.outputCost += cost.outputCost || 0;
        existing.requests++;
      } else {
        results.push({
          name: key,
          cost: cost.totalCost || 0,
          inputCost: cost.inputCost || 0,
          outputCost: cost.outputCost || 0,
          requests: 1,
          currency: record.cost && record.cost.currency ? record.cost.currency : DEFAULT_CURRENCY,
        });
      }
    }

    // 按成本降序排列
    results.sort((a, b) => b.cost - a.cost);

    return {
      groupBy,
      days,
      totalCost: roundCost(totalCost),
      totalRequests,
      items: results,
    };
  }

  // --------------------------------------------------------------------------
  // 测试与诊断辅助
  // --------------------------------------------------------------------------

  /**
   * 重置内部状态（主要用于测试隔离）。
   */
  _resetForTest() {
    this.records.clear();
    this.daily.clear();
  }

  /**
   * 返回简要诊断快照（不暴露内部 Map 引用）。
   */
  snapshot() {
    return {
      modelCount: this.models.size,
      recordCount: this.records.size,
      dailyKeys: this.listDailyKeys(),
      globalBudget: summarizeBudget(this.globalBudget),
      agentBudgetCount: this.agentBudgets.size,
    };
  }
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  BudgetCheck,
  CostTracker,
  BudgetReason,
};
