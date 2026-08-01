// src/storage/memory-store.js
// Smart Router Mainline - Phase 1
// 内存存储实现：测试默认使用，进程重启后数据丢失。
//
// 设计：
//   - 实现 StorageInterface 全部方法
//   - 使用 Map/Set 保证唯一约束（与 SQLite UNIQUE 约束语义一致）
//   - 事务通过批量操作模拟（内存操作本身是同步的）
//   - 供单元测试和集成测试使用
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { StorageInterface } from './interface.js';

export class MemoryStore extends StorageInterface {
  constructor() {
    super();
    this._requests = new Map();
    this._attempts = new Map(); // key: "requestId:attemptNumber"
    this._costs = new Map();
    this._keyStatus = new Map(); // key: "provider:keyId"
    this._providerHealth = new Map();
    this._finalized = new Map();
    this._auditRecords = [];
  }

  async init() { /* no-op for memory store */ }

  async close() { /* no-op for memory store */ }

  // --- requests ---

  async saveRequest(request) {
    if (!request?.requestId) return false;
    if (this._requests.has(request.requestId)) return false;
    this._requests.set(request.requestId, { ...request });
    return true;
  }

  async getRequest(requestId) {
    const r = this._requests.get(requestId);
    return r ? { ...r } : null;
  }

  // --- attempts ---

  async saveAttempt(attempt) {
    if (!attempt?.requestId || !attempt.attemptNumber) return false;
    const key = `${attempt.requestId}:${attempt.attemptNumber}`;
    if (this._attempts.has(key)) return false;
    this._attempts.set(key, { ...attempt });
    return true;
  }

  async getAttempts(requestId) {
    const results = [];
    for (const [key, attempt] of this._attempts) {
      if (key.startsWith(`${requestId}:`)) {
        results.push({ ...attempt });
      }
    }
    return results.sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  // --- cost_records ---

  async saveCost(costRecord) {
    if (!costRecord?.requestId) {
      throw new Error('saveCost: requestId required');
    }
    if (this._costs.has(costRecord.requestId)) {
      return { recorded: false, record: this._costs.get(costRecord.requestId) };
    }
    this._costs.set(costRecord.requestId, { ...costRecord });
    return { recorded: true, record: { ...costRecord } };
  }

  async hasCost(requestId) {
    return this._costs.has(requestId);
  }

  async getCost(requestId) {
    const c = this._costs.get(requestId);
    return c ? { ...c } : null;
  }

  // --- key_status ---

  async saveKeyStatus(keyStatus) {
    if (!keyStatus?.provider || !keyStatus?.keyId) return;
    const key = `${keyStatus.provider}:${keyStatus.keyId}`;
    this._keyStatus.set(key, { ...keyStatus });
  }

  async getKeyStatuses(provider) {
    const results = [];
    for (const [key, status] of this._keyStatus) {
      if (key.startsWith(`${provider}:`)) {
        results.push({ ...status });
      }
    }
    return results;
  }

  async getKeyStatus(provider, keyId) {
    const key = `${provider}:${keyId}`;
    const s = this._keyStatus.get(key);
    return s ? { ...s } : null;
  }

  // --- provider_health ---

  async saveProviderHealth(health) {
    if (!health?.provider) return;
    this._providerHealth.set(health.provider, { ...health });
  }

  async getProviderHealth(provider) {
    const h = this._providerHealth.get(provider);
    return h ? { ...h } : null;
  }

  async getAllProviderHealth() {
    return [...this._providerHealth.values()].map((h) => ({ ...h }));
  }

  // --- finalized_requests ---

  async saveFinalized(finalized) {
    if (!finalized?.requestId) {
      return { finalized: false, reason: 'missing_requestId' };
    }
    if (this._finalized.has(finalized.requestId)) {
      return { finalized: false, reason: 'already_finalized' };
    }
    this._finalized.set(finalized.requestId, { ...finalized });
    return { finalized: true };
  }

  async isFinalized(requestId) {
    return this._finalized.has(requestId);
  }

  // --- audit ---

  async saveAuditRecord(auditRecord) {
    if (!auditRecord?.requestId) return;
    this._auditRecords.push({ ...auditRecord });
  }

  async getAuditRecord(requestId) {
    return this._auditRecords.find((r) => r.requestId === requestId) || null;
  }

  async getAllAuditRecords() {
    return [...this._auditRecords];
  }

  // --- test helpers ---

  _reset() {
    this._requests.clear();
    this._attempts.clear();
    this._costs.clear();
    this._keyStatus.clear();
    this._providerHealth.clear();
    this._finalized.clear();
    this._auditRecords = [];
  }

  snapshot() {
    return {
      requests: this._requests.size,
      attempts: this._attempts.size,
      costs: this._costs.size,
      keyStatuses: this._keyStatus.size,
      providerHealth: this._providerHealth.size,
      finalized: this._finalized.size,
      auditRecords: this._auditRecords.length,
    };
  }
}

export default { MemoryStore };
