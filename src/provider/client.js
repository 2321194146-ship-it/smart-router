// src/provider/client.js
// Smart Router Mainline - Phase 1
// Provider 客户端：实际调用上游 LLM API（OpenAI 兼容 / Anthropic Messages）。
//
// 设计要点（参考 6.5.0 改进）：
//   - 客户端断开时 abortSignal 已 aborted → 立即短路，不发起上游请求
//   - fetch 的 signal 直接传入 abortSignal → 客户端断开时上游立即 abort
//   - 请求体 model 字段使用 apiModel 映射（网关内部 id 与上游 apiModel 解耦）
//   - 支持 OpenAI 兼容（Authorization: Bearer）与 Anthropic（x-api-key + anthropic-version）
//   - 响应中提取 usage 信息用于成本追踪
//   - 超时处理：首字节超时使用 AbortController + setTimeout
//   - 成功/失败后自动通知 keyPool 和 health 模块
//
// 仅使用 Node.js 内置模块（含 Node 18+ 全局 fetch），无第三方依赖。

import {
  ErrorType,
  ProviderError,
  classifyError,
  parseRetryAfter,
} from './errors.js';

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300000; // 5min，与 config.server.request_timeout_ms 默认值一致
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 10000; // listModels 探测超时
const MAX_BODY_LOG_LEN = 512; // 错误日志中 body 截断长度

// Anthropic Messages API 版本（若 provider 配置未指定）
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

// ----------------------------------------------------------------------------
// 本地日志
// ----------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[provider-client][${ts}] ${msg}\n`);
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.code === 'ABORT_ERR') return true;
  if (err.message && /aborted/i.test(String(err.message))) return true;
  return false;
}

function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 为上游流包装 idle/total deadline。
 * fetch 收到响应头后不会再受普通 fetch timeout 保护，因此必须把 deadline
 * 延伸到 ReadableStream 消费阶段，避免 Provider 保持连接无限占用资源。
 */
function guardStreamingResponse(response, abortController, externalSignal, onExternalAbort, options) {
  if (!response?.body || typeof response.body.getReader !== 'function') return response;

  const reader = response.body.getReader();
  const idleTimeoutMs = Math.max(1, options.idleTimeoutMs);
  const totalTimeoutMs = Math.max(1, options.totalTimeoutMs);
  let idleTimer = null;
  let totalTimer = null;
  let finished = false;
  let streamController = null;

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    idleTimer = null;
    totalTimer = null;
  };

  const cleanup = () => {
    clearTimers();
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };

  const abortStream = (error) => {
    if (finished) return;
    finished = true;
    cleanup();
    try { abortController.abort(); } catch {}
    reader.cancel(error).catch(() => {});
    if (streamController) streamController.error(error);
  };

  const guardedBody = new ReadableStream({
    start(controller) {
      streamController = controller;
      totalTimer = setTimeout(() => {
        abortStream(new Error('upstream stream total timeout'));
      }, totalTimeoutMs);
    },
    async pull(controller) {
      if (finished) return;
      if (idleTimer) clearTimeout(idleTimer);
      let idleReject;
      const idlePromise = new Promise((_, reject) => { idleReject = reject; });
      idleTimer = setTimeout(() => {
        const error = new Error('upstream stream idle timeout');
        try { abortController.abort(); } catch {}
        idleReject(error);
      }, idleTimeoutMs);

      try {
        const result = await Promise.race([reader.read(), idlePromise]);
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        if (result.done) {
          finished = true;
          cleanup();
          controller.close();
          return;
        }
        if (result.value) controller.enqueue(result.value);
      } catch (error) {
        abortStream(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      cleanup();
      try { await reader.cancel(reason); } catch {}
    },
  });

  return new Response(guardedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ----------------------------------------------------------------------------
// ProviderClient
// ----------------------------------------------------------------------------

/**
 * Provider 客户端：封装对上游 LLM API 的调用。
 *
 * 每次调用会：
 *   1. 从 keyPool 获取可用 key（轮换）
 *   2. 构建请求（URL、headers、body with apiModel 映射）
 *   3. 使用 fetch 发起请求（传入 abortSignal）
 *   4. 根据响应状态通知 keyPool（成功/失败）和 health
 *   5. 返回原始 Response 对象 + 元信息（供路由层处理流式/非流式响应）
 *
 * @example
 * const client = new ProviderClient(config, keyPool, health);
 * const result = await client.callChat(modelConfig, requestBody, {
 *   abortSignal: req.signal,
 *   agentId: 'claude-code',
 * });
 * // result.response 是原始 fetch Response
 * // result.keyId, result.providerName, result.modelId 是元信息
 */
export class ProviderClient {
  /**
   * @param {object} config 已加载的配置对象
   * @param {object} keyPool KeyPool 实例
   * @param {object} [health] ProviderHealth 实例（可选，用于记录调用结果）
   */
  constructor(config, keyPool, health) {
    this.config = config;
    this.keyPool = keyPool;
    this.health = health || null;
    this._defaultTimeoutMs =
      config?.server?.request_timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this._streamIdleTimeoutMs =
      config?.server?.stream_idle_timeout_ms ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this._streamTotalTimeoutMs =
      config?.server?.stream_total_timeout_ms ?? this._defaultTimeoutMs;

    // 构建 provider 查找索引（name → provider config）
    this._providerIndex = new Map();
    const providers = Array.isArray(config?.providers) ? config.providers : [];
    for (const p of providers) {
      if (p?.name) this._providerIndex.set(p.name, p);
    }

    // 构建 model 查找索引（id → model config）
    this._modelIndex = new Map();
    const models = Array.isArray(config?.models) ? config.models : [];
    for (const m of models) {
      if (m?.id) this._modelIndex.set(m.id, m);
    }
  }

  // --------------------------------------------------------------------------
  // Chat Completions API（OpenAI 兼容）
  // --------------------------------------------------------------------------

  /**
   * 调用 Chat Completions API。
   *
   * @param {object|string} model 模型配置对象或模型 id（将自动查找配置）
   * @param {object} body 请求体（OpenAI 格式，含 messages, stream 等）
   * @param {object} [options]
   * @param {AbortSignal} [options.abortSignal] 客户端取消信号
   * @param {number} [options.timeoutMs] 请求超时（毫秒）
   * @param {string} [options.agentId] 调用方 Agent id
   * @param {object} [options.budget] Agent 预算配置
   * @param {string[]} [options.excludeKeys] 需排除的 keyId 列表（重试时跳过已失败 key）
   * @returns {Promise<{response: Response, providerName: string, keyId: string, modelId: string}>}
   * @throws {ProviderError}
   */
  async callChat(model, body, options = {}) {
    return this._execute(model, body, {
      ...options,
      endpoint: '/v1/chat/completions',
      apiType: 'openai',
    });
  }

  // --------------------------------------------------------------------------
  // Anthropic Messages API
  // --------------------------------------------------------------------------

  /**
   * 调用 Anthropic Messages API。
   *
   * @param {object|string} model 模型配置对象或模型 id
   * @param {object} body 请求体（Anthropic 格式，含 messages, system, max_tokens 等）
   * @param {object} [options]
   * @param {AbortSignal} [options.abortSignal]
   * @param {number} [options.timeoutMs]
   * @param {string} [options.agentId]
   * @param {object} [options.budget]
   * @param {string[]} [options.excludeKeys]
   * @returns {Promise<{response: Response, providerName: string, keyId: string, modelId: string}>}
   * @throws {ProviderError}
   */
  async callAnthropic(model, body, options = {}) {
    return this._execute(model, body, {
      ...options,
      endpoint: '/v1/messages',
      apiType: 'anthropic',
    });
  }

  /**
   * 调用受控的 OpenAI 兼容非对话端点（当前用于图片/视频生成）。
   * 端点白名单放在客户端边界，避免管理 API 被滥用成任意 URL 代理。
   */
  async callRaw(model, body, endpoint, options = {}) {
    if (!['/v1/images/generations', '/v1/video/generations'].includes(endpoint)) {
      throw new ProviderError(ErrorType.UNKNOWN, `unsupported raw endpoint: ${endpoint}`, {});
    }
    return this._execute(model, body, {
      ...options,
      endpoint,
      apiType: 'openai',
    });
  }

  // --------------------------------------------------------------------------
  // 模型列表（健康检查用）
  // --------------------------------------------------------------------------

  /**
   * 获取 provider 的模型列表（用于健康检查）。
   * 探测 /v1/models 端点。
   *
   * @param {string} providerName
   * @returns {Promise<object|null>} 模型列表 JSON 或 null（失败时）
   */
  async listModels(providerName) {
    const provider = this._providerIndex.get(providerName);
    if (!provider) {
      throw new Error(`listModels: provider not found: ${providerName}`);
    }

    // 尝试从 keyPool 获取 key，回退到 provider 配置的 api_key
    let key;
    let keyId = null;
    if (this.keyPool) {
      const keyInfo = this.keyPool.nextKey(providerName);
      if (keyInfo) {
        key = keyInfo.key;
        keyId = keyInfo.keyId;
      }
    }
    if (!key) {
      key = provider.api_key;
    }

    const url = this._buildUrl(provider, '/v1/models');
    const headers = this._buildHeaders(provider, key, 'application/json');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (response.ok) {
        const json = await response.json();
        if (keyId && this.keyPool) {
          this.keyPool.markKeySucceeded(providerName, keyId);
        }
        return json;
      }

      // 错误响应
      const respBody = await this._safeReadBody(response);
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const errorType = classifyError(
        response.status,
        respBody,
        this._extractErrorCode(respBody),
        { retryAfter }
      );

      if (keyId && this.keyPool && errorType !== ErrorType.CLIENT_ABORTED) {
        this.keyPool.markKeyFailed(providerName, keyId, errorType);
      }

      log(
        `listModels ${providerName} failed: HTTP ${response.status} ` +
          `(${errorType}): ${truncate(
            typeof respBody === 'string' ? respBody : JSON.stringify(respBody),
            MAX_BODY_LOG_LEN
          )}`
      );
      return null;
    } catch (err) {
      if (keyId && this.keyPool && !isAbortError(err)) {
        this.keyPool.markKeyFailed(providerName, keyId, ErrorType.NETWORK_ERROR);
      }
      log(`listModels ${providerName} error: ${err.message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --------------------------------------------------------------------------
  // 请求构建
  // --------------------------------------------------------------------------

  /**
   * 构建请求 URL。
   * 将 base_url 与 endpoint 拼接，处理尾部斜杠和 /v1 重复。
   *
   * @param {object} provider provider 配置
   * @param {string} endpoint 端点路径（如 /v1/chat/completions）
   * @returns {string}
   */
  _buildUrl(provider, endpoint) {
    const base = String(provider.base_url || '').replace(/\/+$/, '');
    const normalizedEndpoint = provider.strip_v1_prefix === true && endpoint.startsWith('/v1/')
      ? endpoint.slice(3)
      : endpoint;

    // 如果 base 已经以 /v1 结尾，且 endpoint 以 /v1 开头，避免重复
    if (base.endsWith('/v1') && normalizedEndpoint.startsWith('/v1/')) {
      return base + normalizedEndpoint.slice(3); // 去掉 endpoint 的 /v1
    }

    return base + normalizedEndpoint;
  }

  /**
   * 构建请求头。
   * 支持两种认证方式：
   *   - OpenAI 兼容：Authorization: Bearer <key>
   *   - Anthropic：x-api-key: <key> + anthropic-version: <version>
   *
   * @param {object} provider provider 配置
   * @param {string} key API key 值
   * @param {string} [contentType='application/json']
   * @returns {object}
   */
  _buildHeaders(provider, key, contentType = 'application/json') {
    const headers = {
      'Content-Type': contentType,
    };

    const authHeader = provider.auth_header || 'Authorization';
    // auth_prefix 默认逻辑：
    //   - 显式配置（含空字符串）则使用配置值
    //   - 未配置时：Authorization 头默认 'Bearer '（OpenAI 兼容），
    //     其它头（如 x-api-key）默认空前缀
    let authPrefix;
    if (provider.auth_prefix != null) {
      authPrefix = provider.auth_prefix;
    } else if (authHeader.toLowerCase() === 'authorization') {
      authPrefix = 'Bearer ';
    } else {
      authPrefix = '';
    }
    headers[authHeader] = authPrefix + key;

    // Anthropic 版本头
    if (provider.version_header && provider.version_value) {
      headers[provider.version_header] = provider.version_value;
    }

    return headers;
  }

  // --------------------------------------------------------------------------
  // Usage 解析
  // --------------------------------------------------------------------------

  /**
   * 解析 provider 响应中的 usage 信息（用于成本追踪）。
   *
   * 支持两种格式：
   *   - OpenAI: { usage: { prompt_tokens, completion_tokens, total_tokens } }
   *   - Anthropic: { usage: { input_tokens, output_tokens } }
   *
   * @param {object|string} responseBody 响应体（已解析的对象或原始字符串）
   * @param {object} [provider] provider 配置（用于区分格式，可选）
   * @returns {object|null} 归一化的 usage：{ promptTokens, completionTokens, totalTokens, raw }
   */
  parseUsage(responseBody, provider) {
    let body = responseBody;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return null;
      }
    }
    if (!body || typeof body !== 'object') return null;

    const usage = body.usage;
    if (!usage || typeof usage !== 'object') return null;

    // 归一化字段名
    const promptTokens =
      usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const completionTokens =
      usage.completion_tokens ?? usage.output_tokens ?? 0;
    const totalTokens =
      usage.total_tokens ?? promptTokens + completionTokens;

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      // 保留原始 usage 对象（可能含 cache_read_input_tokens 等扩展字段）
      raw: { ...usage },
    };
  }

  // --------------------------------------------------------------------------
  // 内部：核心执行逻辑
  // --------------------------------------------------------------------------

  /**
   * 执行上游 API 调用的核心逻辑（callChat 和 callAnthropic 共用）。
   *
   * @param {object|string} model 模型配置或 id
   * @param {object} body 请求体
   * @param {object} opts 含 endpoint, apiType, abortSignal, timeoutMs, excludeKeys 等
   * @returns {Promise<{response: Response, providerName: string, keyId: string, modelId: string}>}
   */
  async _execute(model, body, opts) {
    // 1. 解析 model 配置
    const modelConfig = this._resolveModel(model);
    if (!modelConfig) {
      throw new ProviderError(
        ErrorType.UNKNOWN,
        `model not found in config: ${model}`,
        {}
      );
    }

    const providerName = modelConfig.provider;
    const modelId = modelConfig.id;

    // 2. 获取 provider 配置
    const provider = this._providerIndex.get(providerName);
    if (!provider) {
      throw new ProviderError(
        ErrorType.UNKNOWN,
        `provider not found in config: ${providerName}`,
        { provider: providerName, model: modelId }
      );
    }

    // 3. 客户端已断开 → 立即短路，不发起上游请求
    if (opts.abortSignal?.aborted) {
      throw new ProviderError(
        ErrorType.CLIENT_ABORTED,
        'client aborted before upstream request',
        { provider: providerName, model: modelId }
      );
    }

    // 4. 获取可用 key（轮换）
    const excludeKeys = opts.excludeKeys || [];
    const keyInfo = this.keyPool
      ? this.keyPool.nextKey(providerName, excludeKeys)
      : null;

    if (!keyInfo) {
      throw new ProviderError(
        ErrorType.UNKNOWN,
        `no available key for provider "${providerName}" ` +
          `(all keys cooling/invalid/disabled)`,
        { provider: providerName, model: modelId }
      );
    }

    // 5. 构建请求
    const url = this._buildUrl(provider, opts.endpoint);
    const headers = this._buildHeaders(provider, keyInfo.key);

    // apiModel 映射：将网关内部 model id 替换为上游实际 apiModel
    const requestBody = opts.nativeRequest && opts.nativeBody
      ? { ...opts.nativeBody }
      : { ...body };
    if (modelConfig.apiModel) {
      requestBody.model = modelConfig.apiModel;
    }
    // 传输兼容性：按模型配置的 max_tokens 收紧请求（部分真实网关对超大 max_tokens + tools 拒绝）
    if (typeof modelConfig.max_tokens === 'number' && modelConfig.max_tokens > 0) {
      const reqMax = Number(requestBody.max_tokens);
      if (!Number.isFinite(reqMax) || reqMax > modelConfig.max_tokens) {
        requestBody.max_tokens = modelConfig.max_tokens;
      }
    }

    // Anthropic 特殊处理：添加 anthropic-version 头（若未在 provider 配置中指定）
    if (opts.apiType === 'anthropic') {
      if (!provider.version_header || !provider.version_value) {
        headers['anthropic-version'] = DEFAULT_ANTHROPIC_VERSION;
      }
    }

    const requestBodyStr = JSON.stringify(requestBody);

    // 6. 发起 fetch 请求（组合 abortSignal + 超时）
    const timeoutMs = opts.timeoutMs ?? this._defaultTimeoutMs;
    const startTime = Date.now();

    let response;
    try {
      response = await this._fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: requestBodyStr,
      }, timeoutMs, opts.abortSignal, requestBody.stream === true ? {
        idleTimeoutMs: opts.streamIdleTimeoutMs
          ?? provider.stream_idle_timeout_ms
          ?? this._streamIdleTimeoutMs,
        totalTimeoutMs: opts.streamTotalTimeoutMs
          ?? provider.stream_total_timeout_ms
          ?? this._streamTotalTimeoutMs,
      } : null);
    } catch (err) {
      // fetch 抛出：网络错误或 abort
      const latency = Date.now() - startTime;
      const aborted = opts.abortSignal?.aborted || isAbortError(err);
      const errorType = aborted
        ? ErrorType.CLIENT_ABORTED
        : ErrorType.NETWORK_ERROR;

      // 客户端取消不标记 key 失败（非 key 问题）
      if (!aborted && this.keyPool) {
        this.keyPool.markKeyFailed(providerName, keyInfo.keyId, errorType);
      }
      if (this.health) {
        this.health.recordResult(providerName, false, latency);
      }

      throw new ProviderError(
        errorType,
        aborted
          ? `client aborted during upstream request to ${providerName}`
          : `network error calling ${providerName}: ${err.message}`,
        {
          provider: providerName,
          model: modelId,
          cause: err,
        }
      );
    }

    const latency = Date.now() - startTime;

    // 7. 处理响应
    if (response.ok) {
      // 成功：标记 key 成功 + 记录 health
      if (this.keyPool) {
        this.keyPool.markKeySucceeded(providerName, keyInfo.keyId);
      }
      if (this.health) {
        this.health.recordResult(providerName, true, latency);
      }

      return {
        response,
        providerName,
        keyId: keyInfo.keyId,
        modelId,
        nativeProtocol: opts.nativeRequest === true,
      };
    }

    // 错误响应：读取 body，分类错误
    const respBody = await this._safeReadBody(response);
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    const errorCode = this._extractErrorCode(respBody);
    const errorType = classifyError(
      response.status,
      respBody,
      errorCode,
      { retryAfter }
    );

    // 标记 key 失败（客户端取消不标记）
    if (errorType !== ErrorType.CLIENT_ABORTED && this.keyPool) {
      this.keyPool.markKeyFailed(providerName, keyInfo.keyId, errorType);
    }
    if (this.health) {
      this.health.recordResult(providerName, false, latency);
    }

    const bodyPreview = truncate(
      typeof respBody === 'string'
        ? respBody
        : JSON.stringify(respBody),
      MAX_BODY_LOG_LEN
    );

    log(
      `upstream error from ${providerName}/${modelId}: ` +
        `HTTP ${response.status} (${errorType})` +
        (retryAfter ? ` retry-after=${retryAfter}s` : '') +
        `: ${bodyPreview}`
    );

    throw new ProviderError(
      errorType,
      `upstream ${providerName} returned HTTP ${response.status}`,
      {
        httpStatus: response.status,
        errorCode,
        provider: providerName,
        model: modelId,
        retryAfter,
        body: respBody,
      }
    );
  }

  // --------------------------------------------------------------------------
  // 内部：fetch 封装（组合 abortSignal + 超时）
  // --------------------------------------------------------------------------

  /**
   * 使用 fetch 发起请求，组合外部 abortSignal 与超时控制。
   *
   * 关键设计：
   *   - 若外部 signal 已 aborted，立即抛出（短路）
   *   - 创建 AbortController，将外部 signal 和超时都接入
   *   - 无论成功/失败，都清理定时器和事件监听器
   *
   * @param {string} url
   * @param {object} fetchOptions fetch 配置（method, headers, body）
   * @param {number} timeoutMs 超时毫秒
   * @param {AbortSignal} [externalSignal] 外部取消信号（客户端断开）
   * @returns {Promise<Response>}
   */
  async _fetchWithTimeout(url, fetchOptions, timeoutMs, externalSignal, streamGuard = null) {
    const controller = new AbortController();

    // 超时定时器
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    // 外部信号接入
    let onExternalAbort = null;
    if (externalSignal) {
      // 再次检查（可能在 fetch 前的微任务中变为 aborted）
      if (externalSignal.aborted) {
        clearTimeout(timeout);
        throw new Error('aborted: external signal already aborted');
      }
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let streamGuardActive = false;
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      if (streamGuard && response.body) {
        clearTimeout(timeout);
        streamGuardActive = true;
        return guardStreamingResponse(
          response,
          controller,
          externalSignal,
          onExternalAbort,
          streamGuard,
        );
      }
      return response;
    } finally {
      // 清理：取消超时定时器，移除事件监听
      if (!streamGuardActive) clearTimeout(timeout);
      if (!streamGuardActive && externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  // --------------------------------------------------------------------------
  // 内部：工具方法
  // --------------------------------------------------------------------------

  /**
   * 解析 model 参数为配置对象。
   * 支持传入 model id 字符串或 model 配置对象。
   *
   * @param {object|string} model
   * @returns {object|null}
   */
  _resolveModel(model) {
    if (!model) return null;
    if (typeof model === 'string') {
      return this._modelIndex.get(model) || null;
    }
    // 已是配置对象
    if (typeof model === 'object' && model.id && model.provider) {
      return model;
    }
    return null;
  }

  /**
   * 安全读取响应体（尝试 JSON 解析，失败则返回原始文本）。
   *
   * @param {Response} response
   * @returns {Promise<object|string|null>}
   */
  async _safeReadBody(response) {
    try {
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      return null;
    }
  }

  /**
   * 从响应体中提取 error.code 字段（用于错误分类）。
   *
   * @param {object|string} body
   * @returns {string|null}
   */
  _extractErrorCode(body) {
    if (!body) return null;
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        body = parsed;
      } catch {
        return null;
      }
    }
    if (typeof body === 'object') {
      return (
        body?.error?.code ||
        body?.error?.type ||
        body?.code ||
        body?.type ||
        null
      );
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // 便捷方法
  // --------------------------------------------------------------------------

  /**
   * 获取 provider 配置。
   * @param {string} providerName
   * @returns {object|null}
   */
  getProvider(providerName) {
    return this._providerIndex.get(providerName) || null;
  }

  /**
   * 获取 model 配置。
   * @param {string} modelId
   * @returns {object|null}
   */
  getModel(modelId) {
    return this._modelIndex.get(modelId) || null;
  }
}

export default { ProviderClient };
