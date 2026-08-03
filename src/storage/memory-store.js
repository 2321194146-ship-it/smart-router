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
    this._shadowDecisions = new Map();
    this._appState = new Map();
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

  async getRequestByExternalId(externalRequestId) {
    if (!externalRequestId) return null;
    for (const [id, r] of this._requests) {
      if (r.externalRequestId === externalRequestId) {
        return { ...r };
      }
    }
    return null;
  }

  // --- attempts ---

  async saveAttempt(attempt, transaction) {
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

  async saveCost(costRecord, transaction) {
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

  async saveKeyStatus(keyStatus, transaction) {
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

  async saveFinalized(finalized, transaction) {
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

  async updateRequestStatus(requestId, status, transaction) {
    const r = this._requests.get(requestId);
    if (r) {
      r.status = status;
      r.updatedAt = new Date().toISOString();
    }
  }

  /**
   * 单次同步原子收尾（内存版）。
   * 内存操作本身同步，无并发冲突；语义与 SQLiteStore.finalizeRequestAtomic 一致：
   * finalized 幂等占位 → requests 状态 → attempts → cost → audit；
   * 已收尾返回 already_finalized 且不修改任何数据。
   */
  finalizeRequestAtomic(payload) {
    const {
      requestId, outcome, attempts = [], costRecord = null, auditRecord,
      agentId = null, protocol = null, externalRequestId = null, timestamp,
    } = payload || {};
    if (!requestId) {
      throw new Error('finalizeRequestAtomic: requestId required');
    }
    if (!auditRecord) {
      throw new Error('finalizeRequestAtomic: auditRecord required');
    }
    const ts = timestamp || new Date().toISOString();

    if (this._finalized.has(requestId)) {
      return { finalized: false, reason: 'already_finalized' };
    }
    this._finalized.set(requestId, { requestId, outcome, agentId, protocol, timestamp: ts });

    const r = this._requests.get(requestId);
    if (r) {
      r.status = outcome || null;
      r.updatedAt = ts;
    } else {
      this._requests.set(requestId, {
        requestId, agentId, protocol, status: outcome || null,
        externalRequestId, timestamp: ts,
      });
    }

    for (const a of attempts) {
      const key = `${requestId}:${a.attemptNumber}`;
      if (!this._attempts.has(key)) {
        this._attempts.set(key, { ...a });
      }
    }

    if (costRecord && !this._costs.has(requestId)) {
      this._costs.set(requestId, { ...costRecord });
    }

    this._auditRecords.push({ ...auditRecord });
    return { finalized: true };
  }

  async beginTransaction() {
    // Memory store: snapshot state for potential rollback
    return {
      snapshot: {
        requests: new Map(this._requests),
        attempts: new Map(this._attempts),
        costs: new Map(this._costs),
        finalized: new Map(this._finalized),
        auditRecords: [...this._auditRecords],
      },
    };
  }

  async commitTransaction(transaction) {
    // Memory store: no-op, changes already applied
  }

  async rollbackTransaction(transaction) {
    // Memory store: restore snapshot
    if (transaction?.snapshot) {
      this._requests = transaction.snapshot.requests;
      this._attempts = transaction.snapshot.attempts;
      this._costs = transaction.snapshot.costs;
      this._finalized = transaction.snapshot.finalized;
      this._auditRecords = transaction.snapshot.auditRecords;
    }
  }

  // --- audit ---

  async saveAuditRecord(auditRecord, transaction) {
    if (!auditRecord?.requestId) return;
    this._auditRecords.push({ ...auditRecord });
  }

  async getAuditRecord(requestId) {
    return this._auditRecords.find((r) => r.requestId === requestId) || null;
  }

  async getAllAuditRecords() {
    return [...this._auditRecords];
  }

  // --------------------------------------------------------------------------
  // Shadow 决策持久化（Phase2-A Shadow；内存镜像，语义与 SQLiteStore 一致）
  // --------------------------------------------------------------------------

  async saveShadowDecision(record) {
    const prev = this._shadowDecisions.get(record.request_id) || {};
    this._shadowDecisions.set(record.request_id, {
      request_id: record.request_id,
      protocol: record.protocol ?? prev.protocol ?? null,
      agent_id: record.agent_id ?? prev.agent_id ?? null,
      requested_model: record.requested_model ?? prev.requested_model ?? null,
      task_profile: record.task_profile ?? prev.task_profile ?? null,
      recommendation: record.recommendation ?? prev.recommendation ?? null,
      ranked_candidates: record.ranked_candidates ?? prev.ranked_candidates ?? null,
      predictions: record.predictions ?? prev.predictions ?? null,
      explanation: record.explanation ?? prev.explanation ?? null,
      created_at: record.created_at || prev.created_at || new Date().toISOString(),
      actual_final_model: prev.actual_final_model ?? null,
      actual_final_provider: prev.actual_final_provider ?? null,
      actual_outcome: prev.actual_outcome ?? null,
      actual_attempt_count: prev.actual_attempt_count ?? null,
      actual_usage: prev.actual_usage ?? null,
      actual_cost: prev.actual_cost ?? null,
      actual_latency: prev.actual_latency ?? null,
      comparison_status: prev.comparison_status ?? null,
      finalized_at: prev.finalized_at ?? null,
    });
    return { saved: true };
  }

  async finalizeShadowDecision(record) {
    const row = this._shadowDecisions.get(record.request_id);
    if (!row) return { saved: false, changes: 0 };
    row.actual_final_model = record.actual_final_model ?? null;
    row.actual_final_provider = record.actual_final_provider ?? null;
    row.actual_outcome = record.actual_outcome ?? null;
    row.actual_attempt_count = record.actual_attempt_count ?? null;
    row.actual_usage = record.actual_usage ?? null;
    row.actual_cost = record.actual_cost ?? null;
    row.actual_latency = record.actual_latency ?? null;
    row.comparison_status = record.comparison_status ?? null;
    row.finalized_at = record.finalized_at || new Date().toISOString();
    return { saved: true, changes: 1 };
  }

  async getShadowDecision(requestId) {
    const row = this._shadowDecisions.get(requestId);
    if (!row) return null;
    return {
      requestId: row.request_id,
      protocol: row.protocol,
      agentId: row.agent_id,
      requestedModel: row.requested_model,
      taskProfile: row.task_profile ? JSON.parse(row.task_profile) : null,
      recommendation: row.recommendation ? JSON.parse(row.recommendation) : null,
      rankedCandidates: row.ranked_candidates ? JSON.parse(row.ranked_candidates) : [],
      predictions: row.predictions ? JSON.parse(row.predictions) : null,
      explanation: row.explanation ? JSON.parse(row.explanation) : null,
      actualFinalModel: row.actual_final_model,
      actualFinalProvider: row.actual_final_provider,
      actualOutcome: row.actual_outcome,
      actualAttemptCount: row.actual_attempt_count,
      actualUsage: row.actual_usage ? JSON.parse(row.actual_usage) : null,
      actualCost: row.actual_cost ? JSON.parse(row.actual_cost) : null,
      actualLatency: row.actual_latency,
      comparisonStatus: row.comparison_status,
      createdAt: row.created_at,
      finalizedAt: row.finalized_at,
    };
  }

  async listShadowDecisions() {
    const out = [];
    for (const row of this._shadowDecisions.values()) {
      out.push({
        requestId: row.request_id,
        protocol: row.protocol,
        agentId: row.agent_id,
        requestedModel: row.requested_model,
        taskProfile: row.task_profile ? JSON.parse(row.task_profile) : null,
        recommendation: row.recommendation ? JSON.parse(row.recommendation) : null,
        rankedCandidates: row.ranked_candidates ? JSON.parse(row.ranked_candidates) : [],
        predictions: row.predictions ? JSON.parse(row.predictions) : null,
        explanation: row.explanation ? JSON.parse(row.explanation) : null,
        actualFinalModel: row.actual_final_model,
        actualFinalProvider: row.actual_final_provider,
        actualOutcome: row.actual_outcome,
        actualAttemptCount: row.actual_attempt_count,
        actualUsage: row.actual_usage ? JSON.parse(row.actual_usage) : null,
        actualCost: row.actual_cost ? JSON.parse(row.actual_cost) : null,
        actualLatency: row.actual_latency,
        comparisonStatus: row.comparison_status,
        createdAt: row.created_at,
        finalizedAt: row.finalized_at,
      });
    }
    return out;
  }

  async pruneShadowDecisions(_retentionDays = 30) {
    return 0; // 内存版由上层负责清空
  }

  // --- app_state (Phase2-C: Canary Kill Switch 持久化；内存版) ---

  async getAppState(key) {
    const v = this._appState.get(key);
    return v === undefined ? null : v;
  }

  async setAppState(key, value) {
    this._appState.set(key, String(value));
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
    this._shadowDecisions.clear();
    this._appState.clear();
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
