// src/management/users.js
// Smart Router Mainline - Phase 2
// 用户管理系统：管理员管理员工账户，分配API额度、模型白名单。
//
// 设计：
//   - 管理员（admin）可创建/删除员工（employee）
//   - 员工有独立API密钥，只能访问白名单模型
//   - 按用户/部门追踪成本
//   - 员工密钥过期可自动轮换
//
// 仅使用 Node.js 内置模块。

import { createHash, randomBytes } from 'node:crypto';

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[users][${ts}] ${msg}\n`);
}

function hashToken(token) {
  return typeof token === 'string' && token
    ? createHash('sha256').update(token, 'utf8').digest('hex')
    : null;
}

function currentUsageMonth() {
  return new Date().toISOString().slice(0, 7);
}

// 角色常量
export const UserRole = {
  ADMIN: 'admin',
  EMPLOYEE: 'employee',
};

// 用户状态
export const UserStatus = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
};

// ----------------------------------------------------------------------------
// 用户记录结构
// ----------------------------------------------------------------------------
/**
 * @typedef {object} UserRecord
 * @property {string} id 用户唯一ID (uuid)
 * @property {string} username 用户名（唯一）
 * @property {string} displayName 显示名称
 * @property {UserRole} role admin|employee
 * @property {UserStatus} status active|disabled
 * @property {string} department 部门
 * @property {string|null} apiToken 员工API密钥（仅员工）
 * @property {number|null} monthlyQuotaBytes 月度配额（bytes），null=不限
 * @property {string[]} modelWhitelist 模型白名单，空=全部可用
 * @property {string[]} providerWhitelist 提供商白名单，空=全部可用
 * @property {number} usageBytes 已用量
 * @property {number} costTotal 累计成本
 * @property {string} createdAt
 * @property {string} updatedAt
 */

// ----------------------------------------------------------------------------
// UserManager
// ----------------------------------------------------------------------------
export class UserManager {
  constructor(store) {
    this._store = store;
    this._users = new Map(); // id -> UserRecord
    this._usernameIndex = new Map(); // username -> id
    this._tokenIndex = new Map(); // apiToken -> id
  }

  // ---- 初始化 ----

  /** 从数据库恢复用户数据 */
  async restoreUsers() {
    if (!this._store) return;
    try {
      const users = await this._store.listUsers();
      for (const user of users) {
        if (user.usageMonth !== currentUsageMonth()) {
          user.usageBytes = 0;
          user.usageMonth = currentUsageMonth();
          await this._store.saveUser?.(user);
        }
        this._users.set(user.id, user);
        this._usernameIndex.set(user.username, user.id);
        if (user.status === UserStatus.ACTIVE) {
          const tokenKey = user.apiToken ? user.apiToken : user.apiTokenHash;
          if (tokenKey) this._tokenIndex.set(user.apiToken ? user.apiToken : tokenKey, user.id);
        }
      }
      log(`restored ${users.length} user(s) from store`);
    } catch (err) {
      log(`restoreUsers failed: ${err.message}`);
    }
  }

  /** 创建默认管理员 */
  async initDefaultAdmin() {
    // 先恢复已有用户
    await this.restoreUsers();
    if (this._users.size > 0) return null;
    const adminId = this._genId('admin');
    const record = {
      id: adminId,
      username: 'admin',
      displayName: '系统管理员',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      department: 'admin',
      apiToken: null,
      monthlyQuotaBytes: null,
      modelWhitelist: [],
      providerWhitelist: [],
      usageBytes: 0,
      usageMonth: currentUsageMonth(),
      costTotal: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this._users.set(adminId, record);
    this._usernameIndex.set('admin', adminId);
    if (this._store) {
      await this._store.saveUser(record).catch(() => {});
    }
    log(`default admin created: ${adminId}`);
    return record;
  }

  // ---- CRUD ----

  async createUser(params) {
    // params: { username, displayName, role?, department?, apiToken?, monthlyQuotaBytes?, modelWhitelist?, providerWhitelist? }
    const {
      username, displayName, role = UserRole.EMPLOYEE, department = 'general',
      apiToken, monthlyQuotaBytes = null, modelWhitelist = [], providerWhitelist = [],
    } = params;

    if (!username || !displayName) throw new Error('username and displayName required');
    if (this._usernameIndex.has(username)) throw new Error(`username "${username}" already exists`);

    const id = this._genId(role);
    const token = apiToken || this._genApiToken();
    if (this._tokenIndex.has(token) || (this._store?.getUserByToken && await this._store.getUserByToken(token))) {
      throw new Error('apiToken already exists');
    }
    const now = new Date().toISOString();
    const record = {
      id, username, displayName, role, department,
      status: UserStatus.ACTIVE,
      apiToken: token,
      apiTokenHash: hashToken(token),
      monthlyQuotaBytes,
      modelWhitelist: [...modelWhitelist],
      providerWhitelist: [...providerWhitelist],
      usageBytes: 0,
      usageMonth: currentUsageMonth(),
      costTotal: 0,
      createdAt: now,
      updatedAt: now,
    };
    this._users.set(id, record);
    this._usernameIndex.set(username, id);
    this._tokenIndex.set(token, id);
    if (this._store) {
      await this._store.saveUser(record).catch((err) => log(`saveUser failed: ${err.message}`));
    }
    log(`user created: ${id} (${username}, ${role})`);
    return { ...record, apiToken: token }; // 返回时包含token（仅在创建时）
  }

  async getUser(id) {
    const user = this._users.get(id);
    return user ? maskUser(user) : null;
  }

  async getUserByUsername(username) {
    const id = this._usernameIndex.get(username);
    return id ? this._users.get(id) : null;
  }

  async getUserByToken(token) {
    if (!token) return null;
    const id = this._tokenIndex.get(token) || this._tokenIndex.get(hashToken(token));
    return id ? this._users.get(id) : null;
  }

  async listUsers() {
    return Array.from(this._users.values()).map((u) => maskUser(u));
  }

  async updateUser(id, updates) {
    const record = this._users.get(id);
    if (!record) throw new Error(`user ${id} not found`);

    const {
      displayName, role, department, monthlyQuotaBytes, modelWhitelist, providerWhitelist, status,
    } = updates;

    if (displayName !== undefined) {
      this._usernameIndex.delete(record.username);
      record.displayName = displayName;
      this._usernameIndex.set(record.username, id);
    }
    if (role !== undefined) {
      record.role = role;
      if (role === UserRole.EMPLOYEE && !record.apiToken) {
        record.apiToken = this._genApiToken();
        record.apiTokenHash = hashToken(record.apiToken);
        this._tokenIndex.set(record.apiToken, id);
      }
    }
    if (department !== undefined) record.department = department;
    if (monthlyQuotaBytes !== undefined) record.monthlyQuotaBytes = monthlyQuotaBytes;
    if (Array.isArray(modelWhitelist)) record.modelWhitelist = [...modelWhitelist];
    if (Array.isArray(providerWhitelist)) record.providerWhitelist = [...providerWhitelist];
    if (status !== undefined) {
      record.status = status;
      if (status === UserStatus.DISABLED) {
        this._tokenIndex.delete(record.apiToken);
        this._tokenIndex.delete(record.apiTokenHash);
      } else if (status === UserStatus.ACTIVE && record.apiToken) {
        this._tokenIndex.set(record.apiToken, id);
      } else if (status === UserStatus.ACTIVE && record.apiTokenHash) {
        this._tokenIndex.set(record.apiTokenHash, id);
      }
    }

    record.updatedAt = new Date().toISOString();
    this._users.set(id, record);
    if (this._store) {
      await this._store.saveUser(record).catch((err) => log(`saveUser failed: ${err.message}`));
    }
    return maskUser(record);
  }

  async disableUser(id) {
    return this.updateUser(id, { status: UserStatus.DISABLED });
  }

  async enableUser(id) {
    return this.updateUser(id, { status: UserStatus.ACTIVE });
  }

  async deleteUser(id) {
    const record = this._users.get(id);
    if (!record) throw new Error(`user ${id} not found`);
    if (record.role === UserRole.ADMIN) throw new Error('cannot delete admin user');
    this._usernameIndex.delete(record.username);
    this._tokenIndex.delete(record.apiToken);
    this._users.delete(id);
    if (this._store) {
      await this._store.deleteUser(id).catch((err) => log(`deleteUser failed: ${err.message}`));
    }
    log(`user deleted: ${id}`);
  }

  async rotateToken(id) {
    const record = this._users.get(id);
    if (!record) throw new Error(`user ${id} not found`);
    if (record.apiToken) this._tokenIndex.delete(record.apiToken);
    if (record.apiTokenHash) this._tokenIndex.delete(record.apiTokenHash);
    const newToken = this._genApiToken();
    record.apiToken = newToken;
    record.apiTokenHash = hashToken(newToken);
    this._tokenIndex.set(newToken, id);
    record.updatedAt = new Date().toISOString();
    if (this._store) {
      await this._store.saveUser(record).catch((err) => log(`saveUser failed: ${err.message}`));
    }
    log(`token rotated for user: ${id}`);
    return newToken;
  }

  // ---- 配额与白名单 ----

  canAccessModel(user, modelId) {
    if (!user || user.status !== UserStatus.ACTIVE) return false;
    if (user.role === UserRole.ADMIN) return true;
    if (user.modelWhitelist.length === 0) return true; // 空白名单=全部可用
    return user.modelWhitelist.includes(modelId);
  }

  canAccessProvider(user, providerName) {
    if (!user || user.status !== UserStatus.ACTIVE) return false;
    if (user.role === UserRole.ADMIN) return true;
    if (user.providerWhitelist.length === 0) return true;
    return user.providerWhitelist.includes(providerName);
  }

  canAccessAnyModel(user) {
    if (!user || user.status !== UserStatus.ACTIVE) return false;
    if (user.role === UserRole.ADMIN) return true;
    return user.modelWhitelist.length > 0;
  }

  checkQuota(user) {
    this._rollUsagePeriod(user);
    if (!user || user.role === UserRole.ADMIN || user.monthlyQuotaBytes === null) return { allowed: true, remaining: null };
    const used = user.usageBytes || 0;
    const remaining = user.monthlyQuotaBytes - used;
    return { allowed: remaining >= 0, remaining };
  }

  async recordUsage(id, bytes, cost) {
    const record = this._users.get(id);
    if (!record) return;
    this._rollUsagePeriod(record);
    record.usageBytes = (record.usageBytes || 0) + (bytes || 0);
    record.costTotal = (record.costTotal || 0) + (cost || 0);
    record.updatedAt = new Date().toISOString();
    this._users.set(id, record);
    if (this._store) {
      await this._store.updateUserUsage(id, bytes || 0, cost || 0).catch(() => {});
    }
  }

  // ---- 统计 ----

  _rollUsagePeriod(record) {
    const month = currentUsageMonth();
    if (record.usageMonth !== month) {
      record.usageMonth = month;
      record.usageBytes = 0;
    }
  }

  getStats() {
    const users = Array.from(this._users.values());
    const totalUsers = users.length;
    const activeUsers = users.filter((u) => u.status === UserStatus.ACTIVE).length;
    const admins = users.filter((u) => u.role === UserRole.ADMIN).length;
    const employees = totalUsers - admins;
    const totalCost = users.reduce((sum, u) => sum + (u.costTotal || 0), 0);
    const totalUsage = users.reduce((sum, u) => sum + (u.usageBytes || 0), 0);
    return { totalUsers, activeUsers, admins, employees, totalCost, totalUsage };
  }

  // ---- 辅助 ----

  _genId(prefix) {
    return `${prefix}_${randomBytes(8).toString('hex')}`;
  }

  _genApiToken() {
    return `sr_${randomBytes(24).toString('hex')}`;
  }
}

// ---- 脱敏用户数据 ----

function maskUser(user) {
  const masked = { ...user };
  delete masked.apiTokenHash;
  if (masked.apiToken) {
    masked.apiToken = masked.apiToken.length > 12
      ? `${masked.apiToken.slice(0, 6)}****${masked.apiToken.slice(-4)}`
      : '****';
  }
  return masked;
}

export default { UserManager, UserRole, UserStatus };
