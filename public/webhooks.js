(() => {
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  const root = document.querySelector('[data-webhooks-admin-page]');
  const state = {
    endpoints: [],
    selectedId: 0,
    selected: null,
    deliveries: [],
    support: { eventCatalog: [], permissions: {}, permissionKeys: [], roles: [], can: {} }
  };

  if (root) {
    injectCss(root.dataset.cssHref);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }

  async function init() {
    bind();
    await loadAll();
  }

  function bind() {
    document.querySelector('[data-new-webhook]')?.addEventListener('click', () => openEditor());
    document.querySelector('[data-edit-webhook]')?.addEventListener('click', () => openEditor(state.selected));
    document.querySelector('[data-delete-webhook]')?.addEventListener('click', deleteSelected);
    document.querySelector('[data-refresh-deliveries]')?.addEventListener('click', loadDeliveries);
    document.querySelector('[data-save-webhook-permissions]')?.addEventListener('click', savePermissions);
    document.querySelector('[data-close-webhook-dialog]')?.addEventListener('click', () => document.querySelector('#webhookEndpointDialog')?.close());
    document.querySelector('#webhookEndpointForm')?.addEventListener('submit', saveEndpoint);
    document.querySelector('#webhookPreviewEvent')?.addEventListener('change', renderPayloadPreview);
  }

  async function loadAll() {
    state.support = await fetchJson('/api/admin/webhooks/support-data');
    await loadEndpoints();
    await loadDeliveries();
    renderPermissions();
  }

  async function loadEndpoints() {
    const response = await fetchJson('/api/admin/webhooks/endpoints');
    state.endpoints = response.items || [];
    state.selected = state.endpoints.find((item) => item.id === state.selectedId) || state.endpoints[0] || null;
    state.selectedId = state.selected?.id || 0;
    renderEndpointList();
    renderDetail();
  }

  async function loadDeliveries() {
    const params = new URLSearchParams();
    if (state.selectedId) params.set('endpointId', state.selectedId);
    const response = await fetchJson(`/api/admin/webhooks/deliveries?${params.toString()}`);
    state.deliveries = response.items || [];
    renderDeliveries();
  }

  function renderEndpointList() {
    const target = document.querySelector('#webhookEndpointList');
    if (!target) return;
    target.innerHTML = state.endpoints.length ? state.endpoints.map((endpoint) => `
      <button class="webhook-endpoint-row ${endpoint.id === state.selectedId ? 'active' : ''}" type="button" data-webhook-endpoint="${endpoint.id}">
        <span><strong>${esc(endpoint.name)}</strong><small>${esc(endpoint.url)}</small></span>
        <span class="pill ${endpoint.isActive ? 'success' : ''}">${endpoint.isActive ? msg('active', 'Active') : msg('inactive', 'Inactive')}</span>
      </button>
    `).join('') : renderEmpty(msg('noEndpoints', 'No endpoints'), msg('noEndpointsText', 'Create an endpoint to start sending webhooks.'));
    target.querySelectorAll('[data-webhook-endpoint]').forEach((button) => button.addEventListener('click', async () => {
      state.selectedId = Number(button.dataset.webhookEndpoint);
      state.selected = state.endpoints.find((item) => item.id === state.selectedId) || null;
      renderEndpointList();
      renderDetail();
      await loadDeliveries();
    }));
  }

  function renderDetail() {
    const target = document.querySelector('#webhookEndpointDetail');
    if (!target) return;
    document.querySelector('[data-edit-webhook]')?.toggleAttribute('hidden', !state.selected || !state.support.can.edit);
    document.querySelector('[data-delete-webhook]')?.toggleAttribute('hidden', !state.selected || !state.support.can.delete);
    if (!state.selected) {
      target.innerHTML = renderEmpty(msg('selectEndpoint', 'Select an endpoint'), msg('selectEndpointText', 'Choose an endpoint to see details.'));
      return;
    }
    const endpoint = state.selected;
    target.innerHTML = `
      <article class="webhook-detail-card">
        <div class="webhook-detail-head">
          <div><p class="eyebrow">${endpoint.isActive ? msg('active', 'Active') : msg('inactive', 'Inactive')}</p><h2>${esc(endpoint.name)}</h2><p class="hint">${esc(endpoint.url)}</p></div>
          <span class="pill">${endpoint.hasSecret ? msg('signed', 'Signed') : msg('unsigned', 'Unsigned')}</span>
        </div>
        <section><h3>${msg('events', 'Events')}</h3><div class="webhook-event-pills">${endpoint.events.map((event) => `<span class="pill">${esc(event)}</span>`).join('') || `<span class="hint">${msg('noSubscriptions', 'No subscriptions')}</span>`}</div></section>
        <section><h3>${msg('lastDelivery', 'Last delivery')}</h3>${endpoint.lastDelivery ? renderDeliverySummary(endpoint.lastDelivery) : `<p class="hint">${msg('noDeliveries', 'No deliveries yet.')}</p>`}</section>
        <section class="webhook-test-row"><select data-test-event>${state.support.eventCatalog.map((event) => `<option value="${esc(event)}">${esc(event)}</option>`).join('')}</select><button class="button primary" type="button" data-send-test>${msg('sendTest', 'Send test')}</button></section>
      </article>
    `;
    target.querySelector('[data-send-test]')?.addEventListener('click', async () => {
      const eventName = target.querySelector('[data-test-event]')?.value || 'webhook.test';
      await fetchJson('/api/admin/webhooks/test', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ endpointId: endpoint.id, eventName }) });
      await loadEndpoints();
      await loadDeliveries();
    });
  }

  function renderDeliverySummary(delivery) {
    return `<div class="webhook-delivery-summary"><span class="pill ${delivery.status === 'delivered' ? 'success' : delivery.status === 'failed' ? 'danger' : ''}">${esc(delivery.status)}</span><span>${esc(delivery.eventName)}</span><span>${delivery.responseStatusCode || '-'}</span><small>${formatDate(delivery.lastAttemptAt || delivery.createdAt)}</small></div>`;
  }

  function renderDeliveries() {
    const target = document.querySelector('#webhookDeliveries');
    if (!target) return;
    target.innerHTML = state.deliveries.length ? state.deliveries.map((delivery) => `
      <details class="webhook-delivery-row">
        <summary>${renderDeliverySummary(delivery)}</summary>
        <div class="webhook-delivery-body">
          <pre>${esc(prettyJson(delivery.payloadJson))}</pre>
          <pre>${esc(delivery.responseBody || '')}</pre>
          <div class="row-actions"><span class="hint">${msg('attempts', 'Attempts')}: ${delivery.attemptCount}</span><span class="hint">${msg('nextAttempt', 'Next attempt')}: ${delivery.nextAttemptAt ? formatDate(delivery.nextAttemptAt) : '-'}</span><button class="button small ghost" type="button" data-retry-delivery="${delivery.id}">${msg('retry', 'Retry')}</button></div>
        </div>
      </details>
    `).join('') : renderEmpty(msg('noDeliveries', 'No deliveries yet.'), msg('noDeliveriesText', 'Deliveries appear here after events are sent.'));
    target.querySelectorAll('[data-retry-delivery]').forEach((button) => button.addEventListener('click', async () => {
      await fetchJson(`/api/admin/webhooks/deliveries/${button.dataset.retryDelivery}/retry`, { method: 'POST' });
      await loadEndpoints();
      await loadDeliveries();
    }));
  }

  function openEditor(endpoint = null) {
    const form = document.querySelector('#webhookEndpointForm');
    if (!form) return;
    form.reset();
    form.elements.id.value = endpoint?.id || '';
    form.elements.name.value = endpoint?.name || '';
    form.elements.url.value = endpoint?.url || '';
    form.elements.secret.value = '';
    form.elements.is_active.checked = endpoint ? endpoint.isActive : true;
    renderEventPicker(endpoint?.events || []);
    renderPayloadPreview();
    document.querySelector('#webhookEndpointDialog')?.showModal();
  }

  function renderEventPicker(selected = []) {
    const picker = document.querySelector('#webhookEventPicker');
    const preview = document.querySelector('#webhookPreviewEvent');
    if (picker) picker.innerHTML = state.support.eventCatalog.map((event) => `<label class="check"><input type="checkbox" data-webhook-event value="${esc(event)}" ${selected.includes(event) ? 'checked' : ''}><span>${esc(event)}</span></label>`).join('');
    if (preview) preview.innerHTML = state.support.eventCatalog.map((event) => `<option value="${esc(event)}">${esc(event)}</option>`).join('');
  }

  function renderPayloadPreview() {
    const eventName = document.querySelector('#webhookPreviewEvent')?.value || 'webhook.test';
    const target = document.querySelector('#webhookPayloadPreview');
    if (!target) return;
    target.textContent = JSON.stringify({
      id: '00000000-0000-4000-8000-000000000000',
      event: eventName,
      createdAt: new Date().toISOString(),
      source: { atlas: 'core', plugin: eventName.split('.')[0] },
      data: { example: true }
    }, null, 2);
  }

  async function saveEndpoint(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      id: form.elements.id.value || undefined,
      name: form.elements.name.value,
      url: form.elements.url.value,
      is_active: form.elements.is_active.checked,
      events: Array.from(document.querySelectorAll('[data-webhook-event]:checked')).map((input) => input.value)
    };
    if (form.elements.secret.value) payload.secret = form.elements.secret.value;
    const response = await fetchJson('/api/admin/webhooks/endpoints', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(payload) });
    state.endpoints = response.items || [];
    document.querySelector('#webhookEndpointDialog')?.close();
    await loadEndpoints();
    await loadDeliveries();
  }

  async function deleteSelected() {
    if (!state.selected || !confirm(msg('deleteConfirm', 'Delete this item?'))) return;
    await fetchJson(`/api/admin/webhooks/endpoints/${state.selected.id}`, { method: 'DELETE' });
    state.selectedId = 0;
    await loadEndpoints();
    await loadDeliveries();
  }

  function renderPermissions() {
    const target = document.querySelector('#webhookPermissions');
    if (!target) return;
    target.innerHTML = state.support.permissionKeys.map((key) => `
      <section class="permission-card">
        <div><strong>${esc(key)}</strong><p class="hint">${esc(permissionHint(key))}</p></div>
        <div class="permission-grid compact">${state.support.roles.map((role) => `<label class="check"><input type="checkbox" data-webhook-permission="${esc(key)}" value="${esc(role.name)}" ${(state.support.permissions[key] || []).includes(role.name) ? 'checked' : ''}><span>${esc(role.name)}</span></label>`).join('')}</div>
      </section>
    `).join('');
  }

  async function savePermissions() {
    const permissions = {};
    state.support.permissionKeys.forEach((key) => { permissions[key] = []; });
    document.querySelectorAll('[data-webhook-permission]:checked').forEach((input) => permissions[input.dataset.webhookPermission].push(input.value));
    const response = await fetchJson('/api/admin/webhooks/permissions', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ permissions }) });
    state.support.permissions = response.permissions || permissions;
    renderPermissions();
  }

  function permissionHint(key) {
    return ({
      'webhooks.view': msg('webhooksViewHint', 'May view webhook endpoints.'),
      'webhooks.create': msg('webhooksCreateHint', 'May create endpoints.'),
      'webhooks.edit': msg('webhooksEditHint', 'May edit endpoints and permissions.'),
      'webhooks.delete': msg('webhooksDeleteHint', 'May delete endpoints.'),
      'webhooks.test': msg('webhooksTestHint', 'May send tests and retry deliveries.'),
      'webhooks.view_deliveries': msg('webhooksViewDeliveriesHint', 'May view delivery logs.')
    })[key] || key;
  }

  function renderEmpty(title, text) {
    return `<div class="empty-state"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
  }

  function prettyJson(value) {
    try { return JSON.stringify(JSON.parse(value || '{}'), null, 2); } catch { return value || ''; }
  }

  function formatDate(value) {
    return value ? new Date(value).toLocaleString() : '';
  }

  function jsonHeaders() {
    return { 'content-type': 'application/json' };
  }

  function injectCss(href) {
    if (!href || Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((link) => link.href === new URL(href, location.href).href)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new Error(data?.error || text || response.statusText);
    return data;
  }

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function readPortalI18n() {
    try { return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}'); } catch { return {}; }
  }
})();
