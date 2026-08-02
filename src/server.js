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
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
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

  // 3. 初始化存储后端
  //    测试环境（port=0 或无 data_dir）使用 MemoryStore
  //    生产环境使用 SQLiteStore
  let store = null;
  const dataDir = config.server?.data_dir || config.data_dir || null;
  if (dataDir) {
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

  // 4b. 初始化智能层（Phase2-A Shadow；off 模式零开销）
  const intelligence = new IntelligenceLayer(config);
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
  const { config } = components;

  try {
    // 1. 解析 URL
    const url = new URL(req.url, `http://${req.headers.host || DEFAULT_HOST}`);
    let pathname = url.pathname;

    // 2. 路径归一化（/v1/v1/ → /v1/，Claude Code 2.1.206+ 兼容）
    pathname = normalizePath(pathname);

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
        status === 413
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
 *   - JSON 解析失败时返回空对象（不抛出错误，由调用方处理）
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
        // JSON 解析失败：返回空对象，由协议处理器处理无效 body
        log(`server: JSON 解析失败: ${e.message}`);
        resolve({});
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
