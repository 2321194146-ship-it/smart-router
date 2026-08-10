// Authenticated MCP reverse proxy for the local 28788 gateway.
// Client Authorization is never forwarded; only explicitly configured MCP headers are.

import { timingSafeEqual } from 'node:crypto';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function loopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function sameToken(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function configuredAdminToken(config) {
  const envToken = process.env.SMART_ROUTER_ADMIN_TOKEN;
  if (envToken) return envToken;
  return typeof config?.intelligence?.adminToken === 'string' ? config.intelligence.adminToken : null;
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('request_too_large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function handleMcpProxyRequest(req, res, components, pathname) {
  if (!pathname.startsWith('/mcp/')) return false;
  if (!loopback(req.socket?.remoteAddress || '')) {
    json(res, 403, { error: 'forbidden' });
    return true;
  }
  const expected = configuredAdminToken(components.config);
  const authorization = req.headers.authorization || '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!expected || !sameToken(expected, provided)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  const rest = pathname.slice('/mcp/'.length);
  const serverName = decodeURIComponent(rest.split('/')[0] || '');
  const server = components.config.mcp_servers?.[serverName];
  if (!server || server.enabled === false || !validUrl(server.url)) {
    json(res, 404, { error: 'mcp_server_not_found' });
    return true;
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) {
    json(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  const target = new URL(server.url);
  const suffix = rest.slice(serverName.length).replace(/^\//, '');
  if (suffix) target.pathname = `${target.pathname.replace(/\/$/, '')}/${suffix}`;
  target.search = new URL(req.url, 'http://127.0.0.1').search;
  const headers = {};
  for (const [key, value] of Object.entries(server.headers || {})) {
    if (typeof key === 'string' && typeof value === 'string' && key.toLowerCase() !== 'authorization') headers[key] = value;
  }
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers.accept) headers.accept = req.headers.accept;

  try {
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : await readBody(req, components.config.server?.max_request_body_bytes || 10 * 1024 * 1024);
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const responseHeaders = {};
    for (const key of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']) {
      const value = upstream.headers.get(key);
      if (value) responseHeaders[key] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body && req.method !== 'HEAD') {
      const reader = upstream.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        res.write(chunk.value);
      }
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) json(res, error.statusCode || 502, { error: error.statusCode === 413 ? error.message : 'mcp_upstream_error' });
    else if (!res.writableEnded) res.end();
  }
  return true;
}
