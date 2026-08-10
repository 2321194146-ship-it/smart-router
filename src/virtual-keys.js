// Local virtual API key policy and concurrency guard.
// Raw keys are only accepted on create and are never returned by list/get APIs.

import { createHash, randomBytes } from 'node:crypto';

function hashKey(rawKey) {
  return createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

function safeNumber(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

export function generateVirtualKey() {
  return `sk-smart-${randomBytes(24).toString('base64url')}`;
}

export class VirtualKeyManager {
  constructor(config = {}) {
    this._active = new Map();
    this.load(config);
  }

  load(config = {}) {
    this._active.clear();
    for (const [rawKey, value] of Object.entries(config.virtual_keys || {})) {
      if (typeof rawKey !== 'string' || !rawKey || !value || typeof value !== 'object') continue;
      this._active.set(hashKey(rawKey), {
        hash: hashKey(rawKey),
        rawKey,
        name: typeof value.name === 'string' && value.name ? value.name : 'Unnamed',
        tenant: typeof value.tenant === 'string' && value.tenant ? value.tenant : 'default',
        models: Array.isArray(value.models) ? value.models.filter((model) => typeof model === 'string') : [],
        enabled: value.enabled !== false,
        concurrentMax: safeNumber(value.concurrent_max, 5, 0),
        concurrentUsed: 0,
        budgetMonthlyRmb: safeNumber(value.budget_monthly_rmb, 0, 0),
        spentRmb: safeNumber(value.spent_rmb, 0, 0),
        createdAt: value.created_at || new Date().toISOString(),
      });
    }
  }

  authorize(req, modelId = null) {
    const authorization = req.headers?.authorization || '';
    const rawKey = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const key = this._active.get(hashKey(rawKey));
    if (!rawKey || !key) return { allowed: true, key: null, release: () => {} };
    if (!key.enabled) return { allowed: false, status: 403, reason: 'key_disabled', key };
    if (key.budgetMonthlyRmb > 0 && key.spentRmb >= key.budgetMonthlyRmb) {
      return { allowed: false, status: 429, reason: 'budget_exceeded', key };
    }
    if (key.models.length > 0 && (!modelId || modelId === 'auto' || !key.models.includes(modelId) && !key.models.includes('*'))) {
      return { allowed: false, status: 403, reason: 'model_not_allowed', key };
    }
    if (key.concurrentMax > 0 && key.concurrentUsed >= key.concurrentMax) {
      return { allowed: false, status: 429, reason: 'concurrent_limit', key };
    }
    key.concurrentUsed += 1;
    let released = false;
    return {
      allowed: true,
      key,
      release: () => {
        if (released) return;
        released = true;
        key.concurrentUsed = Math.max(0, key.concurrentUsed - 1);
      },
    };
  }

  list() {
    return [...this._active.values()].map((key) => ({
      hash: key.hash,
      name: key.name,
      tenant: key.tenant,
      budget_monthly_rmb: key.budgetMonthlyRmb,
      spent_rmb: key.spentRmb,
      budget_percent: key.budgetMonthlyRmb > 0 ? Math.round(key.spentRmb / key.budgetMonthlyRmb * 100) : 0,
      models: [...key.models],
      enabled: key.enabled,
      concurrent_max: key.concurrentMax,
      concurrent_used: key.concurrentUsed,
      created_at: key.createdAt,
    }));
  }

  stats() {
    const keys = this.list();
    const totalBudget = keys.reduce((sum, key) => sum + key.budget_monthly_rmb, 0);
    const totalSpent = keys.reduce((sum, key) => sum + key.spent_rmb, 0);
    return {
      total_keys: keys.length,
      active_keys: keys.filter((key) => key.enabled).length,
      total_budget_rmb: Math.round(totalBudget * 100) / 100,
      total_spent_rmb: Math.round(totalSpent * 10000) / 10000,
      budget_percent: totalBudget > 0 ? Math.round(totalSpent / totalBudget * 100) : 0,
    };
  }
}

export function virtualKeyHash(rawKey) {
  return hashKey(rawKey);
}
