// Request admission controls shared by the HTTP server.
// 仅使用内存状态；多实例部署时应在边缘层或共享限流服务上补充全局限流。

export class FixedWindowRateLimiter {
  constructor({ windowMs = 60_000, maxRequests = 120, enabled = true } = {}) {
    this.windowMs = Math.max(1, Math.floor(windowMs));
    this.maxRequests = Math.max(1, Math.floor(maxRequests));
    this.enabled = enabled !== false;
    this._windows = new Map();
  }

  consume(key, now = Date.now()) {
    if (!this.enabled) return { allowed: true, retryAfterMs: 0 };
    // 防止攻击者用大量伪造来源地址让进程内窗口表无限增长。
    if (this._windows.size > 1024) {
      for (const [windowKey, window] of this._windows) {
        if (now >= window.resetAt) this._windows.delete(windowKey);
      }
    }
    const bucketKey = String(key || 'unknown');
    let bucket = this._windows.get(bucketKey);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this._windows.set(bucketKey, bucket);
    }
    if (bucket.count >= this.maxRequests) {
      return { allowed: false, retryAfterMs: Math.max(1, bucket.resetAt - now) };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
}

export class ConcurrencyGate {
  constructor(maxConcurrent = 64) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer');
    }
    this.maxConcurrent = maxConcurrent;
    this._active = 0;
  }

  get active() {
    return this._active;
  }

  tryAcquire() {
    if (this._active >= this.maxConcurrent) return false;
    this._active += 1;
    return true;
  }

  release() {
    if (this._active > 0) this._active -= 1;
  }
}
