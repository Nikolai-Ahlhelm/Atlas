(() => {
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  const appRoot = document.querySelector('[data-announcements-app]');
  const adminRoot = document.querySelector('[data-announcements-admin-page]');
  const state = {
    items: [],
    selectedId: Number(appRoot?.dataset.announcementId || 0),
    selected: null,
    can: {},
    q: '',
    priority: '',
    status: 'active',
    support: { roles: [], users: [], permissions: {}, permissionKeys: [], can: {} }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  async function init() {
    await loadBanner();
    if (appRoot) {
      bindPublic();
      await loadPublic();
    }
    if (adminRoot) {
      bindAdmin();
      await loadAdmin();
    }
  }

  async function loadBanner() {
    if (document.querySelector('[data-announcement-banner]')) return;
    try {
      const response = await fetchJson('/api/announcements/banner');
      const items = Array.isArray(response.items) ? response.items : [];
      if (!items.length) return;
      const banner = document.createElement('aside');
      banner.className = 'announcement-global-banner';
      banner.dataset.announcementBanner = 'true';
      banner.innerHTML = `
        <div class="announcement-banner-strip">
          ${items.map(renderBannerItem).join('')}
        </div>
      `;
      const topbar = document.querySelector('.topbar');
      if (topbar) topbar.insertAdjacentElement('afterend', banner);
      else document.body.prepend(banner);
      banner.querySelectorAll('[data-banner-ack]').forEach((button) => button.addEventListener('click', async () => {
        await acknowledge(Number(button.dataset.bannerAck));
        banner.remove();
        await loadBanner();
      }));
    } catch {
      // Logged-out or unauthorized pages simply do not show the global banner.
    }
  }

  function renderBannerItem(item) {
    return `
      <article class="announcement-banner-item priority-${esc(item.priority)}">
        <span class="announcement-priority-dot"></span>
        <div><strong>${esc(item.title)}</strong><small>${esc(priorityLabel(item.priority))}${item.isPinned ? ` · ${msg('pinned', 'Pinned')}` : ''}</small></div>
        <a class="button small ghost" href="/announcements/${item.id}">${msg('open', 'Open')}</a>
        ${item.can?.acknowledge ? `<button class="button small primary" type="button" data-banner-ack="${item.id}">${msg('acknowledge', 'Acknowledge')}</button>` : ''}
      </article>
    `;
  }

  function bindPublic() {
    document.querySelector('#announcementSearch')?.addEventListener('input', debounce(async (event) => {
      state.q = event.target.value || '';
      await loadPublic();
    }, 220));
    document.querySelector('#announcementPriorityFilter')?.addEventListener('change', async (event) => {
      state.priority = event.target.value || '';
      await loadPublic();
    });
    document.querySelector('#announcementStatusFilter')?.addEventListener('change', async (event) => {
      state.status = event.target.value || 'active';
      await loadPublic();
    });
  }

  async function loadPublic() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.priority) params.set('priority', state.priority);
    if (state.status) params.set('status', state.status);
    const response = await fetchJson(`/api/announcements?${params.toString()}`);
    state.items = response.items || [];
    state.can = response.can || {};
    renderPublicList();
    const selected = state.items.find((item) => item.id === state.selectedId) || state.items[0] || null;
    if (selected) selectPublic(selected.id);
    else renderEmptyDetail('#announcementDetail');
  }

  async function selectPublic(id) {
    state.selectedId = Number(id);
    state.selected = await fetchJson(`/api/announcements/detail?id=${encodeURIComponent(id)}`);
    renderPublicList();
    renderDetail('#announcementDetail', state.selected, false);
    history.replaceState(null, '', `/announcements/${encodeURIComponent(id)}`);
  }

  function renderPublicList() {
    const target = document.querySelector('#announcementsList');
    if (!target) return;
    target.innerHTML = state.items.length ? state.items.map(renderListItem).join('') : renderEmpty(msg('noAnnouncements', 'No announcements'), msg('noAnnouncementsText', 'No announcements match this view.'));
    target.querySelectorAll('[data-select-announcement]').forEach((button) => button.addEventListener('click', () => selectPublic(Number(button.dataset.selectAnnouncement))));
  }

  function renderListItem(item) {
    return `
      <button class="announcement-list-item priority-${esc(item.priority)} ${state.selectedId === item.id ? 'active' : ''}" type="button" data-select-announcement="${item.id}">
        <span class="announcement-priority-dot"></span>
        <span><strong>${esc(item.title)}</strong><small>${esc(listMeta(item))}</small></span>
        ${item.requiresAcknowledgement ? `<span class="pill ${item.acknowledged ? 'success' : ''}">${item.acknowledged ? msg('acknowledged', 'Acknowledged') : msg('ackRequired', 'Ack required')}</span>` : ''}
      </button>
    `;
  }

  function bindAdmin() {
    document.querySelector('[data-new-announcement]')?.addEventListener('click', () => openEditor());
    document.querySelector('[data-edit-announcement]')?.addEventListener('click', () => openEditor(state.selected));
    document.querySelector('[data-delete-announcement]')?.addEventListener('click', deleteSelected);
    document.querySelector('[data-save-announcement-permissions]')?.addEventListener('click', savePermissions);
    document.querySelector('[data-close-announcement-editor]')?.addEventListener('click', () => document.querySelector('#announcementEditorDialog')?.close());
    document.querySelector('#announcementEditorForm')?.addEventListener('submit', saveAnnouncement);
  }

  async function loadAdmin() {
    state.support = await fetchJson('/api/admin/announcements/support-data');
    const response = await fetchJson('/api/admin/announcements');
    state.items = response.items || [];
    state.can = response.can || {};
    renderAdminList();
    renderPermissions();
    const selected = state.items.find((item) => item.id === state.selectedId) || state.items[0] || null;
    if (selected) await selectAdmin(selected.id);
    else renderEmptyDetail('#announcementsAdminDetail');
  }

  async function selectAdmin(id) {
    state.selectedId = Number(id);
    state.selected = state.items.find((item) => item.id === state.selectedId) || null;
    renderAdminList();
    renderDetail('#announcementsAdminDetail', state.selected, true);
    document.querySelector('[data-edit-announcement]')?.toggleAttribute('hidden', !state.selected?.can?.edit);
    document.querySelector('[data-delete-announcement]')?.toggleAttribute('hidden', !state.selected?.can?.delete);
    if (state.selected) await renderAcknowledgements(state.selected.id);
  }

  function renderAdminList() {
    const target = document.querySelector('#announcementsAdminList');
    if (!target) return;
    target.innerHTML = state.items.length ? state.items.map(renderListItem).join('') : renderEmpty(msg('noAnnouncements', 'No announcements'), msg('noAnnouncementsText', 'No announcements match this view.'));
    target.querySelectorAll('[data-select-announcement]').forEach((button) => button.addEventListener('click', () => selectAdmin(Number(button.dataset.selectAnnouncement))));
  }

  function renderDetail(selector, item, adminMode) {
    const target = document.querySelector(selector);
    if (!target || !item) return;
    target.innerHTML = `
      <article class="announcement-detail-card priority-${esc(item.priority)}">
        <div class="announcement-detail-head">
          <div><p class="eyebrow">${esc(priorityLabel(item.priority))}</p><h2>${esc(item.title)}</h2><p class="hint">${esc(listMeta(item))}</p></div>
          <div class="announcement-badges">${item.isPinned ? `<span class="pill">${msg('pinned', 'Pinned')}</span>` : ''}${item.requiresAcknowledgement ? `<span class="pill ${item.acknowledged ? 'success' : ''}">${item.acknowledged ? msg('acknowledged', 'Acknowledged') : msg('ackRequired', 'Ack required')}</span>` : ''}</div>
        </div>
        <div class="announcement-content">${nl2br(item.content)}</div>
        <div class="announcement-detail-actions">
          ${item.can?.acknowledge ? `<button class="button primary" type="button" data-acknowledge="${item.id}">${msg('acknowledge', 'Acknowledge')}</button>` : ''}
          ${adminMode ? `<span class="hint">${msg('acknowledgements', 'Acknowledgements')}: ${item.acknowledgementCount || 0}${item.targetCount === null || item.targetCount === undefined ? '' : ` / ${item.targetCount}`}</span>` : ''}
        </div>
        ${adminMode ? '<div id="announcementAcknowledgements" class="announcement-ack-list"></div>' : ''}
      </article>
    `;
    target.querySelector('[data-acknowledge]')?.addEventListener('click', async (event) => {
      await acknowledge(Number(event.currentTarget.dataset.acknowledge));
      if (appRoot) await loadPublic();
    });
  }

  async function renderAcknowledgements(id) {
    const target = document.querySelector('#announcementAcknowledgements');
    if (!target) return;
    const response = await fetchJson(`/api/admin/announcements/${id}/acknowledgements`);
    target.innerHTML = `
      <h3>${msg('acknowledgementOverview', 'Acknowledgement overview')}</h3>
      ${(response.users || []).map((entry) => `<div class="announcement-ack-row"><span>${esc(entry.user?.name || entry.user?.email || '')}</span><span class="pill ${entry.acknowledgedAt ? 'success' : ''}">${entry.acknowledgedAt ? formatDate(entry.acknowledgedAt) : msg('pending', 'Pending')}</span></div>`).join('') || `<p class="hint">${msg('noTargetUsers', 'No target users.')}</p>`}
    `;
  }

  function openEditor(item = null) {
    const form = document.querySelector('#announcementEditorForm');
    if (!form) return;
    form.reset();
    form.elements.id.value = item?.id || '';
    form.elements.title.value = item?.title || '';
    form.elements.content.value = item?.content || '';
    form.elements.priority.value = item?.priority || 'normal';
    form.elements.starts_at.value = toLocalInput(item?.startsAt);
    form.elements.ends_at.value = toLocalInput(item?.endsAt);
    form.elements.is_pinned.checked = Boolean(item?.isPinned);
    form.elements.requires_acknowledgement.checked = Boolean(item?.requiresAcknowledgement);
    renderTargetPickers(item);
    document.querySelector('#announcementEditorDialog')?.showModal();
  }

  function renderTargetPickers(item = null) {
    const rolesTarget = document.querySelector('#announcementRoleTargets');
    const usersTarget = document.querySelector('#announcementUserTargets');
    const roles = item?.targetRoles || [];
    const users = item?.targetUserIds || [];
    if (rolesTarget) rolesTarget.innerHTML = `<fieldset><legend>${msg('roles', 'Roles')}</legend>${(state.support.roles || []).map((role) => `<label class="check"><input type="checkbox" data-target-role value="${esc(role.name)}" ${roles.includes(role.name) ? 'checked' : ''}><span>${esc(role.name)}</span></label>`).join('')}</fieldset>`;
    if (usersTarget) usersTarget.innerHTML = `<fieldset><legend>${msg('people', 'People')}</legend>${(state.support.users || []).map((user) => `<label class="check"><input type="checkbox" data-target-user value="${user.id}" ${users.includes(user.id) ? 'checked' : ''}><span>${esc(user.name || user.email)}</span></label>`).join('')}</fieldset>`;
  }

  async function saveAnnouncement(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      id: form.elements.id.value || undefined,
      title: form.elements.title.value,
      content: form.elements.content.value,
      priority: form.elements.priority.value,
      starts_at: form.elements.starts_at.value,
      ends_at: form.elements.ends_at.value,
      is_pinned: form.elements.is_pinned.checked,
      requires_acknowledgement: form.elements.requires_acknowledgement.checked,
      target_roles: Array.from(document.querySelectorAll('[data-target-role]:checked')).map((input) => input.value),
      target_user_ids: Array.from(document.querySelectorAll('[data-target-user]:checked')).map((input) => Number(input.value))
    };
    const response = await fetchJson('/api/admin/announcements', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(payload) });
    state.items = response.items || [];
    document.querySelector('#announcementEditorDialog')?.close();
    await loadAdmin();
  }

  async function deleteSelected() {
    if (!state.selected || !confirm(msg('deleteConfirm', 'Delete this item?'))) return;
    await fetchJson(`/api/admin/announcements/${state.selected.id}`, { method: 'DELETE' });
    state.selectedId = 0;
    await loadAdmin();
  }

  async function acknowledge(id) {
    await fetchJson('/api/announcements/acknowledge', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ id }) });
  }

  function renderPermissions() {
    const target = document.querySelector('#announcementsPermissions');
    if (!target) return;
    target.innerHTML = (state.support.permissionKeys || []).map((key) => `
      <section class="permission-card">
        <div><strong>${esc(key)}</strong><p class="hint">${esc(permissionHint(key))}</p></div>
        <div class="permission-grid compact">${(state.support.roles || []).map((role) => `<label class="check"><input type="checkbox" data-announcement-permission="${esc(key)}" value="${esc(role.name)}" ${(state.support.permissions[key] || []).includes(role.name) ? 'checked' : ''}><span>${esc(role.name)}</span></label>`).join('')}</div>
      </section>
    `).join('');
  }

  async function savePermissions() {
    const permissions = {};
    (state.support.permissionKeys || []).forEach((key) => { permissions[key] = []; });
    document.querySelectorAll('[data-announcement-permission]:checked').forEach((input) => permissions[input.dataset.announcementPermission].push(input.value));
    const response = await fetchJson('/api/admin/announcements/permissions', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ permissions }) });
    state.support.permissions = response.permissions || permissions;
    renderPermissions();
  }

  function renderEmptyDetail(selector) {
    const target = document.querySelector(selector);
    if (target) target.innerHTML = renderEmpty(msg('selectAnnouncement', 'Select an announcement'), msg('selectAnnouncementText', 'Choose an announcement to see details.'));
  }

  function listMeta(item) {
    const parts = [priorityLabel(item.priority)];
    if (item.startsAt) parts.push(`${msg('startsAt', 'Starts at')}: ${formatDate(item.startsAt)}`);
    if (item.endsAt) parts.push(`${msg('endsAt', 'Ends at')}: ${formatDate(item.endsAt)}`);
    if (!item.active) parts.push(msg('inactive', 'Inactive'));
    return parts.join(' · ');
  }

  function priorityLabel(priority) {
    return ({ low: msg('low', 'Low'), normal: msg('normal', 'Normal'), high: msg('high', 'High'), critical: msg('critical', 'Critical') })[priority] || priority;
  }

  function permissionHint(key) {
    return ({
      'announcements.view': msg('announcementsViewHint', 'May view targeted announcements.'),
      'announcements.create': msg('announcementsCreateHint', 'May create announcements.'),
      'announcements.edit': msg('announcementsEditHint', 'May edit announcements.'),
      'announcements.delete': msg('announcementsDeleteHint', 'May delete announcements.'),
      'announcements.acknowledge': msg('announcementsAcknowledgeHint', 'May acknowledge announcements.'),
      'announcements.manage': msg('announcementsManageHint', 'May manage targeting, acknowledgements and permissions.')
    })[key] || key;
  }

  function renderEmpty(title, text) {
    return `<div class="empty-state"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
  }

  function toLocalInput(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatDate(value) {
    return value ? new Date(value).toLocaleString() : '';
  }

  function nl2br(value = '') {
    return esc(value).replace(/\n/g, '<br>');
  }

  function jsonHeaders() {
    return { 'content-type': 'application/json' };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new Error(data?.error || text || response.statusText);
    return data;
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function readPortalI18n() {
    try { return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}'); } catch { return {}; }
  }
})();
