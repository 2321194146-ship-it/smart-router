// src/config/loader.js
// Smart Router Mainline - Phase 1
// 配置加载器：JSON 文件加载 + 环境变量覆盖 + secrets 本地文件覆盖 + 热重载
//
// 仅使用 Node.js 内置模块（fs, path, url），无第三方依赖。

import { readFileSync, existsSync, statSync, accessSync, constants } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ----------------------------------------------------------------------------
// 模块级状态
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 当前已加载的配置（深冻结，防止意外修改）
let _config = null;

// 当前配置文件路径（用于 reload）
let _configPath = null;

// 当前 secrets 文件路径（用于 reload）
let _secretsPath = null;

// 上次加载的文件 mtime，用于热重载变更检测
let _configMtime = null;
let _secretsMtime = null;

// 环境变量覆盖前缀，例如 SR_SERVER_PORT => config.server.port
const ENV_PREFIX = 'SR_';

// ----------------------------------------------------------------------------
// 日志
// ----------------------------------------------------------------------------

let _verbose = false;

export function setVerbose(value) {
  _verbose = !!value;
}

/**
 * 简易日志函数，输出到 stderr，不干扰 stdout 的业务流。
 * @param {string} msg
 */
export function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[config-loader][${ts}] ${msg}\n`);
}

function debug(msg) {
  if (_verbose) log(msg);
}

// ----------------------------------------------------------------------------
// 深度工具
// ----------------------------------------------------------------------------

/**
 * 深拷贝（结构化克隆语义，覆盖 JSON 可表达的类型）。
 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * 递归冻结对象。
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

/**
 * 在 target 上递归合并 source（source 覆盖 target，数组整体替换）。
 * 用于 secrets 覆盖配置：secrets 中的字段优先。
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (
      sv !== null &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === 'object' &&
      !Array.isArray(tv)
    ) {
      deepMerge(tv, sv);
    } else {
      target[key] = deepClone(sv);
    }
  }
  return target;
}

// ----------------------------------------------------------------------------
// 文件读取
// ----------------------------------------------------------------------------

function safeReadJSON(filePath) {
  if (!filePath) return null;
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function safeStatMtime(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// 环境变量覆盖
// ----------------------------------------------------------------------------

/**
 * 将下划线分隔的环境变量名转换为点路径。
 * SR_SERVER_PORT => server.port
 * SR_ROUTING_MAX_CONCURRENT => routing.max_concurrent
 * 注意：键名本身含下划线（如 max_concurrent）会被原样保留为对象键。
 *
 * 采用「贪婪匹配已知前缀」策略：我们扫描配置对象的键，按环境变量分段
 * 进行大小写不敏感匹配，避免把 max_concurrent 误拆成 max / concurrent。
 */
function applyEnvOverrides(config) {
  const envKeys = Object.keys(process.env).filter(
    (k) => k.startsWith(ENV_PREFIX) && k.length > ENV_PREFIX.length
  );
  if (envKeys.length === 0) return config;

  for (const envKey of envKeys) {
    const rawValue = process.env[envKey];
    const path = envKeyToPath(envKey);
    if (!path) continue;
    const parsed = coerceEnvValue(rawValue);
    if (parsed === undefined) continue;
    setByPath(config, path, parsed);
    debug(`env override: ${envKey} -> ${path.join('.')} = ${JSON.stringify(parsed)}`);
  }
  return config;
}

/**
 * 环境变量名 -> 配置路径段数组。
 * SR_SERVER_PORT => ['server','port']
 *
 * 采用最长前缀匹配：从配置根出发，逐段尝试在当前层级的键集合中
 * 大小写不敏感地匹配「下一段」。若无法匹配则跳过该环境变量。
 */
function envKeyToPath(envKey) {
  const stripped = envKey.slice(ENV_PREFIX.length); // SERVER_PORT
  // 把每一段切出来（按下划线），但需与配置键对齐
  const tokens = stripped.split('_').filter(Boolean); // ['SERVER','PORT']
  // 我们不知道配置键边界，所以采用「贪心匹配」：
  // 从根配置对象的键出发，依次尝试 1..n 个 token 拼成一段键去匹配。
  return matchPath(_configTemplate, tokens);
}

function matchPath(node, tokens) {
  const path = [];
  let current = node;
  let i = 0;
  while (i < tokens.length) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      // 无法继续深入，剩余 tokens 作为叶子键
      const leaf = tokens.slice(i).join('_').toLowerCase();
      path.push(leaf);
      return path;
    }
    const keys = Object.keys(current);
    let matched = null;
    let matchedLen = 0;
    // 尝试从长到短拼接 token，找到第一个能匹配（大小写不敏感、下划线敏感）的键
    for (let len = tokens.length - i; len >= 1; len--) {
      const candidate = tokens.slice(i, i + len).join('_').toLowerCase();
      const hit = keys.find(
        (k) => k.toLowerCase().replace(/-/g, '_') === candidate
      );
      if (hit) {
        matched = hit;
        matchedLen = len;
        break;
      }
    }
    if (!matched) {
      // 剩余 token 作为叶子键（保留原样小写）
      const leaf = tokens.slice(i).join('_').toLowerCase();
      path.push(leaf);
      return path;
    }
    path.push(matched);
    current = current[matched];
    i += matchedLen;
  }
  return path.length ? path : null;
}

function coerceEnvValue(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw);
  if (s === '') return '';
  // 布尔
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  // 数字
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  // JSON 数组/对象
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // 退化为字符串
    }
  }
  return s; // 字符串
}

function setByPath(obj, path, value) {
  let node = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (node[seg] === null || typeof node[seg] !== 'object') {
      node[seg] = {};
    }
    node = node[seg];
  }
  node[path[path.length - 1]] = value;
}

// 用于环境变量匹配时的「配置键模板」。
// 由于真实配置尚未加载，我们用一个空对象作为占位；
// 实际匹配在第一次加载后会使用真实配置重跑一次（见 loadConfig 中的二次应用）。
let _configTemplate = {};

// ----------------------------------------------------------------------------
// secrets 文件覆盖
// ----------------------------------------------------------------------------

/**
 * 推断 secrets 文件路径：与配置文件同目录下，按优先级查找：
 *   config/secrets.local.json
 *   config/local.<name>.json
 *   <name>.secrets.json（同目录）
 * 这些文件被 .gitignore 忽略，仅本地存在。
 */
function resolveSecretsPath(configPath) {
  if (!configPath) return null;
  const dir = dirname(configPath);
  const base = configPath.replace(extname(configPath), '');
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

// ----------------------------------------------------------------------------
// 公共 API
// ----------------------------------------------------------------------------

/**
 * 加载配置。
 *
 * 解析顺序（后者覆盖前者）：
 *   1. 主配置 JSON 文件
 *   2. secrets 本地文件（若存在，深度合并覆盖）
 *   3. 环境变量（SR_ 前缀，最后生效，优先级最高）
 *
 * @param {string} [configPath] 配置文件路径，默认 config/config.json（相对 cwd）
 * @param {object} [options]
 * @param {string} [options.secretsPath] 显式指定 secrets 文件路径
 * @param {boolean} [options.validate=true] 是否在加载后调用验证器（若可用）
 * @param {(cfg: object)=>{valid:boolean,errors:string[],warnings:string[]}} [options.validateConfig]
 *        注入的验证器函数（来自 validator.js）。传入则在加载时校验，校验失败抛错。
 * @returns {object} 已冻结的配置对象
 */
export function loadConfig(configPath, options = {}) {
  const path = configPath
    ? resolve(configPath)
    : resolve(process.cwd(), 'config', 'config.json');

  _configPath = path;
  _secretsPath = options.secretsPath ? resolve(options.secretsPath) : resolveSecretsPath(path);

  log(`loading config from ${path}`);

  const base = safeReadJSON(path);
  if (base === null) {
    throw new Error(`[loader] config file not found or invalid JSON: ${path}`);
  }

  // 先以基础配置作为模板，使环境变量匹配能命中真实键名
  _configTemplate = deepClone(base);

  // 合并：base -> secrets -> env
  const merged = deepClone(base);

  if (_secretsPath) {
    log(`merging secrets from ${_secretsPath}`);
    const secrets = safeReadJSON(_secretsPath);
    if (secrets && typeof secrets === 'object') {
      deepMerge(merged, secrets);
      // secrets 可能引入新键，刷新模板
      _configTemplate = deepClone(merged);
    }
  }

  // 环境变量覆盖（最高优先级）
  applyEnvOverrides(merged);

  // SMART_ROUTER_DATA_DIR（用户指定的数据目录环境变量，优先于配置 server.data_dir）
  if (process.env.SMART_ROUTER_DATA_DIR) {
    if (!merged.server) merged.server = {};
    merged.server.data_dir = process.env.SMART_ROUTER_DATA_DIR;
  }
  _configTemplate = deepClone(merged);

  // 记录 mtime 用于热重载
  _configMtime = safeStatMtime(path);
  _secretsMtime = safeStatMtime(_secretsPath);

  // 可选验证：通过 options.validateConfig 注入验证器函数，避免与 validator.js
  // 形成静态循环依赖。默认不自动验证（由调用方决定是否校验）。
  if (options.validate !== false && typeof options.validateConfig === 'function') {
    const result = options.validateConfig(merged);
    if (result && result.valid === false) {
      const detail = (result.errors || []).join('; ');
      log(`validation failed: ${detail}`);
      throw new Error(`[loader] config validation failed: ${detail}`);
    }
    if (result && Array.isArray(result.warnings) && result.warnings.length > 0) {
      for (const w of result.warnings) log(`validation warning: ${w}`);
    }
  }

  _config = deepFreeze(merged);
  log(`config loaded (intelligence.mode=${_config?.intelligence?.mode ?? 'n/a'})`);
  return _config;
}

/**
 * 获取当前已加载的配置。若尚未加载则抛出错误。
 * @returns {object}
 */
export function getConfig() {
  if (_config === null) {
    throw new Error('[loader] config not loaded yet; call loadConfig() first');
  }
  return _config;
}

/**
 * 是否已加载配置。
 */
export function isLoaded() {
  return _config !== null;
}

/**
 * 热重载：重新从磁盘读取主配置 + secrets，并重新应用环境变量覆盖。
 * 若文件 mtime 未变化则跳过，返回 null。
 *
 * @returns {object|null} 新配置对象，或 null（无变化）
 */
export function reload() {
  if (!_configPath) {
    throw new Error('[loader] cannot reload: no config path recorded');
  }

  const newConfigMtime = safeStatMtime(_configPath);
  const newSecretsMtime = safeStatMtime(_secretsPath);

  const configChanged = newConfigMtime !== _configMtime;
  const secretsChanged = newSecretsMtime !== _secretsMtime;

  // 环境变量也可能变化，因此每次都重跑 env 覆盖；但仅在文件变化时重建对象。
  if (!configChanged && !secretsChanged) {
    // 仍重新应用 env 覆盖（env 可能在运行期被修改）
    const reEnv = deepClone(_config);
    applyEnvOverrides(reEnv);
    _config = deepFreeze(reEnv);
    return _config;
  }

  log('config file change detected, reloading...');
  return loadConfig(_configPath, { secretsPath: _secretsPath, validate: false });
}

/**
 * 启动基于轮询的热重载监视器。
 * @param {number} [intervalMs=5000] 轮询间隔
 * @param {(config: object|null)=>void} [onChange] 变更回调
 * @returns {NodeJS.Timeout} 定时器句柄（可用 clearInterval 停止）
 */
export function watchReload(intervalMs = 5000, onChange) {
  const handle = setInterval(() => {
    try {
      const before = _config;
      const next = reload();
      if (next && next !== before) {
        log('config reloaded successfully');
        if (typeof onChange === 'function') onChange(next);
      }
    } catch (err) {
      log(`reload failed: ${err.message}`);
    }
  }, intervalMs);
  // 不阻塞进程退出
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

/**
 * 重置模块状态（主要用于测试隔离）。
 */
export function _resetForTest() {
  _config = null;
  _configPath = null;
  _secretsPath = null;
  _configMtime = null;
  _secretsMtime = null;
  _configTemplate = {};
}

// 默认导出主要 API，便于 `import config from './loader.js'`
export default {
  loadConfig,
  getConfig,
  isLoaded,
  reload,
  watchReload,
  setVerbose,
  log,
};
