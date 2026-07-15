/**
 * guard.mjs — v6 安全护栏模块
 * 输入检测：PII脱敏、敏感词过滤、Prompt Injection 拦截
 * 输出检测：PII泄露脱敏、违规内容后检
 */

// ═══════════ PII 正则 ═══════════
const PII_PATTERNS = [
  { name: 'phone', re: /1[3-9]\d{9}/g, label: '手机号', severity: 'high' },
  { name: 'id_card', re: /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, label: '身份证号', severity: 'high' },
  { name: 'bank_card', re: /(?:622|621|628|625|3568|4026|4175|5218|5282|5184|5408|6220)\d{12,15}/g, label: '银行卡号', severity: 'high' },
  { name: 'email', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: '邮箱', severity: 'medium' },
];

// ═══════════ 敏感关键词（输入拦截） ═══════════
const BLOCKED_INPUT_PATTERNS = [
  // Prompt Injection 攻击
  { re: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|messages?)/i, label: 'Prompt Injection: ignore', severity: 'high' },
  { re: /(you\s+are|act\s+as|pretend\s+to\s+be)\s+(DAN|STAN|jailbreak)/i, label: 'Prompt Injection: roleplay', severity: 'high' },
  { re: /do\s+(not|n't)\s+follow\s+(any|the)\s+(instructions?|rules?|guidelines?)/i, label: 'Prompt Injection: bypass', severity: 'high' },
  { re: /forget\s+(all\s+)?(your|the)\s+(training|instructions?|rules?|knowledge)/i, label: 'Prompt Injection: forget', severity: 'high' },
  { re: /system\s*:\s*override/i, label: 'Prompt Injection: override', severity: 'high' },
  { re: /\[system\]|\[hidden\]|\[developer\]/i, label: 'Prompt Injection: system tags', severity: 'medium' },
  { re: /you\s+are\s+now\s+(a\s+)?(different|new|another)\s+(AI|model|bot|assistant)/i, label: 'Prompt Injection: identity', severity: 'medium' },

  // 涉政敏感词
  { re: /(六四|天安门|法轮功|达赖|藏独|疆独|台独|港独)/, label: '涉政敏感词', severity: 'critical' },
  { re: /颠覆(国家|政权|政府)/, label: '涉政敏感词', severity: 'critical' },
  { re: /(暴力|武装)\s*(革命|政变|推翻)/, label: '涉政敏感词', severity: 'critical' },

  // 色情暴力
  { re: /(儿童|未成年).*(色情|淫秽|裸照|侵犯)/, label: '违法内容', severity: 'critical' },
  { re: /(制作|制造)\s*(炸弹|炸药|武器|毒品)/, label: '违法内容', severity: 'critical' },
];

// ═══════════ 输出敏感词 ═══════════
const BLOCKED_OUTPUT_PATTERNS = [
  { re: /(六四|天安门|法轮功|达赖|藏独|疆独)/, label: '涉政输出', severity: 'critical' },
];

// ═══════════ 主检测函数 ═══════════

/**
 * 检测输入内容，返回拦截结果
 * @param {string} text - 用户输入文本
 * @returns {{ blocked: boolean, rules: Array, sanitizedText?: string }}
 */
export function checkInput(text) {
  if (!text || typeof text !== 'string') return { blocked: false, rules: [] };

  const results = [];
  let sanitized = text;

  // 1. 检查敏感关键词
  for (const rule of BLOCKED_INPUT_PATTERNS) {
    if (rule.re.test(text)) {
      results.push({ rule: rule.label, severity: rule.severity, action: 'block' });
    }
  }

  // 2. 检查 PII 并脱敏
  for (const pii of PII_PATTERNS) {
    const matches = sanitized.match(pii.re);
    if (matches) {
      for (const m of matches) {
        // 检查是否是合法场景（如代码中的假号码）
        if (_isLikelyCodeContext(sanitized, m)) continue;
        const masked = m.slice(0, 3) + '***' + m.slice(-3);
        sanitized = sanitized.replace(m, masked);
        results.push({ rule: `PII: ${pii.label}`, severity: pii.severity, action: 'mask', snippet: m.slice(0, 4) + '***' });
      }
    }
  }

  // critical 级别 → blocked
  const blocked = results.some(r => r.severity === 'critical');
  return {
    blocked,
    rules: results,
    sanitizedText: sanitized !== text ? sanitized : undefined,
  };
}

/**
 * 检测输出内容，过滤违规
 * @param {string} text - 模型输出文本
 * @returns {{ filtered: boolean, rules: Array, cleanText: string }}
 */
export function checkOutput(text) {
  if (!text || typeof text !== 'string') return { filtered: false, rules: [], cleanText: text || '' };

  const results = [];
  let clean = text;

  // 1. 检查违规关键词
  for (const rule of BLOCKED_OUTPUT_PATTERNS) {
    if (rule.re.test(text)) {
      clean = clean.replace(rule.re, () => {
        results.push({ rule: rule.label, severity: rule.severity, action: 'filter' });
        return '[内容已过滤]';
      });
    }
  }

  // 2. PII 泄露脱敏
  for (const pii of PII_PATTERNS) {
    const matches = clean.match(pii.re);
    if (matches) {
      for (const m of matches) {
        if (_isLikelyCodeContext(clean, m)) continue;
        const masked = m.slice(0, 3) + '***' + m.slice(-3);
        clean = clean.replace(m, masked);
        results.push({ rule: `PII泄露: ${pii.label}`, severity: pii.severity, action: 'mask' });
      }
    }
  }

  const filtered = results.some(r => r.severity === 'critical');
  return { filtered, rules: results, cleanText: clean };
}

/**
 * 判断一段文本是否像代码上下文（避免脱敏代码中的假数据）
 */
function _isLikelyCodeContext(text, match) {
  const idx = text.indexOf(match);
  if (idx < 0) return false;
  const context = text.slice(Math.max(0, idx - 100), idx);
  // 代码上下文特征
  const codePatterns = [
    /["'`]\s*(phone|mobile|tel|手机|电话)/i,
    /["'`]\s*\d+/,
    /const\s+|let\s+|var\s+|String\s|int\s+|str\s*[=:]|phoneNum|mobileNum/,
    /```|function\s|class\s|import\s/,
    /\d{4}-\d{2}-\d{2}/, // 日期
    /test.*data|mock|fake|example|sample/i,
  ];
  return codePatterns.some(p => p.test(context));
}

/**
 * 记录护栏拦截日志到 SQLite
 */
export function logGuardrail(db, dbLogGuardrail, direction, rule, severity, ip, snippet, action, agent) {
  try {
    dbLogGuardrail.run(Date.now() / 1000, direction, rule, severity || 'medium', ip || '', (snippet || '').slice(0, 200), action || 'block', agent || '');
  } catch {}
}

/**
 * 查询护栏日志
 */
export function getGuardrailLogs(db, limit = 50) {
  try {
    return db.prepare('SELECT * FROM guardrail_logs ORDER BY id DESC LIMIT ?').all(limit);
  } catch { return []; }
}
