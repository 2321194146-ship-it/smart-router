// src/runtime/cancellation.js
// Smart Router Mainline - Phase 1
// 客户端取消处理：管理客户端断开信号，将取消传递到上游 fetch。
//
// 设计要点（参考 6.5.0 的改进）：
//   - CancelToken 封装 AbortController，提供统一的取消信号管理
//   - 客户端断开时立即 abort 上游 fetch，避免无意义的上游调用
//   - 支持从 HTTP req/res 创建 CancelToken，监听 'aborted' 和 'close' 事件
//   - 取消原因区分：请求体上传期间断开 vs 响应期间断开
//   - onCancel 监听器支持已取消时立即回调
//   - isAbortError 兼容 AbortError / TimeoutError / cause 链
//
// 仅使用 Node.js 内置模块，无第三方依赖。

// ----------------------------------------------------------------------------
// CancelToken：客户端取消信号管理
// ----------------------------------------------------------------------------

/**
 * 管理客户端取消信号的令牌。
 *
 * 封装 AbortController，提供：
 *   - isAborted()：检查是否已取消
 *   - signal：AbortSignal，传递给 fetch
 *   - abort(reason)：触发取消
 *   - onCancel(fn)：监听取消事件
 *   - fromHttp(req, res)：从 HTTP 请求/响应创建
 *
 * @example
 * const token = CancelToken.fromHttp(req, res);
 * // 传递 signal 到 fetch
 * const response = await fetch(url, { signal: token.signal });
 * // 或手动取消
 * token.abort('manual_cancel');
 */
export class CancelToken {
  constructor() {
    this._abortController = new AbortController();
    this._aborted = false;
    this._reason = null;
    this._listeners = [];
    // HTTP 事件清理函数（fromHttp 创建时设置）
    this._httpCleanup = null;
  }

  /**
   * 检查是否已取消。
   * @returns {boolean}
   */
  isAborted() {
    return this._aborted;
  }

  /**
   * 获取 AbortSignal（传递给 fetch）。
   * @returns {AbortSignal}
   */
  get signal() {
    return this._abortController.signal;
  }

  /**
   * 获取取消原因（未取消时为 null）。
   * @returns {string|null}
   */
  get reason() {
    return this._reason;
  }

  /**
   * 触发取消。
   * 幂等：多次调用只有第一次生效。
   *
   * @param {string} reason 取消原因
   *   - 'client_aborted_request'：客户端在请求体上传期间断开
   *   - 'client_aborted_response'：客户端在响应期间断开
   *   - 'manual_cancel'：手动取消
   *   - 其它自定义原因
   */
  abort(reason) {
    if (this._aborted) return;
    this._aborted = true;
    this._reason = reason || 'unknown';
    this._abortController.abort(reason);

    // 通知所有监听器（容错：单个监听器异常不影响其它）
    for (const fn of this._listeners) {
      try {
        fn(this._reason);
      } catch {
        // 监听器异常忽略，不阻断取消流程
      }
    }
    // 清空监听器列表（已全部回调）
    this._listeners = [];

    // 清理 HTTP 事件监听器（如果由 fromHttp 创建）
    this._cleanupHttp();
  }

  /**
   * 监听取消事件。
   * 若已取消，立即回调；否则注册监听器，在 abort 时回调。
   *
   * @param {(reason: string) => void} fn 取消回调函数
   * @returns {() => void} 取消订阅函数（移除监听器）
   */
  onCancel(fn) {
    if (typeof fn !== 'function') return () => {};

    // 已取消：立即回调
    if (this._aborted) {
      try {
        fn(this._reason);
      } catch {
        // 忽略
      }
      return () => {}; // no-op unsubscribe
    }

    // 未取消：注册监听器
    this._listeners.push(fn);

    // 返回取消订阅函数
    return () => {
      const idx = this._listeners.indexOf(fn);
      if (idx !== -1) {
        this._listeners.splice(idx, 1);
      }
    };
  }

  /**
   * 清理 HTTP 事件监听器（内部方法）。
   * 在 abort 或 dispose 时调用。
   */
  _cleanupHttp() {
    if (this._httpCleanup) {
      try {
        this._httpCleanup();
      } catch {
        // 忽略清理异常
      }
      this._httpCleanup = null;
    }
  }

  /**
   * 释放资源（移除所有监听器和 HTTP 事件绑定）。
   * 注意：dispose 不会触发 abort，仅清理资源。
   */
  dispose() {
    this._listeners = [];
    this._cleanupHttp();
  }

  // --------------------------------------------------------------------------
  // 静态工厂方法
  // --------------------------------------------------------------------------

  /**
   * 从 HTTP req/res 创建 CancelToken。
   *
   * 监听两个事件：
   *   - req 'aborted'：客户端在请求体上传期间断开（请求未完整接收）
   *   - res 'close'：客户端在响应期间断开（仅当响应未正常结束时才触发取消）
   *
   * @param {import('http').IncomingMessage} req HTTP 请求对象
   * @param {import('http').ServerResponse} res HTTP 响应对象
   * @returns {CancelToken}
   */
  static fromHttp(req, res) {
    const token = new CancelToken();

    // 防御性检查：req/res 可能为 null（非 HTTP 场景）
    if (!req || !res) {
      return token;
    }

    const listeners = [];

    // req 'aborted': 客户端在请求体上传期间断开
    const onReqAborted = () => {
      token.abort('client_aborted_request');
    };
    // res 'close': 客户端在响应期间断开（仅当响应未正常结束时）
    const onResClose = () => {
      if (!res.writableEnded && !token._aborted) {
        token.abort('client_aborted_response');
      }
    };

    // 安全注册事件监听器
    if (typeof req.on === 'function') {
      req.on('aborted', onReqAborted);
      listeners.push(['req', 'aborted', onReqAborted]);
    }
    if (typeof res.on === 'function') {
      res.on('close', onResClose);
      listeners.push(['res', 'close', onResClose]);
    }

    // 设置清理函数：移除所有事件监听器
    token._httpCleanup = () => {
      for (const [target, event, handler] of listeners) {
        try {
          if (target === 'req' && typeof req.off === 'function') {
            req.off(event, handler);
          } else if (target === 'res' && typeof res.off === 'function') {
            res.off(event, handler);
          }
        } catch {
          // 忽略移除异常
        }
      }
    };

    return token;
  }
}

// ----------------------------------------------------------------------------
// isAbortError：判断错误是否是 AbortError
// ----------------------------------------------------------------------------

/**
 * 判断错误是否是 AbortError（客户端取消）或 TimeoutError（超时）。
 *
 * 检查范围：
 *   - error.name === 'AbortError'（标准 AbortController 取消）
 *   - error.name === 'TimeoutError'（超时导致的 abort）
 *   - error.cause.name === 'AbortError'（cause 链中的 abort）
 *   - error.code === 'ABORT_ERR'（Node.js 内部 abort 错误码）
 *
 * @param {Error|null|undefined} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  if (error.name === 'TimeoutError') return true;
  if (error.code === 'ABORT_ERR') return true;
  if (error.cause && error.cause.name === 'AbortError') return true;
  return false;
}

// ----------------------------------------------------------------------------
// 默认导出
// ----------------------------------------------------------------------------

export default {
  CancelToken,
  isAbortError,
};
