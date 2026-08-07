(() => {
  'use strict';

  let adminToken = '';
  let refreshTimer = null;

  const $ = (id) => document.getElementById(id);
  const setText = (id, value) => { $(id).textContent = String(value ?? '—'); };
  const setMessage = (text, kind = '') => {
    const node = $('message');
    node.textContent = text;
    node.className = kind ? `message ${kind}` : 'message';
  };
  const number = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—';

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
    try {
      const response = await fetch(path, { ...options, headers, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || body.hint || `HTTP ${response.status}`);
      return body;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function setConnected(connected) {
    const badge = $('connection-badge');
    badge.textContent = connected ? '已连接' : '未连接';
    badge.className = connected ? 'badge badge-good' : 'badge badge-muted';
    $('kill-button').disabled = !connected;
    $('resume-button').disabled = !connected;
  }

  function render(data) {
    const canary = data.canary || {};
    const stopped = canary.stopped === true;
    const active = canary.activeRequests ?? 0;
    const autoStop = canary.autoStop;
    setText('mode-value', data.mode || 'off');
    setText('enabled-value', data.enabled ? '智能层已启用' : '智能层关闭');
    setText('canary-value', canary.enabled ? `${canary.percentage ?? 0}%` : '关闭');
    setText('canary-foot', stopped ? '已停止采样' : '采样运行中');
    setText('active-value', number(active));
    setText('active-foot', `累计采样 ${number(canary.active)}`);
    setText('cost-value', `$${Number(canary.totalCost || 0).toFixed(4)}`);
    setText('stop-state', stopped ? '已停止' : '运行中');
    $('stop-state').className = stopped ? 'badge badge-danger' : 'badge badge-good';
    setText('stop-detail', autoStop ? `${autoStop.reason || '自动停止'} · ${autoStop.at || '时间未知'}` : '当前没有自动停止原因。');
    setText('eligible-value', number(canary.eligible));
    setText('sampled-value', number(canary.sampled));
    setText('fallback-value', number(canary.fallbackCount));
    setText('incomplete-value', number(canary.incomplete));
    setText('provider-error-value', number(canary.consecutiveErrors?.provider_error));
  }

  async function refresh() {
    if (!adminToken) return;
    try {
      const data = await request('/_smart-router/intelligence/status');
      render(data);
      setConnected(true);
      setMessage(`最近刷新：${new Date().toLocaleTimeString('zh-CN')}`, 'success');
    } catch (error) {
      setConnected(false);
      setMessage(`连接失败：${error.message}`, 'error');
    }
  }

  function beginRefresh() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(refresh, 10000);
  }

  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = $('admin-token').value.trim();
    if (value.length < 16) {
      setMessage('Token 至少需要 16 个字符。', 'error');
      return;
    }
    adminToken = value;
    await refresh();
    beginRefresh();
  });

  $('refresh-button').addEventListener('click', refresh);
  $('kill-button').addEventListener('click', async () => {
    if (!window.confirm('确认停止 Active Canary？系统将停止采样并持久化状态。')) return;
    try {
      render(await request('/_smart-router/intelligence/kill', { method: 'POST' }));
      setMessage('Active Canary 已停止。', 'success');
    } catch (error) { setMessage(`停止失败：${error.message}`, 'error'); }
  });
  $('resume-button').addEventListener('click', async () => {
    try {
      render(await request('/_smart-router/intelligence/resume-shadow', { method: 'POST' }));
      setMessage('已恢复 Shadow；不会自动恢复 Active。', 'success');
    } catch (error) { setMessage(`恢复失败：${error.message}`, 'error'); }
  });
})();
