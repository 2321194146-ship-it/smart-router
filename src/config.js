/**
 * config.js — Configuration loader
 * Loads from: .env file → environment variables → config.json
 * Separates raw config (file content) from normalized runtime config.
 */
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  loadDotenv({ path: envPath });
}

const DEFAULTS = {
  port: 7878,
  host: '127.0.0.1',
  adminToken: '',
  configFile: join(ROOT, 'config', 'config.json'),
  dbPath: join(ROOT, 'data', 'smart-router.db'),
  cacheTtl: 300,
  logLevel: 'info',
};

let rawConfig = null;
let runtimeConfig = null;

/**
 * Load raw config from config.json (no normalization)
 */
export function loadRawConfig() {
  const configPath = process.env.CONFIG_FILE || DEFAULTS.configFile;
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (e) {
      console.error(`[config] Failed to parse ${configPath}:`, e.message);
    }
  }
  return {};
}

/**
 * Normalize raw config → runtime config (camelCase, defaults, env overrides)
 */
export function normalizeConfig(raw) {
  const envPort = parseInt(process.env.PORT) || DEFAULTS.port;
  const envHost = process.env.HOST || DEFAULTS.host;
  const envToken = process.env.ADMIN_TOKEN || '';
  const configPath = process.env.CONFIG_FILE || DEFAULTS.configFile;
  const dbPath = process.env.DB_PATH || DEFAULTS.dbPath;

  const providers = raw.providers || {};
  for (const p of Object.values(providers)) {
    if (!p.api_type) p.api_type = 'openai';
    if (p.api_type !== 'openai' && p.api_type !== 'anthropic') {
      console.error(`[config] Provider "${p.display || 'unknown'}" has invalid api_type "${p.api_type}"`);
      p.enabled = false;
    }
  }

  return {
    port: envPort,
    host: envHost,
    adminToken: envToken || raw.admin_token || '',
    configFile: configPath,
    dbPath,
    cacheTtl: parseInt(process.env.CACHE_TTL) || raw.routing?.cache_ttl || DEFAULTS.cacheTtl,
    logLevel: process.env.LOG_LEVEL || 'info',
    providers,
    routing: {
      tierWeights: raw.routing?.tier_weights || { 0: 40, 1: 45, 2: 20 },
      maxRetries: raw.routing?.max_retries || 4,
      maxConcurrent: raw.routing?.max_concurrent || 2,
      perModelTimeoutMs: raw.routing?.per_model_timeout_ms || 20000,
      timeoutMs: raw.routing?.timeout_ms || 120000,
      connectTimeoutMs: raw.routing?.connect_timeout_ms || 5000,
      cooldownSeconds: raw.routing?.cooldown_seconds || 30,
      failureThreshold: raw.routing?.failure_threshold || 2,
      semanticCache: raw.routing?.semantic_cache !== false,
      healthCheckInterval: raw.routing?.health_check_interval || 30,
      rateLimit: raw.routing?.rate_limit || {},
    },
    models: raw.models || [],
    apiKeys: raw.api_keys || [],
    agents: raw.agents || [],
    mcpServers: raw.mcp_servers || [],
    guardrails: raw.guardrails || { enabled: true },
    roles: raw.roles || {},
    system_prompt: raw.system_prompt || '',
    provider_prompts: raw.provider_prompts || {},
    model_prompts: raw.model_prompts || {},
    disable_prompt_injection: raw.disable_prompt_injection === true,
    claude_code_mode: raw.claude_code_mode || 'claude-native',
    circuitBreaker: raw.routing?.circuit_breaker || {
      failure_threshold: 3,
      slow_call_threshold_ms: 5000,
      slow_call_ratio: 0.5,
      slow_call_window: 10,
      half_open_max_probes: 1,
      cooldown_base_ms: 30000,
    },
  };
}

/**
 * Load everything from scratch
 */
export function loadConfig() {
  const configPath = process.env.CONFIG_FILE || DEFAULTS.configFile;
  const dbPath = process.env.DB_PATH || DEFAULTS.dbPath;

  const dataDir = dirname(dbPath);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  rawConfig = loadRawConfig();
  runtimeConfig = normalizeConfig(rawConfig);
  return runtimeConfig;
}

/**
 * Get current runtime config
 */
export function getConfig() {
  if (!runtimeConfig) return loadConfig();
  return runtimeConfig;
}

/**
 * Reload config from disk
 */
export function reloadConfig() {
  loadDotenv({ path: envPath, override: true });
  return loadConfig();
}

/**
 * Save raw config to disk atomically (write to temp, then rename)
 */
export function saveRawConfigAtomic(newRawConfig) {
  const configPath = runtimeConfig?.configFile || process.env.CONFIG_FILE || DEFAULTS.configFile;
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(newRawConfig, null, 2), 'utf-8');
  renameSync(tmpPath, configPath);
  rawConfig = newRawConfig;
  runtimeConfig = normalizeConfig(newRawConfig);
}

export default { loadConfig, getConfig, reloadConfig, loadRawConfig, normalizeConfig, saveRawConfigAtomic };
