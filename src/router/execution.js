// src/router/execution.js
// Smart Router Mainline - Phase 1
// 执行引擎：串行 Fallback 执行候选链，调用上游 provider 并处理重试/切换。
//
// 设计要点（参考 6.5.0 的 executeCandidates）：
//   - 串行 Fallback，不实现并行竞速
//   - 客户端断开立即 Abort 上游：abortSignal 传递到 fetch
//   - 首字节后禁止切换模型：firstByteReceived 标记后不再 fallback
//   - 每次 Attempt 前必须重新检查预算
//   - 禁付费时付费模型绝不执行
//   - strict 模型不被改变
//   - client_aborted 单独归因，不记为模型质量失败
//   - 每次 Attempt 独立记录：attemptLog 数组
//   - attemptedFree + freeFailedRetriable：追踪免费失败后的付费 Fallback
//   - 同模型跨 Provider：同 id 不同 provider 的候选可以 fallback
//   - 四重上限：maxAttemptsPerKey, maxKeysPerProvider, maxProvidersPerRequest, maxTotalUpstreamCalls
//   - provider 故障与模型质量分开：transport_outcome 与 validated_outcome 分离
//   - no_candidate 也写审计记录
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import {
  ErrorType,
  ProviderError,
  isRetriable,
  getCooldownScope,
} from '../provider/errors.js';
import { FallbackChain, FallbackDecision } from './fallback.js';

// ----------------------------------------------------------------------------
// 日志
// ----------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[execution][${ts}] ${msg}\n`);
}

// ----------------------------------------------------------------------------
// ExecutionResult：执行结果
// ----------------------------------------------------------------------------

/**
 * 执行结果。
 *
 * @property {boolean} success 是否成功
 * @property {object|null} response 上游响应（成功时为 fetch Response）
 * @property {Array<object>} attempts attemptLog 数组（审计记录）
 * @property {object|null} finalCandidate 最终成功的候选
 * @property {object|null} error 最终错误
 * @property {string} outcome 结果类型：
 *   'completed' | 'incomplete' | 'no_candidate' | 'client_aborted' |
 *   'budget_exceeded' | 'provider_error'
 */
export class ExecutionResult {
  constructor(success, response, attempts, finalCandidate, error, outcome) {
    this.success = !!success;
    this.response = response || null;
    this.attempts = Array.isArray(attempts) ? attempts : [];
    this.finalCandidate = finalCandidate || null;
    this.error = error || null;
    this.outcome = outcome || (success ? 'completed' : 'incomplete');
  }

  toJSON() {
    return {
      success: this.success,
      outcome: this.outcome,
      finalCandidate: this.finalCandidate
        ? {
            modelId: this.finalCandidate.modelId,
            provider: this.finalCandidate.provider,
          }
        : null,
      attemptCount: this.attempts.length,
      error: this.error
        ? { type: this.error.type, message: this.error.message }
        : null,
      attempts: this.attempts.map((a) => ({
        attemptNumber: a.attemptNumber,
        model: a.model,
        provider: a.provider,
        keyId: a.keyId,
        outcome: a.outcome,
        latencyMs: a.latencyMs,
      })),
    };
  }
}

// ----------------------------------------------------------------------------
// ExecutionEngine：执行引擎
// ----------------------------------------------------------------------------

/**
 * 执行引擎：串行 Fallback 执行候选链。
 *
 * 职责：
 *   - 创建 FallbackChain 管理候选遍历
 *   - 每次尝试前重新检查预算
 *   - 获取 key 并调用 provider client
 *   - 根据错误类型决定 key 级重试或候选级切换
 *   - 记录每次尝试的 attemptLog（审计）
 *   - 成功后记录成本
 *   - 处理客户端断开、首字节后禁止切换等边界条件
 *
 * @example
 * const engine = new ExecutionEngine(config, providerClient, keyPool, health, costTracker, circuitBreaker);
 * const result = await engine.execute(candidates, body, {
 *   agentId: 'claude-code',
 *   abortSignal: req.signal,
 *   protocol: 'anthropic',
 * });
 * if (result.success) {
 *   // result.response 是上游 fetch Response
 * }
 */
export class ExecutionEngine {
  /**
   * @param {object} config 已加载的配置对象
   * @param {object} providerClient ProviderClient 实例
   * @param {object} keyPool KeyPool 实例
   * @param {object} health ProviderHealth 实例
   * @param {object} costTracker CostTracker 实例
   * @param {object} circuitBreaker CircuitBreaker 实例
   */
  constructor(config, providerClient, keyPool, health, costTracker, circuitBreaker, store = null) {
    this.config = config;
    this.providerClient = providerClient;
    this.keyPool = keyPool;
    this.health = health;
    this.costTracker = costTracker;
    this.circuitBreaker = circuitBreaker;
    this.store = store || null;

    // 解析四重上限
    const routing = config?.routing || {};
    this.limits = {
      maxTotalUpstreamCalls: routing.max_total_upstream_calls ?? 10,
      maxKeysPerProvider: routing.max_keys_per_provider ?? 5,
      maxProvidersPerRequest: routing.max_providers_per_request ?? 5,
      maxAttemptsPerKey: routing.max_attempts_per_key ?? 1,
    };
  }

  // --------------------------------------------------------------------------
  // 核心执行：串行 Fallback
  // --------------------------------------------------------------------------

  /**
   * 执行候选链（串行 Fallback）。
   *
   * 逻辑：
   *   1. 创建 FallbackChain
   *   2. 循环：
   *      a. 获取下一个候选（fallbackChain.next）
   *      b. 如果没有候选，返回 no_candidate
   *      c. 预算检查（每次 Attempt 前必须重新检查）
   *      d. 获取 key（keyPool.getKeys 检查可用性）
   *      e. 如果没有可用 key，排除 provider，跳到下一候选
   *      f. 调用 providerClient.callChat/callAnthropic
   *      g. 记录 attemptLog
   *      h. 如果成功，返回 ExecutionResult(success=true)
   *      i. 如果失败，根据错误类型决定是否 fallback
   *      j. 首字节后禁止切换模型
   *   3. 返回 ExecutionResult
   *
   * @param {Array<object>} candidates 候选列表（由 buildCandidates 构建）
   * @param {object} body 请求体
   * @param {object} [options]
   * @param {string} [options.agentId] Agent 标识
   * @param {AbortSignal} [options.abortSignal] 客户端取消信号
   * @param {object} [options.budget] Agent 预算配置
   * @param {string} [options.protocol] 协议类型 'chat'|'responses'|'anthropic'
   * @param {string} [options.requestId] 请求唯一标识（用于成本记录去重）
   * @param {number} [options.timeoutMs] 请求超时
   * @returns {Promise<ExecutionResult>}
   */
  async execute(candidates, body, options = {}) {
    const chain = new FallbackChain(candidates, this.config);
    const attempts = [];
    let lastError = null;
    let totalUpstreamCalls = 0;
    const providersTried = new Set();
    const providerKeyCount = new Map(); // providerName → 已尝试 key 数

    const abortSignal = options.abortSignal || null;
    const protocol = options.protocol || 'chat';
    const requestId = options.requestId || null;

    // 持久化请求元数据到 store
    if (this.store && requestId) {
      this.store.saveRequest({
        requestId,
        agentId: options.agentId || 'unknown',
        protocol,
        model: body?.model || null,
        provider: null,
        externalRequestId: options.externalRequestId || null,
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        log('saveRequest error: ' + err.message);
      });
    }

    while (totalUpstreamCalls < this.limits.maxTotalUpstreamCalls) {
      // 检查客户端是否已断开
      if (abortSignal?.aborted) {
        log('client aborted before next attempt');
        return new ExecutionResult(
          false, null, attempts, null, lastError, 'client_aborted'
        );
      }

      // 获取下一个候选
      const decision = chain.next({
        lastError,
        firstByteReceived: chain.firstByteReceived,
        clientAborted: abortSignal?.aborted || false,
      });

      if (!decision.shouldFallback) {
        // no_candidate 也写审计记录（spec 要求）
        if (attempts.length === 0) {
          // 检查是否因预算阻止（禁付费时付费候选被 FallbackChain 过滤）
          const allowPaid =
            options.budget?.allowPaid ?? this.config?.budget?.allowPaid ?? true;
          const hasPaidCandidates = candidates.some((c) => c.paid);

          if (!allowPaid && hasPaidCandidates) {
            // 所有候选为付费模型且 allowPaid=false → 写 budget_blocked 审计记录
            const firstPaid = candidates.find((c) => c.paid);
            log('all candidates budget-blocked (allowPaid=false, paid models only)');
            attempts.push(
              this._buildAttemptLog(
                firstPaid, null, 1, 'budget_blocked',
                {
                  type: 'budget_blocked',
                  reason: 'paid_blocked',
                  message: 'paid model blocked by allowPaid=false',
                },
                null, null, 0
              )
            );
            return new ExecutionResult(
              false, null, attempts, null, lastError, 'budget_exceeded'
            );
          }

          // 无可用候选（空列表、全被 health/circuit breaker 过滤等）
          log(`no candidates available (reason: ${decision.reason})`);
          const placeholder =
            candidates[0] || { modelId: 'none', provider: 'none', model: {} };
          attempts.push(
            this._buildAttemptLog(
              placeholder, null, 1, 'no_candidate',
              lastError ? this._errorToLog(lastError) : null,
              null, null, 0
            )
          );
        }

        // 不再 fallback：根据原因返回不同 outcome
        const outcome = this._decisionToOutcome(decision.reason);
        return new ExecutionResult(false, null, attempts, null, lastError, outcome);
      }

      const candidate = decision.nextCandidate;

      // 检查 maxProvidersPerRequest
      if (!providersTried.has(candidate.provider)) {
        if (providersTried.size >= this.limits.maxProvidersPerRequest) {
          log(`max providers per request reached (${providersTried.size})`);
          const attemptLog = this._buildAttemptLog(
            candidate, null, attempts.length + 1,
            'max_providers', null, null, null, 0
          );
          attempts.push(attemptLog);
          chain.markAttempted(candidate);
          chain.excludeProvider(candidate.provider);
          // lastError 保留原值：排除 provider 后继续尝试下一候选
          continue;
        }
        providersTried.add(candidate.provider);
      }

      // 预算检查（每次 Attempt 前必须重新检查）
      const budgetCheck = this.costTracker.checkBudget(
        candidate.model, candidate.provider, {
          agentId: options.agentId,
          allowPaid: options.budget?.allowPaid,
          maxRequestCost: options.budget?.maxRequestCost,
          allowedModels: options.budget?.allowedModels,
          allowedProviders: options.budget?.allowedProviders,
          strictModel: options.budget?.strictModel,
          requestedModel: body?.model,
        }
      );

      if (!budgetCheck.allowed) {
        log(`budget blocked for ${candidate.provider}/${candidate.modelId}: ${budgetCheck.reason}`);
        const attemptLog = this._buildAttemptLog(
          candidate, null, attempts.length + 1,
          'budget_blocked',
          { type: 'budget_blocked', reason: budgetCheck.reason, message: budgetCheck.details?.message || budgetCheck.reason },
          null, null, 0
        );
        attempts.push(attemptLog);
        chain.markAttempted(candidate);

        // budget_blocked：排除该候选，尝试下一个
        chain.excludeModel(candidate.modelId);

        // 如果是付费阻止（allowPaid=false），排除所有付费候选
        if (budgetCheck.reason === 'paid_blocked') {
          lastError = new ProviderError(
            ErrorType.UNKNOWN,
            `budget blocked: ${budgetCheck.reason}`,
            { provider: candidate.provider, model: candidate.modelId }
          );
          continue;
        }

        lastError = new ProviderError(
          ErrorType.UNKNOWN,
          `budget blocked: ${budgetCheck.reason}`,
          { provider: candidate.provider, model: candidate.modelId }
        );
        continue;
      }

      // 检查可用 key
      const availableKeys = this.keyPool
        ? this.keyPool.getKeys(candidate.provider)
        : [];
      if (availableKeys.length === 0) {
        log(`no available keys for provider "${candidate.provider}"`);
        const attemptLog = this._buildAttemptLog(
          candidate, null, attempts.length + 1,
          'no_key', null, null, null, 0
        );
        attempts.push(attemptLog);
        chain.markAttempted(candidate);
        chain.excludeProvider(candidate.provider);
        // lastError 保留原值（如 auth_invalid）：排除 provider 后继续尝试下一候选
        continue;
      }

      // 检查 maxKeysPerProvider
      const keyCount = providerKeyCount.get(candidate.provider) || 0;
      if (keyCount >= this.limits.maxKeysPerProvider) {
        log(`max keys per provider reached for "${candidate.provider}" (${keyCount})`);
        const attemptLog = this._buildAttemptLog(
          candidate, null, attempts.length + 1,
          'max_keys', null, null, null, 0
        );
        attempts.push(attemptLog);
        chain.markAttempted(candidate);
        chain.excludeProvider(candidate.provider);
        // lastError 保留原值：排除 provider 后继续尝试下一候选
        continue;
      }

      // 执行单次尝试
      totalUpstreamCalls++;
      providerKeyCount.set(candidate.provider, keyCount + 1);

      const tryResult = await this._tryOnce(
        candidate, body, options, attempts.length + 1, protocol
      );

      attempts.push(tryResult.attemptLog);
      chain.markAttempted(candidate);

      // 持久化 Attempt 记录到 store
      if (this.store && requestId) {
        this.store.saveAttempt({
          requestId,
          attemptNumber: tryResult.attemptLog.attemptNumber,
          model: tryResult.attemptLog.model,
          provider: tryResult.attemptLog.provider,
          keyId: tryResult.attemptLog.keyId,
          transportOutcome: tryResult.attemptLog.transportOutcome,
          validatedOutcome: tryResult.attemptLog.validatedOutcome,
          errorType: tryResult.attemptLog.error?.type || null,
          errorMessage: tryResult.attemptLog.error?.message || null,
          latencyMs: tryResult.attemptLog.latencyMs,
          firstByteMs: tryResult.attemptLog.firstContentByteMs,
          headersReceived: tryResult.attemptLog.headersReceived,
          firstByteSentToClient: tryResult.attemptLog.firstByteSentToClient,
          usage: tryResult.attemptLog.usage,
          cost: tryResult.attemptLog.cost,
          timestamp: tryResult.attemptLog.timestamp || new Date().toISOString(),
        }).catch((err) => {
          log('saveAttempt error: ' + err.message);
        });
      }

      // 首字节标记
      if (tryResult.firstByteReceived) {
        chain.markFirstByte();
      }

      // 成功
      if (tryResult.success) {
        // 记录成本
        this._recordCost(tryResult, candidate, options);

        log(
          `request completed: ${candidate.provider}/${candidate.modelId} ` +
            `(${tryResult.attemptLog.latencyMs}ms, ${totalUpstreamCalls} upstream calls)`
        );

        return new ExecutionResult(
          true, tryResult.response, attempts, candidate, null, 'completed'
        );
      }

      // 失败：记录错误
      lastError = tryResult.error;

      // 客户端断开：单独归因，不记为模型质量失败
      if (tryResult.error.type === ErrorType.CLIENT_ABORTED) {
        log('client aborted during upstream request');
        return new ExecutionResult(
          false, null, attempts, null, lastError, 'client_aborted'
        );
      }

      // 首字节后禁止切换模型
      if (chain.firstByteReceived) {
        log('first byte received but request failed; no fallback');
        return new ExecutionResult(
          false, null, attempts, null, lastError, 'incomplete'
        );
      }

      // 根据错误类型决定 fallback 策略
      const errorType = tryResult.error.type;
      const scope = getCooldownScope(errorType);

      // key 级错误：不排除 provider/model，由 FallbackChain 返回同候选
      // 执行引擎下次循环会用不同 key（keyPool 已标记失败 key）
      if (scope === 'key') {
        log(`key-level error (${errorType}) for ${candidate.provider}; will retry with different key`);
        // 不排除任何东西，FallbackChain.next 会返回同候选
        continue;
      }

      // 可重试的 model 级错误（SERVER_ERROR, NETWORK_ERROR 等）：
      // 不排除 model，由 FallbackChain 前进到下一候选
      if (scope === 'model' && isRetriable(errorType)) {
        log(`retriable model-level error (${errorType}) for ${candidate.provider}/${candidate.modelId}; falling back`);
        // FallbackChain.next 会前进到下一候选（currentIndex++）
        continue;
      }

      // provider 级错误：排除 provider
      if (scope === 'provider') {
        log(`provider-level error (${errorType}) for ${candidate.provider}; excluding provider`);
        chain.excludeProvider(candidate.provider);
        continue;
      }

      // model 级非重试错误（FORBIDDEN_MODEL, RATE_LIMIT_QUOTA 等）：排除 model
      if (scope === 'model' && !isRetriable(errorType)) {
        log(`non-retriable model-level error (${errorType}) for ${candidate.modelId}; excluding model`);
        chain.excludeModel(candidate.modelId);
        continue;
      }

      // scope === 'none'（UNKNOWN 等）：由 FallbackChain 决定是否继续
      log(`non-retriable error (${errorType}); letting fallback chain decide`);
      continue;
    }

    // 超过总上游调用上限
    log(`max total upstream calls reached (${totalUpstreamCalls})`);
    return new ExecutionResult(
      false, null, attempts, null, lastError, 'no_candidate'
    );
  }

  // --------------------------------------------------------------------------
  // 单次尝试
  // --------------------------------------------------------------------------

  /**
   * 单次尝试：调用 provider client 并记录结果。
   *
   * 逻辑：
   *   1. 检查熔断器
   *   2. 调用 providerClient.callChat/callAnthropic
   *   3. 记录 attempt 信息
   *   4. 返回 { success, response, error, firstByteReceived, attemptLog }
   *
   * @param {object} candidate 候选
   * @param {object} body 请求体
   * @param {object} options 全局选项
   * @param {number} attemptNumber 尝试序号
   * @param {string} protocol 协议类型
   * @returns {Promise<object>}
   */
  async _tryOnce(candidate, body, options, attemptNumber, protocol) {
    const startTime = Date.now();
    const modelConfig = candidate.model;
    const modelId = candidate.modelId;
    const provider = candidate.provider;
    const cbKey = `${provider}:${modelId}`;

    // 检查熔断器
    if (this.circuitBreaker && typeof this.circuitBreaker.allow === 'function') {
      if (!this.circuitBreaker.allow(cbKey)) {
        const latency = Date.now() - startTime;
        const error = new ProviderError(
          ErrorType.UNKNOWN,
          `circuit breaker open for ${cbKey}`,
          { provider, model: modelId }
        );
        log(`circuit breaker open for ${cbKey}, skipping attempt`);
        const attemptLog = this._buildAttemptLog(
          candidate, null, attemptNumber, 'circuit_open',
          this._errorToLog(error), null, null, latency
        );
        return {
          success: false, response: null, error,
          headersReceived: false, firstByteReceived: false, attemptLog,
        };
      }
    }

    // 调用 provider client
    const callOptions = {
      abortSignal: options.abortSignal,
      agentId: options.agentId,
      timeoutMs: options.timeoutMs,
    };

    let result = null;
    let error = null;

    try {
      if (protocol === 'anthropic') {
        result = await this.providerClient.callAnthropic(
          modelConfig, body, callOptions
        );
      } else {
        result = await this.providerClient.callChat(
          modelConfig, body, callOptions
        );
      }
    } catch (err) {
      // 归一化错误为 ProviderError
      if (err instanceof ProviderError) {
        error = err;
      } else {
        error = new ProviderError(
          ErrorType.UNKNOWN,
          err.message || 'unknown error during upstream call',
          { provider, model: modelId, cause: err }
        );
      }
    }

    const latency = Date.now() - startTime;

    // 成功
    if (result && !error) {
      // 记录熔断器成功
      if (this.circuitBreaker && typeof this.circuitBreaker.record === 'function') {
        this.circuitBreaker.record(cbKey, true, latency);
      }

      // 解析 usage（仅非流式响应）+ 内容有效性验证
      let usage = null;
      let cost = null;
      const isStreaming = body?.stream === true;
      let firstByteSentToClient = false;
      let firstContentByteMs = null;
      let bodyValid = false;
      let contentInvalid = false; // 200 但内容无效（空 body、无效 JSON 等）

      if (!isStreaming) {
        try {
          const cloned = result.response.clone();
          const bodyText = await cloned.text();
          if (bodyText && bodyText.trim()) {
            // 尝试解析 JSON 验证内容有效性
            try {
              const parsed = JSON.parse(bodyText);
              if (parsed && typeof parsed === 'object') {
                bodyValid = true;
                usage = this.providerClient.parseUsage(bodyText, provider);
                if (usage && this.costTracker) {
                  cost = this.costTracker.calculateCost(modelConfig, usage);
                }
              } else {
                contentInvalid = true;
                log('upstream returned 200 but body is not valid JSON object');
              }
            } catch (jsonErr) {
              contentInvalid = true;
              log('upstream returned 200 but body is not valid JSON: ' + jsonErr.message);
            }
          } else {
            contentInvalid = true;
            log('upstream returned 200 with empty body');
          }
        } catch {
          // 读取 body 失败：可能是流式响应
          contentInvalid = true;
          log('upstream returned 200 but body read failed');
        }
        // 非流式：body 有效才视为首字节已发送
        firstByteSentToClient = bodyValid;
        firstContentByteMs = bodyValid ? latency : null;
      }
      // 流式：预读验证 + firstByteSentToClient 保持 false
      if (isStreaming && !contentInvalid) {
        // 预读流式响应的第一个有效 SSE 事件
        const preReadResult = await this._validateStreamFirstChunk(
          result.response, protocol, 5000
        );

        if (!preReadResult.valid) {
          // 流式预读失败：空 SSE、无效首事件、异常 EOF
          log('stream pre-read invalid: ' + preReadResult.reason + '; allowing fallback');
          contentInvalid = true;

          // 记录 key 成功（HTTP 层面确实成功了）
          if (this.keyPool && result.keyId) {
            await this.keyPool.markKeySucceeded(provider, result.keyId);
          }

          const attemptLog = this._buildAttemptLog(
            candidate, result.keyId, attemptNumber, 'error',
            {
              type: 'content_invalid',
              message: 'stream pre-read failed: ' + preReadResult.reason,
              httpStatus: 200,
            },
            null, null, latency
          );
          attemptLog.headersReceived = true;
          attemptLog.firstContentByteMs = null;
          attemptLog.firstByteSentToClient = false;

          // 持久化 Attempt
          if (this.store && options.requestId) {
            this.store.saveAttempt({
              requestId: options.requestId,
              attemptNumber,
              model: candidate.modelId,
              provider: candidate.provider,
              keyId: result.keyId,
              transportOutcome: 'success',
              validatedOutcome: 'error',
              errorType: 'content_invalid',
              errorMessage: 'stream pre-read: ' + preReadResult.reason,
              latencyMs: latency,
              firstByteMs: null,
              headersReceived: true,
              firstByteSentToClient: false,
              timestamp: new Date().toISOString(),
            }).catch(() => {});
          }

          return {
            success: false,
            response: null,
            error: new ProviderError(
              ErrorType.CONTENT_INVALID,
              'stream pre-read failed: ' + preReadResult.reason,
              { provider, model: modelId }
            ),
            headersReceived: true,
            firstByteReceived: false,
            attemptLog,
            keyId: result.keyId,
            usage: null,
            cost: null,
          };
        }

        // 预读成功：用合并流替换原始 response.body
        // 创建新的 Response 对象，body 为预读 chunks + 剩余流
        if (preReadResult.restStream && preReadResult.chunks.length > 0) {
          const combinedStream = preReadResult.restStream;
          // 用 Object.defineProperty 替换 body（Response.body 是只读的）
          result.response = new Response(combinedStream, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }

        log('stream pre-read valid, ' + preReadResult.chunks.length + ' chunks buffered');
      }

      // 如果内容无效且尚未向客户端发送任何内容，允许 Fallback
      if (contentInvalid && !firstByteSentToClient) {
        log('upstream 200 but content invalid; allowing fallback to next candidate');
        // 记录 key 成功（HTTP 层面确实成功了）
        if (this.keyPool && result.keyId) {
          await this.keyPool.markKeySucceeded(provider, result.keyId);
        }
        const attemptLog = this._buildAttemptLog(
          candidate, result.keyId, attemptNumber, 'error',
          { type: 'invalid_content', message: 'upstream returned 200 but body was empty or invalid', httpStatus: 200 },
          null, null, latency
        );
        attemptLog.headersReceived = true;
        attemptLog.firstContentByteMs = null;
        attemptLog.firstByteSentToClient = false;
        // 持久化 Attempt 到 store
        if (this.store && options.requestId) {
          this.store.saveAttempt({
            requestId: options.requestId,
            attemptNumber: attemptNumber,
            model: candidate.modelId,
            provider: candidate.provider,
            keyId: result.keyId,
            transportOutcome: 'success',
            validatedOutcome: 'error',
            errorType: 'invalid_content',
            errorMessage: 'upstream 200 but body empty or invalid',
            latencyMs: latency,
            firstByteMs: null,
            headersReceived: true,
            firstByteSentToClient: false,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        }
        return {
          success: false,
          response: null,
          error: new ProviderError(
            ErrorType.CONTENT_INVALID,
            'upstream returned 200 but body was empty or invalid',
            { provider, model: modelId }
          ),
          headersReceived: true,
          firstByteReceived: false,
          attemptLog,
          keyId: result.keyId,
          usage: null,
          cost: null,
        };
      }

      const attemptLog = this._buildAttemptLog(
        candidate, result.keyId, attemptNumber, 'success',
        null, usage, cost, latency
      );
      // 附加首字节语义字段
      attemptLog.headersReceived = true;
      attemptLog.firstContentByteMs = firstContentByteMs;
      attemptLog.firstByteSentToClient = firstByteSentToClient;

      return {
        success: true,
        response: result.response,
        error: null,
        // headersReceived: 收到上游 Response 对象（仅表示 HTTP 连接成功）
        headersReceived: true,
        // firstByteReceived: 是否已向客户端发送有效内容（true 时禁止切换模型）
        firstByteReceived: firstByteSentToClient,
        attemptLog,
        keyId: result.keyId,
        usage,
        cost,
      };
    }

    // 失败
    // 记录熔断器失败（客户端取消除外）
    if (
      this.circuitBreaker &&
      typeof this.circuitBreaker.record === 'function' &&
      error.type !== ErrorType.CLIENT_ABORTED
    ) {
      this.circuitBreaker.record(cbKey, false, latency);
    }

    const attemptLog = this._buildAttemptLog(
      candidate, null, attemptNumber, 'error',
      this._errorToLog(error), null, null, latency
    );

    return {
      success: false,
      response: null,
      error,
      headersReceived: false,
      firstByteReceived: false,
      attemptLog,
      keyId: null,
      usage: null,
      cost: null,
    };
  }

  // --------------------------------------------------------------------------
  // 流式预读验证
  // --------------------------------------------------------------------------

  /**
   * 预读流式响应的第一个有效 SSE 事件。
   *
   * 在返回给协议处理器前，预读上游流的前几个 chunk，
   * 验证至少包含一个合法协议事件。
   *
   * 验证通过时：
   *   - 返回 { valid: true, chunks: Buffer[], restStream: ReadableStream }
   *   - chunks 是预读的数据块，协议处理器必须先写入这些再继续 pipe
   *   - restStream 是原始流的剩余部分
   *
   * 验证失败时：
   *   - 返回 { valid: false, reason: string }
   *   - 调用方应关闭上游并允许 Fallback
   *
   * @param {Response} response 上游 fetch Response
   * @param {string} protocol 协议类型
   * @param {number} timeoutMs 预读超时（默认 5000ms）
   * @returns {Promise<{valid: boolean, chunks?: Buffer[], restStream?: ReadableStream, reason?: string}>}
   */
  async _validateStreamFirstChunk(response, protocol, timeoutMs = 5000) {
    if (!response || !response.body) {
      return { valid: false, reason: 'no response body' };
    }

    const body = response.body;
    const chunks = [];
    let sseBuffer = '';
    let validEventFound = false;

    // 获取 reader
    let reader;
    if (typeof body.getReader === 'function') {
      reader = body.getReader();
    } else if (typeof body[Symbol.asyncIterator] === 'function') {
      // Node.js readable stream - wrap in a simple reader
      const iter = body[Symbol.asyncIterator]();
      reader = {
        read: async () => {
          const { done, value } = await iter.next();
          return { done, value };
        },
        releaseLock: () => {},
      };
    } else {
      return { valid: false, reason: 'unsupported stream type' };
    }

    try {
      // 预读循环：最多读取 3 个 chunk 或找到有效事件
      for (let i = 0; i < 3 && !validEventFound; i++) {
        // 带超时的读取
        const readPromise = reader.read();
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('pread_timeout')), timeoutMs);
        });

        let readResult;
        try {
          readResult = await Promise.race([readPromise, timeoutPromise]);
        } catch (err) {
          if (err.message === 'pread_timeout') {
            log('stream pre-read timeout, no data received');
            break;
          }
          throw err;
        }

        if (readResult.done) {
          // 流已结束
          break;
        }

        if (!readResult.value) continue;

        const buf = Buffer.isBuffer(readResult.value)
          ? readResult.value
          : Buffer.from(readResult.value);
        chunks.push(buf);
        sseBuffer += buf.toString('utf8');

        // 检查是否有完整的 SSE 事件（以 \n\n 分隔）
        while (sseBuffer.includes('\n\n')) {
          const idx = sseBuffer.indexOf('\n\n');
          const block = sseBuffer.slice(0, idx);
          sseBuffer = sseBuffer.slice(idx + 2);

          // 验证事件是否为合法协议事件
          if (this._isValidSSEEvent(block, protocol)) {
            validEventFound = true;
            break;
          }
        }
      }

      // 检查缓冲区中剩余的不完整事件
      if (!validEventFound && sseBuffer.trim()) {
        if (this._isValidSSEEvent(sseBuffer, protocol)) {
          validEventFound = true;
        }
      }

      if (!validEventFound) {
        // 没有找到有效事件
        try { reader.releaseLock(); } catch {}
        try { await reader.cancel?.(); } catch {}
        return {
          valid: false,
          reason: chunks.length === 0 ? 'empty_stream' : 'no_valid_events',
        };
      }

      // 验证通过：创建合并流（预读 chunks + 剩余原始流）
      let restStream;
      if (typeof body.getReader === 'function') {
        // Web ReadableStream：创建新的 ReadableStream
        const originalReader = reader;
        restStream = new ReadableStream({
          start(controller) {
            // 先输出预读的 chunks
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
          },
          async pull(controller) {
            try {
              const { done, value } = await originalReader.read();
              if (done) {
                controller.close();
              } else if (value) {
                controller.enqueue(value);
              }
            } catch (err) {
              controller.error(err);
            }
          },
          async cancel() {
            try { await originalReader.cancel(); } catch {}
          },
        });
      } else {
        // Node.js stream：无法完美创建合并流，但预读 chunks 会被返回
        // 协议处理器需要先写入 chunks 再继续读取原始流
        restStream = body; // 原始流可能已被部分消费，但 Node.js stream 有缓冲
        // 对于 Node.js stream，我们标记需要先写入 chunks
      }

      return { valid: true, chunks, restStream };
    } catch (err) {
      log('stream pre-read error: ' + err.message);
      try { reader.releaseLock(); } catch {}
      try { await reader.cancel?.(); } catch {}
      return { valid: false, reason: 'pread_error: ' + err.message };
    }
  }

  /**
   * 验证 SSE 事件块是否为合法协议事件。
   *
   * @param {string} block SSE 事件块（以 \n\n 分隔的部分）
   * @param {string} protocol 协议类型
   * @returns {boolean}
   */
  _isValidSSEEvent(block, protocol) {
    if (!block || !block.trim()) return false;

    // 跳过注释行
    const lines = block.split('\n').filter(l => l && !l.startsWith(':'));
    if (lines.length === 0) return false;

    // 解析 data 字段
    let dataStr = null;
    let eventType = null;
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const field = line.slice(0, colonIdx);
      let value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') {
        dataStr = dataStr === null ? value : dataStr + '\n' + value;
      } else if (field === 'event') {
        eventType = value;
      }
    }

    // [DONE] 是流终止标记，不是内容事件；
    // 若首事件仅为 [DONE]，说明上游返回了空 SSE，应允许 Fallback
    if (dataStr && dataStr.trim() === '[DONE]') return false;

    if (!dataStr) return false;

    // 根据协议验证
    try {
      const parsed = JSON.parse(dataStr);
      if (!parsed || typeof parsed !== 'object') return false;

      switch (protocol) {
        case 'chat':
          // Chat SSE: 应有 choices 数组或 error 对象
          return Array.isArray(parsed.choices) ||
                 (parsed.error && typeof parsed.error === 'object');
        case 'anthropic':
          // Anthropic SSE: 原生事件有 type 字段；
          // 兼容上游为 Chat 格式（choices）经 adapter 转换的场景
          return (typeof parsed.type === 'string' && parsed.type.length > 0) ||
                 Array.isArray(parsed.choices) ||
                 typeof parsed.object === 'string';
        case 'responses':
          // Responses SSE: 原生事件有 type 字段；
          // 兼容上游为 Chat 格式（choices）经 adapter 转换的场景
          return (typeof parsed.type === 'string' && parsed.type.length > 0) ||
                 Array.isArray(parsed.choices) ||
                 typeof parsed.object === 'string';
        default:
          // 通用：只要能解析为 JSON 对象即可
          return true;
      }
    } catch {
      // 非 JSON data，但有 event 字段也视为有效
      return !!eventType;
    }
  }

  // --------------------------------------------------------------------------
  // 审计日志构建
  // --------------------------------------------------------------------------

  /**
   * 构建单次尝试的审计日志。
   *
   * @param {object} candidate 候选
   * @param {string|null} keyId 使用的 key id
   * @param {number} attemptNumber 尝试序号
   * @param {string} outcome 结果：'success' | 'error' | 'budget_blocked' |
   *        'no_key' | 'circuit_open' | 'max_providers' | 'max_keys' | 'aborted'
   * @param {object|null} error 错误信息
   * @param {object|null} usage token 使用量
   * @param {object|null} cost 成本信息
   * @param {number} latencyMs 延迟（毫秒）
   * @returns {object} 审计日志条目
   */
  _buildAttemptLog(candidate, keyId, attemptNumber, outcome, error, usage, cost, latency) {
    return {
      attemptNumber,
      model: candidate.modelId,
      provider: candidate.provider,
      keyId: keyId || null,
      outcome,
      // transport_outcome: 传输层结果（HTTP 请求是否成功）
      transportOutcome: outcome === 'success' ? 'success'
        : (outcome === 'error' || outcome === 'circuit_open') ? 'error'
        : 'skipped',
      // validated_outcome: 模型质量结果（响应是否有效）
      validatedOutcome: outcome === 'success' ? 'success'
        : outcome === 'error' ? 'error'
        : 'pending',
      error: error || null,
      usage: usage || null,
      cost: cost || null,
      latencyMs: latency || 0,
      // 首字节语义：区分 headersReceived 与 firstByteSentToClient
      headersReceived: false,
      firstContentByteMs: null,
      firstByteSentToClient: false,
      timestamp: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // 成本记录
  // --------------------------------------------------------------------------

  /**
   * 记录请求成本（仅成功时调用，以 requestId 去重）。
   *
   * @param {object} tryResult 单次尝试结果
   * @param {object} candidate 候选
   * @param {object} options 全局选项
   */
  _recordCost(tryResult, candidate, options) {
    if (!this.costTracker || !tryResult.usage) return;

    const requestId = options.requestId || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = this.costTracker.recordCost(
        requestId,
        candidate.model,
        candidate.provider,
        tryResult.usage,
        tryResult.cost
      );
      if (result.recorded) {
        log(
          `cost recorded: ${candidate.provider}/${candidate.modelId} ` +
            `${result.record.cost.totalCost} ${result.record.cost.currency}`
        );
      }
    } catch (err) {
      log(`cost recording failed: ${err.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // 内部工具
  // --------------------------------------------------------------------------

  /**
   * 将 FallbackDecision.reason 映射为 ExecutionResult.outcome。
   * @param {string} reason
   * @returns {string}
   */
  _decisionToOutcome(reason) {
    switch (reason) {
      case 'client_aborted':
        return 'client_aborted';
      case 'budget_blocked':
        return 'budget_exceeded';
      case 'no_more_candidates':
      case 'non_retriable_error':
        return 'no_candidate';
      case 'first_byte_received':
        return 'incomplete';
      default:
        return 'no_candidate';
    }
  }

  /**
   * 将 ProviderError 转换为可序列化的日志对象。
   * @param {ProviderError} error
   * @returns {object}
   */
  _errorToLog(error) {
    if (!error) return null;
    return {
      type: error.type || 'unknown',
      message: error.message || '',
      httpStatus: error.httpStatus ?? null,
      provider: error.provider ?? null,
      model: error.model ?? null,
    };
  }
}

export default { ExecutionResult, ExecutionEngine };
