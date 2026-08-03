// src/storage/interface.js
// Smart Router Mainline - Phase 1
// 存储抽象接口：定义所有存储操作的方法签名。
//
// 设计原则：
//   - 业务模块通过此接口操作存储，不直接接触 SQLite
//   - 测试默认使用 MemoryStore，生产使用 SQLiteStore
//   - 接口方法返回 Promise，支持异步实现
//   - 唯一约束由具体实现保证（SQLite 用 UNIQUE，Memory 用 Map key）
//
// 仅使用 Node.js 内置模块，无第三方依赖。

/**
 * 存储抽象接口。
 *
 * 所有方法返回 Promise。具体实现（MemoryStore / SQLiteStore）必须实现全部方法。
 *
 * 表结构对应：
 *   - requests: 请求元数据（requestId PK）
 *   - attempts: Attempt 审计记录（requestId + attemptNumber 联合唯一）
 *   - cost_records: 成本记录（requestId PK，防重复扣费）
 *   - key_status: Key 健康状态（provider + keyId 联合唯一）
 *   - provider_health: Provider 熔断状态（provider PK）
 *   - finalized_requests: 已收尾请求（requestId PK，幂等保护）
 */
export class StorageInterface {
  /**
   * 初始化存储（创建表、索引等）。
   * @returns {Promise<void>}
   */
  async init() {
    throw new Error('StorageInterface.init() not implemented');
  }

  /**
   * 关闭存储连接。
   * @returns {Promise<void>}
   */
  async close() {
    throw new Error('StorageInterface.close() not implemented');
  }

  // --- requests ---

  /**
   * 保存请求元数据。
   * @param {object} request { requestId, agentId, protocol, model, provider, timestamp }
   * @returns {Promise<boolean>} 是否成功插入（已存在返回 false）
   */
  async saveRequest(request) {
    throw new Error('StorageInterface.saveRequest() not implemented');
  }

  /**
   * 按 requestId 查询请求。
   * @param {string} requestId
   * @returns {Promise<object|null>}
   */
  async getRequest(requestId) {
    throw new Error('StorageInterface.getRequest() not implemented');
  }

  async getRequestByExternalId(externalRequestId) {
    throw new Error('StorageInterface.getRequestByExternalId() not implemented');
  }

  // --- attempts ---

  /**
   * 保存 Attempt 记录。
   * @param {object} attempt { requestId, attemptNumber, model, provider, keyId, ... }
   * @returns {Promise<boolean>} 是否成功插入（同 requestId+attemptNumber 已存在返回 false）
   */
  async saveAttempt(attempt, transaction) {
    throw new Error('StorageInterface.saveAttempt() not implemented');
  }

  /**
   * 按 requestId 查询所有 Attempt 记录。
   * @param {string} requestId
   * @returns {Promise<object[]>}
   */
  async getAttempts(requestId) {
    throw new Error('StorageInterface.getAttempts() not implemented');
  }

  // --- cost_records ---

  /**
   * 记录成本（以 requestId 唯一约束防重复）。
   * @param {object} costRecord { requestId, modelId, provider, usage, cost, dateKey, timestamp }
   * @returns {Promise<{ recorded: boolean, record: object }>}
   */
  async saveCost(costRecord, transaction) {
    throw new Error('StorageInterface.saveCost() not implemented');
  }

  /**
   * 检查是否已记录成本。
   * @param {string} requestId
   * @returns {Promise<boolean>}
   */
  async hasCost(requestId) {
    throw new Error('StorageInterface.hasCost() not implemented');
  }

  /**
   * 按 requestId 查询成本记录。
   * @param {string} requestId
   * @returns {Promise<object|null>}
   */
  async getCost(requestId) {
    throw new Error('StorageInterface.getCost() not implemented');
  }

  // --- key_status ---

  /**
   * 更新 Key 状态（401 永久失效等）。
   * @param {object} keyStatus { provider, keyId, status, reason, updatedAt }
   * @returns {Promise<void>}
   */
  async saveKeyStatus(keyStatus) {
    throw new Error('StorageInterface.saveKeyStatus() not implemented');
  }

  /**
   * 按 provider 查询所有 Key 状态。
   * @param {string} provider
   * @returns {Promise<object[]>}
   */
  async getKeyStatuses(provider) {
    throw new Error('StorageInterface.getKeyStatuses() not implemented');
  }

  /**
   * 按 provider + keyId 查询 Key 状态。
   * @param {string} provider
   * @param {string} keyId
   * @returns {Promise<object|null>}
   */
  async getKeyStatus(provider, keyId) {
    throw new Error('StorageInterface.getKeyStatus() not implemented');
  }

  // --- provider_health ---

  /**
   * 保存 Provider 健康状态（熔断器状态）。
   * @param {object} health { provider, state, failureCount, lastFailureAt, updatedAt }
   * @returns {Promise<void>}
   */
  async saveProviderHealth(health) {
    throw new Error('StorageInterface.saveProviderHealth() not implemented');
  }

  /**
   * 按 provider 查询健康状态。
   * @param {string} provider
   * @returns {Promise<object|null>}
   */
  async getProviderHealth(provider) {
    throw new Error('StorageInterface.getProviderHealth() not implemented');
  }

  /**
   * 查询所有 Provider 健康状态。
   * @returns {Promise<object[]>}
   */
  async getAllProviderHealth() {
    throw new Error('StorageInterface.getAllProviderHealth() not implemented');
  }

  // --- finalized_requests ---

  /**
   * 标记请求已收尾（幂等：同 requestId 只插入一次）。
   * @param {object} finalized { requestId, outcome, agentId, protocol, timestamp }
   * @returns {Promise<{ finalized: boolean, reason?: string }>}
   */
  async saveFinalized(finalized, transaction) {
    throw new Error('StorageInterface.saveFinalized() not implemented');
  }

  /**
   * 检查请求是否已收尾。
   * @param {string} requestId
   * @returns {Promise<boolean>}
   */
  async isFinalized(requestId) {
    throw new Error('StorageInterface.isFinalized() not implemented');
  }

  // --- request status update ---

  /**
   * 更新请求最终状态。
   * @param {string} requestId
   * @param {string} status 最终状态
   * @param {*} [transaction] 事务对象（可选）
   * @returns {Promise<void>}
   */
  async updateRequestStatus(requestId, status, transaction) {
    throw new Error('StorageInterface.updateRequestStatus() not implemented');
  }

  /**
   * 单次同步原子收尾事务（方案A）。
   * 内部必须使用 BEGIN IMMEDIATE + 连续同步写入（无 await / 网络操作）。
   * 业务层在调用前完成全部纯计算，成功后更新内存聚合。
   * @param {object} payload { requestId, outcome, attempts, costRecord, auditRecord, agentId, protocol, timestamp }
   * @returns {{finalized: boolean, reason?: string}}
   */
  finalizeRequestAtomic(payload) {
    throw new Error('StorageInterface.finalizeRequestAtomic() not implemented');
  }

  // --- transactions ---

  /**
   * 开始事务。
   * @returns {Promise<object>} 事务句柄
   */
  async beginTransaction() {
    throw new Error('StorageInterface.beginTransaction() not implemented');
  }

  /**
   * 提交事务。
   * @param {object} transaction 事务句柄
   * @returns {Promise<void>}
   */
  async commitTransaction(transaction) {
    throw new Error('StorageInterface.commitTransaction() not implemented');
  }

  /**
   * 回滚事务。
   * @param {object} transaction 事务句柄
   * @returns {Promise<void>}
   */
  async rollbackTransaction(transaction) {
    throw new Error('StorageInterface.rollbackTransaction() not implemented');
  }

  // --- audit ---

  /**
   * 保存审计记录。
   * @param {object} auditRecord
   * @returns {Promise<void>}
   */
  async saveAuditRecord(auditRecord, transaction) {
    throw new Error('StorageInterface.saveAuditRecord() not implemented');
  }

  /**
   * 按 requestId 查询审计记录。
   * @param {string} requestId
   * @returns {Promise<object|null>}
   */
  async getAuditRecord(requestId) {
    throw new Error('StorageInterface.getAuditRecord() not implemented');
  }

  /**
   * 查询所有审计记录。
   * @returns {Promise<object[]>}
   */
  async getAllAuditRecords() {
    throw new Error('StorageInterface.getAllAuditRecords() not implemented');
  }

  // --- app_state (Phase2-C: Canary Kill Switch 持久化) ---

  /**
   * 读取应用状态（key/value）。
   * @param {string} key
   * @returns {Promise<string|null>} 存储的原始字符串值；不存在返回 null
   */
  async getAppState(key) {
    throw new Error('StorageInterface.getAppState() not implemented');
  }

  /**
   * 写入应用状态（key/value，upsert）。
   * @param {string} key
   * @param {string} value 原始字符串值
   * @returns {Promise<void>}
   */
  async setAppState(key, value) {
    throw new Error('StorageInterface.setAppState() not implemented');
  }
}

export default { StorageInterface };
