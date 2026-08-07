// scripts/real-daily-report.mjs
// 真实日常使用分析报告生成器（数据达标后运行）
// 门槛：Active 请求 ≥ 20 或 累计总请求 ≥ 300
// 用法：node scripts/real-daily-report.mjs [dataDir]
import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DATA_DIR = process.argv[2] || process.env.SMART_ROUTER_DATA_DIR || join(ROOT, 'data', 'canary');
const DB = join(DATA_DIR, 'smart-router.db');

if (!existsSync(DB)) {
  console.error('数据库不存在:', DB);
  process.exit(1);
}

const db = new DatabaseSync(DB, { readOnly: true });
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);

const total = one('SELECT COUNT(*) n FROM audit_records').n;
const active = one(`SELECT COUNT(*) n FROM shadow_decisions WHERE comparison_status='active'`).n || 0;
const eligible = one(`SELECT COUNT(*) n FROM shadow_decisions`).n || 0;

if (active < 20 && total < 300) {
  console.log(`[report] 数据未达门槛：active=${active}（需≥20）或 total=${total}（需≥300）`);
  console.log(`[report] 请正常使用 Claude Code 后再运行本脚本`);
  process.exit(0);
}

const byOutcome = all('SELECT outcome, COUNT(*) n FROM audit_records GROUP BY outcome');
const byType = all(`SELECT json_extract(task_profile,'$.taskType') t, COUNT(*) n FROM shadow_decisions GROUP BY t`);
const byModel = all('SELECT final_model, final_provider, COUNT(*) n FROM audit_records GROUP BY final_model, final_provider');
const attempts = all(`SELECT a.request_id, a.model, a.provider, a.error_type, a.first_byte_ms, a.latency_ms
  FROM attempts a JOIN audit_records r ON r.request_id=a.request_id WHERE r.outcome='completed'`);
const fallback = all(`SELECT COUNT(*) n FROM audit_records WHERE attempt_count > 1`).n;
const cost = one('SELECT SUM(json_extract(cost,"$.totalCost")) t, COUNT(*) n FROM cost_records');
const activeVsPhase1 = one(`SELECT json_extract(comparison_status,'$.activeVsPhase1') v FROM shadow_decisions LIMIT 1`);

const fb = attempts.filter(a => a.first_byte_ms);
const avgFb = fb.length ? (fb.reduce((s,a)=>s+(a.first_byte_ms||0),0)/fb.length).toFixed(0) : 'n/a';
const avgLat = attempts.length ? (attempts.reduce((s,a)=>s+(a.latency_ms||0),0)/attempts.length).toFixed(0) : 'n/a';

const L = [];
L.push('# REAL_DAILY_CANARY_REPORT');
L.push('');
L.push(`> 生成时间：${new Date().toISOString()} ｜ 数据目录：${DATA_DIR}`);
L.push('');
L.push('## 汇总');
L.push('');
L.push(`| 指标 | 值 |`);
L.push(`|---|---|`);
L.push(`| 总请求数 | ${total} |`);
L.push(`| 符合 Canary 资格（shadow_decisions） | ${eligible} |`);
L.push(`| Active（实际采样） | ${active} |`);
L.push(`| Fallback 请求数（attempt>1） | ${fallback} |`);
L.push(`| 平均首字节时间 (ms) | ${avgFb} |`);
L.push(`| 平均总延迟 (ms) | ${avgLat} |`);
L.push(`| 实际成本 (USD) | ${cost ? (cost.t || 0).toFixed(6) : 'n/a'} |`);
L.push('');
L.push('## Outcome 分布');
L.push('');
L.push('| outcome | 数量 |');
L.push('|---|---|');
for (const r of byOutcome) L.push(`| ${r.outcome} | ${r.n} |`);
L.push('');
L.push('## 任务类型分布');
L.push('');
L.push('| taskType | 数量 |');
L.push('|---|---|');
for (const r of byType) L.push(`| ${r.t || 'null'} | ${r.n} |`);
L.push('');
L.push('## 最终模型分布');
L.push('');
L.push('| model | provider | 数量 |');
L.push('|---|---|---|');
for (const r of byModel) L.push(`| ${r.final_model} | ${r.final_provider} | ${r.n} |`);
L.push('');
L.push('## 说明');
L.push('- 分类错误/推荐不合理案例需结合 shadow_decisions 的 explanation 与 requestId 人工复核后补充');
L.push('- 模型能力分/价格/健康数据准确性建议：继续观察 Provider 429 与失败率');
L.push('- 建议：数据不足 300 条前保持 5%，不扩大');

writeFileSync(join(ROOT, 'REAL_DAILY_CANARY_REPORT.md'), L.join('\n'));
console.log('[report] 已生成 REAL_DAILY_CANARY_REPORT.md');
db.close();
