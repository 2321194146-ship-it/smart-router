// src/server.js
// Smart Router Mainline - Phase 1
// HTTP 服务器入口：创建并配置 HTTP 服务器，监听 127.0.0.1:28788，
// 将请求路由到对应的协议处理器。
//
// 设计要点：
//   - 端口 28788，绑定 127.0.0.1（与 7878 完全独立，可单独停止）
//   - 配置、数据库、日志全部独立（不读取 7878 数据库）
//   - HEAD /v1 探活支持（Claude Code 兼容）
//   - /v1/v1/ 路径归一化（Claude Code 2.1.206+ 兼容）
//   - count_tokens 兼容（Claude Code 预估 token 用量）
//   - /v1/models 返回 auto 虚拟模型
//   - 优雅关闭（SIGTERM/SIGINT）
//   - 请求体解析（JSON，带大小限制）
//   - 错误处理（不泄露内部错误给客户端）
//   - 请求 ID 生成（用于审计追踪）
//   - ES Module 语法，纯 Node.js 内置模块
//
// 仅使用 Node.js 内置模块（http, url, crypto），无第三方依赖。

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfig, log } from './config/loader.js';
import { validateConfig } from './config/validator.js';
import { resolveAgent } from './agent/identity.js';
import {
  handleHeadRequest,
  normalizePath,
  handleCountTokens,
  applyClaudeCodePatches,
} from './agent/compatibility.js';
import { KeyPool } from './provider/key-pool.js';
import { ProviderHealth, CircuitBreaker } from './provider/health.js';
import { ProviderClient } from './provider/client.js';
import { ExecutionEngine } from './router/execution.js';
import { IntelligenceLayer } from './intelligence/index.js';
import { CostTracker } from './cost/tracker.js';
import { CancelToken } from './runtime/cancellation.js';
import { Finalizer } from './runtime/finalization.js';
import { ConcurrencyGate, FixedWindowRateLimiter } from './runtime/request-controls.js';
import { MemoryStore, SQLiteStore } from './storage/index.js';
import { handleChatCompletion } from './protocols/chat.js';
import { handleChatCompletionStream } from './protocols/chat-stream.js';
import { handleResponse, responsesToChat } from './protocols/responses.js';
import { handleResponseStream } from './protocols/responses-stream.js';
import { handleAnthropicMessage } from './protocols/anthropic.js';
import { handleAnthropicMessageStream } from './protocols/anthropic-stream.js';

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 28788;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
const DASHBOARD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

// ----------------------------------------------------------------------------
// createServer：创建并配置 HTTP 服务器
// ----------------------------------------------------------------------------

/**
 * 创建 HTTP 服务器。
 *
 * 流程：
 *   1. 加载配置（loadConfig）
 *   2. 验证配置（validateConfig）
 *   3. 初始化所有组件（KeyPool / ProviderHealth / CircuitBreaker /
 *      ProviderClient / CostTracker / Finalizer / ExecutionEngine）
 *   4. 启动健康检查（ProviderHealth.startHealthCheck）
 *   5. 创建 HTTP 服务器（http.createServer）
 *   6. 配置服务器超时参数
 *   7. 将配置和组件附加到 server 对象，供外部访问
 *
 * @param {string} [configPath] 配置文件路径
 * @returns {http.Server} HTTP 服务器实例（附加了 _config 和 _components）
 * @throws {Error} 配置加载或验证失败时抛出
 */
export async function createServer(configPath) {
  // 1. 加载配置
  const config = loadConfig(configPath);
  log('server: config loaded');

  // 2. 验证配置
  const validation = validateConfig(config);
  if (!validation.valid) {
    const detail = validation.errors.join('; ');
    throw new Error(`配置验证失败: ${detail}`);
  }
  if (validation.warnings && validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      log(`server: config warning: ${w}`);
    }
  }
  log('server: config validated');

  // 非回环监听默认强制 API Bearer Token；即使配置显式关闭，也不允许把公网接口裸露出去。
  const publicAuth = createPublicAuthPolicy(config);
  const rateLimitConfig = config.routing?.rate_limit || {};
  const rateLimiter = new FixedWindowRateLimiter({
    enabled: rateLimitConfig.enabled ?? publicAuth.enabled,
    windowMs: rateLimitConfig.window_ms ?? 60_000,
    maxRequests: rateLimitConfig.max_requests ?? 120,
  });
  const concurrencyGate = new ConcurrencyGate(config.routing?.max_concurrent ?? 64);

  // 3. 初始化存储后端
  //    测试环境（port=0 或无 data_dir）使用 MemoryStore
  //    生产环境使用 SQLiteStore
  let store = null;
  const dataDir = config.server?.data_dir || config.data_dir || null;
  if (dataDir) {
    // SQLite 不会自动创建父目录；先初始化数据目录，避免首次部署因目录不存在启动失败。
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const dbPath = join(dataDir, 'smart-router.db');
    store = new SQLiteStore(dbPath);
  } else {
    store = new MemoryStore();
  }
  await store.init();
  log('server: storage initialized');

  // 4. 初始化所有组件（注入 store）
  const keyPool = new KeyPool(config, store);
  const health = new ProviderHealth(config, store);
  const circuitBreaker = new CircuitBreaker(config.circuit_breaker || {}, store);
  const providerClient = new ProviderClient(config, keyPool, health);
  const costTracker = new CostTracker(config, store);
  const finalizer = new Finalizer(costTracker, store);
  const executionEngine = new ExecutionEngine(
    config,
    providerClient,
    keyPool,
    health,
    costTracker,
    circuitBreaker,
    store,
  );

  // 持久化状态必须在监听端口前恢复完成，避免重启后的首批请求绕过冷却 Key、
  // Provider 健康状态或已打开的熔断器。
  await Promise.all(
    [
      keyPool.getRestoredPromise?.(),
      health.getRestoredPromise?.(),
      circuitBreaker.getRestoredPromise?.(),
    ].filter(Boolean),
  );
  log('server: provider state restored');

  // 4b. 初始化智能层（Phase2-A/2-B Shadow；off 模式零开销；Shadow 记录持久化到 store）
  const intelligence = new IntelligenceLayer(config, {
    store,
    health,
  });
  // 真实最终结果仅在 Finalize 原子事务成功后记录（观察者钩子失败不影响主流程）
  intelligence.attachTo(finalizer);
  // 启动时按保留天数清理过期 Shadow 记录（intelligence.shadow.retentionDays，默认 30）
  intelligence.prune().catch(() => {});
  // Phase2-C Safety Sealed：恢复持久化的 Canary Kill Switch / shadow 模式（重启后仍保持）
  await intelligence.restoreCanaryState();
  log(`server: intelligence layer initialized (mode=${intelligence.mode})`);

  log('server: all components initialized');

  // 5. 启动健康检查
  //    优先使用 routing.health_check_interval_sec，回退到 300s
  const healthCheckIntervalSec =
    config.routing?.health_check_interval_sec ??
    config.health_check?.interval_sec ??
    300;
  health.startHealthCheck(healthCheckIntervalSec * 1000);
  log(`server: health check started (interval=${healthCheckIntervalSec}s)`);

  // 组件集合（供 handleRequest 使用）
  const components = {
    config,
    store,
    keyPool,
    health,
    circuitBreaker,
    providerClient,
    costTracker,
    finalizer,
    executionEngine,
    intelligence,
    publicAuth,
    rateLimiter,
    concurrencyGate,
  };

  // 6. 创建 HTTP 服务器
  const server = http.createServer(async (req, res) => {
    await handleRequest(req, res, components);
  });

  // 7. 配置服务器超时参数
  server.timeout = config.server?.request_timeout_ms || DEFAULT_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout =
    config.server?.keep_alive_timeout_ms || DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  // headersTimeout 必须 > keepAliveTimeout，否则会导致请求被拒绝
  server.headersTimeout =
    (config.server?.keep_alive_timeout_ms || DEFAULT_KEEP_ALIVE_TIMEOUT_MS) + 1000;

  // 8. 将配置和组件附加到 server 对象，供 index.js 访问
  server._config = config;
  server._components = components;

  log(
    `server: created (timeout=${server.timeout}ms, ` +
    `keepAlive=${server.keepAliveTimeout}ms)`,
  );

  return server;
}

// ----------------------------------------------------------------------------
// handleRequest：请求处理主函数
// ----------------------------------------------------------------------------

/**
 * HTTP 请求处理主函数。
 *
 * 路由逻辑：
 *   1. 解析 URL
 *   2. 路径归一化（/v1/v1/ → /v1/）
 *   3. HEAD /v1 探活（Claude Code 兼容）
 *   4. GET /v1/models（返回 auto 虚拟模型）
 *   5. POST count_tokens 兼容（Claude Code）
 *   6. POST 请求路由到协议处理器：
 *      - /v1/chat/completions → Chat Completions（流式/非流式）
 *      - /v1/responses        → Responses API（流式/非流式）
 *      - /v1/messages         → Anthropic Messages（流式/非流式）
 *   7. 其他方法 → 405
 *
 * @param {http.IncomingMessage} req HTTP 请求对象
 * @param {http.ServerResponse} res HTTP 响应对象
 * @param {object} components 组件集合
 */
async function handleRequest(req, res, components) {
  const { config, publicAuth, rateLimiter, concurrencyGate } = components;
  let admitted = false;

  try {
    // 1. 解析 URL
    const url = new URL(req.url, `http://${req.headers.host || DEFAULT_HOST}`);
    let pathname = url.pathname;

    // 2. 路径归一化（/v1/v1/ → /v1/，Claude Code 2.1.206+ 兼容）
    pathname = normalizePath(pathname);

    // 本地 Dashboard：只允许 loopback 绑定，数据操作仍由 Admin Token 保护。
    if (await handleDashboardRequest(req, res, config, pathname)) return;

    // 2b. 本地管理接口（Phase2-C Safety Sealed）：仅 127.0.0.1 + Admin Token
    if (pathname.startsWith('/_smart-router/intelligence/')) {
      await handleIntelligenceAdmin(req, res, components, pathname);
      return;
    }

    // 先限流再认证，避免错误 Token 暴力尝试绕过资源保护。
    const clientKey = req.socket?.remoteAddress || 'unknown';
    const rate = rateLimiter.consume(clientKey);
    if (!rate.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)),
      });
      res.end(JSON.stringify({ error: { message: 'Too many requests' } }));
      return;
    }

    if (publicAuth.enabled && !isPublicRequestAuthorized(req, publicAuth.token)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      });
      res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
      return;
    }

    if (!concurrencyGate.tryAcquire()) {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': '1',
      });
      res.end(JSON.stringify({ error: { message: 'Server is at concurrency capacity' } }));
      return;
    }
    admitted = true;

    // 3. HEAD /v1 探活（Claude Code 兼容）
    if (req.method === 'HEAD') {
      const headResult = handleHeadRequest(pathname);
      if (headResult.handled) {
        res.writeHead(headResult.statusCode, headResult.headers);
        res.end();
        return;
      }
      // 其他 HEAD 请求 → 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
      return;
    }

    // 4. GET /v1/models（返回 auto 虚拟模型 + 配置中的模型列表）
    if (
      req.method === 'GET' &&
      (pathname === '/v1/models' || pathname === '/models')
    ) {
      handleListModels(req, res, config);
      return;
    }

    // 5. count_tokens 兼容（Claude Code 预估 token 用量）
    if (req.method === 'POST' && pathname.includes('count_tokens')) {
      const body = await parseBody(req, config);
      const tokenResult = handleCountTokens(pathname, body);
      if (tokenResult.handled) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tokenResult.response));
        return;
      }
    }

    // 6. POST 请求路由到协议处理器
    if (req.method === 'POST') {
      const body = await parseBody(req, config);
      assertRequestBodyObject(body);

      // 创建取消令牌（监听客户端断开）
      const cancelToken = CancelToken.fromHttp(req, res);

      // 解析 Agent 身份（从请求头和请求体）
      const agentInfo = resolveAgent(req.headers, body, { path: pathname });

      // 判断协议类型（在构建上下文之前确定，以便透传 protocol）
      const isAnthropic =
        pathname === '/v1/messages' || pathname === '/messages';
      const isResponses =
        pathname === '/v1/responses' || pathname === '/responses';
      const isChat =
        pathname === '/v1/chat/completions' || pathname === '/chat/completions';

      // 确定协议类型（用于审计记录中的 protocol 字段）
      const protocol = isAnthropic ? 'anthropic'
        : isResponses ? 'responses'
        : 'chat';

      // 构建上下文（传递给协议处理器）
      // requestId 由 Server 生成一次，所有 adapter 透传同一个
      // 客户端提供的 x-request-id / x-correlation-id 仅作为 externalRequestId 保存
      const context = {
        ...components,
        cancelToken,
        agentInfo,
        requestId: generateRequestId(req),
        externalRequestId: extractExternalRequestId(req),
        protocol,
      };

      if (isChat) {
        // Chat Completions 协议
        if (body.stream) {
          await handleChatCompletionStream(req, res, body, context);
        } else {
          await handleChatCompletion(req, res, body, context);
        }
      } else if (isResponses) {
        // Responses API 协议（Codex 使用）
        if (body.stream) {
          await handleResponseStream(req, res, body, context);
        } else {
          await handleResponse(req, res, body, context);
        }
      } else if (isAnthropic) {
        // Anthropic Messages 协议（Claude Code 使用）
        // 注意：7878 中 Anthropic 进网关会强制 stream=false
        // 新系统应该尊重客户端的 stream 设置
        if (body.stream) {
          await handleAnthropicMessageStream(req, res, body, context);
        } else {
          await handleAnthropicMessage(req, res, body, context);
        }
      } else {
        // 未知端点
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: `Unknown endpoint: ${pathname}` },
          }),
        );
      }
      return;
    }

    // 7. 其他 HTTP 方法 → 405 Method Not Allowed
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'Method not allowed' },
      }),
    );
  } catch (error) {
    // 顶层错误兜底：记录日志，返回 500（不泄露内部错误详情）
    log(`server: 请求处理错误: ${error.message}`);
    if (error.stack) {
      log(`server: stack: ${error.stack}`);
    }
    if (!res.headersSent) {
      // 请求体过大 → 413
      const status = error.statusCode || 500;
      const message =
        status === 400 || status === 413
          ? error.message
          : 'Internal server error';
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    } else if (!res.writableEnded) {
      // 响应头已发送但未结束，尝试结束响应
      try {
        res.end();
      } catch {
        // 忽略结束异常
      }
    }
  } finally {
    if (admitted) concurrencyGate.release();
  }
}

// ----------------------------------------------------------------------------
// parseBody：请求体解析
// ----------------------------------------------------------------------------

/**
 * 解析 HTTP 请求体（JSON 格式）。
 *
 * 特性：
 *   - 支持 Content-Length 和 chunked 传输
 *   - 大请求体限制（默认 10MB，可配置）
 *   - 超限时抛出 413 错误（由 handleRequest 顶层捕获）
 *   - JSON 解析失败时返回 400，不进入路由或上游调用
 *   - 空请求体返回空对象
 *
 * @param {http.IncomingMessage} req HTTP 请求对象
 * @param {object} config 已加载的配置对象
 * @returns {Promise<object>} 解析后的请求体对象
 * @throws {Error} 当请求体超过大小限制时抛出（含 statusCode=413）
 */
async function parseBody(req, config) {
  // 解析请求体大小限制
  // 支持 max_request_body_bytes（规范字段）和 max_body_size（别名）
  const maxBodyBytes =
    config?.server?.max_request_body_bytes ||
    config?.server?.max_body_size ||
    DEFAULT_MAX_BODY_BYTES;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let exceeded = false;

    req.on('data', (chunk) => {
      if (exceeded) return;

      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        exceeded = true;
        const err = new Error(
          `Request body exceeds maximum size of ${maxBodyBytes} bytes`,
        );
        err.statusCode = 413;
        err.code = 'PAYLOAD_TOO_LARGE';
        // 销毁请求流，停止接收数据
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (exceeded) return; // 已被 reject

      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw || raw.trim() === '') {
          resolve({});
          return;
        }
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (e) {
        // JSON 解析失败：稳定返回 400，避免无效请求进入 Provider。
        log(`server: JSON 解析失败: ${e.message}`);
        const err = new Error('Invalid JSON request body');
        err.statusCode = 400;
        err.code = 'INVALID_JSON';
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (!exceeded) {
        reject(err);
      }
    });
  });
}

// ----------------------------------------------------------------------------
// 本地管理接口（Phase2-C Safety Sealed）
// ----------------------------------------------------------------------------

const ADMIN_STATUS = '/_smart-router/intelligence/status';
const ADMIN_KILL = '/_smart-router/intelligence/kill';
const ADMIN_RESUME = '/_smart-router/intelligence/resume-shadow';

const DASHBOARD_ASSETS = new Map([
  ['/dashboard', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dashboard/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

/**
 * 生成可供本地配置中心展示的安全摘要。
 * 绝不返回 provider api_key、adminToken 或其它凭据；管理页面只需要
 * 了解结构、模型和策略，真正的密钥仍只由服务端配置/环境变量持有。
 */
function buildConfigSummary(config) {
  const models = Array.isArray(config?.models) ? config.models.map((model) => ({
    id: model.id,
    provider: model.provider,
    apiModel: model.apiModel,
    tier: model.tier,
    paid: model.paid === true,
    enabled: model.enabled !== false,
    capabilities: Array.isArray(model.capability)
      ? [...model.capability]
      : Object.keys(model.capabilities || {}),
  })) : [];
  const providers = Array.isArray(config?.providers) ? config.providers.map((provider) => ({
    name: provider.name,
    base_url: provider.base_url,
    api_type: provider.api_type || 'openai_compatible',
    auth_header: provider.auth_header,
    hasApiKey: typeof provider.api_key === 'string' && provider.api_key.length > 0,
  })) : [];
  const bindings = {};
  for (const [agent, binding] of Object.entries(config?.agent_bindings || {})) {
    bindings[agent] = {
      model_ids: Array.isArray(binding?.model_ids) ? [...binding.model_ids] : [],
      budget: binding?.budget ? {
        allowPaid: binding.budget.allowPaid,
        maxRequestCost: binding.budget.maxRequestCost,
        allowedModels: Array.isArray(binding.budget.allowedModels) ? [...binding.budget.allowedModels] : [],
        allowedProviders: Array.isArray(binding.budget.allowedProviders) ? [...binding.budget.allowedProviders] : [],
        strictModel: binding.budget.strictModel,
      } : null,
    };
  }
  return {
    providers,
    models,
    routing: {
      strategy: config?.routing?.strategy,
      maxRetries: config?.routing?.max_retries,
      failoverOnError: config?.routing?.failover_on_error,
      tierWeights: config?.routing?.tier_weights,
    },
    intelligence: {
      mode: config?.intelligence?.mode,
      canaryPercentage: config?.intelligence?.activeCanary?.percentage,
    },
    bindings,
    budget: {
      allowPaid: config?.budget?.allowPaid,
      maxRequestCost: config?.budget?.maxRequestCost,
      strictModel: config?.budget?.strictModel,
    },
  };
}

/**
 * 提供本地运维 Dashboard 静态资源。
 * 页面本身不携带 Token；实际状态、Kill、Resume 请求仍走 Admin Token。
 */
async function handleDashboardRequest(req, res, config, pathname) {
  if (req.method !== 'GET' || !DASHBOARD_ASSETS.has(pathname)) return false;
  if (!isLoopbackBind(config?.server?.host) || !isLoopback(req.socket?.remoteAddress || '')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }

  const [fileName, contentType] = DASHBOARD_ASSETS.get(pathname);
  try {
    const content = readFileSync(join(DASHBOARD_DIR, fileName));
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(content);
  } catch (error) {
    log(`server: dashboard asset error: ${error.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Dashboard unavailable');
  }
  return true;
}

/**
 * 判断是否为回环地址（仅本机可访问管理接口）。
 */
function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * 监听地址是否仅限本机。
 * 未知地址按非回环处理，避免误配置时默认裸露 API。
 */
function isLoopbackBind(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * 构造主推理 API 的认证策略。
 * Token 只从环境变量读取，配置文件不接受明文 api token。
 */
function createPublicAuthPolicy(config) {
  const authConfig = config?.server?.auth;
  const nonLoopback = !isLoopbackBind(config?.server?.host);
  const enabled = nonLoopback || authConfig?.enabled === true;
  if (!enabled) return { enabled: false, token: null };

  const tokenEnv = typeof authConfig?.token_env === 'string' && authConfig.token_env.trim()
    ? authConfig.token_env.trim()
    : 'SMART_ROUTER_API_TOKEN';
  const token = process.env[tokenEnv];
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error(
      `public API auth is required for server.host="${config?.server?.host}"; ` +
      `set ${tokenEnv} to a token of at least 16 characters`,
    );
  }
  return { enabled: true, token };
}

function isPublicRequestAuthorized(req, token) {
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  return secureTokenEqual(token, auth.slice(7));
}

function assertRequestBodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
    const err = new Error('Request body must be a non-empty JSON object');
    err.statusCode = 400;
    err.code = 'INVALID_REQUEST_BODY';
    throw err;
  }
}

/**
 * 读取管理 Token：优先环境变量 SMART_ROUTER_ADMIN_TOKEN，其次配置
 * intelligence.adminToken（实际值不得入 Git）。未配置 → 管理接口禁用（503）。
 */
function resolveAdminToken(config) {
  if (process.env.SMART_ROUTER_ADMIN_TOKEN) return process.env.SMART_ROUTER_ADMIN_TOKEN;
  const t = config?.intelligence?.adminToken;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

/**
 * 使用常量时间比较管理 Token，避免直接字符串比较暴露可利用的时序差异。
 * 长度不一致时只能提前返回；相同长度的比较使用 timingSafeEqual。
 */
function secureTokenEqual(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}

/**
 * 本地管理接口处理：
 *   - GET  status         返回智能层状态（mode / canary / metrics）
 *   - POST kill           立即停止 Active Canary 并持久化（重启后仍保持）
 *   - POST resume-shadow  只恢复 Shadow（Canary 禁用），绝不自动恢复 Active
 * 安全约束：仅回环地址 + Bearer Token；未配置 Token 时返回 503。
 */
async function handleIntelligenceAdmin(req, res, components, pathname) {
  const { config, intelligence } = components;
  const token = resolveAdminToken(config);
  const auth = req.headers['authorization'] || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const ip = req.socket?.remoteAddress || '';

  if (!isLoopback(ip)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
    return;
  }
  if (!token) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false, error: 'admin_disabled',
      hint: 'set SMART_ROUTER_ADMIN_TOKEN to enable admin endpoints',
    }));
    return;
  }
  if (!secureTokenEqual(provided, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  try {
    if (req.method === 'GET' && pathname === ADMIN_STATUS) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...intelligence.status(), config: buildConfigSummary(config) }));
      return;
    }
    if (req.method === 'POST' && pathname === ADMIN_KILL) {
      intelligence.killCanary('admin_kill_switch');
      await intelligence.persistCanaryState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, killed: true, ...intelligence.status() }));
      return;
    }
    if (req.method === 'POST' && pathname === ADMIN_RESUME) {
      intelligence.resumeShadow();
      await intelligence.persistCanaryState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, resumedShadow: true, ...intelligence.status() }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  } catch (err) {
    log(`server: admin route error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'internal' }));
  }
}

// ----------------------------------------------------------------------------
// handleListModels：/v1/models 响应
// ----------------------------------------------------------------------------

/**
 * 处理 GET /v1/models 请求。
 *
 * 返回 OpenAI 兼容的模型列表格式：
 *   {
 *     object: 'list',
 *     data: [
 *       { id: 'auto', object: 'model', created: 0, owned_by: 'smart-router' },
 *       { id: '<model-id>', object: 'model', created: 0, owned_by: '<provider>' },
 *       ...
 *     ]
 *   }
 *
 * 'auto' 是虚拟模型，表示由路由器自动选择模型。
 * 仅返回 enabled=true 的模型。
 *
 * @param {http.IncomingMessage} req HTTP 请求对象
 * @param {http.ServerResponse} res HTTP 响应对象
 * @param {object} config 已加载的配置对象
 */
function handleListModels(req, res, config) {
  // 虚拟模型 'auto'：表示由路由器自动选择
  const models = [
    {
      id: 'auto',
      object: 'model',
      created: 0,
      owned_by: 'smart-router',
    },
  ];

  // 添加配置中的模型（仅 enabled 的）
  const configModels = Array.isArray(config.models) ? config.models : [];
  for (const m of configModels) {
    // 跳过未启用的模型
    if (m.enabled === false) continue;
    models.push({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: m.provider || 'unknown',
    });
  }

  const responseBody = JSON.stringify({ object: 'list', data: models });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(responseBody),
  });
  res.end(responseBody);
}

// ----------------------------------------------------------------------------
// generateRequestId：请求 ID 生成
// ----------------------------------------------------------------------------

/**
 * 生成请求唯一标识（用于审计追踪）。
 *
 * 优先级：
 *   1. x-request-id 请求头
 *   2. x-correlation-id 请求头
 *   3. 自动生成：sr_<timestamp>_<random>
 *
 * @param {http.IncomingMessage} req HTTP 请求对象
 * @returns {string} 请求唯一标识
 */
function generateRequestId(req) {
  // 始终生成内部唯一 ID，不使用外部 header 作为主键
  const timestamp = Date.now();
  const random = randomBytes(3).toString('hex');
  return `sr_${timestamp}_${random}`;
}

/**
 * 提取外部请求 ID（仅用于审计追踪，不作为数据库主键）。
 */
function extractExternalRequestId(req) {
  const headers = req?.headers || {};
  return headers['x-request-id'] || headers['x-correlation-id'] || null;
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  createServer,
  parseBody,
  handleListModels,
  generateRequestId,
  extractExternalRequestId,
};
