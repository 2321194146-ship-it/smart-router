// src/index.js
// Smart Router Mainline - Phase 1
// 入口文件：加载配置、创建服务器、启动监听、处理优雅关闭。
//
// 设计要点：
//   - 配置文件路径优先级：命令行参数 > 环境变量 > 默认路径
//   - 默认监听 127.0.0.1:28788（与 7878 完全独立）
//   - 优雅关闭：收到 SIGTERM/SIGINT 后停止接受新连接，
//     等待现有连接完成（有超时兜底），然后退出
//   - 启动时输出关键信息：监听地址、配置文件、智能模式、模型/provider 数量
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { createServer } from './server.js';
import { getConfig, log } from './config/loader.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ----------------------------------------------------------------------------
// 配置文件路径解析
// ----------------------------------------------------------------------------

// 优先级：命令行参数 > 环境变量 > 默认路径（与 src/ 同级的 config/config.json）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultConfigPath = join(__dirname, '..', 'config', 'config.json');

const configPath =
  process.argv[2] ||
  process.env.SR_CONFIG_PATH ||
  defaultConfigPath;

// ----------------------------------------------------------------------------
// 创建并启动服务器
// ----------------------------------------------------------------------------

let server;

try {
  server = createServer(configPath);
} catch (err) {
  log(`server: 启动失败: ${err.message}`);
  if (err.stack) {
    log(`server: stack: ${err.stack}`);
  }
  process.exit(1);
}

// 获取配置（createServer 内部已调用 loadConfig，getConfig 返回已加载的配置）
const config = server._config || getConfig();

// 解析监听地址和端口
const host = config.server?.host || '127.0.0.1';
const port = config.server?.port || 28788;
const shutdownGraceMs = config.server?.shutdown_grace_ms || 5000;

// 启动服务器
server.listen(port, host, () => {
  log(`server: Smart Router Mainline 已启动: http://${host}:${port}`);
  log(`server: 配置文件: ${configPath}`);
  log(`server: 智能模式: ${config.intelligence?.mode || 'off'}`);
  log(`server: 模型数量: ${config.models?.length || 0}`);
  log(`server: Provider 数量: ${config.providers?.length || 0}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`server: 端口 ${port} 已被占用，请检查是否有其他进程正在使用`);
  } else {
    log(`server: 服务器错误: ${err.message}`);
  }
  process.exit(1);
});

// ----------------------------------------------------------------------------
// 优雅关闭
// ----------------------------------------------------------------------------

/**
 * 优雅关闭服务器。
 *
 * 流程：
 *   1. 停止接受新连接（server.close）
 *   2. 等待现有连接完成（有 shutdownGraceMs 超时兜底）
 *   3. 停止健康检查定时器
 *   4. 退出进程
 *
 * 与 7878 完全独立：停止 28788 不影响 7878 的运行。
 */
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) {
    // 重复信号：强制退出
    log(`server: 收到重复 ${signal}，强制退出`);
    process.exit(1);
    return;
  }
  shuttingDown = true;

  log(`server: 收到 ${signal}，正在关闭...`);

  // 停止健康检查定时器
  const components = server._components;
  if (components?.health && typeof components.health.stopHealthCheck === 'function') {
    components.health.stopHealthCheck();
    log('server: 健康检查已停止');
  }

  // 停止接受新连接，等待现有连接完成
  server.close((err) => {
    if (err) {
      log(`server: 关闭时出错: ${err.message}`);
      process.exit(1);
    } else {
      log('server: 服务器已关闭');
      process.exit(0);
    }
  });

  // 超时兜底：超过 shutdownGraceMs 后强制退出
  setTimeout(() => {
    log(`server: 关闭超时（${shutdownGraceMs}ms），强制退出`);
    process.exit(1);
  }, shutdownGraceMs).unref();
}

// 注册信号处理
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未捕获异常兜底（防止进程崩溃）
process.on('uncaughtException', (err) => {
  log(`server: 未捕获异常: ${err.message}`);
  if (err.stack) {
    log(`server: stack: ${err.stack}`);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log(`server: 未处理的 Promise 拒绝: ${msg}`);
});

// ----------------------------------------------------------------------------
// 导出服务器实例（供测试或其他模块使用）
// ----------------------------------------------------------------------------

export { server };
