// src/config/validator.js
// Smart Router Mainline - Phase 1
// 配置验证器：结构完整性 / 模型唯一性 / provider 合法性 / agent 引用 / budget 安全接口
//
// 仅使用 Node.js 内置模块，无第三方依赖。
// 导出 validateConfig(config) -> { valid, errors, warnings }

// ----------------------------------------------------------------------------
// 规则定义
// ----------------------------------------------------------------------------

const TIER_NAMES = new Set(['tier1', 'tier2', 'tier3']);

const BUDGET_FIELDS = {
  allowPaid: 'boolean',
  maxRequestCost: 'number',
  allowedModels: 'array',
  allowedProviders: 'array',
  strictModel: 'boolean',
};

/**
 * 验证主入口。
 * @param {object} config
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    errors.push('config must be a non-null object');
    return { valid: false, errors, warnings };
  }

  // 各分区校验（顺序敏感：先结构，后语义，后引用）
  validateTopLevel(config, errors, warnings);
  validateServer(config.server, errors, warnings);
  validateIntelligence(config.intelligence, errors, warnings);
  validateRouting(config.routing, errors, warnings);
  validateProviders(config.providers, errors, warnings);
  validateModels(config.models, config.providers, errors, warnings);
  validateAgentBindings(config.agent_bindings, config.models, config.providers, errors, warnings);
  validateBudget(config.budget, errors, warnings);
  validateCircuitBreaker(config.circuit_breaker, errors, warnings);

  return { valid: errors.length === 0, errors, warnings };
}

// ----------------------------------------------------------------------------
// 顶层结构
// ----------------------------------------------------------------------------

function validateTopLevel(config, errors, warnings) {
  const required = [
    'server',
    'intelligence',
    'routing',
    'models',
    'providers',
    'agent_bindings',
    'budget',
    'circuit_breaker',
  ];
  for (const key of required) {
    if (!(key in config)) {
      errors.push(`missing top-level field: "${key}"`);
    }
  }
}

// ----------------------------------------------------------------------------
// server
// ----------------------------------------------------------------------------

function validateServer(server, errors, warnings) {
  if (!server || typeof server !== 'object') {
    errors.push('server must be an object');
    return;
  }
  if (typeof server.host !== 'string' || !server.host.trim()) {
    errors.push('server.host must be a non-empty string');
  }
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    errors.push('server.port must be an integer in [1, 65535]');
  }
  if (server.request_timeout_ms !== undefined) {
    if (!Number.isFinite(server.request_timeout_ms) || server.request_timeout_ms <= 0) {
      errors.push('server.request_timeout_ms must be a positive number');
    }
  }
  if (server.shutdown_grace_ms !== undefined) {
    if (!Number.isFinite(server.shutdown_grace_ms) || server.shutdown_grace_ms < 0) {
      errors.push('server.shutdown_grace_ms must be a non-negative number');
    }
  }
  if (server.max_request_body_bytes !== undefined) {
    if (!Number.isInteger(server.max_request_body_bytes) || server.max_request_body_bytes <= 0) {
      errors.push('server.max_request_body_bytes must be a positive integer');
    }
  }

  // 安全提醒：绑定到 0.0.0.0 需要确认
  if (typeof server.host === 'string' && (server.host === '0.0.0.0' || server.host === '::')) {
    warnings.push(
      `server.host="${server.host}" binds to all interfaces; ensure network access is restricted`
    );
  }
}

// ----------------------------------------------------------------------------
// intelligence
// ----------------------------------------------------------------------------

function validateIntelligence(intel, errors, warnings) {
  if (!intel || typeof intel !== 'object') {
    errors.push('intelligence must be an object');
    return;
  }
  // Phase 1 主干仅支持 off；Phase2-A Shadow 新增 shadow 模式（不改变执行路径）
  const allowedModes = new Set(['off', 'assist', 'auto', 'shadow']);
  if (!('mode' in intel)) {
    errors.push('intelligence.mode is required');
  } else if (!allowedModes.has(intel.mode)) {
    errors.push(
      `intelligence.mode must be one of ${[...allowedModes].join(', ')} (got "${intel.mode}")`
    );
  }
  if (intel.mode !== undefined && intel.mode !== 'off' && intel.mode !== 'shadow') {
    warnings.push(
      `intelligence.mode="${intel.mode}" is set, but Phase 1/2-A expects "off" or "shadow"`
    );
  }
}

// ----------------------------------------------------------------------------
// routing
// ----------------------------------------------------------------------------

function validateRouting(routing, errors, warnings) {
  if (!routing || typeof routing !== 'object') {
    errors.push('routing must be an object');
    return;
  }
  if (routing.tier_weights !== undefined) {
    if (routing.tier_weights === null || typeof routing.tier_weights !== 'object') {
      errors.push('routing.tier_weights must be an object');
    } else {
      for (const [tier, w] of Object.entries(routing.tier_weights)) {
        if (!TIER_NAMES.has(tier)) {
          warnings.push(`routing.tier_weights has unknown tier "${tier}"`);
        }
        if (typeof w !== 'number' || w < 0) {
          errors.push(`routing.tier_weights["${tier}"] must be a non-negative number`);
        }
      }
    }
  }
  if (routing.max_concurrent !== undefined) {
    if (!Number.isInteger(routing.max_concurrent) || routing.max_concurrent < 1) {
      errors.push('routing.max_concurrent must be a positive integer');
    }
  }
  if (routing.max_retries !== undefined) {
    if (!Number.isInteger(routing.max_retries) || routing.max_retries < 0) {
      errors.push('routing.max_retries must be a non-negative integer');
    }
  }
  if (routing.retry_backoff_ms !== undefined) {
    if (!Number.isFinite(routing.retry_backoff_ms) || routing.retry_backoff_ms < 0) {
      errors.push('routing.retry_backoff_ms must be a non-negative number');
    }
  }
  if (routing.cooldown_default_sec !== undefined) {
    if (!Number.isFinite(routing.cooldown_default_sec) || routing.cooldown_default_sec < 0) {
      errors.push('routing.cooldown_default_sec must be a non-negative number');
    }
  }
}

// ----------------------------------------------------------------------------
// providers
// ----------------------------------------------------------------------------

function validateProviders(providers, errors, warnings) {
  if (!Array.isArray(providers)) {
    errors.push('providers must be an array');
    return null;
  }
  if (providers.length === 0) {
    errors.push('providers must contain at least one provider');
    return null;
  }

  const names = new Set();
  providers.forEach((p, idx) => {
    const ctx = `providers[${idx}]`;
    if (!p || typeof p !== 'object') {
      errors.push(`${ctx} must be an object`);
      return;
    }
    if (typeof p.name !== 'string' || !p.name.trim()) {
      errors.push(`${ctx}.name must be a non-empty string`);
      return;
    }
    if (names.has(p.name)) {
      errors.push(`${ctx}.name duplicate provider name "${p.name}"`);
    }
    names.add(p.name);

    if (typeof p.base_url !== 'string' || !isValidHttpUrl(p.base_url)) {
      errors.push(`${ctx}.base_url must be a valid http(s) URL (got "${p.base_url}")`);
    }

    // api_key 存在性检查
    if (p.api_key === undefined || p.api_key === null || String(p.api_key).trim() === '') {
      errors.push(`${ctx}.api_key is missing or empty`);
    } else if (typeof p.api_key === 'string' && isPlaceholderKey(p.api_key)) {
      warnings.push(`${ctx}.api_key looks like a placeholder ("${p.api_key}"); replace before production`);
    }

    if (p.auth_header !== undefined && typeof p.auth_header !== 'string') {
      errors.push(`${ctx}.auth_header must be a string if present`);
    }
  });

  return names;
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPlaceholderKey(value) {
  const v = value.trim();
  return (
    /^REPLACE_WITH/i.test(v) ||
    /YOUR.*KEY/i.test(v) ||
    /^changeme$/i.test(v) ||
    /^<.*>$/i.test(v) ||
    v === ''
  );
}

// ----------------------------------------------------------------------------
// models
// ----------------------------------------------------------------------------

function validateModels(models, providers, errors, warnings) {
  if (!Array.isArray(models)) {
    errors.push('models must be an array');
    return null;
  }
  if (models.length === 0) {
    errors.push('models must contain at least one model');
    return null;
  }

  const providerNames = new Set(
    Array.isArray(providers) ? providers.map((p) => p?.name).filter(Boolean) : []
  );

  const ids = new Set();
  const apiModelKeys = new Set();

  models.forEach((m, idx) => {
    const ctx = `models[${idx}]`;
    if (!m || typeof m !== 'object') {
      errors.push(`${ctx} must be an object`);
      return;
    }
    // 必需字段
    for (const f of ['id', 'provider', 'apiModel', 'tier']) {
      if (typeof m[f] !== 'string' || !m[f].trim()) {
        errors.push(`${ctx}.${f} must be a non-empty string`);
      }
    }
    // id 唯一
    if (typeof m.id === 'string' && m.id.trim()) {
      if (ids.has(m.id)) {
        errors.push(`${ctx}.id duplicate model id "${m.id}"`);
      }
      ids.add(m.id);
    }
    // (provider + apiModel) 组合唯一性（同一 provider 不允许重复 apiModel）
    if (typeof m.provider === 'string' && typeof m.apiModel === 'string' && m.provider && m.apiModel) {
      const combo = `${m.provider}::${m.apiModel}`;
      if (apiModelKeys.has(combo)) {
        errors.push(`${ctx} duplicate (provider,apiModel) combination "${combo}"`);
      }
      apiModelKeys.add(combo);
    }
    // provider 引用存在
    if (typeof m.provider === 'string' && m.provider && providerNames.size > 0 && !providerNames.has(m.provider)) {
      errors.push(`${ctx}.provider "${m.provider}" not found in providers list`);
    }
    // tier 合法
    if (typeof m.tier === 'string' && m.tier && !TIER_NAMES.has(m.tier)) {
      errors.push(`${ctx}.tier "${m.tier}" is not a valid tier (expected ${[...TIER_NAMES].join('/')})`);
    }
    // paid 字段类型
    if ('paid' in m && typeof m.paid !== 'boolean') {
      errors.push(`${ctx}.paid must be a boolean`);
    }
    // enabled 字段类型
    if ('enabled' in m && typeof m.enabled !== 'boolean') {
      errors.push(`${ctx}.enabled must be a boolean`);
    }
    // capability
    if ('capability' in m) {
      if (!Array.isArray(m.capability)) {
        errors.push(`${ctx}.capability must be an array`);
      } else {
        for (const c of m.capability) {
          if (typeof c !== 'string' || !c.trim()) {
            errors.push(`${ctx}.capability contains a non-string element`);
            break;
          }
        }
      }
    }
    // max_tokens
    if ('max_tokens' in m) {
      if (!Number.isInteger(m.max_tokens) || m.max_tokens <= 0) {
        errors.push(`${ctx}.max_tokens must be a positive integer`);
      }
    }
  });

  return ids;
}

// ----------------------------------------------------------------------------
// agent_bindings
// ----------------------------------------------------------------------------

function validateAgentBindings(bindings, models, providers, errors, warnings) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    errors.push('agent_bindings must be an object');
    return;
  }

  const modelIds = new Set(
    Array.isArray(models) ? models.map((m) => m?.id).filter(Boolean) : []
  );
  const providerNames = new Set(
    Array.isArray(providers) ? providers.map((p) => p?.name).filter(Boolean) : []
  );

  const agentIds = Object.keys(bindings);
  if (agentIds.length === 0) {
    warnings.push('agent_bindings is empty; all agents will use the global model pool');
  }

  for (const agentId of agentIds) {
    const ctx = `agent_bindings["${agentId}"]`;
    const b = bindings[agentId];
    if (!b || typeof b !== 'object') {
      errors.push(`${ctx} must be an object`);
      continue;
    }

    // model_ids
    if ('model_ids' in b) {
      if (!Array.isArray(b.model_ids)) {
        errors.push(`${ctx}.model_ids must be an array`);
      } else {
        const seen = new Set();
        for (const mid of b.model_ids) {
          if (typeof mid !== 'string' || !mid.trim()) {
            errors.push(`${ctx}.model_ids contains a non-string element`);
            break;
          }
          if (modelIds.size > 0 && !modelIds.has(mid)) {
            errors.push(`${ctx}.model_ids references unknown model "${mid}"`);
          }
          if (seen.has(mid)) {
            errors.push(`${ctx}.model_ids has duplicate "${mid}"`);
          }
          seen.add(mid);
        }
        // 空池语义：空数组合法（表示不限制），但给出提示
        if (b.model_ids.length === 0) {
          warnings.push(`${ctx}.model_ids is empty (null-pool: no model restriction)`);
        }
      }
    } else {
      warnings.push(`${ctx}.model_ids missing; agent will use the global model pool`);
    }

    // budget（若存在则校验安全接口字段）
    if ('budget' in b) {
      validateBudget(b.budget, errors, warnings, `${ctx}.budget`, modelIds, providerNames);
    }
  }
}

// ----------------------------------------------------------------------------
// budget（安全接口）
// ----------------------------------------------------------------------------

function validateBudget(budget, errors, warnings, ctx = 'budget', modelIds, providerNames) {
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
    errors.push(`${ctx} must be an object`);
    return;
  }

  for (const [field, type] of Object.entries(BUDGET_FIELDS)) {
    if (!(field in budget)) continue; // 字段可选；缺失时合并全局默认值
    const v = budget[field];
    switch (type) {
      case 'boolean':
        if (typeof v !== 'boolean') errors.push(`${ctx}.${field} must be a boolean`);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          errors.push(`${ctx}.${field} must be a non-negative number`);
        }
        break;
      case 'array':
        if (!Array.isArray(v)) {
          errors.push(`${ctx}.${field} must be an array`);
        } else {
          for (const item of v) {
            if (typeof item !== 'string' || !item.trim()) {
              errors.push(`${ctx}.${field} contains a non-string element`);
              break;
            }
          }
        }
        break;
    }
  }

  // 语义校验
  if (budget.allowPaid === false && budget.allowedModels && budget.allowedModels.length > 0) {
    warnings.push(`${ctx}.allowPaid=false but allowedModels is non-empty; verify intent`);
  }

  // 引用校验（仅当上下文提供了已知集合）
  if (modelIds && modelIds.size > 0 && Array.isArray(budget.allowedModels)) {
    for (const m of budget.allowedModels) {
      if (!modelIds.has(m)) {
        errors.push(`${ctx}.allowedModels references unknown model "${m}"`);
      }
    }
  }
  if (providerNames && providerNames.size > 0 && Array.isArray(budget.allowedProviders)) {
    for (const p of budget.allowedProviders) {
      if (!providerNames.has(p)) {
        errors.push(`${ctx}.allowedProviders references unknown provider "${p}"`);
      }
    }
  }

  // strictModel 与 allowedModels 的一致性
  if (budget.strictModel === true && (!budget.allowedModels || budget.allowedModels.length === 0)) {
    warnings.push(`${ctx}.strictModel=true but allowedModels is empty; strictModel has no effect`);
  }
}

// ----------------------------------------------------------------------------
// circuit_breaker
// ----------------------------------------------------------------------------

function validateCircuitBreaker(cb, errors, warnings) {
  if (cb === undefined) return; // 可选分区
  if (cb === null || typeof cb !== 'object' || Array.isArray(cb)) {
    errors.push('circuit_breaker must be an object');
    return;
  }
  if (cb.enabled !== undefined && typeof cb.enabled !== 'boolean') {
    errors.push('circuit_breaker.enabled must be a boolean');
  }
  if (cb.failure_threshold !== undefined) {
    if (!Number.isInteger(cb.failure_threshold) || cb.failure_threshold < 1) {
      errors.push('circuit_breaker.failure_threshold must be a positive integer');
    }
  }
  if (cb.failure_window_sec !== undefined) {
    if (!Number.isFinite(cb.failure_window_sec) || cb.failure_window_sec <= 0) {
      errors.push('circuit_breaker.failure_window_sec must be a positive number');
    }
  }
  if (cb.open_state_sec !== undefined) {
    if (!Number.isFinite(cb.open_state_sec) || cb.open_state_sec <= 0) {
      errors.push('circuit_breaker.open_state_sec must be a positive number');
    }
  }
  if (cb.half_open_max_calls !== undefined) {
    if (!Number.isInteger(cb.half_open_max_calls) || cb.half_open_max_calls < 1) {
      errors.push('circuit_breaker.half_open_max_calls must be a positive integer');
    }
  }
  if (cb.key_disable_on_auth_invalid !== undefined) {
    if (typeof cb.key_disable_on_auth_invalid !== 'boolean') {
      errors.push('circuit_breaker.key_disable_on_auth_invalid must be a boolean');
    }
  }
}

export default {
  validateConfig,
};
