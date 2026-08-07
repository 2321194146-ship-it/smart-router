(() => {
  'use strict';

  let adminToken = '';
  let refreshTimer = null;
  let configEditing = false;
  let editableConfigDraft = null;
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

  const cloneJson = (value) => JSON.parse(JSON.stringify(value || {}));

  function renderSimpleConfig(summary, editableConfig) {
    if (!editableConfig) return;
    editableConfigDraft = cloneJson(editableConfig);
    const target = $('simple-config-content');
    const providerMeta = new Map((summary?.providers || []).map((provider) => [provider.name, provider]));
    const providers = Array.isArray(editableConfigDraft.providers) ? editableConfigDraft.providers : [];
    const models = Array.isArray(editableConfigDraft.models) ? editableConfigDraft.models : [];
    const routing = editableConfigDraft.routing || {};
    const intelligence = editableConfigDraft.intelligence || {};
    const budget = editableConfigDraft.budget || {};
    target.innerHTML = `
      <div class="simple-section">
        <div class="simple-heading"><div><span class="section-label">第一步</span><strong>选择路由方式</strong></div><span class="simple-hint">普通用户只需要调整这几项</span></div>
        <div class="simple-fields">
          <label>智能模式<select id="simple-intelligence-mode"><option value="off">关闭智能层</option><option value="shadow">Shadow 观察</option><option value="active_canary">Active Canary</option></select></label>
          <label>路由策略<select id="simple-routing-strategy"><option value="tier_weighted">按模型层级</option><option value="quality_first">质量优先</option><option value="cost_first">成本优先</option></select></label>
          <label>最大回退次数<input id="simple-max-retries" type="number" min="0" max="10" step="1"></label>
          <label class="switch-field"><span>失败自动回退</span><input id="simple-failover" type="checkbox"><i></i></label>
          <label class="switch-field"><span>允许付费模型</span><input id="simple-allow-paid" type="checkbox"><i></i></label>
          <label>单次成本上限<input id="simple-max-cost" type="number" min="0" step="0.01"></label>
        </div>
      </div>
      <div class="simple-section">
        <div class="simple-heading"><div><span class="section-label">第二步</span><strong>启用模型</strong></div><span class="simple-hint">关闭的模型不会进入候选池</span></div>
        <div class="model-toggle-grid">${models.length ? models.map((model) => `<label class="model-toggle"><input type="checkbox" data-model-id="${escapeHtml(model.id)}" ${model.enabled !== false ? 'checked' : ''}><span><strong>${escapeHtml(model.id)}</strong><small>${escapeHtml(model.provider)} · ${escapeHtml(model.tier || '未分层')} · ${model.paid ? '付费' : '免费'}</small></span></label>`).join('') : '<div class="empty-state">还没有模型配置。</div>'}</div>
      </div>
      <div class="simple-section">
        <div class="simple-heading"><div><span class="section-label">第三步</span><strong>Provider 连接</strong></div><button id="simple-add-provider" class="button button-secondary" type="button">＋ 添加自定义 Provider</button></div>
        <div class="simple-provider-grid">${providers.length ? providers.map((provider) => { const meta = providerMeta.get(provider.name) || {}; return `<div class="simple-provider-card"><div class="provider-card-title"><strong>${escapeHtml(provider.name)}</strong><span class="status-pill status-good"><span class="status-dot"></span>${meta.hasApiKey ? '密钥已配置' : '需要密钥'}</span></div><label>接口地址<input data-provider-url="${escapeHtml(provider.name)}" value="${escapeHtml(provider.base_url || '')}" inputmode="url"></label><label>接口类型<select data-provider-type="${escapeHtml(provider.name)}"><option value="openai" ${provider.api_type === 'openai' ? 'selected' : ''}>OpenAI 兼容</option><option value="anthropic_native" ${provider.api_type === 'anthropic_native' ? 'selected' : ''}>Anthropic 原生</option></select></label></div>`; }).join('') : '<div class="empty-state">还没有 Provider。</div>'}</div>
        <div id="new-provider-form" class="new-provider-form" hidden><label>Provider 名称<input id="new-provider-name" placeholder="例如：my-gateway"></label><label>接口地址<input id="new-provider-url" placeholder="https://api.example.com/v1" inputmode="url"></label><label>接口类型<select id="new-provider-type"><option value="openai">OpenAI 兼容</option><option value="anthropic_native">Anthropic 原生</option></select></label><label>API Key（只写入，不回显）<input id="new-provider-key" type="password" autocomplete="new-password" placeholder="输入后仅保存在本次草稿内存"></label><button id="new-provider-save" class="button button-primary" type="button">加入草稿</button></div>
      </div>
      <div class="simple-save-bar"><span id="simple-config-message" class="editor-message">修改后点击保存，服务会自动校验并创建备份。</span><button id="simple-save-button" class="button button-primary" type="button">校验并保存</button></div>`;

    $('simple-intelligence-mode').value = intelligence.mode || 'off';
    $('simple-routing-strategy').value = routing.strategy || 'tier_weighted';
    $('simple-max-retries').value = Number.isFinite(Number(routing.max_retries)) ? routing.max_retries : 0;
    $('simple-failover').checked = routing.failover_on_error !== false;
    $('simple-allow-paid').checked = budget.allowPaid !== false;
    $('simple-max-cost').value = Number.isFinite(Number(budget.maxRequestCost)) ? budget.maxRequestCost : 0;
    $('simple-add-provider').addEventListener('click', () => { $('new-provider-form').hidden = !$('new-provider-form').hidden; });
    $('new-provider-save').addEventListener('click', addProviderToDraft);
    $('simple-save-button').addEventListener('click', saveSimpleConfig);
  }

  function addProviderToDraft() {
    const name = $('new-provider-name').value.trim();
    const baseUrl = $('new-provider-url').value.trim();
    const apiKey = $('new-provider-key').value;
    if (!name || !baseUrl || !apiKey) { setEditorMessage('新增 Provider 需要填写名称、接口地址和 API Key。', 'error'); return; }
    if (editableConfigDraft.providers.some((provider) => provider.name === name)) { setEditorMessage('Provider 名称已存在，请换一个名称。', 'error'); return; }
    editableConfigDraft.providers.push({ name, base_url: baseUrl, api_type: $('new-provider-type').value, auth_header: $('new-provider-type').value === 'anthropic_native' ? 'x-api-key' : 'Authorization', auth_prefix: $('new-provider-type').value === 'anthropic_native' ? '' : 'Bearer ', api_key: apiKey });
    renderSimpleConfig({ providers: editableConfigDraft.providers.map(({ api_key: _key, ...provider }) => ({ ...provider, hasApiKey: true })) }, editableConfigDraft);
    setEditorMessage(`Provider ${name} 已加入当前草稿，保存后才会写入。`, 'success');
  }

  function collectSimpleDraft() {
    const draft = cloneJson(editableConfigDraft);
    draft.intelligence.mode = $('simple-intelligence-mode').value;
    draft.routing.strategy = $('simple-routing-strategy').value;
    draft.routing.max_retries = Number($('simple-max-retries').value);
    draft.routing.failover_on_error = $('simple-failover').checked;
    draft.budget.allowPaid = $('simple-allow-paid').checked;
    draft.budget.maxRequestCost = Number($('simple-max-cost').value);
    for (const model of draft.models) model.enabled = Boolean(document.querySelector(`[data-model-id="${CSS.escape(model.id)}"]`)?.checked);
    for (const provider of draft.providers) {
      const urlInput = document.querySelector(`[data-provider-url="${CSS.escape(provider.name)}"]`);
      const typeInput = document.querySelector(`[data-provider-type="${CSS.escape(provider.name)}"]`);
      if (urlInput) provider.base_url = urlInput.value.trim();
      if (typeInput) provider.api_type = typeInput.value;
    }
    return draft;
  }

  async function saveSimpleConfig() {
    const draft = collectSimpleDraft();
    const message = $('simple-config-message');
    try {
      const validation = await request('/_smart-router/config/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: draft }) });
      if (validation.warnings?.length) message.textContent = `校验通过：${validation.warnings[0]}`;
      if (!window.confirm('配置校验通过。确认保存并创建备份？保存后需要重启服务生效。')) return;
      const result = await request('/_smart-router/config/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: draft }) });
      message.textContent = `已保存并备份：${result.backupName || '已创建'}，请重启服务生效。`;
      message.className = 'editor-message success';
      editableConfigDraft = draft;
    } catch (error) {
      message.textContent = `保存失败：${error.message}`;
      message.className = 'editor-message error';
    }
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
    renderSimpleConfig(data.config, data.editableConfig);
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
