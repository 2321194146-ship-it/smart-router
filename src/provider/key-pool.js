// src/provider/key-pool.js
// Smart Router Mainline - Phase 1
// Key 池管理器：管理每个 provider 的 API key 生命周期，
// 包括轮换、冷却、永久失效与手动禁用。
//
// 设计要点（参考 7878 key-pool 与 6.5.0 改进）：
//   - Key 轮换：按 lastUsed 时间戳排序，选择最久未使用的可用 key
//   - 401 (AUTH_INVALID)       → 永久失效（INVALID），不再尝试
//   - 403 key 级 (FORBIDDEN_KEY) → 冷却 2h
//   - 429 瞬时 (TRANSIENT)     → 冷却 30s
//   - 429 配额 (QUOTA)         → 冷却 10min
//   - 5xx (SERVER_ERROR)       → 指数退避冷却（30s * 2^n，上限 5min）
//   - 网络错误 (NETWORK_ERROR)  → 指数退避冷却（5s * 2^n，上限 60s）
//   - keyId 格式：{providerName}-{index}（如 "anthropic-0"）
//   - 支持同 provider 多 key（config 中 api_keys 数组或单 api_key 字符串）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { ErrorType, shouldDisableKey, getCooldownScope } from './errors.js';

// ----------------------------------------------------------------------------
// Key 状态枚举
// ----------------------------------------------------------------------------

export const KeyStatus = {
  ACTIVE: 'active', // 可用
  COOLING: 'cooling', // 冷却中（暂时不可用，到期后自动恢复）
  INVALID: 'invalid', // 永久失效（401），不再尝试
  DISABLED: 'disabled', // 手动禁用（管理员操作）
};

// ----------------------------------------------------------------------------
// 本地日志（避免与 config/loader 产生静态循环依赖）
// ----------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[key-pool][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// KeyPool
// ----------------------------------------------------------------------------

/**
 * Key 池管理器。
 *
 * 负责管理所有 provider 的 API key 的状态机：
 *   ACTIVE → (失败) → COOLING → (到期) → ACTIVE
 *   ACTIVE → (401)  → INVALID（永久）
 *   任意   → (手动) → DISABLED
 *
 * @example
 * const pool = new KeyPool(config);
 * const key = pool.nextKey('openai');
 * // ... 使用 key.key 调用 API ...
 * pool.markKeySucceeded('openai', key.keyId);
 */
export class KeyPool {
  /**
   * @param {object} config 已加载的配置对象
   */
  constructor(config) {
    this.config = config;
    /** @type {Map<string, object>} keyId → key 记录 */
    this._keys = new Map();
    /** @type {Map<string, string[]>} providerName → keyId 数组（保持插入顺序） */
    this._providerKeyIds = new Map();
    this._initKeys(config);
  }

  // --------------------------------------------------------------------------
  // 初始化
  // --------------------------------------------------------------------------

  /**
   * 从配置中提取所有 provider 的 key，构建内部状态。
   */
  _initKeys(config) {
    const providers = Array.isArray(config?.providers) ? config.providers : [];
    for (const provider of providers) {
      const name = provider?.name;
      if (!name) continue;

      const keyValues = this._extractKeyValues(provider);
      const keyIds = [];

      keyValues.forEach((keyValue, index) => {
        const keyId = `${name}-${index}`;
        const record = {
          provider: name,
          keyId,
          key: keyValue,
          status: KeyStatus.ACTIVE,
          cooldownUntil: null, // Date.now() 的时间戳，null 表示无冷却
          failureCount: 0,
          successCount: 0,
          lastUsed: 0,
          lastSuccess: 0,
          lastFailure: 0,
          createdAt: Date.now(),
          // 记录最近一次失败的 errorType，用于诊断
          lastErrorType: null,
        };
        this._keys.set(keyId, record);
        keyIds.push(keyId);
      });

      this._providerKeyIds.set(name, keyIds);

      if (keyValues.length === 0) {
        log(`warning: provider "${name}" has no API keys configured`);
      } else if (keyValues.length > 1) {
        log(`provider "${name}" initialized with ${keyValues.length} keys`);
      }
    }
  }

  /**
   * 从 provider 配置中提取 key 值列表。
   * 支持两种格式：
   *   - api_keys: ["key1", "key2"] （多 key，前向兼容）
   *   - api_key: "key1"           （单 key，当前配置格式）
   * @param {object} provider
   * @returns {string[]}
   */
  _extractKeyValues(provider) {
    if (Array.isArray(provider.api_keys)) {
      return provider.api_keys.filter((k) => typeof k === 'string' && k.trim());
    }
    if (typeof provider.api_key === 'string' && provider.api_key.trim()) {
      return [provider.api_key];
    }
    return [];
  }

  // --------------------------------------------------------------------------
  // 查询
  // --------------------------------------------------------------------------

  /**
   * 获取 provider 的可用 key 列表（排除冷却中、失效和禁用的）。
   * 注意：此方法会触发冷却到期检查，可能将 COOLING 状态的 key 恢复为 ACTIVE。
   *
   * @param {string} providerName
   * @returns {Array<{keyId: string, key: string, provider: string}>}
   */
  getKeys(providerName) {
    const keyIds = this._providerKeyIds.get(providerName);
    if (!keyIds || keyIds.length === 0) return [];

    const now = Date.now();
    const result = [];
    for (const keyId of keyIds) {
      const rec = this._keys.get(keyId);
      if (!rec) continue;
      if (this._checkAndRecover(rec, now)) {
        result.push({
          keyId: rec.keyId,
          key: rec.key,
          provider: rec.provider,
        });
      }
    }
    return result;
  }

  /**
   * 获取下一个可用 key（轮换策略：最久未使用优先）。
   *
   * @param {string} providerName
   * @param {string[]} [excludeKeys=[]] 需排除的 keyId 列表（已尝试失败的 key）
   * @returns {{keyId: string, key: string, provider: string}|null}
   */
  nextKey(providerName, excludeKeys = []) {
    const keyIds = this._providerKeyIds.get(providerName);
    if (!keyIds || keyIds.length === 0) return null;

    const excludeSet = new Set(excludeKeys);
    const now = Date.now();
    const candidates = [];

    for (const keyId of keyIds) {
      const rec = this._keys.get(keyId);
      if (!rec) continue;
      if (excludeSet.has(rec.keyId)) continue;
      if (this._checkAndRecover(rec, now)) {
        candidates.push(rec);
      }
    }

    if (candidates.length === 0) return null;

    // 按 lastUsed 升序排序：最久未使用的排在最前
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);

    const selected = candidates[0];
    selected.lastUsed = now;

    return {
      keyId: selected.keyId,
      key: selected.key,
      provider: selected.provider,
    };
  }

  /**
   * 检查 key 是否当前可用。
   * 会触发冷却到期恢复检查。
   *
   * @param {string} providerName
   * @param {string} keyId
   * @returns {boolean}
   */
  isKeyAvailable(providerName, keyId) {
    const rec = this._keys.get(keyId);
    if (!rec) return false;
    return this._checkAndRecover(rec, Date.now());
  }

  /**
   * 获取 key 的当前状态。
   * 会触发冷却到期恢复检查。
   *
   * @param {string} providerName
   * @param {string} keyId
   * @returns {string|null} KeyStatus 枚举值，key 不存在时返回 null
   */
  getKeyStatus(providerName, keyId) {
    const rec = this._keys.get(keyId);
    if (!rec) return null;
    this._checkAndRecover(rec, Date.now());
    return rec.status;
  }

  // --------------------------------------------------------------------------
  // 状态变更
  // --------------------------------------------------------------------------

  /**
   * 标记 key 调用成功。
   * - 重置连续失败计数
   * - 如果 key 处于冷却中，恢复为 ACTIVE
   *
   * @param {string} providerName
   * @param {string} keyId
   */
  markKeySucceeded(providerName, keyId) {
    const rec = this._keys.get(keyId);
    if (!rec) return;

    rec.successCount++;
    rec.lastSuccess = Date.now();
    rec.failureCount = 0; // 重置连续失败计数
    rec.lastErrorType = null;

    if (rec.status === KeyStatus.COOLING) {
      log(`key "${keyId}" recovered from COOLING after success`);
      rec.status = KeyStatus.ACTIVE;
      rec.cooldownUntil = null;
    }
  }

  /**
   * 标记 key 调用失败，根据错误类型决定冷却时长或永久禁用。
   *
   * 策略：
   *   - AUTH_INVALID (401)              → 永久失效 (INVALID)
   *   - FORBIDDEN_KEY (403 key 级)      → 冷却 2h
   *   - RATE_LIMIT_TRANSIENT (429 瞬时)  → 冷却 30s
   *   - RATE_LIMIT_QUOTA (429 配额)      → 冷却 10min
   *   - SERVER_ERROR (5xx)              → 指数退避（30s * 2^n，上限 5min）
   *   - NETWORK_ERROR                   → 指数退避（5s * 2^n，上限 60s）
   *   - FORBIDDEN_TEMP                  → 冷却 60s
   *   - FORBIDDEN_MODEL                 → 冷却 5min（模型问题，非 key 问题）
   *   - FORBIDDEN_PROVIDER / REGION     → 冷却 30min
   *   - CLIENT_ABORTED / UNKNOWN        → 不冷却（非 provider 故障）
   *
   * @param {string} providerName
   * @param {string} keyId
   * @param {string} errorType ErrorType 枚举值
   */
  markKeyFailed(providerName, keyId, errorType) {
    const rec = this._keys.get(keyId);
    if (!rec) return;

    rec.failureCount++;
    rec.lastFailure = Date.now();
    rec.lastErrorType = errorType;

    // 已经永久失效或手动禁用，不再变更
    if (rec.status === KeyStatus.INVALID || rec.status === KeyStatus.DISABLED) {
      return;
    }

    // 401 → 永久失效
    if (errorType === ErrorType.AUTH_INVALID) {
      rec.status = KeyStatus.INVALID;
      rec.cooldownUntil = null;
      log(`key "${keyId}" permanently disabled (AUTH_INVALID / 401)`);
      return;
    }

    // 获取冷却作用域：scope='none' 表示不影响 key 可用性
    const scope = getCooldownScope(errorType);
    if (scope === 'none') {
      // 客户端取消或未知错误：不冷却 key
      return;
    }

    // 计算冷却时长（秒）
    const cooldownSec = this._computeCooldown(errorType, rec.failureCount);

    if (cooldownSec > 0) {
      rec.status = KeyStatus.COOLING;
      rec.cooldownUntil = Date.now() + cooldownSec * 1000;
      log(
        `key "${keyId}" cooling for ${cooldownSec}s ` +
          `(errorType=${errorType}, failureCount=${rec.failureCount})`
      );
    }
  }

  /**
   * 手动禁用 key（管理员操作）。
   * @param {string} providerName
   * @param {string} keyId
   */
  disableKey(providerName, keyId) {
    const rec = this._keys.get(keyId);
    if (!rec) return;
    rec.status = KeyStatus.DISABLED;
    rec.cooldownUntil = null;
    log(`key "${keyId}" manually disabled`);
  }

  /**
   * 手动启用 key（恢复手动禁用的 key）。
   * 不会恢复永久失效 (INVALID) 的 key。
   * @param {string} providerName
   * @param {string} keyId
   */
  enableKey(providerName, keyId) {
    const rec = this._keys.get(keyId);
    if (!rec) return;
    if (rec.status === KeyStatus.DISABLED) {
      rec.status = KeyStatus.ACTIVE;
      rec.cooldownUntil = null;
      rec.failureCount = 0;
      log(`key "${keyId}" manually enabled`);
    }
  }

  /**
   * 重置指定 provider 的所有 key 状态为 ACTIVE（清除冷却和失败计数）。
   * 不会恢复永久失效 (INVALID) 或手动禁用 (DISABLED) 的 key。
   * @param {string} providerName
   */
  resetProvider(providerName) {
    const keyIds = this._providerKeyIds.get(providerName);
    if (!keyIds) return;
    for (const keyId of keyIds) {
      const rec = this._keys.get(keyId);
      if (!rec) continue;
      if (rec.status === KeyStatus.COOLING) {
        rec.status = KeyStatus.ACTIVE;
        rec.cooldownUntil = null;
        rec.failureCount = 0;
      }
    }
    log(`reset all cooling keys for provider "${providerName}"`);
  }

  // --------------------------------------------------------------------------
  // 健康摘要
  // --------------------------------------------------------------------------

  /**
   * 获取所有 key 的健康摘要。
   * @returns {Object<string, {
   *   total: number,
   *   active: number,
   *   cooling: number,
   *   invalid: number,
   *   disabled: number,
   *   keys: Array<object>
   * }>}
   */
  getKeyHealthSummary() {
    const now = Date.now();
    const summary = {};

    for (const [providerName, keyIds] of this._providerKeyIds) {
      const keys = keyIds
        .map((id) => this._keys.get(id))
        .filter(Boolean);

      // 先触发冷却到期恢复
      for (const k of keys) {
        this._checkAndRecover(k, now);
      }

      summary[providerName] = {
        total: keys.length,
        active: keys.filter((k) => k.status === KeyStatus.ACTIVE).length,
        cooling: keys.filter((k) => k.status === KeyStatus.COOLING).length,
        invalid: keys.filter((k) => k.status === KeyStatus.INVALID).length,
        disabled: keys.filter((k) => k.status === KeyStatus.DISABLED).length,
        keys: keys.map((k) => ({
          keyId: k.keyId,
          status: k.status,
          failureCount: k.failureCount,
          successCount: k.successCount,
          lastUsed: k.lastUsed,
          lastSuccess: k.lastSuccess,
          lastFailure: k.lastFailure,
          lastErrorType: k.lastErrorType,
          cooldownUntil: k.cooldownUntil,
          cooldownRemainingMs: k.cooldownUntil
            ? Math.max(0, k.cooldownUntil - now)
            : 0,
        })),
      };
    }

    return summary;
  }

  /**
   * 获取指定 provider 的 keyId 列表。
   * @param {string} providerName
   * @returns {string[]}
   */
  getKeyIds(providerName) {
    const keyIds = this._providerKeyIds.get(providerName);
    return keyIds ? [...keyIds] : [];
  }

  /**
   * 获取 key 的原始记录（用于诊断/调试）。
   * @param {string} keyId
   * @returns {object|null}
   */
  getKeyRecord(keyId) {
    const rec = this._keys.get(keyId);
    if (!rec) return null;
    this._checkAndRecover(rec, Date.now());
    return { ...rec };
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  /**
   * 检查 key 是否可用，若冷却到期则自动恢复为 ACTIVE。
   * @param {object} rec key 记录
   * @param {number} now 当前时间戳
   * @returns {boolean} key 是否可用
   */
  _checkAndRecover(rec, now) {
    if (rec.status === KeyStatus.INVALID || rec.status === KeyStatus.DISABLED) {
      return false;
    }
    if (rec.status === KeyStatus.COOLING) {
      if (rec.cooldownUntil && now >= rec.cooldownUntil) {
        // 冷却到期，自动恢复
        rec.status = KeyStatus.ACTIVE;
        rec.cooldownUntil = null;
        // 注意：不重置 failureCount，仅恢复可用状态
        // failureCount 在 markKeySucceeded 时重置
        log(`key "${rec.keyId}" cooldown expired, recovered to ACTIVE`);
        return true;
      }
      return false;
    }
    // ACTIVE
    return true;
  }

  /**
   * 根据错误类型和连续失败次数计算冷却时长（秒）。
   *
   * @param {string} errorType ErrorType 枚举值
   * @param {number} failureCount 连续失败次数
   * @returns {number} 冷却时长（秒），0 表示不冷却
   */
  _computeCooldown(errorType, failureCount) {
    switch (errorType) {
      case ErrorType.AUTH_INVALID:
        // 永久失效由调用方处理，此处不返回
        return 0;

      case ErrorType.FORBIDDEN_KEY:
        // 403 key 级 → 冷却 2h
        return 7200;

      case ErrorType.RATE_LIMIT_TRANSIENT:
        // 429 瞬时 → 冷却 30s
        return 30;

      case ErrorType.RATE_LIMIT_QUOTA:
        // 429 配额 → 冷却 10min
        return 600;

      case ErrorType.SERVER_ERROR:
        // 5xx → 指数退避：30s * 2^(n-1)，上限 300s（5min）
        return Math.min(30 * Math.pow(2, Math.max(0, failureCount - 1)), 300);

      case ErrorType.NETWORK_ERROR:
        // 网络错误 → 指数退避：5s * 2^(n-1)，上限 60s
        return Math.min(5 * Math.pow(2, Math.max(0, failureCount - 1)), 60);

      case ErrorType.FORBIDDEN_TEMP:
        // 403 临时 → 冷却 60s
        return 60;

      case ErrorType.FORBIDDEN_MODEL:
        // 403 model 级 → 冷却 5min（模型问题，key 本身可能没问题）
        return 300;

      case ErrorType.FORBIDDEN_PROVIDER:
      case ErrorType.FORBIDDEN_REGION:
        // 403 provider/region 级 → 冷却 30min
        return 1800;

      case ErrorType.CLIENT_ABORTED:
      case ErrorType.UNKNOWN:
      default:
        // 客户端取消或未知错误 → 不冷却
        return 0;
    }
  }
}

export default { KeyStatus, KeyPool };
