// src/storage/index.js
// Smart Router Mainline - Phase 1
// 存储模块入口：统一导出存储接口和实现。

import { StorageInterface } from './interface.js';
import { MemoryStore } from './memory-store.js';
import { SQLiteStore } from './sqlite-store.js';

export { StorageInterface, MemoryStore, SQLiteStore };
export default { StorageInterface, MemoryStore, SQLiteStore };
