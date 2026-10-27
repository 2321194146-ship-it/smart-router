// src/secrets-merge.js
// Smart Router Mainline - Secrets Merge Utility
// 将 secrets.local.json 中的密钥注入到配置对象中。
// 仅用于启动时合并，不修改原始配置文件。
//
// 仅使用 Node.js 内置模块。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[secrets][${ts}] ${msg}\n`);
}

/**
 * 安全读取 JSON 文件
 */
function safeReadJSON(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    log(`failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * 将密钥从 secrets 文件合并到配置对象。
 * 支持两种格式：
 *
 * 格式1（旧）：providers 数组按 name 匹配
 * {
 *   "providers": [
 *     { "name": "openai", "api_key": "sk-xxx", "api_keys": [...] }
 *   ]
 * }
 *
 * 格式2（新）：provider_keys 对象按 name 匹配（推荐）
 * {
 *   "provider_keys": {
 *     "openai": { "api_key": "sk-xxx", "api_keys": [...] },
 *     "anthropic": { "api_key": "sk-xxx" }
 *   }
 * }
 */
export function mergeSecrets(config, configPath, secretsPath = null) {
  const path = secretsPath || resolveSecretsPath(configPath);
  if (!path) return config;

  const secrets = safeReadJSON(path);
  if (!secrets) return config;

  // 格式1：通过 providers 数组按 name 匹配
  if (Array.isArray(secrets.providers)) {
    const secretMap = new Map();
    for (const s of secrets.providers) {
      if (s && s.name) secretMap.set(s.name, s);
    }
    return injectKeysByMap(config, secretMap);
  }

  // 格式2：通过 provider_keys 对象按 name 匹配
  if (secrets.provider_keys && typeof secrets.provider_keys === 'object') {
    return injectKeysByMap(config, new Map(Object.entries(secrets.provider_keys)));
  }

  return config;
}

/**
 * 将密钥注入到配置的 providers 数组中，按 name 匹配。
 */
function injectKeysByMap(config, secretMap) {
  if (!Array.isArray(config.providers)) return config;
  let injected = 0;

  for (const provider of config.providers) {
    const secret = secretMap.get(provider.name);
    if (!secret) continue;

    // 注入 api_key
    if (secret.api_key) {
      provider.api_key = secret.api_key;
      injected++;
    }

    // 注入 api_keys 数组
    if (Array.isArray(secret.api_keys)) {
      provider.api_keys = [...secret.api_keys];
      injected += secret.api_keys.length;
    }
  }

  if (injected > 0) {
    log(`merged ${injected} secrets into ${secretMap.size} provider(s)`);
  }
  return config;
}

/**
 * 解析 secrets 文件路径（与 loader.js 保持一致的搜索顺序）。
 */
function resolveSecretsPath(configPath) {
  if (!configPath) return null;
  const dir = dirname(configPath);
  const base = configPath.replace(/\.\w+$/, '');
  const name = base.split('/').pop();

  const candidates = [
    join(dir, 'secrets.local.json'),
    join(dir, `local.${name}.json`),
    join(dir, `${name}.secrets.json`),
    join(dir, 'secrets.json'),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * 脱敏密钥：显示前4位和后4位，中间用 * 替代。
 * 例如：sk-abc...xyz
 */
export function maskKey(key) {
  if (!key || typeof key !== 'string' || key.length < 8) return '****';
  const prefix = key.slice(0, 6);
  const suffix = key.slice(-4);
  if (key.length > 12) return `${prefix}****${suffix}`;
  return `${prefix}****`;
}

/**
 * 递归脱敏对象中的所有密钥字段。
 */
export function maskSecrets(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((item) => maskSecrets(item));

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'api_key' && typeof value === 'string') {
      result[key] = maskKey(value);
    } else if (key === 'api_keys' && Array.isArray(value)) {
      result[key] = value.map((k) => maskKey(k));
    } else {
      result[key] = maskSecrets(value);
    }
  }
  return result;
}

export default { mergeSecrets, maskKey, maskSecrets };