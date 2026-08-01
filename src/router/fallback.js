// src/router/fallback.js
// Smart Router Mainline - Phase 1
// Fallback 链管理：串行 Fallback 决策引擎，决定「是否切换到下一个候选」以及「切换到哪个」。
//
// 设计要点（参考 7878 和 6.5.0 的改进）：
//   - 串行 Fallback，不实现并行竞速
//   - 首字节后禁止切换模型（firstByteReceived 标记后不再 fallback）
//   - key 级错误 → 同 provider 下一 key（不切换候选）
//   - provider 级错误 → 排除当前 provider，下一 provider
//   - model 级错误 → 切换到下一个候选
//   - 非重试错误（UNKNOWN）→ 不 fallback
//   - client_aborted 单独归因，不记为模型质量失败
//   - 免费失败后受控付费 Fallback：attemptedFree + freeFailedRetriable
//   - 禁付费时付费模型绝不执行
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { ErrorType, isRetriable, getCooldownScope } from '../provider/errors.js';

// ----------------------------------------------------------------------------
// 日志
// ----------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[fallback][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// FallbackDecision：Fallback 决策结果
// ----------------------------------------------------------------------------

/**
 * Fallback 决策结果。
 *
 * @property {boolean} shouldFallback 是否应该尝试下一个候选
 * @property {object|null} nextCandidate 下一个候选（shouldFallback=false 时为 null）
 * @property {string} reason 决策原因：
 *   'ok' | 'no_more_candidates' | 'first_byte_received' |
 *   'client_aborted' | 'budget_blocked' | 'non_retriable_error'
 */
export class FallbackDecision {
  constructor(shouldFallback, nextCandidate, reason) {
    this.shouldFallback = !!shouldFallback;
    this.nextCandidate = nextCandidate || null;
    this.reason = reason || 'ok';
  }

  toJSON() {
    return {
      shouldFallback: this.shouldFallback,
      reason: this.reason,
      nextCandidate: this.nextCandidate
        ? {
            modelId: this.nextCandidate.modelId,
            provider: this.nextCandidate.provider,
            paid: this.nextCandidate.paid,
            tier: this.nextCandidate.tier,
          }
        : null,
    };
  }
}

// ----------------------------------------------------------------------------
// FallbackChain：Fallback 链管理器
// ----------------------------------------------------------------------------

/**
 * Fallback 链管理器。
 *
 * 管理候选列表的遍历与 Fallback 决策。核心职责：
 *   - 根据上次错误类型决定是否切换候选、切换到哪个
 *   - key 级错误不切换候选（由执行引擎尝试同 provider 的不同 key）
 *   - provider 级错误排除当前 provider
 *   - model 级非重试错误排除当前 model
 *   - 首字节后禁止切换
 *   - 免费失败后受控付费 Fallback
 *   - 禁付费时跳过付费候选
 *
 * @example
 * const chain = new FallbackChain(candidates, config);
 * let decision = chain.next(); // 获取第一个候选
 * while (decision.shouldFallback) {
 *   const candidate = decision.nextCandidate;
 *   // ... 尝试候选 ...
 *   if (success) break;
 *   decision = chain.next({ lastError: error, firstByteReceived, clientAborted });
 * }
 */
export class FallbackChain {
  /**
   * @param {Array<object>} candidates 候选列表（由 buildCandidates 构建）
   * @param {object} config 已加载的配置对象
   */
  constructor(candidates, config) {
    this.candidates = Array.isArray(candidates) ? candidates : [];
    this.currentIndex = 0;
    this.attemptedCandidates = [];
    this.excludeProviders = new Set();
    this.excludeModels = new Set();
    this.firstByteReceived = false;
    this.maxAttempts = config?.routing?.max_retries ?? 3;
    this.attemptCount = 0;

    // 免费→付费 Fallback 控制
    this.attemptedFree = false;
    this.freeFailedRetriable = false;
    this.allowPaid = true;

    // 从 config/budget 解析 allowPaid
    if (config?.budget && typeof config.budget.allowPaid === 'boolean') {
      this.allowPaid = config.budget.allowPaid;
    }
  }

  // --------------------------------------------------------------------------
  // 核心：获取下一个候选
  // --------------------------------------------------------------------------

  /**
   * 获取下一个候选。
   *
   * 规则：
   *   1. 如果 clientAborted，不 fallback
   *   2. 如果 firstByteReceived=true，不 fallback（首字节后禁止切换模型）
   *   3. 如果 budgetBlocked，不 fallback
   *   4. 检查 maxAttempts 上限
   *   5. 如果 lastError 是 CLIENT_ABORTED → 不 fallback
   *   6. 如果 lastError 是非重试错误且 scope=none（如 UNKNOWN）→ 不 fallback
   *   7. 如果 lastError 是 key 级错误 → 同候选（不切换，由执行引擎换 key）
   *   8. 如果 lastError 是 provider 级错误 → 排除当前 provider，下一候选
   *   9. 如果 lastError 是 model 级错误 → 切换到下一候选
   *  10. 如果所有候选耗尽，返回 no_more_candidates
   *  11. 免费失败后受控付费 Fallback：attemptedFree=true 且 freeFailedRetriable=true 时允许付费
   *  12. 禁付费时付费模型绝不执行
   *
   * @param {object} [options]
   * @param {object|null} [options.lastError] 上次错误（ProviderError 或 { type: string }）
   * @param {boolean} [options.firstByteReceived] 首字节是否已收到
   * @param {boolean} [options.clientAborted] 客户端是否已断开
   * @param {boolean} [options.budgetBlocked] 预算是否已耗尽
   * @returns {FallbackDecision}
   */
  next(options = {}) {
    // 规则 1：客户端断开
    if (options.clientAborted) {
      return new FallbackDecision(false, null, 'client_aborted');
    }

    // 规则 2：首字节后禁止切换
    if (options.firstByteReceived || this.firstByteReceived) {
      return new FallbackDecision(false, null, 'first_byte_received');
    }

    // 规则 3：预算耗尽
    if (options.budgetBlocked) {
      return new FallbackDecision(false, null, 'budget_blocked');
    }

    // 规则 4：maxAttempts 上限（至少尝试过一次后才检查）
    if (this.attemptCount >= this.maxAttempts && this.attemptedCandidates.length > 0) {
      log(`max attempts reached (${this.attemptCount}/${this.maxAttempts})`);
      return new FallbackDecision(false, null, 'no_more_candidates');
    }

    // 处理上次错误
    if (options.lastError) {
      const errorType = options.lastError.type || options.lastError;
      const scope = getCooldownScope(errorType);

      // 规则 5：CLIENT_ABORTED → 不 fallback
      if (errorType === ErrorType.CLIENT_ABORTED) {
        return new FallbackDecision(false, null, 'client_aborted');
      }

      // 规则 6：非重试错误且 scope=none（UNKNOWN 等）→ 不 fallback
      if (scope === 'none') {
        return new FallbackDecision(false, null, 'non_retriable_error');
      }

      // 更新免费→付费 Fallback 状态
      this._updateFreePaidState(errorType);

      // 规则 7：key 级错误 → 同候选（不切换，由执行引擎换 key）
      if (scope === 'key') {
        const candidate = this._current();
        if (!candidate) {
          return new FallbackDecision(false, null, 'no_more_candidates');
        }
        return new FallbackDecision(true, candidate, 'ok');
      }

      // 规则 8/9：provider 级或 model 级错误 → 前进到下一候选
      // provider 级：排除当前 provider
      const currentCandidate = this.candidates[this.currentIndex];
      if (currentCandidate) {
        if (scope === 'provider') {
          this.excludeProviders.add(currentCandidate.provider);
        }
        // model 级非重试错误：排除当前 model
        if (scope === 'model' && !isRetriable(errorType)) {
          this.excludeModels.add(currentCandidate.modelId);
        }
      }

      // 前进到下一候选
      this.currentIndex++;
    }

    // 查找下一个有效候选
    const candidate = this._current();
    if (!candidate) {
      return new FallbackDecision(false, null, 'no_more_candidates');
    }
    return new FallbackDecision(true, candidate, 'ok');
  }

  // --------------------------------------------------------------------------
  // 状态标记
  // --------------------------------------------------------------------------

  /**
   * 标记首字节已收到（首字节后禁止切换模型）。
   */
  markFirstByte() {
    if (!this.firstByteReceived) {
      log('first byte received, model switching disabled');
    }
    this.firstByteReceived = true;
  }

  /**
   * 标记候选已尝试。
   * @param {object} candidate 已尝试的候选
   */
  markAttempted(candidate) {
    this.attemptedCandidates.push(candidate);
    this.attemptCount++;
  }

  /**
   * 手动排除 provider（执行引擎在 key 耗尽时调用）。
   * @param {string} providerName
   */
  excludeProvider(providerName) {
    if (providerName) {
      this.excludeProviders.add(providerName);
    }
  }

  /**
   * 手动排除 model（执行引擎在模型不可用时调用）。
   * @param {string} modelId
   */
  excludeModel(modelId) {
    if (modelId) {
      this.excludeModels.add(modelId);
    }
  }

  // --------------------------------------------------------------------------
  // 查询
  // --------------------------------------------------------------------------

  /**
   * 检查是否还有有效候选（未被排除、未被跳过）。
   * @returns {boolean}
   */
  hasMore() {
    for (let i = this.currentIndex; i < this.candidates.length; i++) {
      const c = this.candidates[i];
      if (this._isCandidateValid(c)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取已尝试的候选列表。
   * @returns {Array<object>}
   */
  getAttempted() {
    return [...this.attemptedCandidates];
  }

  /**
   * 获取已尝试的候选数量。
   * @returns {number}
   */
  getAttemptCount() {
    return this.attemptCount;
  }

  /**
   * 获取已尝试的不同 provider 数量。
   * @returns {number}
   */
  getDistinctProviderCount() {
    const providers = new Set(
      this.attemptedCandidates.map((c) => c.provider)
    );
    return providers.size;
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  /**
   * 获取当前有效候选（跳过被排除的 provider/model/付费候选）。
   * 会推进 currentIndex 直到找到有效候选或到达末尾。
   * @returns {object|null}
   */
  _current() {
    while (this.currentIndex < this.candidates.length) {
      const c = this.candidates[this.currentIndex];
      if (this._isCandidateValid(c)) {
        return c;
      }
      this.currentIndex++;
    }
    return null;
  }

  /**
   * 判断候选是否有效（未被排除、未被付费限制）。
   * @param {object} candidate
   * @returns {boolean}
   */
  _isCandidateValid(candidate) {
    if (!candidate) return false;

    // 排除 provider
    if (this.excludeProviders.has(candidate.provider)) {
      return false;
    }

    // 排除 model
    if (this.excludeModels.has(candidate.modelId)) {
      return false;
    }

    // 禁付费时跳过付费候选
    if (!this.allowPaid && candidate.paid) {
      return false;
    }

    // 免费→付费受控 Fallback：
    // 如果已尝试免费模型且免费失败不可重试，则跳过付费候选
    if (this.attemptedFree && !this.freeFailedRetriable && candidate.paid) {
      return false;
    }

    return true;
  }

  /**
   * 更新免费→付费 Fallback 状态。
   *
   * 当一个免费候选失败时：
   *   - 设置 attemptedFree=true
   *   - 如果错误可重试，设置 freeFailedRetriable=true（允许付费 Fallback）
   *   - 如果错误不可重试，设置 freeFailedRetriable=false（禁止付费 Fallback）
   *
   * @param {string} errorType 错误类型
   */
  _updateFreePaidState(errorType) {
    const lastCandidate = this.attemptedCandidates[this.attemptedCandidates.length - 1];
    if (!lastCandidate) return;

    if (!lastCandidate.paid) {
      // 免费候选失败
      this.attemptedFree = true;
      this.freeFailedRetriable = isRetriable(errorType);
      log(
        `free candidate failed (retriable=${this.freeFailedRetriable}); ` +
          `paid fallback ${this.freeFailedRetriable ? 'allowed' : 'blocked'}`
      );
    }
  }
}

export default { FallbackDecision, FallbackChain };
