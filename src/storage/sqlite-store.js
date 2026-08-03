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
        status TEXT,
        external_request_id TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_external_id ON requests(external_request_id);

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
        cooldown_until INTEGER,
        failure_count INTEGER DEFAULT 0,
        last_error_type TEXT,
        last_failure_at TEXT,
        last_success_at TEXT,
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

      CREATE TABLE IF NOT EXISTS shadow_decisions (
        request_id TEXT PRIMARY KEY,
        protocol TEXT,
        agent_id TEXT,
        requested_model TEXT,
        task_profile TEXT,
        recommendation TEXT,
        ranked_candidates TEXT,
        predictions TEXT,
        explanation TEXT,
        actual_final_model TEXT,
        actual_final_provider TEXT,
        actual_outcome TEXT,
        actual_attempt_count INTEGER,
        actual_usage TEXT,
        actual_cost TEXT,
        actual_latency INTEGER,
        comparison_status TEXT,
        created_at TEXT NOT NULL,
        finalized_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_created_at ON shadow_decisions(created_at);

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    // --- Schema migrations for existing databases ---
    // key_status: add cooldown and failure tracking columns
    try { this._db.exec('ALTER TABLE key_status ADD COLUMN cooldown_until INTEGER'); } catch {}
    try { this._db.exec('ALTER TABLE key_status ADD COLUMN failure_count INTEGER DEFAULT 0'); } catch {}
    try { this._db.exec('ALTER TABLE key_status ADD COLUMN last_error_type TEXT'); } catch {}
    try { this._db.exec('ALTER TABLE key_status ADD COLUMN last_failure_at TEXT'); } catch {}
    try { this._db.exec('ALTER TABLE key_status ADD COLUMN last_success_at TEXT'); } catch {}
    // requests: add external_request_id column
    try { this._db.exec('ALTER TABLE requests ADD COLUMN external_request_id TEXT'); } catch {}
    try { this._db.exec('CREATE INDEX IF NOT EXISTS idx_requests_external_id ON requests(external_request_id)'); } catch {}
  }

  async close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  // --- requests ---

  async saveRequest(request, transaction) {
    if (!request?.requestId) return false;
    const db = (transaction?.db) || this._db;
    try {
      db.prepare(
        'INSERT OR IGNORE INTO requests (request_id, agent_id, protocol, model, provider, external_request_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        request.requestId,
        request.agentId || null,
        request.protocol || null,
        request.model || null,
        request.provider || null,
        request.externalRequestId || null,
        request.timestamp || new Date().toISOString()
      );
      return true;
    } catch {
      return false;
    }
  }

  async getRequest(requestId) {
    const row = this._db.prepare(
      'SELECT request_id, agent_id, protocol, model, provider, status, external_request_id, timestamp FROM requests WHERE request_id = ?'
    ).get(requestId);
    if (!row) return null;
    return {
      requestId: row.request_id,
      agentId: row.agent_id,
      protocol: row.protocol,
      model: row.model,
      provider: row.provider,
      status: row.status || null,
      externalRequestId: row.external_request_id || null,
      timestamp: row.timestamp,
    };
  }

  async getRequestByExternalId(externalRequestId) {
    if (!externalRequestId) return null;
    const row = this._db.prepare(
      'SELECT request_id, agent_id, protocol, model, provider, status, external_request_id, timestamp FROM requests WHERE external_request_id = ?'
    ).get(externalRequestId);
    if (!row) return null;
    return {
      requestId: row.request_id,
      agentId: row.agent_id,
      protocol: row.protocol,
      model: row.model,
      provider: row.provider,
      status: row.status || null,
      externalRequestId: row.external_request_id || null,
      timestamp: row.timestamp,
    };
  }

  // --- attempts ---

  async saveAttempt(attempt, transaction) {
    if (!attempt?.requestId || !attempt.attemptNumber) return false;
    const db = (transaction?.db) || this._db;
    try {
      db.prepare(
        `INSERT OR REPLACE INTO attempts
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

  async saveCost(costRecord, transaction) {
    if (!costRecord?.requestId) {
      throw new Error('saveCost: requestId required');
    }
    const db = (transaction?.db) || this._db;
    try {
      const existing = db.prepare(
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
      db.prepare(
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

  async saveKeyStatus(keyStatus, transaction) {
    if (!keyStatus?.provider || !keyStatus?.keyId) return;
    const db = (transaction?.db) || this._db;
    db.prepare(
      'INSERT OR REPLACE INTO key_status (provider, key_id, status, reason, cooldown_until, failure_count, last_error_type, last_failure_at, last_success_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      keyStatus.provider,
      keyStatus.keyId,
      keyStatus.status,
      keyStatus.reason || null,
      keyStatus.cooldownUntil || null,
      keyStatus.failureCount || 0,
      keyStatus.lastErrorType || null,
      keyStatus.lastFailureAt || null,
      keyStatus.lastSuccessAt || null,
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
      cooldownUntil: r.cooldown_until || null,
      failureCount: r.failure_count || 0,
      lastErrorType: r.last_error_type || null,
      lastFailureAt: r.last_failure_at || null,
      lastSuccessAt: r.last_success_at || null,
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
      cooldownUntil: row.cooldown_until || null,
      failureCount: row.failure_count || 0,
      lastErrorType: row.last_error_type || null,
      lastFailureAt: row.last_failure_at || null,
      lastSuccessAt: row.last_success_at || null,
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

  async saveFinalized(finalized, transaction) {
    if (!finalized?.requestId) {
      return { finalized: false, reason: 'missing_requestId' };
    }
    const db = (transaction?.db) || this._db;
    try {
      const insResult = db.prepare(
        'INSERT OR IGNORE INTO finalized_requests (request_id, outcome, agent_id, protocol, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run(
        finalized.requestId,
        finalized.outcome || null,
        finalized.agentId || null,
        finalized.protocol || null,
        finalized.timestamp || new Date().toISOString()
      );
      if (insResult.changes === 0) {
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

  /**
   * 单次同步原子收尾事务（方案A）。
   *
   * 使用 BEGIN IMMEDIATE 获取写锁，在同一连接上连续同步执行全部写入。
   * 方法内部不包含任何 await / 网络操作，Node.js 单线程下其他请求
   * 无法在事务中途插入，从根本上避免 "cannot start a transaction within a transaction"。
   *
   * 写入顺序：
   *   1. finalized_requests（幂等占位）
   *   2. requests 最终状态
   *   3. attempts
   *   4. cost_records（如提供，已存在则跳过保证成本仅扣一次）
   *   5. audit_records
   *
   * 任何一步失败 → ROLLBACK + 抛出错误；调用方不得 catch 后继续 commit。
   *
   * @param {object} payload
   *   - requestId {string}
   *   - outcome {string}
   *   - attempts {object[]} 已纯计算的 attempt 数组
   *   - costRecord {object|null} 已纯计算的成本记录（可选）
   *   - auditRecord {object} 已构建的审计记录
   *   - agentId {string|null}
   *   - protocol {string|null}
   *   - timestamp {string}
   * @returns {{finalized: boolean, reason?: string}}
   */
  finalizeRequestAtomic(payload) {
    const db = this._db;
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
    db.exec('BEGIN IMMEDIATE');
    try {
      // 1. finalized_requests 幂等占位
      const ins = db.prepare(
        'INSERT OR IGNORE INTO finalized_requests (request_id, outcome, agent_id, protocol, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run(requestId, outcome || null, agentId, protocol, ts);
      if (ins.changes === 0) {
        db.exec('ROLLBACK');
        return { finalized: false, reason: 'already_finalized' };
      }

      // 2. requests 最终状态（行缺失时兜底创建，覆盖 no_candidate 等
      //    execute() 之前收尾、尚未 saveRequest 的场景）
      const upd = db.prepare('UPDATE requests SET status = ? WHERE request_id = ?').run(outcome || null, requestId);
      if (upd.changes === 0) {
        db.prepare(
          'INSERT OR IGNORE INTO requests (request_id, agent_id, protocol, status, external_request_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(requestId, agentId, protocol, outcome || null, externalRequestId, ts);
      }

      // 3. attempts
      const attemptStmt = db.prepare(
        `INSERT OR REPLACE INTO attempts
        (request_id, attempt_number, model, provider, key_id,
         transport_outcome, validated_outcome, error_type, error_message,
         http_status, latency_ms, first_byte_ms, headers_received,
         first_byte_sent_to_client, budget_blocked, usage, cost, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const a of attempts) {
        attemptStmt.run(
          requestId,
          a.attemptNumber,
          a.model || null,
          a.provider || null,
          a.keyId || null,
          a.transportOutcome || null,
          a.validatedOutcome || null,
          a.errorType || null,
          a.errorMessage || null,
          a.httpStatus || null,
          a.latencyMs || 0,
          a.firstByteMs || null,
          a.headersReceived ? 1 : 0,
          a.firstByteSentToClient ? 1 : 0,
          a.budgetBlocked ? 1 : 0,
          a.usage ? JSON.stringify(a.usage) : null,
          a.cost ? JSON.stringify(a.cost) : null,
          a.timestamp || ts
        );
      }

      // 4. cost_records（如提供；已存在则跳过）
      if (costRecord) {
        const existing = db.prepare('SELECT 1 FROM cost_records WHERE request_id = ?').get(requestId);
        if (!existing) {
          db.prepare(
            'INSERT INTO cost_records (request_id, model_id, provider, usage, cost, date_key, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(
            costRecord.requestId,
            costRecord.modelId || null,
            costRecord.provider || null,
            JSON.stringify(costRecord.usage || {}),
            JSON.stringify(costRecord.cost || {}),
            costRecord.dateKey || ts.slice(0, 10),
            costRecord.timestamp || ts
          );
        }
      }

      // 5. audit_records
      db.prepare(
        `INSERT INTO audit_records
        (request_id, outcome, final_model, final_provider, attempt_count,
         agent_id, protocol, response_size, attempts, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        auditRecord.requestId,
        auditRecord.outcome || outcome || null,
        auditRecord.finalModel || null,
        auditRecord.finalProvider || null,
        auditRecord.attemptCount || 0,
        auditRecord.agentId || null,
        auditRecord.protocol || null,
        auditRecord.responseSize || null,
        JSON.stringify(auditRecord.attempts || []),
        auditRecord.timestamp || ts
      );

      db.exec('COMMIT');
      return { finalized: true };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (e) { /* may already be rolled back */ }
      throw err;
    }
  }

  async updateRequestStatus(requestId, status, transaction) {
    const db = (transaction?.db) || this._db;
    db.prepare('UPDATE requests SET status = ? WHERE request_id = ?').run(status, requestId);
  }

  async beginTransaction() {
    this._db.exec('BEGIN TRANSACTION');
    return { active: true, db: this._db };
  }

  async commitTransaction(transaction) {
    this._db.exec('COMMIT');
  }

  async rollbackTransaction(transaction) {
    try { this._db.exec('ROLLBACK'); } catch (e) { /* may already be rolled back */ }
  }

  // --- audit ---

  async saveAuditRecord(auditRecord, transaction) {
    if (!auditRecord?.requestId) return;
    const db = (transaction?.db) || this._db;
    db.prepare(
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

  // --------------------------------------------------------------------------
  // Shadow 决策持久化（Phase2-A Shadow）
  // 执行前 upsert 建议；Finalize 后更新真实最终结果。
  // 不保存完整用户 Prompt；task_profile 仅含脱敏任务特征。
  // --------------------------------------------------------------------------

  async saveShadowDecision(record) {
    const ts = record.created_at || new Date().toISOString();
    this._db.prepare(`
      INSERT INTO shadow_decisions (
        request_id, protocol, agent_id, requested_model, task_profile, recommendation,
        ranked_candidates, predictions, explanation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        protocol=excluded.protocol, agent_id=excluded.agent_id,
        requested_model=excluded.requested_model, task_profile=excluded.task_profile,
        recommendation=excluded.recommendation, ranked_candidates=excluded.ranked_candidates,
        predictions=excluded.predictions, explanation=excluded.explanation,
        created_at=excluded.created_at
    `).run(
      record.request_id, record.protocol || null, record.agent_id || null,
      record.requested_model || null, record.task_profile || null,
      record.recommendation || null, record.ranked_candidates || null,
      record.predictions || null, record.explanation || null, ts,
    );
    return { saved: true };
  }

  async finalizeShadowDecision(record) {
    const result = this._db.prepare(`
      UPDATE shadow_decisions SET
        actual_final_model=?, actual_final_provider=?, actual_outcome=?,
        actual_attempt_count=?, actual_usage=?, actual_cost=?, actual_latency=?,
        comparison_status=?, finalized_at=?
      WHERE request_id=?
    `).run(
      record.actual_final_model || null, record.actual_final_provider || null,
      record.actual_outcome || null, record.actual_attempt_count ?? null,
      record.actual_usage || null, record.actual_cost || null,
      record.actual_latency ?? null, record.comparison_status || null,
      record.finalized_at || new Date().toISOString(),
      record.request_id,
    );
    return { saved: result.changes > 0, changes: result.changes };
  }

  async getShadowDecision(requestId) {
    const row = this._db.prepare('SELECT * FROM shadow_decisions WHERE request_id = ?').get(requestId);
    if (!row) return null;
    return this._parseShadowRow(row);
  }

  async listShadowDecisions() {
    // rowid = 插入顺序（同毫秒 created_at 下顺序稳定；请求按 await 顺序落库）
    const rows = this._db.prepare('SELECT * FROM shadow_decisions ORDER BY rowid').all();
    return rows.map((r) => this._parseShadowRow(r));
  }

  _parseShadowRow(row) {
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

  /**
   * 按保留天数清理过期 Shadow 记录（配置 intelligence.shadow.retentionDays）。
   * @param {number} retentionDays 保留天数（默认 30）
   * @returns {number} 删除条数
   */
  async pruneShadowDecisions(retentionDays = 30) {
    const cutoffMs = Date.now() - retentionDays * 86400000;
    const cutoff = new Date(cutoffMs).toISOString();
    const result = this._db.prepare(
      'DELETE FROM shadow_decisions WHERE created_at < ?'
    ).run(cutoff);
    return result.changes || 0;
  }

  // --- app_state (Phase2-C: Canary Kill Switch 持久化) ---

  async getAppState(key) {
    const row = this._db.prepare(
      'SELECT value FROM app_state WHERE key = ?'
    ).get(key);
    return row ? row.value : null;
  }

  async setAppState(key, value) {
    this._db.prepare(
      'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
    ).run(key, String(value), new Date().toISOString());
  }
}

export default { SQLiteStore };
