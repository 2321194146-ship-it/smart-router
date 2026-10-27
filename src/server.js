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
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfig, log } from './config/loader.js';
import { validateConfig } from './config/validator.js';
import { getAgentBudget, getAgentModels, resolveAgent } from './agent/identity.js';
import {
  handleHeadRequest,
  normalizePath,
  handleCountTokens,
  applyClaudeCodePatches,
} from './agent/compatibility.js';
import { KeyPool } from './provider/key-pool.js';
import { ProviderHealth, CircuitBreaker } from './provider/health.js';
import { ProviderClient } from './provider/client.js';
import { buildCandidates } from './router/candidates.js';
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
import { handleLegacyApiRequest } from './legacy-api.js';
import { handleMcpProxyRequest } from './mcp-proxy.js';
import { handleMediaRequest } from './media-proxy.js';
import { VirtualKeyManager } from './virtual-keys.js';
import { UserManager } from './management/users.js';

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
  await costTracker.restore();
  const finalizer = new Finalizer(costTracker, store);
  const virtualKeys = new VirtualKeyManager(config);
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

  // 4c. 初始化用户管理系统（Phase 2: Multi-user management）
  const userManager = new UserManager(store);
  await userManager.initDefaultAdmin();
  log('server: user management initialized');

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
    configPath: configPath ? resolve(configPath) : resolve(process.cwd(), 'config', 'config.json'),
    store,
    keyPool,
    health,
    circuitBreaker,
    providerClient,
    costTracker,
    finalizer,
    virtualKeys,
    executionEngine,
    intelligence,
    userManager,
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
  let virtualKeyRelease = null;

  try {
    // 1. 解析 URL
    const url = new URL(req.url, `http://${req.headers.host || DEFAULT_HOST}`);
    let pathname = url.pathname;

    // 2. 路径归一化（/v1/v1/ → /v1/，Claude Code 2.1.206+ 兼容）
    pathname = normalizePath(pathname);

    // 本地 Dashboard：只允许 loopback 绑定，数据操作仍由 Admin Token 保护。
    if (await handleDashboardRequest(req, res, config, pathname)) return;

    // 2b. 本地管理接口（Phase2-C Safety Sealed）：仅 127.0.0.1 + Admin Token
    if (pathname.startsWith('/_smart-router/')) {
      await handleIntelligenceAdmin(req, res, components, pathname);
      return;
    }

    if (await handleMcpProxyRequest(req, res, components, pathname)) return;

    // 旧 7878 管理 API 兼容层：仅回环 + 管理 Token（健康探针除外）。
    if (await handleLegacyApiRequest(req, res, components, pathname)) return;

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

    const authHeader = req.headers['authorization'];
    const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '';
    const requestUser = bearerToken && components.userManager
      ? await components.userManager.getUserByToken(bearerToken)
      : null;
    const publicAuthorized = publicAuth.enabled && isPublicRequestAuthorized(req, publicAuth.token);

    if (requestUser && requestUser.status !== 'active') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'User account is disabled' } }));
      return;
    }
    if (publicAuth.enabled && !publicAuthorized && !requestUser) {
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

    if (await handleMediaRequest(req, res, components, pathname)) return;

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

      if (requestUser) {
        const quota = components.userManager.checkQuota(requestUser);
        if (!quota.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'User monthly quota exceeded' } }));
          return;
        }
        if (body.model && body.model !== 'auto' && !components.userManager.canAccessModel(requestUser, body.model)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Requested model is not allowed for this user' } }));
          return;
        }
      }
      const requestBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');

      const virtualKeyDecision = components.virtualKeys?.authorize(req, body.model || null);
      if (virtualKeyDecision && !virtualKeyDecision.allowed) {
        res.writeHead(virtualKeyDecision.status || 403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: virtualKeyDecision.reason }));
        return;
      }
      virtualKeyRelease = virtualKeyDecision?.release || null;

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
        user: requestUser,
      };
      if (requestUser) {
        res.once('finish', () => {
          setImmediate(() => {
            const costRecord = components.costTracker.getRecord(context.requestId);
            const cost = costRecord?.cost?.totalCost || 0;
            components.userManager.recordUsage(requestUser.id, requestBytes, cost).catch(() => {});
          });
        });
      }

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
    virtualKeyRelease?.();
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
 * 生成可编辑但不含密钥的配置草稿。
 * 保存时服务端会按 provider.name 复用当前密钥，避免 Token 往返浏览器。
 */
function buildEditableConfig(config) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const intelligence = clone(config?.intelligence || {});
  delete intelligence.adminToken;
  const providers = Array.isArray(config?.providers)
    ? config.providers.map(({ api_key: _apiKey, api_keys: _apiKeys, ...provider }) => provider)
    : [];
  return {
    intelligence,
    routing: clone(config?.routing || {}),
    models: clone(config?.models || []),
    providers,
    agent_bindings: clone(config?.agent_bindings || {}),
    budget: clone(config?.budget || {}),
    circuit_breaker: clone(config?.circuit_breaker || {}),
  };
}

function mergeEditableConfig(current, incoming) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const next = clone(current);
  const editableSections = ['intelligence', 'routing', 'models', 'agent_bindings', 'budget', 'circuit_breaker'];
  for (const section of editableSections) {
    if (Object.prototype.hasOwnProperty.call(incoming, section)) {
      next[section] = clone(incoming[section]);
    }
  }

  if (Object.prototype.hasOwnProperty.call(incoming, 'providers')) {
    const previousByName = new Map(
      (Array.isArray(current.providers) ? current.providers : [])
        .filter((provider) => provider?.name)
        .map((provider) => [provider.name, provider]),
    );
    next.providers = (Array.isArray(incoming.providers) ? incoming.providers : []).map((provider) => {
      const previous = previousByName.get(provider?.name);
      const merged = clone(provider);
      const incomingApiKey = Object.prototype.hasOwnProperty.call(merged, 'api_key');
      // 草稿不含 api_key 时复用现有密钥；新 Provider 必须显式配置密钥后才能通过校验。
      if (!incomingApiKey && merged.api_key === undefined && previous?.api_key !== undefined) merged.api_key = previous.api_key;
      // 前端输入新 API Key 时会显式提交 api_key、移除 api_keys；这表示用户要用单密钥替换整个旧密钥池。
      if (!incomingApiKey && merged.api_keys === undefined && previous?.api_keys !== undefined) merged.api_keys = previous.api_keys;
      return merged;
    });
  }

  // server、data_dir、adminToken 等运行时/认证边界不允许由 Dashboard 修改。
  next.server = clone(current.server || {});
  if (current.intelligence?.adminToken !== undefined) {
    next.intelligence.adminToken = current.intelligence.adminToken;
  }
  return next;
}

async function writeConfigAtomically(configPath, config) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const backupPath = `${configPath}.bak-${stamp}-${randomBytes(3).toString('hex')}`;
  const tempPath = `${configPath}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  await copyFile(configPath, backupPath);
  await chmod(backupPath, 0o600);
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, configPath);
  } catch (error) {
    try { await rename(tempPath, `${configPath}.failed-${process.pid}`); } catch { /* best effort cleanup */ }
    throw error;
  }
  return backupPath;
}

function adminInputError(code, message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function mergeProviderForTest(config, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw adminInputError('provider_object_required', 'Provider 配置无效');
  }
  const name = typeof incoming.name === 'string' ? incoming.name.trim() : '';
  if (!name || name.length > 128) throw adminInputError('invalid_provider_name', 'Provider 名称无效');
  const previous = (Array.isArray(config?.providers) ? config.providers : [])
    .find((provider) => provider?.name === name);
  const provider = { ...(previous || {}), ...incoming, name };
  if (Object.prototype.hasOwnProperty.call(incoming, 'api_key')) delete provider.api_keys;

  if (typeof provider.base_url !== 'string' || provider.base_url.length > 2048) {
    throw adminInputError('invalid_base_url', '接口地址无效');
  }
  let parsed;
  try { parsed = new URL(provider.base_url); } catch { throw adminInputError('invalid_base_url', '接口地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw adminInputError('invalid_base_url', '接口地址必须是无内嵌账号的 HTTP(S) 地址');
  }
  if (provider.api_type !== undefined && !['openai', 'anthropic_native'].includes(provider.api_type)) {
    throw adminInputError('invalid_api_type', '接口类型只支持 OpenAI 兼容或 Anthropic 原生');
  }
  const key = Array.isArray(provider.api_keys)
    ? provider.api_keys.find((item) => typeof item === 'string' && item.length > 0)
    : provider.api_key;
  if (typeof key !== 'string' || !key.trim() || key.length > 8192) {
    throw adminInputError('api_key_required', '请输入 API Key 后再测试连接');
  }
  return provider;
}

function providerModelsUrl(provider) {
  const target = new URL(provider.base_url);
  const path = target.pathname.replace(/\/+$/, '');
  if (/\/models$/i.test(path)) target.pathname = path;
  else if (/\/v1$/i.test(path)) target.pathname = `${path}/models`;
  else target.pathname = `${path}/v1/models`;
  target.search = '';
  target.hash = '';
  return target.toString();
}

function providerTestHeaders(provider) {
  const key = Array.isArray(provider.api_keys)
    ? provider.api_keys.find((item) => typeof item === 'string' && item.length > 0)
    : provider.api_key;
  const nativeAnthropic = provider.api_type === 'anthropic_native';
  const authHeader = provider.auth_header || (nativeAnthropic ? 'x-api-key' : 'Authorization');
  const authPrefix = provider.auth_prefix ?? (nativeAnthropic ? '' : 'Bearer ');
  const headers = { Accept: 'application/json', [authHeader]: `${authPrefix}${key}` };
  if (nativeAnthropic) {
    headers[provider.version_header || 'anthropic-version'] = provider.version_value || '2023-06-01';
  }
  return headers;
}

async function readProviderJson(response, maxBytes = 1024 * 1024) {
  if (!response.body) return null;
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw adminInputError('provider_response_too_large', 'Provider 返回的模型列表过大');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw adminInputError('provider_response_too_large', 'Provider 返回的模型列表过大');
    }
    chunks.push(Buffer.from(value));
  }
  if (size === 0) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function discoveredModels(payload) {
  const source = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models) ? payload.models : [];
  const unique = new Set();
  const models = [];
  for (const item of source) {
    const id = typeof item === 'string' ? item : item?.id || item?.name;
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || unique.has(id)) continue;
    unique.add(id);
    models.push({ id, ownedBy: typeof item?.owned_by === 'string' ? item.owned_by : null });
    if (models.length >= 200) break;
  }
  return models;
}

function providerFailure(status) {
  if (status === 401 || status === 403) return ['authentication_failed', '认证失败，请检查 API Key 和接口类型'];
  if (status === 404) return ['models_endpoint_not_found', '连接到了服务，但没有找到模型列表接口'];
  if (status === 429) return ['rate_limited', 'Provider 限流，请稍后重试'];
  if (status >= 500) return ['provider_unavailable', 'Provider 暂时不可用'];
  return ['provider_rejected', `Provider 拒绝了测试请求（HTTP ${status}）`];
}

async function testProviderConnection(config, incoming) {
  const provider = mergeProviderForTest(config, incoming);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const startedAt = Date.now();
  try {
    const response = await fetch(providerModelsUrl(provider), {
      method: 'GET',
      headers: providerTestHeaders(provider),
      redirect: 'manual',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (response.status >= 300 && response.status < 400) {
      return { statusCode: 422, body: { ok: false, connected: false, errorCode: 'redirect_not_allowed', message: 'Provider 返回了跳转，为防止密钥泄露已停止测试', latencyMs } };
    }
    if (!response.ok) {
      const [errorCode, message] = providerFailure(response.status);
      return { statusCode: 422, body: { ok: false, connected: false, errorCode, message, httpStatus: response.status, latencyMs } };
    }
    const payload = await readProviderJson(response);
    const models = discoveredModels(payload);
    return {
      statusCode: 200,
      body: {
        ok: true,
        connected: true,
        provider: provider.name,
        latencyMs,
        models,
        message: models.length > 0 ? `连接成功，发现 ${models.length} 个模型` : '连接成功，但没有识别到模型列表',
      },
    };
  } catch (error) {
    if (error?.statusCode === 400) throw error;
    const timedOut = error?.name === 'AbortError';
    return {
      statusCode: timedOut ? 504 : 502,
      body: {
        ok: false,
        connected: false,
        errorCode: timedOut ? 'provider_timeout' : 'provider_network_error',
        message: timedOut ? '连接超时，请检查接口地址或网络' : '无法连接 Provider，请检查接口地址和网络',
        latencyMs: Date.now() - startedAt,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function backupNamePattern(configPath) {
  const escaped = basename(configPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.bak-\\d{14,20}-[a-f0-9]{6}$`);
}

async function listConfigBackups(configPath) {
  const pattern = backupNamePattern(configPath);
  const entries = await readdir(dirname(configPath), { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const info = await lstat(join(dirname(configPath), entry.name));
    backups.push({ name: entry.name, createdAt: info.mtime.toISOString(), size: info.size });
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
}

async function rollbackConfig(components, backupName) {
  if (typeof backupName !== 'string' || !backupNamePattern(components.configPath).test(backupName)) {
    throw adminInputError('invalid_backup_name', '备份名称无效');
  }
  const backupPath = join(dirname(components.configPath), backupName);
  const info = await lstat(backupPath).catch(() => null);
  if (!info?.isFile() || info.size > 2 * 1024 * 1024) {
    throw adminInputError('backup_unavailable', '备份不存在或不可用');
  }
  let candidate;
  try { candidate = JSON.parse(await readFile(backupPath, 'utf8')); } catch { throw adminInputError('invalid_backup', '备份文件不是有效配置'); }
  const validation = validateConfig(candidate);
  if (!validation.valid) {
    const error = adminInputError('invalid_backup', '备份配置校验失败');
    error.details = validation.errors;
    throw error;
  }
  const safetyBackup = await writeConfigAtomically(components.configPath, candidate);
  return {
    backupName,
    safetyBackupName: basename(safetyBackup),
    warnings: validation.warnings,
    config: buildConfigSummary(candidate),
  };
}

function simulateRoute(components, body) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt || prompt.length > 20000) throw adminInputError('invalid_prompt', '请输入 1 到 20000 字的任务内容');
  const protocol = ['chat', 'anthropic', 'responses'].includes(body.protocol) ? body.protocol : 'chat';
  const agentId = typeof body.agentId === 'string' && body.agentId.trim() ? body.agentId.trim().slice(0, 128) : 'generic';
  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const requestBody = protocol === 'responses'
    ? { model: requestedModel, input: prompt }
    : { model: requestedModel, messages: [{ role: 'user', content: prompt }] };
  const agentModels = getAgentModels(agentId, components.config);
  const budget = getAgentBudget(agentId, components.config);
  const candidates = buildCandidates(requestedModel, components.config, {
    agentId,
    agentModels,
    budget,
    strictModel: budget.strictModel,
  });
  const decision = components.intelligence.decisionEngine.decide({
    body: requestBody,
    agentId,
    budget,
    candidates,
    protocol,
  });
  return {
    agentId,
    protocol,
    requestedModel,
    candidateCount: candidates.length,
    task: decision.task,
    budgetAssessment: decision.budgetAssessment,
    recommendation: decision.recommendation,
    ranked: decision.ranked,
    predictions: decision.predictions,
    explanation: decision.explanation,
  };
}

function sanitizeAttempt(attempt) {
  return {
    attemptNumber: attempt?.attemptNumber ?? null,
    model: attempt?.model ?? null,
    provider: attempt?.provider ?? null,
    transportOutcome: attempt?.transportOutcome ?? null,
    validatedOutcome: attempt?.validatedOutcome ?? null,
    errorType: attempt?.errorType ?? null,
    httpStatus: attempt?.httpStatus ?? null,
    latencyMs: Number(attempt?.latencyMs || 0),
    firstByteMs: attempt?.firstByteMs ?? null,
    budgetBlocked: attempt?.budgetBlocked === true,
    usage: attempt?.usage ?? null,
    cost: attempt?.cost ?? null,
    timestamp: attempt?.timestamp ?? null,
  };
}

async function listRequestLogs(store, req) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '30', 10) || 30));
  const query = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
  const provider = (url.searchParams.get('provider') || '').trim().slice(0, 128);
  const outcome = (url.searchParams.get('outcome') || '').trim().slice(0, 64);
  const records = await store.getAllAuditRecords();
  const filtered = records
    .filter((record) => !provider || record.finalProvider === provider)
    .filter((record) => !outcome || record.outcome === outcome)
    .filter((record) => !query || [record.requestId, record.finalModel, record.finalProvider, record.agentId, record.protocol, record.outcome]
      .some((value) => String(value || '').toLowerCase().includes(query)))
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, limit);
  const logs = await Promise.all(filtered.map(async (record) => {
    const attempts = (Array.isArray(record.attempts) ? record.attempts : []).map(sanitizeAttempt);
    const costRecord = await store.getCost(record.requestId);
    return {
      requestId: record.requestId,
      outcome: record.outcome,
      finalModel: record.finalModel,
      finalProvider: record.finalProvider,
      attemptCount: record.attemptCount,
      agentId: record.agentId,
      protocol: record.protocol,
      responseSize: record.responseSize,
      latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
      usage: costRecord?.usage || attempts.at(-1)?.usage || null,
      cost: costRecord?.cost || attempts.at(-1)?.cost || null,
      attempts,
      timestamp: record.timestamp,
    };
  }));
  return { logs, count: logs.length, limit };
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
  const { config, intelligence, userManager } = components;
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
    res.end(JSON.stringify({ ok: false, error: 'admin_disabled' }));
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
      res.end(JSON.stringify({
        ok: true,
        ...intelligence.status(),
        config: buildConfigSummary(config),
        editableConfig: buildEditableConfig(config),
      }));
      return;
    }
    if (req.method === 'POST' && pathname === '/_smart-router/providers/test') {
      const body = await parseBody(req, config);
      assertRequestBodyObject(body);
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 64 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'request_too_large' }));
        return;
      }
      const result = await testProviderConnection(config, body.provider);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
      return;
    }
    if (req.method === 'GET' && pathname === '/_smart-router/config/backups') {
      const backups = await listConfigBackups(components.configPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, backups }));
      return;
    }
    if (req.method === 'POST' && pathname === '/_smart-router/config/rollback') {
      const body = await parseBody(req, config);
      assertRequestBodyObject(body);
      const result = await rollbackConfig(components, body.backupName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        rolledBack: true,
        restartRequired: true,
        ...result,
      }));
      return;
    }
    if (req.method === 'POST' && pathname === '/_smart-router/intelligence/simulate') {
      const body = await parseBody(req, config);
      assertRequestBodyObject(body);
      const result = simulateRoute(components, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, simulated: true, ...result }));
      return;
    }
    if (req.method === 'GET' && pathname === '/_smart-router/logs') {
      const result = await listRequestLogs(components.store, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    // ---- 用户管理 API (Phase 2: Multi-user) ----
    const uAdmin = userManager;
    if (!uAdmin) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'user_manager_unavailable' }));
      return;
    }

    // GET /_smart-router/users/stats - 用户统计
    if (req.method === 'GET' && pathname === '/_smart-router/users/stats') {
      const stats = uAdmin.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...stats }));
      return;
    }

    // GET /_smart-router/users - 列出所有用户
    if (req.method === 'GET' && pathname === '/_smart-router/users') {
      const users = await uAdmin.listUsers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, users }));
      return;
    }

    // GET /_smart-router/users/:id - 获取单个用户
    if (req.method === 'GET' && pathname.startsWith('/_smart-router/users/')) {
      const userId = pathname.split('/').pop();
      const user = await uAdmin.getUser(userId);
      if (!user) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'user_not_found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, user }));
      return;
    }

    // POST /_smart-router/users - 创建用户
    if (req.method === 'POST' && pathname === '/_smart-router/users') {
      const body = await parseBody(req, config);
      assertRequestBodyObject(body);
      try {
        const user = await uAdmin.createUser(body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user }));
      } catch (err) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'user_create_failed', message: err.message }));
      }
      return;
    }

    // PUT /_smart-router/users/:id - 更新用户
    if (req.method === 'PUT' && pathname.startsWith('/_smart-router/users/')) {
      const userId = pathname.split('/').pop();
      const body = await parseBody(req, config);
      assertRequestBodyObject(body);
      try {
        const user = await uAdmin.updateUser(userId, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user }));
      } catch (err) {
        res.writeHead(err.message.includes('not found') ? 404 : 422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'user_update_failed', message: err.message }));
      }
      return;
    }

    // DELETE /_smart-router/users/:id - 删除用户
    if (req.method === 'DELETE' && pathname.startsWith('/_smart-router/users/')) {
      const userId = pathname.split('/').pop();
      try {
        await uAdmin.deleteUser(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: userId }));
      } catch (err) {
        res.writeHead(err.message.includes('not found') ? 404 : 422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'user_delete_failed', message: err.message }));
      }
      return;
    }

    // POST /_smart-router/users/:id/rotate-token - 轮换用户密钥
    if (req.method === 'POST' && pathname.match(/^\/_smart-router\/users\/[^/]+\/rotate-token$/)) {
      const userId = pathname.split('/')[4];
      try {
        const newToken = await uAdmin.rotateToken(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: newToken }));
      } catch (err) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'token_rotation_failed', message: err.message }));
      }
      return;
    }

    // ---- 成本报表 API ----
    if (req.method === 'GET' && pathname === '/_smart-router/cost/report') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const groupBy = params.get('groupBy') || 'model';
      const days = parseInt(params.get('days') || '30', 10);
      if (!['model', 'provider', 'date', 'user'].includes(groupBy) || !Number.isInteger(days) || days < 1 || days > 3650) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_report_parameters' }));
        return;
      }
      const result = await components.costTracker.getReport(groupBy, days);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, groupBy, days, ...result }));
      return;
    }

    if (req.method === 'POST' && (pathname === '/_smart-router/config/validate' || pathname === '/_smart-router/config/apply')) {
      const body = await parseBody(req, config);
      assertRequestBodyObject(body);
      if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'config_object_required' }));
        return;
      }
      if (Buffer.byteLength(JSON.stringify(body.config), 'utf8') > 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'config_too_large' }));
        return;
      }
      const candidate = mergeEditableConfig(config, body.config);
      const validation = validateConfig(candidate);
      if (!validation.valid) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, valid: false, errors: validation.errors, warnings: validation.warnings }));
        return;
      }
      if (pathname.endsWith('/validate')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, valid: true, errors: [], warnings: validation.warnings, config: buildConfigSummary(candidate) }));
        return;
      }
      const backupPath = await writeConfigAtomically(components.configPath, candidate);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        applied: true,
        valid: true,
        restartRequired: true,
        backupCreated: true,
        backupName: backupPath.split('/').pop(),
        warnings: validation.warnings,
        config: buildConfigSummary(candidate),
      }));
      return;
    }
    // 滚动重启：触发热重载
    if (req.method === 'POST' && pathname === '/_smart-router/restart') {
      const msg = `server: 收到管理端重启请求（Admin Token）`;
      log(msg);
      process.emit('SIGUSR2');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, restarting: true, message: '热重载已触发，进程即将重启' }));
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
    const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: statusCode === 500 ? 'internal' : err.code || 'invalid_request',
      hint: statusCode === 500 ? undefined : err.message,
      errors: Array.isArray(err?.details) ? err.details : undefined,
    }));
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
