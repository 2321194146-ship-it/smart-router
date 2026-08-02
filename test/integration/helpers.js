// test/integration/helpers.js
// Smart Router Mainline - Phase 1 Integration Tests
// Mock provider and test server helpers

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../../src/server.js';

/**
 * Create a mock OpenAI-compatible provider HTTP server.
 * Supports: non-streaming JSON, SSE streaming, errors, request recording.
 */
export function createMockProvider(options = {}) {
  const receivedRequests = [];
  let responseQueue = [];
  let defaultResponse = {
    status: 200,
    body: {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: Date.now(),
      model: 'test-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello from mock provider' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsedBody = null;
      try { parsedBody = JSON.parse(body); } catch { /* ignore */ }

      const recorded = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: parsedBody,
        timestamp: Date.now(),
      };
      receivedRequests.push(recorded);

      let response = defaultResponse;
      if (responseQueue.length > 0) {
        const matcher = responseQueue.find(m => {
          if (!m.match) return true;
          return m.match(recorded);
        });
        if (matcher) {
          response = matcher.response;
          if (matcher.once) {
            responseQueue = responseQueue.filter(m => m !== matcher);
          }
        }
      }

      const headers = response.headers || {};
      if (response.contentType) headers['Content-Type'] = response.contentType;
      if (response.stream) {
        headers['Content-Type'] = 'text/event-stream';
        headers['Cache-Control'] = 'no-cache';
        headers['Connection'] = 'keep-alive';
      }

      res.writeHead(response.status || 200, headers);

      if (response.stream) {
        const events = response.events || [];
        let i = 0;
        const sendNext = () => {
          if (i < events.length) {
            res.write(`data: ${JSON.stringify(events[i])}\n\n`);
            i++;
            setTimeout(sendNext, 10);
          } else {
            if (response.sendDone !== false) {
              res.write('data: [DONE]\n\n');
            }
            if (response.endAfterStream === false) {
              res.socket.destroy();
            } else {
              res.end();
            }
          }
        };
        sendNext();
      } else if (typeof response.body === 'string') {
        res.end(response.body);
      } else {
        res.end(JSON.stringify(response.body));
      }
    });
  });

  return {
    server,
    receivedRequests,
    setDefaultResponse(resp) { defaultResponse = resp; },
    queueResponse(matcher) { responseQueue.push(matcher); },
    clearQueue() { responseQueue = []; },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(addr);
        });
      });
    },
    close() {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(), 3000);
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
    get port() {
      const addr = server.address();
      return addr ? addr.port : null;
    },
  };
}

/**
 * Create a test config for Smart Router pointing to mock provider.
 */
export function createTestConfig(mockPort, options = {}) {
  const enableB = options.enableProviderB !== false;

  const config = {
    server: {
      port: 28788,
      host: '127.0.0.1',
      request_timeout_ms: 30000,
      keep_alive_timeout_ms: 5000,
      max_request_body_bytes: 10485760,
      ...(options.dataDir ? { data_dir: options.dataDir } : {}),
    },
    ...(options.dataDir ? { data_dir: options.dataDir } : {}),
    intelligence: {
      mode: 'off',
      fallback_to_routing: true,
    },
    routing: {
      strategy: 'tier_weighted',
      tier_weights: { tier1: 10, tier2: 5, tier3: 1 },
      max_concurrent: 16,
      max_retries: 3,
      retry_backoff_ms: 100,
      cooldown_default_sec: 60,
      health_check_interval_sec: 999999,
      failover_on_error: true,
    },
    circuit_breaker: {
      enabled: true,
      failure_threshold: 100,
      failure_window_sec: 60,
      open_state_sec: 120,
      half_open_max_calls: 2,
      key_disable_on_auth_invalid: true,
    },
    budget: {
      allowPaid: options.allowPaid !== false,
      maxRequestCost: options.maxRequestCost != null ? options.maxRequestCost : 100,
      allowedModels: options.allowedModels || [],
      allowedProviders: options.allowedProviders || [],
      strictModel: options.strictModel || false,
    },
    providers: options.customProviders || [
      {
        name: 'mock-a',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'test-key-a',
        auth_header: 'Authorization',
        auth_prefix: 'Bearer ',
      },
      {
        name: 'mock-b',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'test-key-b',
        auth_header: 'Authorization',
        auth_prefix: 'Bearer ',
      },
    ],
    models: options.customModels || [
      {
        id: 'test-model-a',
        tier: 'tier1',
        provider: 'mock-a',
        apiModel: 'test-model-a',
        enabled: true,
        paid: false,
        capability: ['chat', 'tool_use', 'streaming'],
        price: { input_cost_per_1k: 0, output_cost_per_1k: 0, currency: 'USD' },
      },
      {
        id: 'test-model-b',
        tier: 'tier2',
        provider: 'mock-b',
        apiModel: 'test-model-b',
        enabled: enableB,
        paid: options.modelBPaid || false,
        capability: ['chat', 'tool_use', 'streaming'],
        price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02, currency: 'USD' },
      },
    ],
    agent_bindings: {},
  };

  return config;
}

export function writeConfig(config, configDir) {
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, `config-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

export async function startSmartRouter(configPath) {
  const server = await createServer(configPath);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

/**
 * Stop Smart Router and clean up all resources (store, health check, server).
 */
export async function stopSmartRouter(routerInfo) {
  if (!routerInfo?.server) return;
  const components = routerInfo.server._components;
  // Stop health check first to prevent new probes
  if (components?.health?.stopHealthCheck) {
    components.health.stopHealthCheck();
  }
  // Force-close all inbound connections
  if (typeof routerInfo.server.closeAllConnections === 'function') {
    routerInfo.server.closeAllConnections();
  }
  // Close server with timeout fallback
  await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 3000);
    routerInfo.server.close(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
  // Close store with timeout
  if (components?.store?.close) {
    await Promise.race([
      components.store.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

export function httpRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method || 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export function httpStreamRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const events = [];
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers,
      timeout: 30000,
    }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        while (true) {
          const idx = buffer.indexOf('\n\n');
          if (idx === -1) break;
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = block.split('\n');
          let data = '';
          let eventType = '';
          for (const line of lines) {
            if (line.startsWith('data: ')) data += line.slice(6);
            else if (line.startsWith('event: ')) eventType = line.slice(7);
          }
          if (data) {
            events.push({ type: eventType, data: data.trim() });
          }
        }
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, events, raw: buffer });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
