// src/provider/errors.js
// Smart Router Mainline - Phase 1
// 错误分类体系：将上游 provider 的 HTTP/网络错误归一化为有限错误类型，
// 供路由层决定「是否重试 / 冷却多久 / 是否永久禁用 key」。
//
// 设计要点（参考 6.5.0 改进）：
//   - 401 → AUTH_INVALID（永久禁用 key）
//   - 403 → 顺序敏感分类：model_forbidden → key_forbidden → provider_cooldown
//           → temp_restricted → conservative(UNKNOWN)
//   - 429 → 检查是否 quota 耗尽（RATE_LIMIT_QUOTA），否则瞬时（RATE_LIMIT_TRANSIENT）
//   - 5xx → SERVER_ERROR
//   - fetch 抛出 → NETWORK_ERROR
//   - 客户端主动取消 → CLIENT_ABORTED
//
// 仅使用 Node.js 内置模块，无第三方依赖。

// ----------------------------------------------------------------------------
// 错误类型枚举
// ----------------------------------------------------------------------------

export const ErrorType = {
  AUTH_INVALID: 'auth_invalid', // 401 永久失效
  FORBIDDEN_KEY: 'forbidden_key', // 403 key 级
  FORBIDDEN_MODEL: 'forbidden_model', // 403 model 级
  FORBIDDEN_PROVIDER: 'forbidden_provider', // 403 provider 级
  FORBIDDEN_REGION: 'forbidden_region', // 403 region 级
  FORBIDDEN_TEMP: 'forbidden_temp', // 403 临时
  RATE_LIMIT_TRANSIENT: 'rate_limit_transient', // 429 瞬时
  RATE_LIMIT_QUOTA: 'rate_limit_quota', // 429 配额耗尽
  SERVER_ERROR: 'server_error', // 500/502/503
  NETWORK_ERROR: 'network_error', // fetch 失败
  CLIENT_ABORTED: 'client_aborted', // 客户端取消
  UNKNOWN: 'unknown',
};

// ----------------------------------------------------------------------------
// 归一化的 ProviderError
// ----------------------------------------------------------------------------

/**
 * 表示一次上游 provider 调用的归一化错误。
 */
export class ProviderError extends Error {
  constructor(type, message, context = {}) {
    super(message || type);
    this.name = 'ProviderError';
    this.type = type;
    this.httpStatus = context.httpStatus ?? null;
    this.errorCode = context.errorCode ?? null;
    this.provider = context.provider ?? null;
    this.model = context.model ?? null;
    this.retryAfter = context.retryAfter ?? null; // 秒
    this.body = context.body ?? null; // 原始响应体（截断后）
    this.cause = context.cause ?? null;
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      message: this.message,
      httpStatus: this.httpStatus,
      errorCode: this.errorCode,
      provider: this.provider,
      model: this.model,
      retryAfter: this.retryAfter,
    };
  }
}

// ----------------------------------------------------------------------------
// 关键词表（小写匹配）
// ----------------------------------------------------------------------------

const KW = {
  model: [
    'model', 'not_found', 'does not exist', 'not available', 'unsupported',
    'invalid_model', 'model_not_found', 'model_disabled', 'decommissioned',
  ],
  key: [
    'api key', 'apikey', 'api_key', 'invalid key', 'invalid_key',
    'incorrect api key', 'authentication', 'unauthorized', 'no api key',
  ],
  provider: [
    'provider', 'organization', 'billing', 'subscription', 'plan',
    'account suspended', 'account_disabled', 'access denied',
  ],
  region: [
    'region', 'country', 'geo', 'location', 'not available in your country',
    'unsupported region',
  ],
  quota: [
    'quota', 'exhausted', 'limit reached', 'monthly', 'daily', 'credit',
    'insufficient_quota', 'billing limit', 'spend limit', 'budget exceeded',
    'your current plan', 'usage limit',
  ],
  transient: [
    'rate limit', 'rate_limit', 'too many requests', 'slow down', 'overloaded',
    'capacity', 'temporarily', 'try again later',
  ],
};

function lower(s) {
  return s == null ? '' : String(s).toLowerCase();
}

function containsAny(text, words) {
  for (const w of words) {
    if (text.includes(w)) return true;
  }
  return false;
}

/**
 * 判断 429 是否属于配额耗尽。
 * 依据：错误体关键词 + errorCode + retry-after 量级（quota 通常 retry-after 较长或缺失）。
 *
 * @param {object} body 解析后的响应体（对象或字符串）
 * @param {string|null} errorCode provider 返回的 error.code
 * @param {number|null} retryAfterSec Retry-After 头（秒）
 * @returns {boolean}
 */
export function isQuotaExhausted(body, errorCode, retryAfterSec) {
  const ec = lower(errorCode);
  // 显式 errorCode 信号
  const quotaCodes = [
    'insufficient_quota', 'insufficient_quota_for_request',
    'quota_exceeded', 'billing_hard_limit_reached',
    'usage_limit_reached', 'monthly_limit_reached', 'daily_limit_reached',
    'credits_exhausted', 'plan_limit_reached',
  ];
  if (quotaCodes.includes(ec)) return true;

  // 响应体文本
  let text = '';
  if (typeof body === 'string') {
    text = body;
  } else if (body && typeof body === 'object') {
    // 抽取常见错误消息字段
    const candidates = [
      body.error?.message,
      body.error?.code,
      body.message,
      body.detail,
      body.error,
    ];
    text = candidates.filter(Boolean).map(String).join(' ');
    // 也把整个 JSON 文本纳入（兜底）
    try {
      text += ' ' + JSON.stringify(body);
    } catch {
      /* ignore */
    }
  }
  text = lower(text);

  if (containsAny(text, KW.quota)) return true;

  // 长 Retry-After（>= 600s）通常意味着配额周期重置，视为 quota
  if (typeof retryAfterSec === 'number' && retryAfterSec >= 600) return true;

  return false;
}

/**
 * 403 顺序敏感分类。
 * 顺序：model_forbidden → key_forbidden → provider_cooldown → temp_restricted → conservative
 *
 * @param {object} body
 * @param {string|null} errorCode
 * @returns {string} ErrorType
 */
function classify403(body, errorCode) {
  const ec = lower(errorCode);
  let text = '';
  if (typeof body === 'string') {
    text = body;
  } else if (body && typeof body === 'object') {
    const candidates = [
      body.error?.message,
      body.error?.code,
      body.error?.type,
      body.message,
      body.detail,
      body.error,
    ];
    text = candidates.filter(Boolean).map(String).join(' ');
    try {
      text += ' ' + JSON.stringify(body);
    } catch {
      /* ignore */
    }
  }
  text = lower(text);

  // 1. model 级（最优先：粒度最细，仅冷却该模型）
  if (
    containsAny(text, KW.model) ||
    ec.includes('model') ||
    ec === 'not_found' ||
    ec === 'model_not_found'
  ) {
    return ErrorType.FORBIDDEN_MODEL;
  }

  // 2. key 级
  if (
    containsAny(text, KW.key) ||
    ec.includes('key') ||
    ec === 'authentication_error' ||
    ec === 'invalid_api_key'
  ) {
    return ErrorType.FORBIDDEN_KEY;
  }

  // 3. provider 级（billing/org/subscription → 整个 provider 冷却）
  if (
    containsAny(text, KW.provider) ||
    ec.includes('billing') ||
    ec.includes('organization') ||
    ec.includes('subscription') ||
    ec === 'access_denied'
  ) {
    return ErrorType.FORBIDDEN_PROVIDER;
  }

  // 4. region 级
  if (containsAny(text, KW.region) || ec.includes('region')) {
    return ErrorType.FORBIDDEN_REGION;
  }

  // 5. 临时受限（含 overloaded/capacity/try again）
  if (containsAny(text, KW.transient) || ec.includes('temp')) {
    return ErrorType.FORBIDDEN_TEMP;
  }

  // 6. 保守兜底：未知 403，不永久禁用 key，按临时处理
  return ErrorType.FORBIDDEN_TEMP;
}

// ----------------------------------------------------------------------------
// 主分类函数
// ----------------------------------------------------------------------------

/**
 * 将上游错误归一化为 ErrorType。
 *
 * @param {object} input
 * @param {number|null} [input.httpStatus] HTTP 状态码
 * @param {object|string|null} [input.responseBody] 响应体（对象或字符串）
 * @param {string|null} [input.errorCode] provider error.code
 * @param {number|null} [input.retryAfter] Retry-After 头（秒）
 * @param {Error|null} [input.cause] 原始异常（fetch 抛出 / abort）
 * @param {boolean} [input.aborted] 是否客户端主动取消
 * @returns {string} ErrorType 枚举值
 */
export function classifyError(httpStatus, responseBody, errorCode, input = {}) {
  // 兼容旧签名：第四个参数若为对象则视为完整 input
  const opts = (typeof httpStatus === 'object' && httpStatus !== null)
    ? httpStatus
    : {
        httpStatus,
        responseBody,
        errorCode,
        retryAfter: input.retryAfter ?? null,
        cause: input.cause ?? null,
        aborted: input.aborted ?? false,
      };

  // 0. 客户端主动取消（优先级最高）
  if (opts.aborted || isAbortError(opts.cause)) {
    return ErrorType.CLIENT_ABORTED;
  }

  // 1. 网络错误（fetch 抛出，无 httpStatus）
  if (opts.httpStatus == null && opts.cause) {
    return ErrorType.NETWORK_ERROR;
  }

  const status = Number(opts.httpStatus);
  const body = opts.responseBody ?? null;
  const ec = opts.errorCode ?? null;

  // 2. 401 → AUTH_INVALID（永久禁用 key）
  if (status === 401) {
    return ErrorType.AUTH_INVALID;
  }

  // 3. 403 → 顺序敏感分类
  if (status === 403) {
    return classify403(body, ec);
  }

  // 4. 429 → quota / transient
  if (status === 429) {
    if (isQuotaExhausted(body, ec, opts.retryAfter)) {
      return ErrorType.RATE_LIMIT_QUOTA;
    }
    return ErrorType.RATE_LIMIT_TRANSIENT;
  }

  // 5. 5xx → SERVER_ERROR
  if (status >= 500 && status < 600) {
    return ErrorType.SERVER_ERROR;
  }

  // 6. 408 / 425 / 其它可重试的 4xx
  if (status === 408 || status === 425 || status === 413) {
    return ErrorType.NETWORK_ERROR; // 视为可重试的瞬时
  }

  // 7. 其它 4xx（400/404/422 等）→ 保守归为 UNKNOWN（不重试）
  if (status >= 400 && status < 500) {
    return ErrorType.UNKNOWN;
  }

  return ErrorType.UNKNOWN;
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.code === 'ABORT_ERR') return true;
  if (err.message && /aborted/i.test(String(err.message))) return true;
  return false;
}

// ----------------------------------------------------------------------------
// 策略：可重试 / 冷却时长 / 永久禁用 key
// ----------------------------------------------------------------------------

/**
 * 是否可重试（切换到下一个模型/provider）。
 * - AUTH_INVALID / FORBIDDEN_KEY / FORBIDDEN_PROVIDER / FORBIDDEN_REGION：不可重试（同 key 无意义）
 *   但路由层可切换到其它 provider；此处「不可重试」指对同一 (provider,key,model) 不重试。
 * - RATE_LIMIT_QUOTA：不可瞬时重试（需等待配额恢复）。
 * - CLIENT_ABORTED：不可重试（客户端已断开，重试无意义）。
 * - UNKNOWN：不可重试（保守策略，避免放大错误请求）。
 */
export function isRetriable(errorType) {
  switch (errorType) {
    case ErrorType.RATE_LIMIT_TRANSIENT:
    case ErrorType.FORBIDDEN_TEMP:
    case ErrorType.SERVER_ERROR:
    case ErrorType.NETWORK_ERROR:
      return true;
    case ErrorType.AUTH_INVALID:
    case ErrorType.FORBIDDEN_KEY:
    case ErrorType.FORBIDDEN_MODEL:
    case ErrorType.FORBIDDEN_PROVIDER:
    case ErrorType.FORBIDDEN_REGION:
    case ErrorType.RATE_LIMIT_QUOTA:
    case ErrorType.CLIENT_ABORTED:
    case ErrorType.UNKNOWN:
      return false;
    default:
      return false;
  }
}

/**
 * 冷却时长（秒）。针对「该 (provider,key,model) 组合」的冷却，
 * 不影响其它模型/provider 的可用性。
 *
 * 返回 0 表示不冷却（立即可用，但通常这类错误会直接 failover）。
 */
export function getCooldownDuration(errorType) {
  switch (errorType) {
    case ErrorType.AUTH_INVALID:
      // 永久失效：返回极长冷却（实际由 shouldDisableKey 决定永久禁用）
      return 86400; // 24h（占位，禁用由 key 管理器接管）
    case ErrorType.FORBIDDEN_KEY:
      return 3600; // 1h
    case ErrorType.FORBIDDEN_MODEL:
      return 1800; // 30min（模型级冷却）
    case ErrorType.FORBIDDEN_PROVIDER:
      return 1800; // 30min（provider 级冷却）
    case ErrorType.FORBIDDEN_REGION:
      return 86400; // 24h（region 级，短期不会变化）
    case ErrorType.FORBIDDEN_TEMP:
      return 60; // 1min
    case ErrorType.RATE_LIMIT_TRANSIENT:
      return 30; // 30s
    case ErrorType.RATE_LIMIT_QUOTA:
      return 3600; // 1h（配额恢复周期）
    case ErrorType.SERVER_ERROR:
      return 60; // 1min
    case ErrorType.NETWORK_ERROR:
      return 15; // 15s
    case ErrorType.CLIENT_ABORTED:
      return 0; // 不冷却（客户端行为，非 provider 故障）
    case ErrorType.UNKNOWN:
      return 0; // 不冷却但也不重试
    default:
      return 0;
  }
}

/**
 * 是否应永久禁用该 provider 的 key。
 * 仅 AUTH_INVALID（401）和明确的 key 级 403 触发永久禁用。
 */
export function shouldDisableKey(errorType) {
  switch (errorType) {
    case ErrorType.AUTH_INVALID:
      return true;
    case ErrorType.FORBIDDEN_KEY:
      return true;
    default:
      return false;
  }
}

/**
 * 冷却粒度：决定冷却作用域（model / key / provider）。
 * 供熔断/冷却管理器决定清除范围。
 */
export function getCooldownScope(errorType) {
  switch (errorType) {
    case ErrorType.AUTH_INVALID:
    case ErrorType.FORBIDDEN_KEY:
      return 'key';
    case ErrorType.FORBIDDEN_MODEL:
    case ErrorType.RATE_LIMIT_QUOTA:
    case ErrorType.RATE_LIMIT_TRANSIENT:
      return 'model';
    case ErrorType.FORBIDDEN_PROVIDER:
    case ErrorType.FORBIDDEN_REGION:
      return 'provider';
    case ErrorType.SERVER_ERROR:
    case ErrorType.NETWORK_ERROR:
      return 'model';
    case ErrorType.FORBIDDEN_TEMP:
      return 'model';
    case ErrorType.CLIENT_ABORTED:
    case ErrorType.UNKNOWN:
    default:
      return 'none';
  }
}

/**
 * 从响应中解析 Retry-After 头（秒）。
 * 支持「秒数」与「HTTP-date」两种格式。
 * @param {string|null} retryAfterHeader
 * @returns {number|null}
 */
export function parseRetryAfter(retryAfterHeader) {
  if (!retryAfterHeader) return null;
  const s = String(retryAfterHeader).trim();
  // 纯数字
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // HTTP-date
  const dt = Date.parse(s);
  if (!Number.isNaN(dt)) {
    const diff = Math.ceil((dt - Date.now()) / 1000);
    return diff > 0 ? diff : 0;
  }
  return null;
}

/**
 * 构造一个归一化的 ProviderError（便捷封装）。
 */
export function makeProviderError(input) {
  const type = classifyError(input);
  return new ProviderError(type, input.message || type, {
    httpStatus: input.httpStatus ?? null,
    errorCode: input.errorCode ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    retryAfter: input.retryAfter ?? null,
    body: input.responseBody ?? null,
    cause: input.cause ?? null,
  });
}

export default {
  ErrorType,
  ProviderError,
  classifyError,
  isQuotaExhausted,
  isRetriable,
  getCooldownDuration,
  shouldDisableKey,
  getCooldownScope,
  parseRetryAfter,
  makeProviderError,
};
