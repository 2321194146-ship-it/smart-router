/* Smart Router v6 — 控制台前端 (SPA · 可配置 · 离线可用)
 * 左菜单导航 + 概览监控 + 供应商/模型/密钥/路由/系统 配置写接口
 */
(function () {
  'use strict';

  const API = '';
  const REFRESH_MS = 8000;
  const TREND_DAYS = 14;

  let TOKEN = (window.lijie0821 || '') + '';
  try { const t = localStorage.getItem('sr_token'); if (t) TOKEN = t; } catch (e) {}
  const authHeaders = () => { const h = { 'Accept': 'application/json', 'Content-Type': 'application/json' }; if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN; return h; };

  const charts = {};
  let refreshTimer = null;
  let currentView = 'overview';

  /* ---------- 工具 ---------- */
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function fmtNum(n) { if (n == null || isNaN(n)) return '—'; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(Math.round(n)); }
  function fmtTok(n) { if (n == null || isNaN(n)) return '—'; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(Math.round(n)); }
  function fmtMs(n) { if (n == null || isNaN(n)) return '—'; return n >= 1000 ? (n / 1000).toFixed(2) + 's' : Math.round(n) + 'ms'; }
  function fmtPct(n, d) { return (n == null || isNaN(n)) ? '—' : (n).toFixed(d == null ? 1 : d) + '%'; }
  function fmtMoney(n) { return '¥' + (n == null || isNaN(n) ? '0.00' : Number(n).toFixed(2)); }
  function fmtUptime(s) { if (!s || s < 0) return '—'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); if (d > 0) return d + '天' + h + '时'; if (h > 0) return h + '时' + m + '分'; return m + '分'; }

  /* ---------- 网络 ---------- */
  async function api(path, opts) {
    opts = opts || {};
    const r = await fetch(API + path, { method: opts.method || 'GET', headers: authHeaders(), body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
    if (r.status === 401) throw Object.assign(new Error('unauthorized'), { code: 401 });
    if (!r.ok) { let msg = 'HTTP ' + r.status; try { const j = await r.json(); if (j && j.message) msg = j.message; } catch (e) {} throw new Error(msg); }
    const ct = r.headers.get('content-type') || '';
    return ct.indexOf('application/json') >= 0 ? r.json() : r.text();
  }

  /* ---------- Toast ---------- */
  function toast(msg, kind) {
    const wrap = $('toast-wrap'); if (!wrap) return;
    const t = el('div', 'toast ' + (kind || 'ok'), '<span class="ti">' + (kind === 'err' ? '⚠️' : '✅') + '</span><span>' + esc(msg) + '</span>');
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 2800);
  }

  /* ---------- 令牌门 ---------- */
  function showTokenGate() { const g = $('token-gate'); if (g) g.style.display = 'flex'; const b = $('auth-banner'); if (b) b.style.display = 'block'; }
  function hideTokenGate() { const g = $('token-gate'); if (g) g.style.display = 'none'; const b = $('auth-banner'); if (b) b.style.display = 'none'; }
  function bindTokenGate() {
    const btn = $('token-save'); if (!btn) return;
    btn.addEventListener('click', () => {
      const v = $('token-input') && $('token-input').value.trim();
      if (!v) return;
      TOKEN = v; try { localStorage.setItem('sr_token', v); } catch (e) {}
      hideTokenGate(); start();
    });
  }

  /* ---------- 模态 ---------- */
  function openModal(html) { const box = $('modal-box'); if (box) box.innerHTML = html; const m = $('modal-mask'); if (m) m.classList.add('show'); }
  function closeModal() { const m = $('modal-mask'); if (m) m.classList.remove('show'); }
  document.addEventListener('click', (e) => { if (e.target && e.target.id === 'modal-mask') closeModal(); });

  /* ================= 概览 ================= */
  function initCharts() {
    if (!window.echarts) return;
    const mk = (id) => { const c = echarts.init($(id), null, { renderer: 'canvas' }); charts[id] = c; return c; };
    mk('chart-trend'); mk('chart-status'); mk('chart-topmodels'); /* chart-topo 改为懒初始化：进入拓扑视图、容器已显示后才 echarts.init，避免隐藏容器宽高为0导致白屏 */
    window.addEventListener('resize', () => { Object.values(charts).forEach(c => c.resize()); });
  }
  const AXIS = '#7c8aa5', SPLIT = 'rgba(255,255,255,0.06)', TXT = '#c7d2e0';
  function baseGrid() { return { left: 48, right: 18, top: 28, bottom: 30 }; }

  function renderTrend(trend) {
    const c = charts['chart-trend']; if (!c) return;
    const buckets = (trend || []).map(d => (d.bucket || '').slice(5));
    const reqs = (trend || []).map(d => d.requests || 0);
    const lats = (trend || []).map(d => d.avg_lat ? Math.round(d.avg_lat / 100) / 10 : null);
    c.setOption({
      backgroundColor: 'transparent', grid: baseGrid(),
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,20,32,0.95)', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: TXT } },
      legend: { data: ['请求量', '平均延迟(s)'], textStyle: { color: AXIS }, right: 10, top: 0 },
      xAxis: { type: 'category', data: buckets, axisLine: { lineStyle: { color: SPLIT } }, axisLabel: { color: AXIS, fontSize: 10, interval: Math.ceil(buckets.length / 10) } },
      yAxis: [{ type: 'value', splitLine: { lineStyle: { color: SPLIT } }, axisLabel: { color: AXIS, fontSize: 10 } },
      { type: 'value', splitLine: { show: false }, axisLabel: { color: '#22d3ee', fontSize: 10, formatter: '{value}s' } }],
      series: [
        { name: '请求量', type: 'bar', data: reqs, barWidth: '55%', itemStyle: { borderRadius: [3, 3, 0, 0], color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(99,102,241,0.85)' }, { offset: 1, color: 'rgba(99,102,241,0.12)' }]) } },
        { name: '平均延迟(s)', type: 'line', yAxisIndex: 1, data: lats, smooth: true, symbol: 'none', lineStyle: { color: '#22d3ee', width: 2 }, areaStyle: { color: 'rgba(34,211,238,0.08)' } }
      ]
    });
  }
  function renderStatus(dist) {
    const c = charts['chart-status']; if (!c) return;
    let ok = 0, client = 0, server = 0, other = 0;
    (dist || []).forEach(d => { const s = Number(d.status), n = d.count || 0; if (s >= 200 && s < 300) ok += n; else if (s >= 400 && s < 500) client += n; else if (s >= 500) server += n; else other += n; });
    const total = ok + client + server + other || 1; const eff = (ok / total * 100);
    c.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', backgroundColor: 'rgba(15,20,32,0.95)', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: TXT }, formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { color: AXIS, fontSize: 11 }, icon: 'circle' },
      series: [{ type: 'pie', radius: ['58%', '82%'], center: ['50%', '44%'], avoidLabelOverlap: false, itemStyle: { borderColor: 'rgba(10,14,23,0.9)', borderWidth: 3 },
        label: { show: true, position: 'center', formatter: () => '{v|' + eff.toFixed(1) + '%}\n{l|实效成功率}', rich: { v: { fontSize: 26, fontWeight: 700, color: eff >= 95 ? '#34d399' : eff >= 80 ? '#fbbf24' : '#fb7185' }, l: { fontSize: 11, color: AXIS, padding: [4, 0, 0, 0] } } }, labelLine: { show: false },
        data: [{ value: ok, name: '2xx 成功', itemStyle: { color: '#34d399' } }, { value: client, name: '4xx 客户端', itemStyle: { color: '#fbbf24' } }, { value: server, name: '5xx 服务端', itemStyle: { color: '#fb7185' } }, { value: other, name: '其他', itemStyle: { color: '#64748b' } }] }]
    });
  }
  function renderTopModels(list) {
    const c = charts['chart-topmodels']; if (!c) return;
    const top = (list || []).slice(0, 10).reverse();
    const names = top.map(d => (d.model || '').split('|').pop());
    const vals = top.map(d => d.requests || 0);
    c.setOption({
      backgroundColor: 'transparent', grid: { left: 8, right: 56, top: 10, bottom: 10, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(15,20,32,0.95)', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: TXT } },
      xAxis: { type: 'value', splitLine: { lineStyle: { color: SPLIT } }, axisLabel: { color: AXIS, fontSize: 10 } },
      yAxis: { type: 'category', data: names, axisLine: { lineStyle: { color: SPLIT } }, axisLabel: { color: TXT, fontSize: 11 } },
      series: [{ type: 'bar', data: vals, barWidth: '62%', itemStyle: { borderRadius: [0, 4, 4, 0], color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: 'rgba(34,211,238,0.25)' }, { offset: 1, color: '#22d3ee' }]) }, label: { show: true, position: 'right', color: AXIS, fontSize: 10, formatter: (p) => fmtNum(p.value) } }]
    });
  }
  function setKpi(id, value, sub, tone) { const card = $(id); if (!card) return; card.querySelector('.kpi-value').textContent = value; const s = card.querySelector('.kpi-sub'); if (s) s.textContent = sub || ''; card.className = 'kpi-card' + (tone ? ' tone-' + tone : ''); }
  function renderKpis(ov, health, cost) {
    const o = ov || {};
    setKpi('kpi-requests', fmtNum(o.total_requests), '累计总请求', null);
    const sr = o.success_rate; setKpi('kpi-success', fmtPct(sr), '首轮直连成功率', sr >= 90 ? 'good' : sr >= 70 ? 'warn' : 'bad');
    setKpi('kpi-latency', fmtMs(o.avg_latency_ms), '平均延迟', o.avg_latency_ms < 5000 ? 'good' : o.avg_latency_ms < 10000 ? 'warn' : 'bad');
    setKpi('kpi-models', String(o.pool_size || 0), '模型池规模', null);
    const ph = (health && health.providers_healthy) || 0; const pt = (health && health.providers_degraded) ? ph + health.providers_degraded.length : ph;
    setKpi('kpi-providers', ph + '/' + pt, '健康供应商', ph >= pt ? 'good' : 'warn');
    setKpi('kpi-tokens', fmtTok((o.total_tokens_in || 0) + (o.total_tokens_out || 0)), 'Token 累计', null);
    const today = (cost && cost.overview && cost.overview.today) || {}; setKpi('kpi-cost', fmtMoney(today.cost_rmb), '今日成本', null);
    const up = o.upstream_healthy; setKpi('kpi-upstream', up ? '健康' : '降级', '兜底上游', up ? 'good' : 'bad');
  }
  function renderProvidersLight(list, provHealth) {
    const wrap = $('ov-providers'); if (!wrap) return; wrap.innerHTML = '';
    const l = list || []; if (!l.length) { wrap.appendChild(el('div', 'empty', '暂无供应商数据')); return; }
    l.forEach(p => {
      const degraded = (provHealth && provHealth[p.name] && provHealth[p.name].degraded);
      const succ = p.requests ? (p.success / p.requests * 100) : 0;
      const card = el('div', 'prov-card' + (p.healthy ? '' : ' down') + (degraded ? ' degraded' : ''));
      card.innerHTML = '<div class="prov-head"><span class="dot ' + (p.healthy ? 'green' : 'red') + '"></span><span class="prov-name">' + esc(p.display || p.name) + '</span>' + (p.cool_remain ? '<span class="prov-cool">冷却' + p.cool_remain + 's</span>' : '') + '</div>' +
        '<div class="prov-metrics"><div><span class="m-val">' + fmtNum(p.requests) + '</span><span class="m-lab">请求</span></div><div><span class="m-val">' + fmtPct(succ, 0) + '</span><span class="m-lab">成功</span></div><div><span class="m-val">' + (p.models || 0) + '</span><span class="m-lab">模型</span></div></div>';
      wrap.appendChild(card);
    });
  }
  function renderModelPool(models) {
    const wrap = $('ov-modelpool'); if (!wrap) return; wrap.innerHTML = '';
    const caps = {}; (models || []).forEach(m => { const c = m.capability || 'other'; caps[c] = (caps[c] || 0) + 1; });
    const order = ['coding', 'general', 'reasoning', 'vision', 'fast']; const labels = { coding: '代码', general: '通用', reasoning: '推理', vision: '视觉', fast: '高速', other: '其他' };
    const max = Math.max(1, ...Object.values(caps));
    order.concat(Object.keys(caps).filter(c => !order.includes(c))).forEach(c => { const n = caps[c] || 0; if (!n) return; const row = el('div', 'mp-row'); row.innerHTML = '<span class="mp-lab">' + (labels[c] || c) + '</span><span class="mp-bar"><i style="width:' + (n / max * 100) + '%"></i></span><span class="mp-num">' + n + '</span>'; wrap.appendChild(row); });
  }
  function renderLatency(lat) { if (!lat) return; const set = (id, v) => { const e = $(id); if (e) e.textContent = v; }; set('lat-p50', fmtMs(lat.p50)); set('lat-p90', fmtMs(lat.p90)); set('lat-p99', fmtMs(lat.p99)); set('lat-max', fmtMs(lat.max)); }
  function renderCircuit(cb) { const s = (cb && cb.summary) || {}; const set = (id, v) => { const e = $(id); if (e) e.textContent = v; }; set('cb-total', s.total || 0); set('cb-open', s.open || 0); set('cb-half', s.half_open || 0); set('cb-closed', s.closed || 0); }
  function renderAgents(ov) {
    const wrap = $('ov-agents'); if (!wrap) return; wrap.innerHTML = '';
    const agents = (ov && ov.agents) || []; if (!agents.length) { wrap.appendChild(el('div', 'empty', '未接入 Agent')); return; }
    agents.forEach(a => { const online = a.status === 'running'; const card = el('div', 'agent-card' + (online ? '' : ' off')); const kindBadge = a.kind === 'fleet' ? '<span class="badge cy" style="margin-left:4px">舰队</span>' : '<span class="badge misc" style="margin-left:4px">来源</span>'; card.innerHTML = '<div class="agent-top"><span class="agent-emoji">' + esc(a.emoji || '🤖') + '</span><span class="agent-name">' + esc(a.label || a.name) + '</span>' + kindBadge + '<span class="dot ' + (online ? 'green' : 'grey') + '"></span></div><div class="agent-sys">' + esc(a.system || '') + '</div><div class="agent-meta"><span>绑定 ' + (a.skillCount || 0) + ' 模型</span><span>' + (online ? '在线' : '离线') + '</span></div>'; wrap.appendChild(card); });
    const sum = (ov && ov.summary) || {}; const e = $('agents-summary'); if (e) e.textContent = (sum.onlineCount || 0) + ' 在线 / ' + (sum.totalMainAgents || 0) + ' 个 Agent';
  }
  function renderRecent(logs) {
    const tb = $('ov-recent'); if (!tb) return; tb.innerHTML = '';
    const list = (logs && logs.recent) || []; if (!list.length) { tb.appendChild(el('tr', '', '<td colspan="6" class="empty">暂无请求</td>')); return; }
    list.forEach(r => { const st = r.status || 0; const tone = st >= 200 && st < 300 ? 'ok' : st >= 400 && st < 500 ? 'warn' : st >= 500 ? 'err' : 'misc'; const tr = el('tr'); const t = new Date((r.timestamp || 0) * 1000); const ts = isNaN(t) ? '—' : t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); const who = r.agent_label || r.agent || '未标注'; tr.innerHTML = '<td class="t-ts">' + ts + '</td><td><span class="badge ' + tone + '">' + st + '</span></td><td title="' + esc(r.model) + '">' + esc((r.model || '').split('|').pop()) + '</td><td>' + esc(r.provider || '') + '</td><td>' + fmtMs(r.latency_ms) + '</td><td title="' + esc(r.agent) + '">' + esc(who) + '</td>'; tb.appendChild(tr); });
  }
  async function reloadRecent() {
    const sel = $('recent-agent'); const agent = sel ? sel.value : '';
    const url = '/api/recent?limit=12' + (agent ? '&agent=' + encodeURIComponent(agent) : '');
    try { const d = await api(url, { auth: 1 }); if (d && d.recent) renderRecent(d); } catch (e) { if (e.code === 401) showTokenGate(); }
  }
  function populateAgentFilter(agents, keep) {
    const sel = $('recent-agent'); if (!sel) return;
    const cur = keep !== undefined ? keep : sel.value;
    const opts = ['<option value="">全部来源</option>'].concat((agents || []).map(a => '<option value="' + esc(a.name) + '">' + esc(a.label || a.name) + '</option>'));
    sel.innerHTML = opts.join('');
    if (cur) sel.value = cur;
  }

  async function refreshOverview() {
    const raf = ($('recent-agent') && $('recent-agent').value) || '';
    const [healthR, statsR, provR, costR, trendR, errR, latR, cbR, agentsR, recentR, modelsR] = await Promise.allSettled([
      api('/health'), api('/stats', { auth: 1 }), api('/api/providers', { auth: 1 }), api('/api/cost', { auth: 1 }),
      api('/api/stats/trend?days=' + TREND_DAYS, { auth: 1 }), api('/api/stats/errors?days=1', { auth: 1 }),
      api('/api/stats/latency?days=1', { auth: 1 }), api('/api/circuit-breaker/status', { auth: 1 }),
      api('/api/agents-overview', { auth: 1 }), api('/api/recent?limit=12' + (raf ? '&agent=' + encodeURIComponent(raf) : ''), { auth: 1 }), api('/api/models', { auth: 1 })
    ]);
    const health = healthR.status === 'fulfilled' ? healthR.value : null;
    const stats = statsR.status === 'fulfilled' ? statsR.value : null;
    const overview = (stats && stats.overview) || {}; if (health) { overview.success_rate = health.success_rate; overview.pool_size = health.models_available; overview.upstream_healthy = health.upstream_healthy; }
    renderKpis(overview, health, costR.status === 'fulfilled' ? costR.value : null);
    if (provR.status === 'fulfilled') renderProvidersLight(provR.value, (stats && stats.provider_health) || null);
    if (trendR.status === 'fulfilled') renderTrend(trendR.value.trend);
    if (errR.status === 'fulfilled') renderStatus(errR.value.status_dist);
    if (costR.status === 'fulfilled') renderTopModels(costR.value.top_models);
    if (latR.status === 'fulfilled') renderLatency(latR.value);
    if (cbR.status === 'fulfilled') renderCircuit(cbR.value);
    if (agentsR.status === 'fulfilled') { renderAgents(agentsR.value); populateAgentFilter(agentsR.value.agents, raf); }
    if (recentR.status === 'fulfilled') renderRecent(recentR.value);
    if (modelsR.status === 'fulfilled') renderModelPool(modelsR.value.models);
    if ($('nav-live')) $('nav-live').style.display = health ? 'inline-block' : 'none';
    if ($('sb-status')) $('sb-status').textContent = health ? '运行中' : '异常';
    if ($('sb-uptime')) $('sb-uptime').textContent = '运行时长 ' + fmtUptime((health && health.uptime_seconds) || 0);
    if (health) { if ($('sys-version')) $('sys-version').textContent = health.version || 'v6'; }
    const need = [healthR, statsR, provR, costR, trendR, errR, latR, cbR, agentsR, recentR, modelsR].some(r => r.status === 'rejected' && r.reason && r.reason.code === 401);
    if (need) showTokenGate(); else hideTokenGate();
    const u = $('updated'); if (u) u.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
  }

  /* ================= 供应商 ================= */
  async function loadProviders() {
    let cfg, provs;
    try { cfg = await api('/api/config', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); toast('读取配置失败: ' + e.message, 'err'); return; }
    try { provs = await api('/api/providers', { auth: 1 }); } catch (e) { provs = []; }
    const provMap = {}; (provs || []).forEach(p => provMap[p.name] = p);
    const wrap = $('prov-grid'); if (!wrap) return; wrap.innerHTML = '';
    const entries = Object.entries((cfg && cfg.providers) || {});
    if ($('prov-count')) $('prov-count').textContent = entries.length + ' 个端点';
    if (!entries.length) { wrap.appendChild(el('div', 'empty', '暂无端点，使用上方表单添加')); return; }
    entries.forEach(([name, p]) => {
      const stat = provMap[name]; const healthy = stat ? stat.healthy : (p.enabled !== false);
      const card = el('div', 'prov-card' + (healthy ? '' : ' down'));
      card.innerHTML =
        '<div class="prov-head"><span class="dot ' + (healthy ? 'green' : 'red') + '"></span><span class="prov-name">' + esc(p.display || name) + '</span></div>' +
        '<div style="font-size:11px;color:var(--muted);word-break:break-all;margin-bottom:6px">' + esc(p.base_url || '—') + '</div>' +
        '<div style="font-size:11px;color:var(--dim);margin-bottom:10px">请求 ' + fmtNum(stat ? stat.requests : 0) + ' · Key ' + (p.api_key ? '已设' : '空') + '</div>' +
        '<div class="prov-actions">' +
        '<label class="switch"><input type="checkbox" ' + (p.enabled !== false ? 'checked' : '') + ' data-prov="' + esc(name) + '"><span class="slider"></span></label>' +
        '<button class="btn sm" data-edit-prov="' + esc(name) + '">编辑</button></div>';
      wrap.appendChild(card);
    });
    wrap.querySelectorAll('input[data-prov]').forEach(cb => cb.addEventListener('change', () => toggleProvider(cb.getAttribute('data-prov'), cb.checked)));
    wrap.querySelectorAll('[data-edit-prov]').forEach(b => b.addEventListener('click', () => editProvider(b.getAttribute('data-edit-prov'))));
  }
  async function toggleProvider(name, enabled) {
    try { await api('/api/config/providers/' + encodeURIComponent(name), { method: 'PUT', body: { enabled } }); toast('端点 ' + name + (enabled ? ' 已启用' : ' 已停用')); loadProviders(); }
    catch (e) { toast('操作失败: ' + e.message, 'err'); }
  }
  function editProvider(name) {
    api('/api/config', { auth: 1 }).then(cfg => {
      const p = (cfg.providers || {})[name] || {};
      openModal(
        '<h3>编辑端点 · ' + esc(name) + '</h3><div class="m-sub">修改后自动落盘</div>' +
        '<div class="form-row"><div class="field"><label>显示名</label><input id="ep-display" value="' + esc(p.display || name) + '"></div>' +
        '<div class="field"><label>Base URL</label><input id="ep-url" value="' + esc(p.base_url || '') + '"></div></div>' +
        '<div class="field"><label>API Key</label><input id="ep-key" type="password" placeholder="留空不改动" value=""></div>' +
        '<div class="form-actions"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" id="ep-save">保存</button></div>'
      );
      $('ep-save').addEventListener('click', async () => {
        const body = { display: $('ep-display').value.trim(), base_url: $('ep-url').value.trim() };
        const k = $('ep-key').value.trim(); if (k) body.api_key = k;
        try { await api('/api/config/providers/' + encodeURIComponent(name), { method: 'PUT', body }); toast('端点已更新'); closeModal(); loadProviders(); }
        catch (e) { toast('保存失败: ' + e.message, 'err'); }
      });
    }).catch(e => toast('读取失败: ' + e.message, 'err'));
  }
  async function addProvider() {
    const name = $('np-name').value.trim(); const url = $('np-url').value.trim(); const key = $('np-key').value.trim();
    if (!name || !url) { toast('名称和 Base URL 必填', 'err'); return; }
    try { await api('/api/config/providers', { method: 'POST', body: { name, base_url: url, api_key: key } }); toast('端点已添加'); $('np-name').value = ''; $('np-url').value = ''; $('np-key').value = ''; loadProviders(); }
    catch (e) { toast('添加失败: ' + e.message, 'err'); }
  }

  /* ================= 模型 ================= */
  async function loadModels() {
    let data; try { data = await api('/api/models', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); toast('读取模型失败: ' + e.message, 'err'); return; }
    const list = (data && data.models) || [];
    if ($('model-count')) $('model-count').textContent = list.length + ' 个模型';
    const tb = $('model-body'); if (!tb) return; tb.innerHTML = '';
    if (!list.length) { tb.appendChild(el('tr', '', '<td colspan="6" class="empty">暂无模型</td>')); return; }
    const capLabels = { coding: '代码', general: '通用', reasoning: '推理', vision: '视觉', fast: '高速', other: '其他' };
    list.forEach(m => {
      const tr = el('tr');
      tr.innerHTML =
        '<td><b>' + esc(m.id) + '</b></td>' +
        '<td>' + esc(m.provider) + '</td>' +
        '<td>' + (m.tier != null ? 'T' + m.tier : '—') + '</td>' +
        '<td><span class="tag cy">' + (capLabels[m.capability] || m.capability) + '</span></td>' +
        '<td><label class="switch"><input type="checkbox" ' + (m.enabled !== false ? 'checked' : '') + ' data-mid="' + esc(m.id) + '"><span class="slider"></span></label></td>' +
        '<td><button class="btn sm" data-edit-m="' + esc(m.id) + '">编辑</button> <button class="btn sm danger" data-del-m="' + esc(m.id) + '">删除</button></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('input[data-mid]').forEach(cb => cb.addEventListener('change', () => toggleModel(cb.getAttribute('data-mid'), cb.checked)));
    tb.querySelectorAll('[data-edit-m]').forEach(b => b.addEventListener('click', () => editModel(b.getAttribute('data-edit-m'))));
    tb.querySelectorAll('[data-del-m]').forEach(b => b.addEventListener('click', () => delModel(b.getAttribute('data-del-m'))));
  }
  async function toggleModel(id, enabled) {
    try { await api('/api/config/models/' + encodeURIComponent(id), { method: 'PUT', body: { enabled } }); toast('模型 ' + id + (enabled ? ' 已启用' : ' 已停用')); }
    catch (e) { toast('操作失败: ' + e.message, 'err'); loadModels(); }
  }
  function editModel(id) {
    api('/api/models', { auth: 1 }).then(d => {
      const m = (d.models || []).find(x => x.id === id) || {};
      const caps = ['general', 'coding', 'reasoning', 'vision', 'fast'];
      openModal(
        '<h3>编辑模型 · ' + esc(id) + '</h3><div class="m-sub">档位 1(高)→6(低) · 能力决定路由归类</div>' +
        '<div class="form-row"><div class="field"><label>档位</label><input id="em-tier" type="number" min="1" max="6" value="' + (m.tier != null ? m.tier : 5) + '"></div>' +
        '<div class="field"><label>能力</label><select id="em-cap">' + caps.map(c => '<option value="' + c + '"' + (m.capability === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div></div>' +
        '<div class="field"><label>描述</label><input id="em-desc" value="' + esc(m.description || '') + '"></div>' +
        '<div class="form-actions"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" id="em-save">保存</button></div>'
      );
      $('em-save').addEventListener('click', async () => {
        const body = { tier: parseInt($('em-tier').value) || 5, capability: $('em-cap').value, description: $('em-desc').value.trim() };
        try { await api('/api/config/models/' + encodeURIComponent(id), { method: 'PUT', body }); toast('模型已更新'); closeModal(); loadModels(); }
        catch (e) { toast('保存失败: ' + e.message, 'err'); }
      });
    }).catch(e => toast('读取失败: ' + e.message, 'err'));
  }
  async function delModel(id) {
    if (!confirm('确认删除模型 ' + id + '？')) return;
    try { await api('/api/config/models/' + encodeURIComponent(id), { method: 'DELETE' }); toast('模型已删除'); loadModels(); }
    catch (e) { toast('删除失败: ' + e.message, 'err'); }
  }
  async function addModel() {
    const id = $('nm-id').value.trim(); const provider = $('nm-provider').value.trim();
    if (!id || !provider) { toast('模型 ID 和供应商必填', 'err'); return; }
    const body = { id, provider, tier: parseInt($('nm-tier').value) || 5, capability: $('nm-cap').value, description: $('nm-desc').value.trim() };
    try { await api('/api/config/models', { method: 'POST', body }); toast('模型已添加'); $('nm-id').value = ''; $('nm-provider').value = ''; $('nm-desc').value = ''; loadModels(); }
    catch (e) { toast('添加失败: ' + e.message, 'err'); }
  }

  /* ================= 虚拟密钥 ================= */
  async function loadKeys() {
    let d; try { d = await api('/api/virtual-keys', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); toast('读取密钥失败: ' + e.message, 'err'); return; }
    const keys = (d && d.keys) || [];
    if ($('key-count')) $('key-count').textContent = keys.length + ' 个密钥';
    const tb = $('key-body'); if (!tb) return; tb.innerHTML = '';
    if (!keys.length) { tb.appendChild(el('tr', '', '<td colspan="6" class="empty">暂无密钥</td>')); return; }
    keys.forEach(k => {
      const used = (k.budget_monthly_rmb ? (k.used_rmb || 0) : 0);
      const disabled = k.disabled;
      const tr = el('tr');
      tr.innerHTML =
        '<td><b>' + esc(k.name) + '</b>' + (k.tenant ? ' <span class="tag">租户:' + esc(k.tenant) + '</span>' : '') + '</td>' +
        '<td style="font-family:monospace;font-size:11px">' + esc((k.raw_key || k.key || '').slice(0, 18)) + '…</td>' +
        '<td>' + fmtMoney(used) + ' / ' + fmtMoney(k.budget_monthly_rmb || 0) + '</td>' +
        '<td>' + (k.concurrent_max || '—') + '</td>' +
        '<td>' + (disabled ? '<span class="badge err">停用</span>' : '<span class="badge ok">启用</span>') + '</td>' +
        '<td><button class="btn sm" data-edit-k="' + esc(k.hash || k.name) + '">编辑</button> <button class="btn sm" data-reset-k="' + esc(k.hash || k.name) + '">重置预算</button> <button class="btn sm danger" data-del-k="' + esc(k.hash || k.name) + '">删除</button></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('[data-edit-k]').forEach(b => b.addEventListener('click', () => editKey(b.getAttribute('data-edit-k'))));
    tb.querySelectorAll('[data-reset-k]').forEach(b => b.addEventListener('click', () => resetKey(b.getAttribute('data-reset-k'))));
    tb.querySelectorAll('[data-del-k]').forEach(b => b.addEventListener('click', () => delKey(b.getAttribute('data-del-k'))));
  }
  async function addKey() {
    const name = $('nk-name').value.trim(); if (!name) { toast('名称必填', 'err'); return; }
    const body = { name, budget_monthly_rmb: parseFloat($('nk-budget').value) || 0, concurrent_max: parseInt($('nk-conc').value) || 5, tenant: $('nk-tenant').value.trim() || undefined };
    try { const r = await api('/api/virtual-keys', { method: 'POST', body }); toast('密钥已创建'); $('nk-name').value = ''; $('nk-tenant').value = ''; loadKeys(); if (r && r.raw_key) setTimeout(() => alert('新密钥 (请保存):\n' + r.raw_key), 300); }
    catch (e) { toast('创建失败: ' + e.message, 'err'); }
  }
  function editKey(hash) {
    api('/api/virtual-keys', { auth: 1 }).then(d => {
      const k = (d.keys || []).find(x => (x.hash || x.name) === hash) || {};
      openModal(
        '<h3>编辑密钥 · ' + esc(k.name) + '</h3>' +
        '<div class="form-row"><div class="field"><label>月度预算 (¥)</label><input id="ek-budget" type="number" value="' + (k.budget_monthly_rmb || 0) + '"></div>' +
        '<div class="field"><label>并发上限</label><input id="ek-conc" type="number" value="' + (k.concurrent_max || 5) + '"></div></div>' +
        '<div class="field"><label>状态</label><select id="ek-status"><option value="enabled" ' + (!k.disabled ? 'selected' : '') + '>启用</option><option value="disabled" ' + (k.disabled ? 'selected' : '') + '>停用</option></select></div>' +
        '<div class="form-actions"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" id="ek-save">保存</button></div>'
      );
      $('ek-save').addEventListener('click', async () => {
        const body = { budget_monthly_rmb: parseFloat($('ek-budget').value) || 0, concurrent_max: parseInt($('ek-conc').value) || 5, disabled: $('ek-status').value === 'disabled' };
        try { await api('/api/virtual-keys/' + encodeURIComponent(hash), { method: 'PUT', body }); toast('密钥已更新'); closeModal(); loadKeys(); }
        catch (e) { toast('保存失败: ' + e.message, 'err'); }
      });
    }).catch(e => toast('读取失败: ' + e.message, 'err'));
  }
  async function resetKey(hash) {
    try { await api('/api/virtual-keys/reset', { method: 'POST', body: { hash } }); toast('预算已重置'); loadKeys(); }
    catch (e) { toast('重置失败: ' + e.message, 'err'); }
  }
  async function delKey(hash) {
    if (!confirm('确认删除该密钥？')) return;
    try { await api('/api/virtual-keys/' + encodeURIComponent(hash), { method: 'DELETE' }); toast('密钥已删除'); loadKeys(); }
    catch (e) { toast('删除失败: ' + e.message, 'err'); }
  }

  /* ================= 路由与提示词 ================= */
  async function loadRouting() {
    let cfg; try { cfg = await api('/api/config', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); toast('读取失败: ' + e.message, 'err'); return; }
    if ($('rt-system')) $('rt-system').value = cfg.system_prompt || '';
    if ($('rt-routing')) $('rt-routing').value = JSON.stringify(cfg.routing || {}, null, 2);
  }
  async function saveSystem() {
    try { await api('/api/config/prompts', { method: 'PUT', body: { system: $('rt-system').value } }); toast('提示词已保存'); }
    catch (e) { toast('保存失败: ' + e.message, 'err'); }
  }
  async function saveRouting() {
    let obj; try { obj = JSON.parse($('rt-routing').value); } catch (e) { toast('JSON 格式错误: ' + e.message, 'err'); return; }
    try { await api('/api/config/routing', { method: 'PUT', body: obj }); toast('路由配置已保存'); }
    catch (e) { toast('保存失败: ' + e.message, 'err'); }
  }

  /* ================= 系统 ================= */
  async function loadSystem() {
    let cfg; try { cfg = await api('/api/config', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); }
    if (cfg && $('sys-config')) $('sys-config').textContent = JSON.stringify(cfg, null, 2);
    try { const h = await api('/health'); if (h) { if ($('sys-version')) $('sys-version').textContent = h.version || 'v6'; if ($('sys-uptime')) $('sys-uptime').textContent = fmtUptime(h.uptime_seconds || 0); if ($('sys-features')) { $('sys-features').innerHTML = ''; (h.features || []).forEach(f => $('sys-features').appendChild(el('span', 'chip', esc(f)))); } } } catch (e) {}
    try { const c = await api('/api/cache/stats', { auth: 1 }); if (c && $('sys-cache')) $('sys-cache').textContent = (c.cache_entries != null ? c.cache_entries + ' 条' : '—'); } catch (e) {}
    try { const rl = await api('/api/rate-limit/status', { auth: 1 }); if (rl && $('sys-rl')) $('sys-rl').textContent = ((rl.rate_limits ? rl.rate_limits.length : 0)) + ' 规则'; } catch (e) {}
  }
  async function reloadConfig() {
    try { await api('/config/reload', { method: 'POST' }); toast('配置已重载'); loadSystem(); }
    catch (e) { toast('重载失败: ' + e.message, 'err'); }
  }

  /* ================= Agent 管理 ================= */
  let ALL_MODELS = [];
  async function loadAllModels() { try { const d = await api('/api/models', { auth: 1 }); ALL_MODELS = (d && d.models) || []; } catch (e) { ALL_MODELS = []; } }
  function relTime(ts) { if (!ts) return '从未'; const diff = Math.floor(Date.now() / 1000 - ts); if (diff < 60) return diff + '秒前'; if (diff < 3600) return Math.floor(diff / 60) + '分前'; if (diff < 86400) return Math.floor(diff / 3600) + '时前'; return Math.floor(diff / 86400) + '天前'; }
  let AGENT_FILTER = 'fleet';
  const FLEET_DESC = {
    'Claude Code': '你本机的 Claude Code 客户端（克劳德）',
    'Codex': '你的 Codex 桌面端（小c）',
    'WorkBuddy': 'WorkBuddy 端的小爪，就是你现在用的这个',
    '知夏': '舰队主脑，负责编排与共享记忆',
    '爱马仕': 'Hermes Agent，状态与资源管家',
    '写手姐': '内容 / 文档写作 Agent'
  };
  async function loadAgents() {
    await loadAllModels();
    const nm = $('na-models'); if (nm) nm.innerHTML = ALL_MODELS.map(m => '<option value="' + esc(m.id) + '">' + esc(m.id) + '</option>').join('');
    let d; try { d = await api('/api/agents', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); toast('读取 Agent 失败: ' + e.message, 'err'); return; }
    const agents = (d && d.agents) || [];
    if ($('agent-count')) $('agent-count').textContent = agents.length + ' 个 Agent（舰队 ' + agents.filter(a => a.kind === 'fleet').length + '）';
    renderAgentGrid(agents);
    document.querySelectorAll('[data-af]').forEach(c => c.addEventListener('click', () => {
      document.querySelectorAll('[data-af]').forEach(x => x.classList.remove('active'));
      c.classList.add('active'); AGENT_FILTER = c.getAttribute('data-af'); renderAgentGrid(agents);
    }));
  }
  function renderAgentGrid(agents) {
    const wrap = $('agent-grid'); if (!wrap) return; wrap.innerHTML = '';
    const list = agents.filter(a => AGENT_FILTER === 'all' || a.kind === AGENT_FILTER);
    if (!list.length) { wrap.appendChild(el('div', 'empty', AGENT_FILTER === 'fleet' ? '暂无舰队 Agent' : '该分类下暂无 Agent')); return; }
    list.forEach(a => {
      const models = a.bound_models || [];
      const tags = models.length === 0 ? '<span class="tag">全部模型（全池）</span>' : models.slice(0, 8).map(m => '<span class="tag">' + esc(m) + '</span>').join('') + (models.length > 8 ? '<span class="tag am">+' + (models.length - 8) + '</span>' : '');
      const card = el('div', 'agent-card' + (a.is_active ? '' : ' off'));
      card.innerHTML =
        '<div class="agent-top"><span class="agent-emoji">' + esc(a.logo || '🤖') + '</span><span class="agent-name">' + esc(a.label || a.name) + '</span>' +
        '<span class="badge ' + (a.kind === 'fleet' ? 'cy' : 'misc') + '" style="margin-left:6px">' + (a.kind === 'fleet' ? '舰队' : '来源') + '</span>' +
        '<span class="dot ' + (a.is_active ? 'green' : 'grey') + '"></span></div>' +
        '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">' + esc(a.description || (a.kind === 'fleet' ? (FLEET_DESC[a.name] || '舰队成员') : '非 Agent 的调用来源（工具/脚本流量）')) + '</div>' +
        '<div style="margin-bottom:8px"><span class="badge ' + (a.bound ? 'cy' : 'misc') + '">' + (a.bound ? '已绑定' : '用全池') + '</span> <span style="font-size:11px;color:var(--dim)">' + models.length + ' 模型</span></div>' +
        '<div style="margin-bottom:10px">' + tags + '</div>' +
        '<div style="font-size:11px;color:var(--dim);margin-bottom:10px">最近活跃 ' + relTime(a.last_seen) + (a.last_model ? ' · ' + esc(a.last_model) : '') + ' · 累计 ' + fmtNum(a.count) + ' 次</div>' +
        '<div class="prov-actions">' + (a.bound ? '<button class="btn sm" data-edit-a="' + esc(a.name) + '">编辑</button> <button class="btn sm danger" data-del-a="' + esc(a.name) + '">解绑</button>' : '<button class="btn sm primary" data-edit-a="' + esc(a.name) + '">绑定模型池</button>') + '</div>';
      wrap.appendChild(card);
    });
    wrap.querySelectorAll('[data-edit-a]').forEach(b => b.addEventListener('click', () => editAgent(b.getAttribute('data-edit-a'))));
    wrap.querySelectorAll('[data-del-a]').forEach(b => b.addEventListener('click', () => delAgent(b.getAttribute('data-del-a'))));
  }
  async function addAgent() {
    const name = $('na-name').value.trim(); if (!name) { toast('Agent 名称必填', 'err'); return; }
    const mode = $('na-mode').value;
    const sel = $('na-models'); const model_ids = sel ? Array.from(sel.selectedOptions).map(o => o.value) : [];
    const body = { mode, model_ids, description: $('na-desc').value.trim() };
    try { await api('/api/agents/' + encodeURIComponent(name) + '/model', { method: 'PUT', body }); await api('/config/reload', { method: 'POST' }); toast('已保存 Agent 绑定：' + name); $('na-name').value = ''; $('na-desc').value = ''; if (sel) Array.from(sel.options).forEach(o => o.selected = false); loadAgents(); }
    catch (e) { toast('保存失败: ' + e.message, 'err'); }
  }
  function editAgent(name) {
    api('/api/agents', { auth: 1 }).then(d => {
      const a = (d.agents || []).find(x => x.name === name) || {};
      const models = a.bound_models || (a.bound_model ? [a.bound_model] : []);
      const opts = ALL_MODELS.map(m => '<option value="' + esc(m.id) + '"' + (models.includes(m.id) ? ' selected' : '') + '>' + esc(m.id) + '</option>').join('');
      openModal(
        '<h3>编辑 Agent · ' + esc(name) + '</h3><div class="m-sub">绑定该 Agent 可使用的模型池（路由时优先从此池选模型）</div>' +
        '<div class="form-row"><div class="field"><label>模式</label><select id="ea-mode"><option value="group" ' + (a.mode !== 'single' ? 'selected' : '') + '>分组(多模型)</option><option value="single" ' + (a.mode === 'single' ? 'selected' : '') + '>单模型</option></select></div>' +
        '<div class="field"><label>描述</label><input id="ea-desc" value="' + esc(a.description || '') + '"></div></div>' +
        '<div class="field"><label>绑定模型（Ctrl/⌘ 多选，留空=全部）</label><input id="ea-search" placeholder="搜索模型…" style="width:100%;margin-bottom:8px"><select id="ea-models" multiple size="9" style="width:100%">' + opts + '</select></div>' +
        '<div class="form-actions"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" id="ea-save">保存</button></div>'
      );
      const eaSearch = $('ea-search'); if (eaSearch) eaSearch.addEventListener('input', () => { const q = eaSearch.value.trim().toLowerCase(); const sel = $('ea-models'); if (sel) Array.from(sel.options).forEach(o => { o.style.display = (!q || o.value.toLowerCase().includes(q)) ? '' : 'none'; }); });
      $('ea-save').addEventListener('click', async () => {
        const sel = $('ea-models'); const mids = Array.from(sel.selectedOptions).map(o => o.value);
        const body = { mode: $('ea-mode').value, model_ids: mids, description: $('ea-desc').value.trim() };
        try { await api('/api/agents/' + encodeURIComponent(name) + '/model', { method: 'PUT', body }); await api('/config/reload', { method: 'POST' }); toast('Agent 已更新'); closeModal(); loadAgents(); }
        catch (e) { toast('保存失败: ' + e.message, 'err'); }
      });
    }).catch(e => toast('读取失败: ' + e.message, 'err'));
  }
  async function delAgent(name) {
    if (!confirm('确认解绑 Agent「' + name + '」的模型池？（不影响该 Agent 继续用全池路由）')) return;
    try { await api('/api/agents/' + encodeURIComponent(name), { method: 'DELETE' }); await api('/config/reload', { method: 'POST' }); toast('已解绑：' + name); loadAgents(); }
    catch (e) { toast('解绑失败: ' + e.message, 'err'); }
  }

  /* ================= 护栏日志 ================= */
  let GR_F = { sev: 'all', act: 'all' };
  async function loadGuardrails() {
    let d; try { d = await api('/api/guardrails/logs', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); toast('读取护栏日志失败: ' + e.message, 'err'); return; }
    const logs = (d && d.logs) || [];
    if ($('gr-count')) $('gr-count').textContent = logs.length + ' 条记录';
    const wrap = $('gr-body'); if (!wrap) return;
    const render = () => {
      const f = logs.filter(l => (GR_F.sev === 'all' || (l.severity || '').toLowerCase() === GR_F.sev) && (GR_F.act === 'all' || (l.action || '').toLowerCase() === GR_F.act));
      wrap.innerHTML = '';
      if (!f.length) { wrap.appendChild(el('tr', '', '<td colspan="7" class="empty">无匹配记录</td>')); return; }
      f.forEach(l => {
        const sev = (l.severity || '').toLowerCase();
        const sevTone = sev === 'high' ? 'err' : sev === 'medium' ? 'warn' : 'ok';
        const act = (l.action || '').toLowerCase();
        const actTone = act === 'block' ? 'err' : act === 'mask' ? 'cy' : 'misc';
        const t = new Date((l.timestamp || 0) * 1000);
        const ts = isNaN(t) ? '—' : t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const tr = el('tr');
        tr.innerHTML = '<td class="t-ts">' + ts + '</td><td>' + esc(l.direction || '') + '</td><td>' + esc(l.rule || '') + '</td><td><span class="badge ' + sevTone + '">' + esc(l.severity || '') + '</span></td><td><span class="badge ' + actTone + '">' + esc(l.action || '') + '</span></td><td>' + esc(l.request_ip || '') + '</td><td title="' + esc(l.snippet || '') + '">' + esc((l.snippet || '').slice(0, 30)) + '</td>';
        wrap.appendChild(tr);
      });
    };
    render();
    document.querySelectorAll('[data-gf]').forEach(b => b.onclick = () => { document.querySelectorAll('[data-gf]').forEach(x => x.classList.remove('active')); b.classList.add('active'); GR_F.sev = b.getAttribute('data-gf'); render(); });
    document.querySelectorAll('[data-ga]').forEach(b => b.onclick = () => { document.querySelectorAll('[data-ga]').forEach(x => x.classList.remove('active')); b.classList.add('active'); GR_F.act = b.getAttribute('data-ga'); render(); });
  }

  /* ================= MCP 服务器 ================= */
  async function loadMcp() {
    let d; try { d = await api('/api/mcp-servers', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); toast('读取 MCP 失败: ' + e.message, 'err'); return; }
    const servers = (d && d.servers) || [];
    if ($('mcp-count')) $('mcp-count').textContent = servers.length + ' 个服务器';
    const wrap = $('mcp-body'); if (!wrap) return; wrap.innerHTML = '';
    if (!servers.length) { wrap.appendChild(el('tr', '', '<td colspan="4" class="empty">暂无 MCP 服务器，使用上方表单添加</td>')); return; }
    servers.forEach(s => {
      const tr = el('tr');
      tr.innerHTML = '<td>' + esc(s.name || '') + '</td><td title="' + esc(s.url || '') + '">' + esc(s.url || '') + '</td><td>' + (s.enabled === false ? '<span class="badge warn">停用</span>' : '<span class="badge ok">启用</span>') + '</td><td><button class="btn sm danger" data-del-mcp="' + esc(s.name) + '">删除</button></td>';
      wrap.appendChild(tr);
    });
    wrap.querySelectorAll('[data-del-mcp]').forEach(b => b.addEventListener('click', () => delMcp(b.getAttribute('data-del-mcp'))));
  }
  async function addMcp() {
    const name = $('nm-name').value.trim(); const url = $('nm-url').value.trim();
    if (!name || !url) { toast('名称和地址必填', 'err'); return; }
    let headers = {}; const hraw = $('nm-headers').value.trim();
    if (hraw) { try { headers = JSON.parse(hraw); } catch (e) { toast('请求头 JSON 解析失败', 'err'); return; } }
    const enabled = $('nm-enabled').value !== 'false';
    try { await api('/api/mcp-servers', { method: 'POST', body: { name, url, headers, enabled } }); toast('MCP 服务器已添加：' + name); $('nm-name').value = ''; $('nm-url').value = ''; $('nm-headers').value = ''; loadMcp(); }
    catch (e) { toast('添加失败: ' + e.message, 'err'); }
  }
  async function delMcp(name) {
    if (!confirm('确认删除 MCP 服务器「' + name + '」？')) return;
    try { await api('/api/mcp-servers/' + encodeURIComponent(name), { method: 'DELETE' }); toast('已删除：' + name); loadMcp(); }
    catch (e) { toast('删除失败: ' + e.message, 'err'); }
  }

  /* ================= 租户统计 ================= */
  async function loadTenants() {
    let d; try { d = await api('/api/tenants', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); toast('读取租户失败: ' + e.message, 'err'); return; }
    const list = (d && d.tenants) || [];
    if ($('tn-count')) $('tn-count').textContent = list.length + ' 个租户';
    const wrap = $('tn-grid'); if (!wrap) return; wrap.innerHTML = '';
    if (!list.length) { wrap.appendChild(el('div', 'empty', '暂无租户数据')); return; }
    list.forEach(t => {
      const rate = t.requests ? Math.round(100 * (t.success || 0) / (t.requests || 1)) : 0;
      const card = el('div', 'card'); card.style.padding = '16px';
      card.innerHTML = '<div class="agent-name" style="margin-bottom:8px">' + (t.tenant ? esc(t.tenant) : '默认租户') + '</div>' +
        '<div style="display:flex;gap:20px;flex-wrap:wrap">' +
        '<div><div class="stat-num">' + fmtNum(t.requests || 0) + '</div><div class="stat-lbl">请求</div></div>' +
        '<div><div class="stat-num">' + rate + '%</div><div class="stat-lbl">成功率</div></div>' +
        '<div><div class="stat-num">' + fmtMs(t.avg_lat || 0) + '</div><div class="stat-lbl">平均延迟</div></div>' +
        '<div><div class="stat-num">' + fmtTok(t.tokens || 0) + '</div><div class="stat-lbl">Token</div></div>' +
        '</div>';
      wrap.appendChild(card);
    });
  }

  /* ================= 拓扑图 ================= */
  async function loadTopology() {
    let d; try { d = await api('/api/graph', { auth: 1 }); } catch (e) { if (e.code === 401) return showTokenGate(); toast('读取拓扑失败: ' + e.message, 'err'); return; }
    const nodes = (d && d.nodes) || [];
    const topoEl = $('chart-topo'); if (!topoEl) return;
    if (!charts['chart-topo'] && window.echarts) charts['chart-topo'] = echarts.init(topoEl, null, { renderer: 'canvas' });
    const c = charts['chart-topo']; if (!c) return;
    const COL = { provider: '#8a73ff', model: '#22d3ee', agent: '#34d399' };
    const maxReq = Math.max(1, ...nodes.map(n => n.requests || 0));
    const data = nodes.map(n => ({ id: n.id, name: n.label || n.id, category: n.type, value: n.requests || 0, symbolSize: 12 + 34 * Math.sqrt((n.requests || 0) / maxReq), itemStyle: { color: COL[n.type] || '#888' }, label: { show: n.type !== 'model' || (n.requests || 0) > maxReq * 0.08 } }));
    const provId = {}; nodes.filter(n => n.type === 'provider').forEach(p => { provId[p.label || p.id] = p.id; });
    const links = [];
    nodes.filter(n => n.type === 'model').forEach(m => { const pid = provId[m.provider]; if (pid) links.push({ source: pid, target: m.id, lineStyle: { color: 'rgba(120,120,160,.22)' } }); });
    c.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', backgroundColor: 'rgba(15,20,32,0.95)', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: '#c7d2e0' }, formatter: p => p.data ? (p.data.name + '<br/>类型: ' + (p.data.category || '') + '<br/>请求: ' + fmtNum(p.data.value || 0)) : '' },
      legend: [{ data: ['provider', 'model', 'agent'], textStyle: { color: '#cbd5e1' }, top: 2 }],
      series: [{
        type: 'graph', layout: 'force', roam: true, draggable: true,
        categories: [{ name: 'provider' }, { name: 'model' }, { name: 'agent' }],
        data, links,
        label: { position: 'right', color: '#e2e8f0', fontSize: 10 },
        force: { repulsion: 150, edgeLength: [50, 130], gravity: 0.06 },
        lineStyle: { curveness: 0.05 },
        emphasis: { focus: 'adjacency' }
      }]
    });
    c.resize();
  }

  /* ================= 路由/导航 ================= */
  const VIEWS = {
    overview: { title: '概览监控', desc: '实时流量、健康与成本', load: refreshOverview },
    providers: { title: '供应商端点', desc: '管理上游 API 端点', load: loadProviders },
    models: { title: '模型池', desc: '管理路由模型与档位', load: loadModels },
    keys: { title: '虚拟密钥', desc: '多租户配额与预算', load: loadKeys },
    routing: { title: '路由与提示词', desc: '路由策略与系统提示', load: loadRouting },
    agents: { title: 'Agent 管理', desc: '绑定模型池与实时状态', load: loadAgents },
    guardrails: { title: '护栏日志', desc: 'PII/安全 触发记录', load: loadGuardrails },
    mcp: { title: 'MCP 服务器', desc: '外部工具服务接入', load: loadMcp },
    tenants: { title: '租户统计', desc: '多租户流量与成本', load: loadTenants },
    topology: { title: '拓扑图', desc: '供应商-模型-Agent 关系', load: loadTopology },
    system: { title: '系统设置', desc: '配置热重载与状态', load: loadSystem }
  };
  function navigate(view) {
    if (!VIEWS[view]) view = 'overview';
    currentView = view;
    Object.keys(VIEWS).forEach(v => { const sec = $('view-' + v); if (sec) sec.classList.toggle('active', v === view); const item = document.querySelector('.sb-item[data-view="' + v + '"]'); if (item) item.classList.toggle('active', v === view); });
    const meta = VIEWS[view]; if ($('crumb-title')) $('crumb-title').textContent = meta.title; if ($('crumb-desc')) $('crumb-desc').textContent = meta.desc;
    if (location.hash !== '#/' + view) location.hash = '#/' + view;
    if (view === 'topology' && charts['chart-topo']) setTimeout(() => charts['chart-topo'].resize(), 30);
    meta.load().catch(e => { if (e.code === 401) showTokenGate(); else toast('加载失败: ' + e.message, 'err'); });
  }
  function bindNav() {
    document.querySelectorAll('.sb-item').forEach(it => it.addEventListener('click', () => navigate(it.getAttribute('data-view'))));
    window.addEventListener('hashchange', () => { const v = (location.hash || '').replace('#/', ''); if (v && v !== currentView) navigate(v); });
  }

  /* ================= 启动 ================= */
  function start() {
    initCharts(); bindNav(); bindTokenGate();
    const rb = $('btn-refresh'); if (rb) rb.addEventListener('click', () => { const m = VIEWS[currentView]; if (m) m.load().catch(() => {}); refreshOverview(); });
    const at = $('btn-autorefresh'); let on = true;
    if (at) at.addEventListener('click', () => { on = !on; at.classList.toggle('off', !on); at.textContent = on ? '自动刷新 开' : '自动刷新 关'; if (on) refreshTimer = setInterval(refreshOverview, REFRESH_MS); else clearInterval(refreshTimer); });
    // 表单绑定
    const npa = $('np-add'); if (npa) npa.addEventListener('click', addProvider);
    const nma = $('nm-add'); if (nma) nma.addEventListener('click', addModel);
    const nka = $('nk-add'); if (nka) nka.addEventListener('click', addKey);
    const rts = $('rt-save-system'); if (rts) rts.addEventListener('click', saveSystem);
    const rtr = $('rt-save-routing'); if (rtr) rtr.addEventListener('click', saveRouting);
    const sr = $('sys-reload'); if (sr) sr.addEventListener('click', reloadConfig);
    const naa = $('na-add'); if (naa) naa.addEventListener('click', addAgent);
    const nmca = $('nmc-add'); if (nmca) nmca.addEventListener('click', addMcp);
    const ra = $('recent-agent'); if (ra) ra.addEventListener('change', reloadRecent);
    // 首屏
    const initial = (location.hash || '').replace('#/', '') || 'overview';
    navigate(initial);
    refreshTimer = setInterval(refreshOverview, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
