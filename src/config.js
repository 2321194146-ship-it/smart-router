/**
 * config.js — Configuration loader
 * Loads from: .env file → environment variables → config.json
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env from project root
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  loadDotenv({ path: envPath });
}

// ── Defaults ──
const DEFAULTS = {
  port: 7878,
  host: '127.0.0.1',
  adminToken: '',
  configFile: join(ROOT, 'config', 'config.json'),
  dbPath: join(ROOT, 'data', 'smart-router.db'),
  cacheTtl: 300,
  logLevel: 'info',
};

let config = null;

/**
 * Load all configuration sources
 */
export function loadConfig() {
  const envPort = parseInt(process.env.PORT) || DEFAULTS.port;
  const envHost = process.env.HOST || DEFAULTS.host;
  const envToken = process.env.ADMIN_TOKEN || '';
  const configPath = process.env.CONFIG_FILE || DEFAULTS.configFile;
  const dbPath = process.env.DB_PATH || DEFAULTS.dbPath;

  // Ensure data directory exists
  const dataDir = dirname(dbPath);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Load config.json
  let fileConfig = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (e) {
      console.error(`[config] Failed to parse ${configPath}:`, e.message);
    }
  } else {
    console.warn(`[config] ${configPath} not found, using defaults`);
  }

  config = {
    port: envPort,
    host: envHost,
    adminToken: envToken || fileConfig.admin_token || '',
    configFile: configPath,
    dbPath: dbPath,
    cacheTtl: parseInt(process.env.CACHE_TTL) || fileConfig.routing?.cache_ttl || DEFAULTS.cacheTtl,
    logLevel: process.env.LOG_LEVEL || 'info',
    providers: fileConfig.providers || {},
    routing: {
      tierWeights: fileConfig.routing?.tier_weights || { 0: 40, 1: 45, 2: 20 },
      maxRetries: fileConfig.routing?.max_retries || 4,
      maxConcurrent: fileConfig.routing?.max_concurrent || 2,
      perModelTimeoutMs: fileConfig.routing?.per_model_timeout_ms || 20000,
      timeoutMs: fileConfig.routing?.timeout_ms || 120000,
      connectTimeoutMs: fileConfig.routing?.connect_timeout_ms || 5000,
      cooldownSeconds: fileConfig.routing?.cooldown_seconds || 30,
      failureThreshold: fileConfig.routing?.failure_threshold || 2,
      semanticCache: fileConfig.routing?.semantic_cache !== false,
      healthCheckInterval: fileConfig.routing?.health_check_interval || 30,
      rateLimit: fileConfig.routing?.rate_limit || {},
    },
    models: fileConfig.models || [],
    apiKeys: fileConfig.api_keys || [],
    agents: fileConfig.agents || [],
    mcpServers: fileConfig.mcp_servers || [],
    guardrails: fileConfig.guardrails || { enabled: true },
    circuitBreaker: fileConfig.routing?.circuit_breaker || {
      failure_threshold: 3,
      slow_call_threshold_ms: 5000,
      slow_call_ratio: 0.5,
      slow_call_window: 10,
      half_open_max_probes: 1,
      cooldown_base_ms: 30000,
    },
  };

  return config;
}

/**
 * Get current config (singleton)
 */
export function getConfig() {
  if (!config) return loadConfig();
  return config;
}

/**
 * Reload config from disk
 */
export function reloadConfig() {
  loadDotenv({ path: envPath, override: true });
  return loadConfig();
}

export default { loadConfig, getConfig, reloadConfig };
