(() => {
  'use strict';

  let adminToken = '';
  let refreshTimer = null;
  let configEditing = false;
  const $ = (id) => document.getElementById(id);
  const setText = (id, value) => { const node = $(id); if (node) node.textContent = String(value ?? '—'); };
  const number = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—';
  const percent = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : '—';
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

  function setMessage(text, kind = '') {
    const node = $('message');
    node.textContent = text;
    node.className = kind ? `message ${kind}` : 'message';
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
    try {
      const response = await fetch(path, { ...options, headers, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      const detail = Array.isArray(body.errors) ? body.errors.join('；') : body.error || body.hint;
      if (!response.ok) throw new Error(detail || `HTTP ${response.status}`);
      return body;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function setConnected(connected) {
    const badge = $('connection-badge');
    badge.innerHTML = `<span class="status-dot"></span>${connected ? '已连接' : '未连接'}`;
    badge.className = `status-pill ${connected ? 'status-good' : 'status-muted'}`;
    $('kill-button').disabled = !connected;
    $('resume-button').disabled = !connected;
  }

  function setStatusPill(id, text, kind) {
    const node = $(id);
    node.innerHTML = `<span class="status-dot"></span>${escapeHtml(text)}`;
    node.className = `status-pill status-${kind}`;
  }

  function renderModels(data) {
    const models = Array.isArray(data?.data) ? data.data.filter((model) => model.id !== 'auto') : [];
    const target = $('model-list');
    if (!models.length) {
      target.innerHTML = '<div class="empty-state">当前没有可展示的启用模型。</div>';
      return;
    }
    target.innerHTML = models.map((model, index) => `
      <div class="table-row model-row" role="row">
        <span class="model-name"><span class="rank">${index + 1}</span><strong title="${escapeHtml(model.id)}">${escapeHtml(model.id)}</strong></span>
        <span class="provider-name">${escapeHtml(model.owned_by || 'unknown')}</span>
        <span class="model-status"><i class="status-dot"></i>已配置</span>
        <span class="availability">路由候选</span>
      </div>`).join('');
  }

  function renderTimeline(canary) {
    const events = [];
    if (canary.autoStop) events.push({ kind: 'danger', title: '安全开关触发', detail: canary.autoStop.reason || '自动停止', at: canary.autoStop.at });
    if (Number(canary.fallbackCount) > 0) events.push({ kind: 'warn', title: '发生模型回退', detail: `${number(canary.fallbackCount)} 次`, at: '当前进程累计' });
    if (Number(canary.incomplete) > 0) events.push({ kind: 'warn', title: '检测到不完整响应', detail: `${number(canary.incomplete)} 次`, at: '当前进程累计' });
    if (Number(canary.sampled) > 0) events.push({ kind: 'good', title: 'Canary 已采样', detail: `${number(canary.sampled)} 个请求`, at: '当前进程累计' });
    if (!events.length) {
      $('timeline').innerHTML = '<div class="empty-state">暂无异常信号。等待真实请求进入。</div>';
      return;
    }
    $('timeline').innerHTML = events.slice(0, 4).map((event) => `
      <div class="timeline-item"><span class="timeline-dot timeline-${event.kind}"></span><div><strong>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.detail)}</p></div><time>${escapeHtml(event.at || '—')}</time></div>`).join('');
  }

  function renderConfig(config) {
    const summary = config || {};
    const routing = summary.routing || {};
    const budget = summary.budget || {};
    const bindings = summary.bindings || {};
    const models = Array.isArray(summary.models) ? summary.models : [];
    const providers = Array.isArray(summary.providers) ? summary.providers : [];
    const modelCount = new Map();
    for (const model of models) modelCount.set(model.provider, (modelCount.get(model.provider) || 0) + 1);

    setText('config-strategy', routing.strategy || '未配置');
    setText('config-routing-detail', `${number(routing.maxRetries)} 次重试 · ${routing.failoverOnError ? '启用回退' : '关闭回退'}`);
    setText('config-budget', budget.allowPaid ? '允许付费' : '仅免费');
    setText('config-budget-detail', `单次上限 ${budget.maxRequestCost ?? '—'} · ${budget.strictModel ? '严格模型' : '可回退'}`);
    setText('config-binding-count', `${Object.keys(bindings).length} 个 Agent`);
    setText('config-binding-detail', `${models.filter((model) => model.enabled !== false).length} 个启用模型可被绑定`);

    const target = $('config-provider-rows');
    if (!providers.length) {
      target.innerHTML = '<div class="empty-state">当前没有 Provider 配置。</div>';
      return;
    }
    target.innerHTML = providers.map((provider) => `
      <div class="table-row model-row">
        <span class="model-name"><span class="rank">◈</span><strong title="${escapeHtml(provider.name)}">${escapeHtml(provider.name)}</strong></span>
        <span class="provider-name" title="${escapeHtml(provider.base_url)}">${escapeHtml(provider.api_type || '兼容接口')}</span>
        <span class="model-status"><i class="status-dot"></i>${provider.hasApiKey ? '已配置' : '未配置'}</span>
        <span class="availability">${number(modelCount.get(provider.name) || 0)} 个</span>
      </div>`).join('');
  }

  function setEditorMessage(text, kind = '') {
    const node = $('config-editor-message');
    node.textContent = text;
    node.className = kind ? `editor-message ${kind}` : 'editor-message';
  }

  function renderConfigEditor(editableConfig) {
    const editor = $('config-editor');
    if (!editor || configEditing || !editableConfig) return;
    editor.value = JSON.stringify(editableConfig || {}, null, 2);
    editor.readOnly = true;
    $('config-validate-button').disabled = true;
    $('config-apply-button').disabled = true;
    $('config-edit-button').textContent = '开始编辑';
    setEditorMessage('当前为只读预览，点击“开始编辑”后才可修改。');
  }

  function render(data, models) {
    const canary = data.canary || {};
    const stopped = canary.stopped === true;
    const active = canary.activeRequests ?? 0;
    const failed = Number(canary.failed || 0);
    const sampled = Number(canary.sampled || 0);
    const health = sampled > 0 ? Math.max(0, 100 - (failed / sampled * 100)) : null;

    setText('mode-value', data.mode || 'off');
    setText('enabled-value', data.enabled ? '智能层已启用' : '智能层关闭');
    setText('canary-value', canary.enabled ? `${canary.percentage ?? 0}%` : '关闭');
    setText('canary-foot', stopped ? '已停止采样' : '采样运行中');
    setText('active-value', number(active));
    setText('active-foot', `累计采样 ${number(canary.active)}`);
    setText('cost-value', `$${Number(canary.totalCost || 0).toFixed(4)}`);
    setText('cost-foot', `${number(canary.attempts)} 次尝试`);

    setText('route-mode', data.mode || 'off');
    setText('route-detail', data.enabled ? `${number(data.records)} 条 Shadow 记录 · 保留 ${number(data.retentionDays)} 天` : '智能层当前关闭，使用基础路由。');
    setText('health-title', health === null ? '数据待采集' : `${health.toFixed(1)}% 可观测完成率`);
    setText('health-detail', sampled ? `${number(failed)} 次失败 / ${number(sampled)} 次采样` : '需要真实请求后计算');
    $('health-ring').style.setProperty('--health', `${health ?? 0}%`);
    $('health-ring').classList.toggle('is-empty', health === null);
    $('health-ring').querySelector('span').textContent = health === null ? '—' : `${Math.round(health)}%`;

    setStatusPill('stop-state', stopped ? '已停止' : '运行中', stopped ? 'danger' : 'good');
    setStatusPill('safety-badge', stopped ? '需要复核' : '安全运行', stopped ? 'danger' : 'good');
    setText('safety-title', stopped ? 'Active Canary 已停止' : '安全策略正常');
    setText('stop-detail', canary.autoStop ? `${canary.autoStop.reason || '自动停止'} · ${canary.autoStop.at || '时间未知'}` : '当前没有自动停止原因。');

    setText('eligible-value', number(canary.eligible));
    setText('sampled-value', number(canary.sampled));
    setText('fallback-value', number(canary.fallbackCount));
    setText('incomplete-value', number(canary.incomplete));
    setText('provider-error-value', number(canary.consecutiveErrors?.provider_error));
    setText('decision-latency-value', canary.decisionLatencyMs ? `${Number(canary.decisionLatencyMs).toFixed(1)} ms` : '—');
    renderModels(models);
    renderTimeline(canary);
    renderConfig(data.config);
    renderConfigEditor(data.editableConfig);
  }

  async function refresh() {
    if (!adminToken) return;
    try {
      const [status, models] = await Promise.all([
        request('/_smart-router/intelligence/status'),
        request('/v1/models'),
      ]);
      render(status, models);
      setConnected(true);
      setMessage(`最近刷新：${new Date().toLocaleTimeString('zh-CN')}`, 'success');
    } catch (error) {
      setConnected(false);
      setMessage(`连接失败：${error.name === 'AbortError' ? '请求超时' : error.message}`, 'error');
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
      await request('/_smart-router/intelligence/kill', { method: 'POST' });
      await refresh();
      setMessage('Active Canary 已停止。', 'success');
    } catch (error) { setMessage(`停止失败：${error.message}`, 'error'); }
  });
  $('resume-button').addEventListener('click', async () => {
    try {
      await request('/_smart-router/intelligence/resume-shadow', { method: 'POST' });
      await refresh();
      setMessage('已恢复 Shadow；不会自动恢复 Active。', 'success');
    } catch (error) { setMessage(`恢复失败：${error.message}`, 'error'); }
  });

  $('config-edit-button').addEventListener('click', () => {
    configEditing = !configEditing;
    const editor = $('config-editor');
    editor.readOnly = !configEditing;
    $('config-validate-button').disabled = !configEditing;
    $('config-apply-button').disabled = !configEditing;
    $('config-edit-button').textContent = configEditing ? '结束编辑' : '开始编辑';
    setEditorMessage(configEditing ? '编辑模式：只修改路由、模型、Provider 和策略字段；保存前必须校验。' : '已退出编辑模式。');
  });

  async function submitConfig(path, successMessage) {
    let draft;
    try { draft = JSON.parse($('config-editor').value); } catch { setEditorMessage('JSON 格式错误，请先修正。', 'error'); return null; }
    try {
      const result = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: draft }) });
      setEditorMessage(successMessage, 'success');
      return result;
    } catch (error) {
      setEditorMessage(`配置操作失败：${error.message}`, 'error');
      return null;
    }
  }

  $('config-validate-button').addEventListener('click', async () => {
    const result = await submitConfig('/_smart-router/config/validate', '配置校验通过，尚未写入文件。');
    if (result?.warnings?.length) setEditorMessage(`校验通过，但有 ${result.warnings.length} 条提醒：${result.warnings[0]}`, 'warn');
  });

  $('config-apply-button').addEventListener('click', async () => {
    if (!window.confirm('确认写入配置？系统会先创建备份，保存后需要重启服务才会加载新配置。')) return;
    const result = await submitConfig('/_smart-router/config/apply', '配置已保存并完成备份。请重启服务使其生效。');
    if (result?.restartRequired) setEditorMessage(`配置已保存，备份：${result.backupName || '已创建'}；请重启服务后生效。`, 'success');
  });
})();
