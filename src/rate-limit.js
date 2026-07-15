/**
 * rate-limit.mjs — v6 限流模块
 * 内存滑动窗口，IP 维度限流
 */

// 默认限流配置
const DEFAULT_CONFIG = {
  enabled: true,
  window_seconds: 60,         // 窗口大小
  max_per_window: 120,        // 每窗口最大请求数
  burst_limit: 30,            // 瞬间并发上限
  chat_limit_per_window: 60,  // Chat API 窗口限制
  image_limit_per_window: 10, // 生图窗口限制
};

// 允许通过 config.json 的 routing.rate_limit 覆盖默认阈值
let OVERRIDES = {};
export function setRateLimitConfig(userConfig = {}) { OVERRIDES = userConfig || {}; }
function getConfig() { return { ...DEFAULT_CONFIG, ...OVERRIDES }; }

// 按虚拟 Key 限流的默认阈值（可在 config.json.rate_limit.per_key_defaults 覆盖）
const KEY_DEFAULTS = {
  rpm: 60,        // 每分钟最大请求数
  tpm: 100000,    // 每分钟最大 token 数
  burst: 10,      // 瞬间并发上限
};
let KEY_OVERRIDES = {};
export function setKeyRateLimitDefaults(d = {}) { KEY_OVERRIDES = d || {}; }
function keyDefaults() { return { ...KEY_DEFAULTS, ...KEY_OVERRIDES }; }

// 内存计数器: { ip: { timestamps: [ts1, ts2, ...], count: N } }
const counters = new Map();

// 按 Key 滑动窗口: { keyId: { reqs: [ts...], tokens: [ {ts, n} ], burst: 0 } }
const keyCounters = new Map();

// 定期清理过期计数器（每5分钟）
setInterval(() => {
  const now = Date.now() / 1000;
  const cfgRL = getConfig();
  for (const [ip, entry] of counters) {
    const windowStart = now - cfgRL.window_seconds * 2;
    entry.timestamps = entry.timestamps.filter(t => t > windowStart);
    if (entry.timestamps.length === 0) counters.delete(ip);
  }
}, 300000).unref();

/**
 * 检查是否被限流
 * @param {string} ip - 请求IP
 * @param {string} path - 请求路径
 * @returns {{ allowed: boolean, retryAfter?: number, rateLimit?: object }}
 */
export function checkRateLimit(ip, path = '/v1/chat/completions') {
  const config = getConfig();
  if (config.enabled === false) return { allowed: true };

  const now = Date.now() / 1000;
  const windowSeconds = config.window_seconds;

  // 根据路径选择不同的限额
  let maxPerWindow = config.max_per_window;
  if (path.includes('images/generations')) maxPerWindow = config.image_limit_per_window;
  else if (path.includes('chat/completions') || path.includes('messages') || path.includes('responses')) maxPerWindow = config.chat_limit_per_window;

  let entry = counters.get(ip);
  if (!entry) {
    entry = { timestamps: [], burst: 0 };
    counters.set(ip, entry);
  }

  // 清理过期时间戳
  const windowStart = now - windowSeconds;
  entry.timestamps = entry.timestamps.filter(t => t > windowStart);

  // 突发保护：1秒内超过 burst_limit
  const burstStart = now - 1;
  const burstCount = entry.timestamps.filter(t => t > burstStart).length;
  if (burstCount >= config.burst_limit) {
    return {
      allowed: false,
      retryAfter: 2,
      rateLimit: { limit: maxPerWindow, remaining: 0, reset: Math.ceil(now + 2), window: windowSeconds },
    };
  }

  // 窗口限流
  if (entry.timestamps.length >= maxPerWindow) {
    const oldest = entry.timestamps[0];
    const retryAfter = Math.ceil(oldest + windowSeconds - now);
    return {
      allowed: false,
      retryAfter: Math.max(1, retryAfter),
      rateLimit: { limit: maxPerWindow, remaining: 0, reset: Math.ceil(oldest + windowSeconds), window: windowSeconds },
    };
  }

  // 放行
  entry.timestamps.push(now);
  const remaining = maxPerWindow - entry.timestamps.length;
  return {
    allowed: true,
    rateLimit: { limit: maxPerWindow, remaining, reset: Math.ceil(entry.timestamps[0] + windowSeconds), window: windowSeconds },
  };
}

/**
 * 获取当前限流状态（用于 API 查看）
 */
export function getRateLimitStats() {
  const now = Date.now() / 1000;
  const cfgRL = getConfig();
  const stats = [];
  for (const [ip, entry] of counters) {
    const activeWindow = entry.timestamps.filter(t => t > now - cfgRL.window_seconds);
    if (activeWindow.length > 0) {
      stats.push({ ip: ip.slice(0, 7) + '***', count: activeWindow.length, limit: cfgRL.max_per_window });
    }
  }
  return stats;
}

/**
 * 按虚拟 Key 维度限流（RPM / TPM / 突发）
 * @param {string} keyId - 虚拟 Key 标识（hash 或 id）
 * @param {object} limits - { rpm, tpm, burst }，缺省用 keyDefaults()
 * @param {number} [tokens=0] - 本次请求预估/实际 token 数（用于 TPM 统计）
 * @returns {{ allowed: boolean, retryAfter?: number, rateLimit?: object, dimension?: string }}
 */
export function checkKeyRateLimit(keyId, limits = {}, tokens = 0) {
  const d = keyDefaults();
  const rpm = limits.rpm ?? d.rpm;
  const tpm = limits.tpm ?? d.tpm;
  const burst = limits.burst ?? d.burst;
  const now = Date.now() / 1000;
  const windowStart = now - 60; // 1 分钟窗口
  let entry = keyCounters.get(keyId);
  if (!entry) { entry = { reqs: [], tokens: [], burst: 0 }; keyCounters.set(keyId, entry); }

  // 清理过期
  entry.reqs = entry.reqs.filter(t => t > windowStart);
  entry.tokens = entry.tokens.filter(t => t.ts > windowStart);

  // 突发保护（1 秒内请求数）
  const burstCount = entry.reqs.filter(t => t > now - 1).length;
  if (burstCount >= burst) {
    return { allowed: false, dimension: 'burst', retryAfter: 2, rateLimit: { rpm, tpm, remaining_rpm: Math.max(0, rpm - entry.reqs.length), remaining_tpm: Math.max(0, tpm - entry.tokens.reduce((a, x) => a + x.n, 0)), reset: Math.ceil(now + 2) } };
  }
  // RPM 窗口限制
  if (entry.reqs.length >= rpm) {
    const oldest = entry.reqs[0];
    const retryAfter = Math.max(1, Math.ceil(oldest + 60 - now));
    return { allowed: false, dimension: 'rpm', retryAfter, rateLimit: { rpm, tpm, remaining_rpm: 0, remaining_tpm: Math.max(0, tpm - entry.tokens.reduce((a, x) => a + x.n, 0)), reset: Math.ceil(oldest + 60) } };
  }
  // TPM 窗口限制
  const usedTokens = entry.tokens.reduce((a, x) => a + x.n, 0);
  if (usedTokens + tokens > tpm) {
    const oldestTok = entry.tokens[0]?.ts || now;
    const retryAfter = Math.max(1, Math.ceil(oldestTok + 60 - now));
    return { allowed: false, dimension: 'tpm', retryAfter, rateLimit: { rpm, tpm, remaining_rpm: Math.max(0, rpm - entry.reqs.length), remaining_tpm: Math.max(0, tpm - usedTokens), reset: Math.ceil(oldestTok + 60) } };
  }
  // 放行：记录
  entry.reqs.push(now);
  if (tokens > 0) entry.tokens.push({ ts: now, n: tokens });
  return { allowed: true, rateLimit: { rpm, tpm, remaining_rpm: rpm - entry.reqs.length, remaining_tpm: Math.max(0, tpm - (usedTokens + (tokens || 0))), reset: Math.ceil(entry.reqs[0] + 60) } };
}

/**
 * 记录某 Key 实际消耗的 token（在响应后调用，补充 TPM 统计）
 */
export function recordKeyTokens(keyId, tokens) {
  if (!tokens || tokens <= 0) return;
  const now = Date.now() / 1000;
  let entry = keyCounters.get(keyId);
  if (!entry) { entry = { reqs: [], tokens: [], burst: 0 }; keyCounters.set(keyId, entry); }
  entry.tokens = entry.tokens.filter(t => t.ts > now - 60);
  entry.tokens.push({ ts: now, n: tokens });
}

/**
 * 按 Key 维度限流统计
 */
export function getKeyRateLimitStats() {
  const now = Date.now() / 1000;
  const d = keyDefaults();
  const stats = [];
  for (const [keyId, entry] of keyCounters) {
    const reqs = entry.reqs.filter(t => t > now - 60);
    const toks = entry.tokens.filter(t => t.ts > now - 60).reduce((a, x) => a + x.n, 0);
    if (reqs.length > 0) stats.push({ key: keyId.slice(0, 8) + '***', rpm_used: reqs.length, rpm_limit: d.rpm, tpm_used: toks, tpm_limit: d.tpm });
  }
  return stats;
}

export default { checkRateLimit, getRateLimitStats, checkKeyRateLimit, recordKeyTokens, getKeyRateLimitStats };
