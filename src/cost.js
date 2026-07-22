/**
 * cost.mjs — v6 成本计算模块
 * Token → 金额换算，按日/模型/Provider统计
 */

const PRICING = {
  'DeepSeek-V3': { input: 2.0, output: 8.0 },
  'DeepSeek-V4-Flash': { input: 0.5, output: 1.5 },
  'DeepSeek-V4-Pro': { input: 3.0, output: 12.0 },
  'deepseek-v4-flash': { input: 0.5, output: 1.5 },
  'deepseek-v4-pro': { input: 3.0, output: 12.0 },
  'Qwen3-Coder': { input: 1.5, output: 6.0 },
  'Qwen3-Next': { input: 1.0, output: 4.0 },
  'Qwen3-235B': { input: 2.0, output: 8.0 },
  'Qwen3.5-397B': { input: 4.0, output: 16.0 },
  'Qwen3.5-35B': { input: 1.0, output: 3.0 },
  'Qwen3.6-35B': { input: 1.0, output: 3.0 },
  'Qwen3-30B': { input: 0.5, output: 2.0 },
  'Qwen3-32B': { input: 1.0, output: 4.0 },
  'Qwen3.7-plus': { input: 2.0, output: 8.0 },
  'Qwen3.7-max': { input: 6.0, output: 24.0 },
  'Qwen3-VL': { input: 3.0, output: 12.0 },
  'Kimi-K2': { input: 2.0, output: 8.0 },
  'kimi-k2': { input: 2.0, output: 8.0 },
  'glm-5.2': { input: 10.0, output: 10.0 },
  'glm-5.1': { input: 4.0, output: 4.0 },
  'glm-4.7': { input: 1.5, output: 1.5 },
  'glm-4.6': { input: 0.5, output: 0.5 },
  'doubao-seed-2-0-pro': { input: 2.0, output: 8.0 },
  'doubao-seed-2-0-code': { input: 1.0, output: 4.0 },
  'doubao-seed-2-0-lite': { input: 0.3, output: 1.2 },
  'doubao-seed-2-0-mini': { input: 0.1, output: 0.5 },
  'MiniMax-M3': { input: 1.0, output: 4.0 },
  'MiniMax-M2': { input: 0.5, output: 2.0 },
  'Mistral-Large': { input: 2.0, output: 6.0 },
  'mistral-medium': { input: 1.0, output: 3.0 },
  'Llama-4-Maverick': { input: 0.5, output: 1.5 },
  'InternVL': { input: 2.0, output: 8.0 },
  'nemotron': { input: 1.0, output: 4.0 },
  'hy3-preview': { input: 2.0, output: 8.0 },
  'LongCat': { input: 0, output: 0 },
  'agnes': { input: 0, output: 0 },
  'meta/llama': { input: 0.3, output: 1.0 },
};

const DEFAULT_PRICE = { input: 1.0, output: 4.0 };

export function getBeijingDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const FREE_PROVIDERS = new Set(['opencode-zen']);
export function isFreeModel(modelId, provider) {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();
  if (id.includes('free')) return true;
  if (provider && FREE_PROVIDERS.has(String(provider).toLowerCase())) return true;
  return false;
}

export function getModelPrice(modelId) {
  if (!modelId) return DEFAULT_PRICE;
  const id = modelId.toLowerCase();
  for (const [key, price] of Object.entries(PRICING)) {
    if (id.includes(key.toLowerCase())) return price;
  }
  return DEFAULT_PRICE;
}

export function calculateCost(modelId, tokensIn, tokensOut) {
  const price = getModelPrice(modelId);
  const ti = tokensIn || 0;
  const to = tokensOut || 0;
  const costRmb = (ti * price.input / 1_000_000) + (to * price.output / 1_000_000);
  return { costRmb, inputPrice: price.input, outputPrice: price.output };
}

export function recordCost(db, dbUpsertCost, modelId, provider, tokensIn, tokensOut, agent) {
  const today = getBeijingDate();
  const costRmb = isFreeModel(modelId, provider) ? 0 : calculateCost(modelId, tokensIn, tokensOut).costRmb;
  dbUpsertCost.run(today, modelId, provider || '', 1, tokensIn || 0, tokensOut || 0, costRmb, tokensIn || 0, tokensOut || 0, costRmb);
}

export function getCostOverview(db) {
  const today = getBeijingDate();
  const monthStart = today.slice(0, 7) + '-01';
  let todayRow, monthRow, totalRow;
  try {
    todayRow = db.prepare('SELECT COALESCE(SUM(cost_rmb),0) as cost, COALESCE(SUM(requests),0) as reqs, COALESCE(SUM(tokens_in),0) as ti, COALESCE(SUM(tokens_out),0) as tok FROM cost_daily WHERE date = ?').get(today);
  } catch (e) { console.error('[cost] today query failed:', e.message); todayRow = null; }
  try {
    monthRow = db.prepare('SELECT COALESCE(SUM(cost_rmb),0) as cost, COALESCE(SUM(requests),0) as reqs FROM cost_daily WHERE date >= ?').get(monthStart);
  } catch (e) { console.error('[cost] month query failed:', e.message); monthRow = null; }
  try {
    totalRow = db.prepare('SELECT COALESCE(SUM(cost_rmb),0) as cost, COALESCE(SUM(requests),0) as reqs FROM cost_daily').get();
  } catch (e) { console.error('[cost] total query failed:', e.message); totalRow = null; }
  return {
    today: { cost_rmb: +(todayRow?.cost || 0).toFixed(6), requests: todayRow?.reqs || 0, tokens_in: todayRow?.ti || 0, tokens_out: todayRow?.tok || 0 },
    this_month: { cost_rmb: +(monthRow?.cost || 0).toFixed(6), requests: monthRow?.reqs || 0 },
    total: { cost_rmb: +(totalRow?.cost || 0).toFixed(6), requests: totalRow?.reqs || 0 },
  };
}

export function getCostDaily(db, days = 30) {
  try {
    return db.prepare('SELECT date, model, provider, requests, tokens_in, tokens_out, ROUND(cost_rmb, 6) as cost_rmb FROM cost_daily ORDER BY date DESC, cost_rmb DESC LIMIT ?').all(days * 10);
  } catch (e) { console.error('[cost] getCostDaily failed:', e.message); return []; }
}

export function getCostByModel(db, days = 30) {
  try {
    const since = getBeijingDate(new Date(Date.now() - days * 86400000));
    return db.prepare('SELECT model, SUM(requests) as requests, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out, ROUND(SUM(cost_rmb), 6) as cost_rmb FROM cost_daily WHERE date >= ? GROUP BY model ORDER BY cost_rmb DESC').all(since);
  } catch (e) { console.error('[cost] getCostByModel failed:', e.message); return []; }
}
