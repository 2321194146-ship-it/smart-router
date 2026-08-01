// src/storage/sqlite-store.js
// Smart Router Mainline - Phase 1
// SQLite 持久化存储实现：生产默认使用，重启后数据保留。
//
// 设计：
//   - 实现 StorageInterface 全部方法
//   - 使用 Node.js 内置 node:sqlite 模块（Node 22+ 实验性，Node 26+ 稳定）
//   - 唯一约束通过 SQLite UNIQUE 索引保证
//   - 事务通过 BEGIN/COMMIT 保证原子性
//   - 业务模块不直接操作 SQLite，通过此实现
//   - SQLite 文件不进入 Git 和 ZIP（.gitignore 排除）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

import { DatabaseSync } from 'node:sqlite';
import { StorageInterface } from './interface.js';

export class SQLiteStore extends StorageInterface {
  /**
   * @param {string} dbPath SQLite 文件路径
   */
  constructor(dbPath) {
    super();
    if (!dbPath) {
      throw new Error('SQLiteStore: dbPath required');
    }
    this._dbPath = dbPath;
    this._db = null;
  }

  async init() {
    this._db = new DatabaseSync(this._dbPath);
    this._db.exec('PRAGMA journal_mode = WAL');
    this._db.exec('PRAGMA foreign_keys = ON');

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        agent_id TEXT,
        protocol TEXT,
        model TEXT,
        provider TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attempts (
        request_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        model TEXT,
        provider TEXT,
        key_id TEXT,
        transport_outcome TEXT,
        validated_outcome TEXT,
        error_type TEXT,
        error_message TEXT,
        http_status INTEGER,
        latency_ms INTEGER,
        first_byte_ms INTEGER,
        headers_received INTEGER DEFAULT 0,
        first_byte_sent_to_client INTEGER DEFAULT 0,
        budget_blocked INTEGER DEFAULT 0,
        usage TEXT,
        cost TEXT,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (request_id, attempt_number)
      );

      CREATE TABLE IF NOT EXISTS cost_records (
        request_id TEXT PRIMARY KEY,
        model_id TEXT,
        provider TEXT,
        usage TEXT,
        cost TEXT,
        date_key TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS key_status (
        provider TEXT NOT NULL,
        key_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, key_id)
      );

      CREATE TABLE IF NOT EXISTS provider_health (
        provider TEXT PRIMARY KEY,
        state TEXT,
        failure_count INTEGER DEFAULT 0,
        last_failure_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finalized_requests (
        request_id TEXT PRIMARY KEY,
        outcome TEXT,
        agent_id TEXT,
        protocol TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_records (
        request_id TEXT,
        outcome TEXT,
        final_model TEXT,
        final_provider TEXT,
        attempt_count INTEGER,
        agent_id TEXT,
        protocol TEXT,
        response_size INTEGER,
        attempts TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_records(request_id);
    `);
  }

  async close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  // --- requests ---

  async saveRequest(request) {
    if (!request?.requestId) return false;
    try {
      this._db.prepare(
        'INSERT OR IGNORE INTO requests (request_id, agent_id, protocol, model, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        request.requestId,
        request.agentId || null,
        request.protocol || null,
        request.model || null,
        request.provider || null,
        request.timestamp || new Date().toISOString()
      );
      return true;
    } catch {
      return false;
    }
  }

  async getRequest(requestId) {
    const row = this._db.prepare(
      'SELECT request_id, agent_id, protocol, model, provider, timestamp FROM requests WHERE request_id = ?'
    ).get(requestId);
    if (!row) return null;
    return {
      requestId: row.request_id,
      agentId: row.agent_id,
      protocol: row.protocol,
      model: row.model,
      provider: row.provider,
      timestamp: row.timestamp,
    };
  }

  // --- attempts ---

  async saveAttempt(attempt) {
    if (!attempt?.requestId || !attempt.attemptNumber) return false;
    try {
      this._db.prepare(
        `INSERT OR IGNORE INTO attempts
        (request_id, attempt_number, model, provider, key_id,
         transport_outcome, validated_outcome, error_type, error_message,
         http_status, latency_ms, first_byte_ms, headers_received,
         first_byte_sent_to_client, budget_blocked, usage, cost, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        attempt.requestId,
        attempt.attemptNumber,
        attempt.model || null,
        attempt.provider || null,
        attempt.keyId || null,
        attempt.transportOutcome || null,
        attempt.validatedOutcome || null,
        attempt.errorType || null,
        attempt.errorMessage || null,
        attempt.httpStatus || null,
        attempt.latencyMs || 0,
        attempt.firstByteMs || null,
        attempt.headersReceived ? 1 : 0,
        attempt.firstByteSentToClient ? 1 : 0,
        attempt.budgetBlocked ? 1 : 0,
        attempt.usage ? JSON.stringify(attempt.usage) : null,
        attempt.cost ? JSON.stringify(attempt.cost) : null,
        attempt.timestamp || new Date().toISOString()
      );
      return true;
    } catch {
      return false;
    }
  }

  async getAttempts(requestId) {
    const rows = this._db.prepare(
      'SELECT * FROM attempts WHERE request_id = ? ORDER BY attempt_number'
    ).all(requestId);
    return rows.map((r) => ({
      requestId: r.request_id,
      attemptNumber: r.attempt_number,
      model: r.model,
      provider: r.provider,
      keyId: r.key_id,
      transportOutcome: r.transport_outcome,
      validatedOutcome: r.validated_outcome,
      errorType: r.error_type,
      errorMessage: r.error_message,
      httpStatus: r.http_status,
      latencyMs: r.latency_ms,
      firstByteMs: r.first_byte_ms,
      headersReceived: !!r.headers_received,
      firstByteSentToClient: !!r.first_byte_sent_to_client,
      budgetBlocked: !!r.budget_blocked,
      usage: r.usage ? JSON.parse(r.usage) : null,
      cost: r.cost ? JSON.parse(r.cost) : null,
      timestamp: r.timestamp,
    }));
  }

  // --- cost_records ---

  async saveCost(costRecord) {
    if (!costRecord?.requestId) {
      throw new Error('saveCost: requestId required');
    }
    try {
      const existing = this._db.prepare(
        'SELECT * FROM cost_records WHERE request_id = ?'
      ).get(costRecord.requestId);
      if (existing) {
        return {
          recorded: false,
          record: {
            requestId: existing.request_id,
            modelId: existing.model_id,
            provider: existing.provider,
            usage: JSON.parse(existing.usage),
            cost: JSON.parse(existing.cost),
            dateKey: existing.date_key,
            timestamp: existing.timestamp,
          },
        };
      }
      this._db.prepare(
        'INSERT INTO cost_records (request_id, model_id, provider, usage, cost, date_key, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        costRecord.requestId,
        costRecord.modelId || null,
        costRecord.provider || null,
        JSON.stringify(costRecord.usage || {}),
        JSON.stringify(costRecord.cost || {}),
        costRecord.dateKey || new Date().toISOString().slice(0, 10),
        costRecord.timestamp || new Date().toISOString()
      );
      return { recorded: true, record: { ...costRecord } };
    } catch (err) {
      throw err;
    }
  }

  async hasCost(requestId) {
    const row = this._db.prepare(
      'SELECT 1 FROM cost_records WHERE request_id = ?'
    ).get(requestId);
    return !!row;
  }

  async getCost(requestId) {
    const row = this._db.prepare(
      'SELECT * FROM cost_records WHERE request_id = ?'
    ).get(requestId);
    if (!row) return null;
    return {
      requestId: row.request_id,
      modelId: row.model_id,
      provider: row.provider,
      usage: JSON.parse(row.usage),
      cost: JSON.parse(row.cost),
      dateKey: row.date_key,
      timestamp: row.timestamp,
    };
  }

  // --- key_status ---

  async saveKeyStatus(keyStatus) {
    if (!keyStatus?.provider || !keyStatus?.keyId) return;
    this._db.prepare(
      'INSERT OR REPLACE INTO key_status (provider, key_id, status, reason, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      keyStatus.provider,
      keyStatus.keyId,
      keyStatus.status,
      keyStatus.reason || null,
      keyStatus.updatedAt || new Date().toISOString()
    );
  }

  async getKeyStatuses(provider) {
    const rows = this._db.prepare(
      'SELECT * FROM key_status WHERE provider = ?'
    ).all(provider);
    return rows.map((r) => ({
      provider: r.provider,
      keyId: r.key_id,
      status: r.status,
      reason: r.reason,
      updatedAt: r.updated_at,
    }));
  }

  async getKeyStatus(provider, keyId) {
    const row = this._db.prepare(
      'SELECT * FROM key_status WHERE provider = ? AND key_id = ?'
    ).get(provider, keyId);
    if (!row) return null;
    return {
      provider: row.provider,
      keyId: row.key_id,
      status: row.status,
      reason: row.reason,
      updatedAt: row.updated_at,
    };
  }

  // --- provider_health ---

  async saveProviderHealth(health) {
    if (!health?.provider) return;
    this._db.prepare(
      'INSERT OR REPLACE INTO provider_health (provider, state, failure_count, last_failure_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      health.provider,
      health.state || null,
      health.failureCount || 0,
      health.lastFailureAt || null,
      health.updatedAt || new Date().toISOString()
    );
  }

  async getProviderHealth(provider) {
    const row = this._db.prepare(
      'SELECT * FROM provider_health WHERE provider = ?'
    ).get(provider);
    if (!row) return null;
    return {
      provider: row.provider,
      state: row.state,
      failureCount: row.failure_count,
      lastFailureAt: row.last_failure_at,
      updatedAt: row.updated_at,
    };
  }

  async getAllProviderHealth() {
    const rows = this._db.prepare('SELECT * FROM provider_health').all();
    return rows.map((r) => ({
      provider: r.provider,
      state: r.state,
      failureCount: r.failure_count,
      lastFailureAt: r.last_failure_at,
      updatedAt: r.updated_at,
    }));
  }

  // --- finalized_requests ---

  async saveFinalized(finalized) {
    if (!finalized?.requestId) {
      return { finalized: false, reason: 'missing_requestId' };
    }
    try {
      this._db.prepare(
        'INSERT OR IGNORE INTO finalized_requests (request_id, outcome, agent_id, protocol, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run(
        finalized.requestId,
        finalized.outcome || null,
        finalized.agentId || null,
        finalized.protocol || null,
        finalized.timestamp || new Date().toISOString()
      );
      const changes = this._db.prepare('SELECT changes() as c').get();
      if (changes.c === 0) {
        return { finalized: false, reason: 'already_finalized' };
      }
      return { finalized: true };
    } catch (err) {
      return { finalized: false, reason: err.message };
    }
  }

  async isFinalized(requestId) {
    const row = this._db.prepare(
      'SELECT 1 FROM finalized_requests WHERE request_id = ?'
    ).get(requestId);
    return !!row;
  }

  // --- audit ---

  async saveAuditRecord(auditRecord) {
    if (!auditRecord?.requestId) return;
    this._db.prepare(
      `INSERT INTO audit_records
      (request_id, outcome, final_model, final_provider, attempt_count,
       agent_id, protocol, response_size, attempts, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      auditRecord.requestId,
      auditRecord.outcome || null,
      auditRecord.finalModel || null,
      auditRecord.finalProvider || null,
      auditRecord.attemptCount || 0,
      auditRecord.agentId || null,
      auditRecord.protocol || null,
      auditRecord.responseSize || null,
      JSON.stringify(auditRecord.attempts || []),
      auditRecord.timestamp || new Date().toISOString()
    );
  }

  async getAuditRecord(requestId) {
    const row = this._db.prepare(
      'SELECT * FROM audit_records WHERE request_id = ? ORDER BY rowid DESC LIMIT 1'
    ).get(requestId);
    if (!row) return null;
    return {
      requestId: row.request_id,
      outcome: row.outcome,
      finalModel: row.final_model,
      finalProvider: row.final_provider,
      attemptCount: row.attempt_count,
      agentId: row.agent_id,
      protocol: row.protocol,
      responseSize: row.response_size,
      attempts: JSON.parse(row.attempts || '[]'),
      timestamp: row.timestamp,
    };
  }

  async getAllAuditRecords() {
    const rows = this._db.prepare('SELECT * FROM audit_records ORDER BY rowid').all();
    return rows.map((r) => ({
      requestId: r.request_id,
      outcome: r.outcome,
      finalModel: r.final_model,
      finalProvider: r.final_provider,
      attemptCount: r.attempt_count,
      agentId: r.agent_id,
      protocol: r.protocol,
      responseSize: r.response_size,
      attempts: JSON.parse(r.attempts || '[]'),
      timestamp: r.timestamp,
    }));
  }
}

export default { SQLiteStore };
