// src/provider/health.js
// Smart Router Mainline - Phase 1
// Provider 健康检查模块 + 熔断器（Circuit Breaker）。
//
// 设计要点（参考 7878 cbRecord/cbAllow 与 6.5.0 改进）：
//
// ProviderHealth:
//   - 跟踪每个 provider 的调用结果（成功/失败 + 延迟）
//   - 维护 provider 状态：ACTIVE / DEGRADED / DOWN / UNKNOWN
//   - 定时探测 /v1/models 或 /models 端点（主动健康检查）
//   - 基于延迟与失败率自动降级
//
// CircuitBreaker:
//   - 标准「CLOSED → OPEN → HALF_OPEN → CLOSED」状态机
//   - 失败计数窗口（failure_window_sec）
//   - 慢调用比率检测（slow_call_ratio）
//   - HALF_OPEN 阶段限制探测调用数
//   - 按 key 维度独立熔断（如 provider:model 或 provider:keyId）
//
// 仅使用 Node.js 内置模块（含 Node 18+ 全局 fetch），无第三方依赖。

// ----------------------------------------------------------------------------
// 枚举
// ----------------------------------------------------------------------------

export const ProviderStatus = {
  ACTIVE: 'active', // 健康，正常可用
  DEGRADED: 'degraded', // 降级（延迟高或失败率偏高）
  DOWN: 'down', // 不可用（连续失败超阈值或探测失败）
  UNKNOWN: 'unknown', // 未知（尚未有调用数据）
};

export const CircuitState = {
  CLOSED: 'CLOSED', // 正常放行
  OPEN: 'OPEN', // 熔断，拒绝调用
  HALF_OPEN: 'HALF_OPEN', // 半开，允许有限探测
};

// ----------------------------------------------------------------------------
// 本地日志
// ----------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[health][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// CircuitBreaker
// ----------------------------------------------------------------------------

/**
 * 熔断器状态机。
 *
 * 状态流转：
 *   CLOSED  --(失败率 >= failure_threshold)-->  OPEN
 *   CLOSED  --(慢调用比率 > slow_call_ratio)-->   OPEN
 *   OPEN    --(经过 open_state_sec)-->            HALF_OPEN
 *   HALF_OPEN --(探测成功)-->                     CLOSED
 *   HALF_OPEN --(探测失败)-->                     OPEN
 *
 * key 维度：每个 key（如 "provider:model" 或 "provider:keyId"）独立维护熔断状态。
 *
 * @example
 * const cb = new CircuitBreaker(config.circuit_breaker);
 * if (!cb.allow('openai:gpt-4.1')) {
 *   throw new Error('circuit open');
 * }
 * // ... 调用上游 ...
 * cb.record('openai:gpt-4.1', success, latencyMs);
 */
export class CircuitBreaker {
  /**
   * @param {object} [config] circuit_breaker 配置段
   */
  constructor(config = {}, store = null) {
    this.enabled = config.enabled !== false;
    this.failureThreshold = config.failure_threshold ?? 5;
    this.failureWindowMs = (config.failure_window_sec ?? 60) * 1000;
    this.openStateMs = (config.open_state_sec ?? 120) * 1000;
    this.halfOpenMaxProbes = config.half_open_max_probes ?? config.half_open_max_calls ?? 2;
    this.slowCallThresholdMs = config.slow_call_threshold_ms ?? 30000;
    this.slowCallRatioThreshold = config.slow_call_ratio ?? 0.5;
    this.slowCallWindowMs = (config.slow_call_window_sec ?? config.slow_call_window ?? 60) * 1000;
    this.cooldownBaseMs = config.cooldown_base_ms ?? 1000;
    this.store = store || null;

    /** @type {Map<string, object>} key → 熔断记录 */
    this._records = new Map();
    if (this.store) {
      this._restorePromise = this._restoreCircuitState();
    }
  }

  /**
   * 等待熔断器状态恢复完成。
   * @returns {Promise<void>|undefined}
   */
  getRestoredPromise() {
    return this._restorePromise;
  }

  /**
   * 判断是否允许调用。
   * 在 OPEN 状态下返回 false；HALF_OPEN 状态下允许有限探测。
   *
   * @param {string} key 熔断维度键（如 "provider:model" 或 "provider:keyId"）
   * @returns {boolean}
   */
  allow(key) {
    if (!this.enabled) return true;

    const rec = this._records.get(key);
    if (!rec) return true;

    const now = Date.now();
    this._prune(rec, now);

    switch (rec.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN: {
        // 检查是否应转入 HALF_OPEN
        if (now >= rec.openUntil) {
          rec.state = CircuitState.HALF_OPEN;
          rec.halfOpenProbes = 0;
          rec.halfOpenSuccesses = 0;
          rec.halfOpenFailures = 0;
          log(`circuit "${key}" OPEN → HALF_OPEN (probing)`);
          // 放行第一个探测
          rec.halfOpenProbes++;
          return true;
        }
        return false;
      }

      case CircuitState.HALF_OPEN: {
        // 允许有限探测
        if (rec.halfOpenProbes < this.halfOpenMaxProbes) {
          rec.halfOpenProbes++;
          return true;
        }
        return false;
      }

      default:
        return true;
    }
  }

  /**
   * 记录调用结果。
   *
   * @param {string} key 熔断维度键
   * @param {boolean} success 调用是否成功
   * @param {number} [latencyMs] 调用延迟（毫秒）
   */
  record(key, success, latencyMs = 0) {
    if (!this.enabled) return;

    let rec = this._records.get(key);
    if (!rec) {
      rec = this._createRecord();
      this._records.set(key, rec);
    }

    const now = Date.now();
    this._prune(rec, now);

    const slow = latencyMs > this.slowCallThresholdMs;

    // 记录调用样本（用于慢调用比率计算）
    rec.callSamples.push({ time: now, latency: latencyMs, slow, success });

    if (rec.state === CircuitState.HALF_OPEN) {
      if (success) {
        rec.halfOpenSuccesses++;
        // 探测成功 → 关闭熔断器
        rec.state = CircuitState.CLOSED;
        rec.consecutiveFailures = 0;
        rec.failures = [];
        rec.callSamples = [];
        rec.openUntil = null;
        log(`circuit "${key}" HALF_OPEN → CLOSED (probe succeeded)`);
        this._persistCircuitState(key);
      } else {
        rec.halfOpenFailures++;
        // 探测失败 → 重新打开
        rec.state = CircuitState.OPEN;
        rec.openUntil = now + this.openStateMs;
        rec.consecutiveFailures++;
        log(`circuit "${key}" HALF_OPEN → OPEN (probe failed)`);
        this._persistCircuitState(key);
      }
      return;
    }

    // CLOSED 状态
    if (success) {
      rec.consecutiveFailures = 0;
    } else {
      rec.consecutiveFailures++;
      rec.failures.push({ time: now, latency: latencyMs });
    }

    // 检查是否应打开熔断器
    if (rec.state === CircuitState.CLOSED) {
      // 条件 1：连续失败次数达到阈值
      const failByCount = rec.consecutiveFailures >= this.failureThreshold;

      // 条件 2：窗口内失败数达到阈值
      const windowFailures = rec.failures.length;
      const failByWindow = windowFailures >= this.failureThreshold;

      // 条件 3：慢调用比率超过阈值
      let failBySlowRatio = false;
      if (rec.callSamples.length >= 4) {
        const slowCount = rec.callSamples.filter((s) => s.slow).length;
        const ratio = slowCount / rec.callSamples.length;
        failBySlowRatio = ratio > this.slowCallRatioThreshold;
      }

      if (failByCount || failByWindow || failBySlowRatio) {
        rec.state = CircuitState.OPEN;
        rec.openUntil = now + this.openStateMs;
        const reason = failByCount
          ? `consecutive failures=${rec.consecutiveFailures}`
          : failBySlowRatio
            ? `slow call ratio exceeded`
            : `window failures=${windowFailures}`;
        log(`circuit "${key}" CLOSED → OPEN (${reason})`);
        this._persistCircuitState(key);
      }
    }
  }

  /**
   * 获取指定 key 的熔断状态。
   * 注意：此方法不触发状态转换，仅返回当前记录的状态。
   * 若 OPEN 状态已到期，返回 HALF_OPEN（表示下次 allow() 会放行）。
   *
   * @param {string} key
   * @returns {string} CircuitState 枚举值
   */
  getState(key) {
    const rec = this._records.get(key);
    if (!rec) return CircuitState.CLOSED;
    const now = Date.now();
    if (rec.state === CircuitState.OPEN && now >= rec.openUntil) {
      return CircuitState.HALF_OPEN;
    }
    return rec.state;
  }

  /**
   * 手动重置指定 key 的熔断状态（强制 CLOSED）。
   * @param {string} key
   */
  reset(key) {
    const rec = this._records.get(key);
    if (!rec) return;
    rec.state = CircuitState.CLOSED;
    rec.consecutiveFailures = 0;
    rec.failures = [];
    rec.callSamples = [];
    rec.openUntil = null;
    log(`circuit "${key}" manually reset to CLOSED`);
  }

  /**
   * 重置所有熔断记录。
   */
  resetAll() {
    this._records.clear();
    log('all circuits reset');
  }

  /**
   * 获取所有熔断状态的摘要。
   * @returns {Object<string, {state: string, consecutiveFailures: number, openUntil: number|null}>}
   */
  getSummary() {
    const now = Date.now();
    const summary = {};
    for (const [key, rec] of this._records) {
      this._prune(rec, now);
      let state = rec.state;
      if (state === CircuitState.OPEN && now >= rec.openUntil) {
        state = CircuitState.HALF_OPEN;
      }
      summary[key] = {
        state,
        consecutiveFailures: rec.consecutiveFailures,
        openUntil: rec.openUntil,
        openRemainingMs: rec.openUntil ? Math.max(0, rec.openUntil - now) : 0,
      };
    }
    return summary;
  }

  // ------------------------------------------------------------------------
  // 内部方法
  // ------------------------------------------------------------------------

  _createRecord() {
    return {
      state: CircuitState.CLOSED,
      consecutiveFailures: 0,
      /** @type {Array<{time: number, latency: number}>} */
      failures: [], // 失败记录（窗口内）
      /** @type {Array<{time: number, latency: number, slow: boolean, success: boolean}>} */
      callSamples: [], // 所有调用样本（窗口内，用于慢调用比率）
      openUntil: null,
      halfOpenProbes: 0,
      halfOpenSuccesses: 0,
      halfOpenFailures: 0,
    };
  }

  /**
   * 清理过期记录。
   * @param {object} rec
   * @param {number} now
   */
  _prune(rec, now) {
    const failureCutoff = now - this.failureWindowMs;
    const slowCutoff = now - this.slowCallWindowMs;

    rec.failures = rec.failures.filter((f) => f.time > failureCutoff);
    rec.callSamples = rec.callSamples.filter((s) => s.time > slowCutoff);
  }
  // ------------------------------------------------------------------------
  // Store 持久化集成
  // ------------------------------------------------------------------------

  /**
   * 从 store 恢复熔断器状态。
   * 异步执行，不阻塞构造函数。
   */
  async _restoreCircuitState() {
    if (!this.store || typeof this.store.getAllProviderHealth !== 'function') return;
    try {
      const records = await this.store.getAllProviderHealth();
      for (const r of records) {
        if (!r.provider) continue;
        const rec = this._createRecord();
        if (r.state === 'OPEN') {
          rec.state = CircuitState.OPEN;
          rec.openUntil = Date.now() + this.openStateMs;
        } else if (r.state === 'HALF_OPEN') {
          rec.state = CircuitState.HALF_OPEN;
        }
        rec.consecutiveFailures = r.failureCount || 0;
        this._records.set(r.provider, rec);
        log('restored circuit "' + r.provider + '" state: ' + r.state);
      }
    } catch (err) {
      log('restoreCircuitState error: ' + err.message);
    }
  }

  /**
   * 持久化熔断器状态到 store。
   * 异步执行，使用 .catch() 不阻塞主流程。
   * @param {string} key
   */
  _persistCircuitState(key) {
    if (!this.store || typeof this.store.saveProviderHealth !== 'function') return;
    const rec = this._records.get(key);
    if (!rec) return;
    this.store.saveProviderHealth({
      provider: key,
      state: rec.state,
      failureCount: rec.consecutiveFailures,
      lastFailureAt: rec.failures.length > 0 ? new Date(rec.failures[rec.failures.length - 1].time).toISOString() : null,
      updatedAt: new Date().toISOString(),
    }).catch((err) => {
      log('persistCircuitState error: ' + err.message);
    });
  }
}

// ----------------------------------------------------------------------------
// ProviderHealth
// ----------------------------------------------------------------------------

/**
 * 默认配置值
 */
const DEFAULTS = {
  healthCheckIntervalMs: 30000, // 30s
  degradedLatencyMs: 10000, // avg latency > 10s → degraded
  degradedFailureRate: 0.3, // failure rate > 30% → degraded
  downConsecutiveFailures: 5, // 5 次连续失败 → down
  latencySampleWindow: 50, // 保留最近 50 次延迟样本
  probeTimeoutMs: 10000, // 探测超时 10s
};

/**
 * Provider 健康检查管理器。
 *
 * 跟踪每个 provider 的运行时健康状态，支持：
 *   - 被动记录：由 client 在每次调用后调用 recordResult()
 *   - 主动探测：定时请求 /v1/models 端点
 *
 * @example
 * const health = new ProviderHealth(config);
 * health.startHealthCheck(30000);
 * // ... 在 client 调用后 ...
 * health.recordResult('openai', true, 350);
 * if (!health.isAvailable('openai')) { ... }
 */
export class ProviderHealth {
  /**
   * @param {object} config 已加载的配置对象
   */
  constructor(config, store = null) {
    this.config = config;
    this.store = store || null;
    /** @type {Map<string, object>} providerName → 健康记录 */
    this._records = new Map();
    this._timer = null;
    this._init(config);
    if (this.store) {
      this._restorePromise = this._restoreHealthState();
    }
  }

  /**
   * 等待 Provider 健康状态恢复完成。
   * @returns {Promise<void>|undefined}
   */
  getRestoredPromise() {
    return this._restorePromise;
  }

  // --------------------------------------------------------------------------
  // 初始化
  // --------------------------------------------------------------------------

  _init(config) {
    const providers = Array.isArray(config?.providers) ? config.providers : [];
    for (const p of providers) {
      if (!p?.name) continue;
      this._records.set(p.name, {
        name: p.name,
        status: ProviderStatus.UNKNOWN,
        lastCheck: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        avgLatency: 0,
        totalRequests: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        /** @type {number[]} 最近的延迟样本（毫秒） */
        latencySamples: [],
        /** @type {Array<{time: number, success: boolean}>} 最近的调用记录 */
        recentCalls: [],
      });
    }
  }

  // --------------------------------------------------------------------------
  // 查询
  // --------------------------------------------------------------------------

  /**
   * 获取 provider 健康状态。
   * @param {string} providerName
   * @returns {object|null} 健康记录快照
   */
  getHealth(providerName) {
    const rec = this._records.get(providerName);
    if (!rec) return null;
    this._recomputeStatus(rec);
    return { ...rec, latencySamples: [...rec.latencySamples] };
  }

  /**
   * 获取所有 provider 健康摘要。
   * @returns {Object<string, object>}
   */
  getHealthSummary() {
    const now = Date.now();
    const summary = {};
    for (const [name, rec] of this._records) {
      this._recomputeStatus(rec);
      summary[name] = {
        status: rec.status,
        avgLatency: Math.round(rec.avgLatency * 100) / 100,
        totalRequests: rec.totalRequests,
        totalFailures: rec.totalFailures,
        totalSuccesses: rec.totalSuccesses,
        consecutiveFailures: rec.consecutiveFailures,
        consecutiveSuccesses: rec.consecutiveSuccesses,
        lastCheck: rec.lastCheck,
        failureRate:
          rec.totalRequests > 0
            ? Math.round((rec.totalFailures / rec.totalRequests) * 10000) / 100
            : 0,
      };
    }
    return summary;
  }

  /**
   * 判断 provider 是否可用（非 DOWN 状态）。
   * @param {string} providerName
   * @returns {boolean}
   */
  isAvailable(providerName) {
    const rec = this._records.get(providerName);
    if (!rec) return false;
    this._recomputeStatus(rec);
    return rec.status !== ProviderStatus.DOWN;
  }

  // --------------------------------------------------------------------------
  // 记录调用结果
  // --------------------------------------------------------------------------

  /**
   * 记录 provider 调用结果（由 client 在每次请求后调用）。
   *
   * @param {string} providerName
   * @param {boolean} success
   * @param {number} [latencyMs=0]
   */
  recordResult(providerName, success, latencyMs = 0) {
    let rec = this._records.get(providerName);
    if (!rec) {
      // 动态注册未知 provider
      rec = this._createRecord(providerName);
      this._records.set(providerName, rec);
    }

    const now = Date.now();
    rec.totalRequests++;

    if (success) {
      rec.totalSuccesses++;
      rec.consecutiveSuccesses++;
      rec.consecutiveFailures = 0;
    } else {
      rec.totalFailures++;
      rec.consecutiveFailures++;
      rec.consecutiveSuccesses = 0;
    }

    // 延迟样本（仅成功请求的延迟有意义，但失败也记录用于诊断）
    rec.latencySamples.push(latencyMs);
    if (rec.latencySamples.length > DEFAULTS.latencySampleWindow) {
      rec.latencySamples.shift();
    }

    // 调用记录（用于失败率计算）
    rec.recentCalls.push({ time: now, success });
    // 保留最近 100 条
    if (rec.recentCalls.length > 100) {
      rec.recentCalls.shift();
    }

    // 更新平均延迟
    if (rec.latencySamples.length > 0) {
      const sum = rec.latencySamples.reduce((a, b) => a + b, 0);
      rec.avgLatency = sum / rec.latencySamples.length;
    }

    // 重算状态
    this._recomputeStatus(rec);
    this._persistHealthState(providerName);
  }

  // --------------------------------------------------------------------------
  // 主动健康检查
  // --------------------------------------------------------------------------

  /**
   * 启动定时健康检查。
   * @param {number} [intervalMs] 检查间隔（毫秒），默认使用配置或 30s
   * @returns {NodeJS.Timeout} 定时器句柄
   */
  startHealthCheck(intervalMs) {
    if (this._timer) {
      log('health check already running, stopping previous timer');
      this.stopHealthCheck();
    }

    const interval =
      intervalMs ??
      (this.config?.routing?.health_check_interval_sec ?? 30) * 1000;

    log(`starting periodic health check every ${interval}ms`);

    this._timer = setInterval(async () => {
      await this._checkAll();
    }, interval);

    // 不阻塞进程退出
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }

    // 立即执行一次
    this._checkAll().catch((err) => {
      log(`initial health check error: ${err.message}`);
    });

    return this._timer;
  }

  /**
   * 停止定时健康检查。
   */
  stopHealthCheck() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      log('health check stopped');
    }
  }

  /**
   * 执行单次 provider 健康检查。
   * 探测 /v1/models 或 /models 端点。
   *
   * @param {string} providerName
   * @returns {Promise<boolean>} provider 是否健康
   */
  async checkProvider(providerName) {
    const provider = this.config?.providers?.find((p) => p.name === providerName);
    if (!provider) {
      log(`checkProvider: unknown provider "${providerName}"`);
      return false;
    }

    const rec = this._records.get(providerName) ?? this._createRecord(providerName);
    if (!this._records.has(providerName)) {
      this._records.set(providerName, rec);
    }

    const url = this._buildModelsUrl(provider);
    const headers = this._buildHeaders(provider);

    log(`probing ${providerName}: GET ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULTS.probeTimeoutMs);

    const startTime = Date.now();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      const latency = Date.now() - startTime;
      rec.lastCheck = Date.now();

      // 2xx → 健康
      // 401/403/429 → 服务器在线，但认证/限流有问题 → 降级
      // 5xx / 网络错误 → 不可用
      if (response.ok) {
        rec.consecutiveFailures = 0;
        rec.consecutiveSuccesses++;
        this._setStatus(rec, ProviderStatus.ACTIVE);
        log(`probe ${providerName}: OK (${latency}ms)`);
        return true;
      }

      if (response.status === 401 || response.status === 403 || response.status === 429) {
        // 服务器在线但认证/限流受限
        rec.consecutiveFailures = 0;
        this._setStatus(rec, ProviderStatus.DEGRADED);
        log(`probe ${providerName}: DEGRADED (HTTP ${response.status}, ${latency}ms)`);
        return true; // 服务器可达，视为可用
      }

      // 5xx 或其它错误
      rec.consecutiveFailures++;
      rec.consecutiveSuccesses = 0;
      if (rec.consecutiveFailures >= DEFAULTS.downConsecutiveFailures) {
        this._setStatus(rec, ProviderStatus.DOWN);
      } else {
        this._setStatus(rec, ProviderStatus.DEGRADED);
      }
      log(`probe ${providerName}: FAIL (HTTP ${response.status}, ${latency}ms)`);
      return false;
    } catch (err) {
      const latency = Date.now() - startTime;
      rec.lastCheck = Date.now();
      rec.consecutiveFailures++;
      rec.consecutiveSuccesses = 0;

      // 判断是超时还是网络错误
      const isAbort = err.name === 'AbortError' || err.code === 'ABORT_ERR';

      if (rec.consecutiveFailures >= DEFAULTS.downConsecutiveFailures) {
        this._setStatus(rec, ProviderStatus.DOWN);
      } else {
        this._setStatus(rec, ProviderStatus.DEGRADED);
      }

      log(
        `probe ${providerName}: ${isAbort ? 'TIMEOUT' : 'NETWORK_ERROR'} ` +
          `(${latency}ms, ${err.message})`
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  /**
   * 对所有 provider 执行一轮健康检查。
   */
  async _checkAll() {
    const providers = Array.isArray(this.config?.providers) ? this.config.providers : [];
    const names = providers.map((p) => p.name).filter(Boolean);
    if (names.length === 0) return;

    // 并行探测所有 provider
    await Promise.allSettled(
      names.map((name) => this.checkProvider(name).catch(() => false))
    );
  }

  /**
   * 根据当前统计数据重算 provider 状态。
   * @param {object} rec
   */
  _recomputeStatus(rec) {
    // 连续失败超阈值 → DOWN
    if (rec.consecutiveFailures >= DEFAULTS.downConsecutiveFailures) {
      this._setStatus(rec, ProviderStatus.DOWN);
      return;
    }

    // 连续成功且有调用记录 → 恢复 ACTIVE
    if (rec.consecutiveSuccesses > 0 && rec.consecutiveFailures === 0) {
      // 检查延迟和失败率
      const failRate = this._computeFailureRate(rec);
      const latencyHigh = rec.avgLatency > DEFAULTS.degradedLatencyMs;

      if (failRate > DEFAULTS.degradedFailureRate || latencyHigh) {
        this._setStatus(rec, ProviderStatus.DEGRADED);
      } else if (rec.totalRequests > 0) {
        this._setStatus(rec, ProviderStatus.ACTIVE);
      }
      return;
    }

    // 有失败但未达到 DOWN 阈值
    if (rec.consecutiveFailures > 0) {
      const failRate = this._computeFailureRate(rec);
      if (failRate > DEFAULTS.degradedFailureRate) {
        this._setStatus(rec, ProviderStatus.DEGRADED);
      }
    }
  }

  /**
   * 计算最近调用窗口内的失败率。
   * @param {object} rec
   * @returns {number} 0~1
   */
  _computeFailureRate(rec) {
    if (rec.recentCalls.length === 0) return 0;
    const failures = rec.recentCalls.filter((c) => !c.success).length;
    return failures / rec.recentCalls.length;
  }

  /**
   * 设置状态（仅记录变更日志）。
   */
  _setStatus(rec, status) {
    if (rec.status !== status) {
      log(`provider "${rec.name}" status: ${rec.status} → ${status}`);
      rec.status = status;
    }
  }

  /**
   * 创建新的健康记录。
   */
  _createRecord(name) {
    return {
      name,
      status: ProviderStatus.UNKNOWN,
      lastCheck: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      avgLatency: 0,
      totalRequests: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      latencySamples: [],
      recentCalls: [],
    };
  }

  /**
   * 构建 /models 或 /v1/models 探测 URL。
   */
  _buildModelsUrl(provider) {
    const base = String(provider.base_url || '').replace(/\/+$/, '');
    if (provider.strip_v1_prefix === true) {
      return `${base}/models`;
    }
    // 优先 /v1/models，部分 provider 可能不支持 /v1 前缀
    if (base.endsWith('/v1')) {
      return `${base}/models`;
    }
    return `${base}/v1/models`;
  }

  /**
   * 构建请求头（用于健康探测）。
   */
  _buildHeaders(provider) {
    const headers = {
      'Content-Type': 'application/json',
    };

    const authHeader = provider.auth_header || 'Authorization';
    let authPrefix;
    if (provider.auth_prefix != null) {
      authPrefix = provider.auth_prefix;
    } else if (authHeader.toLowerCase() === 'authorization') {
      authPrefix = 'Bearer ';
    } else {
      authPrefix = '';
    }
    const key = provider.api_key || '';
    headers[authHeader] = authPrefix + key;

    if (provider.version_header && provider.version_value) {
      headers[provider.version_header] = provider.version_value;
    }

    return headers;
  }
  // --------------------------------------------------------------------------
  // Store 持久化集成
  // --------------------------------------------------------------------------

  /**
   * 从 store 恢复 Provider 健康状态。
   * 异步执行，不阻塞构造函数。
   */
  async _restoreHealthState() {
    if (!this.store || typeof this.store.getAllProviderHealth !== 'function') return;
    try {
      const records = await this.store.getAllProviderHealth();
      for (const r of records) {
        const rec = this._records.get(r.provider);
        if (!rec) continue;
        if (r.state === 'active') {
          rec.status = ProviderStatus.ACTIVE;
        } else if (r.state === 'degraded') {
          rec.status = ProviderStatus.DEGRADED;
        } else if (r.state === 'down') {
          rec.status = ProviderStatus.DOWN;
        }
        rec.consecutiveFailures = r.failureCount || 0;
        log('restored provider "' + r.provider + '" status: ' + (r.state || 'unknown'));
      }
    } catch (err) {
      log('restoreHealthState error: ' + err.message);
    }
  }

  /**
   * 持久化 Provider 健康状态到 store。
   * 异步执行，使用 .catch() 不阻塞主流程。
   * @param {string} providerName
   */
  _persistHealthState(providerName) {
    if (!this.store || typeof this.store.saveProviderHealth !== 'function') return;
    const rec = this._records.get(providerName);
    if (!rec) return;
    this.store.saveProviderHealth({
      provider: providerName,
      state: rec.status,
      failureCount: rec.consecutiveFailures,
      lastFailureAt: rec.lastCheck ? new Date(rec.lastCheck).toISOString() : null,
      updatedAt: new Date().toISOString(),
    }).catch((err) => {
      log('persistHealthState error: ' + err.message);
    });
  }
}

export default { ProviderStatus, CircuitState, CircuitBreaker, ProviderHealth };
