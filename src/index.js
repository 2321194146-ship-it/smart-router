#!/usr/bin/env node
/**
 * Smart Router v6.2.1 — AI Gateway
 * Intelligent model routing with circuit breaker, rate limiting, caching, and dashboard
 * 
 * Usage:
 *   node src/index.js               # defaults to PORT=17878 (modular test port)
 *   PORT=17878 node src/index.js    # explicit modular test port
 *   PORT=7878 node src/index.js     # OLD production port — human-only, never automated
 */
import { loadConfig } from './config.js';
import { createServer } from './server.js';

const config = loadConfig();
const srv = createServer();

const PORT = config.port;
const HOST = config.host;

srv.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
    process.exit(1);
  }
  console.error(`💥 Server error:`, e.message);
});

srv.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════╗
║     Smart Router v6.2.1 — AI Gateway     ║
╠══════════════════════════════════════╣
║  📡 ${HOST}:${PORT}                    ║
║  📊 Dashboard: http://${HOST}:${PORT}/dashboard  ║
║  🩺 Health:    http://${HOST}:${PORT}/health      ║
║  🤖 API:       http://${HOST}:${PORT}/v1/chat/completions  ║
╚══════════════════════════════════════╝
  `);
  console.log(`[startup] Listening on ${HOST}:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shutdown] Gracefully shutting down...');
  srv.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  srv.close(() => process.exit(0));
});
