(() => {
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  const publicRoot = document.querySelector('[data-events-app]');
  const adminRoot = document.querySelector('[data-events-admin-page]');

  const state = {
    month: startOfMonth(new Date()),
    items: [],
    selectedSlug: publicRoot?.dataset.eventSlug || '',
    selected: null,
    support: { roles: [], users: [], permissions: {}, permissionKeys: [] },
    can: {},
    q: '',
    visibility: ''
  };

  if (publicRoot || adminRoot) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }

  async function init() {
    bindEvents();
    await refreshSupport();
    hydrateRoleSelects();
    await refreshEvents();
  }

  function bindEvents() {
    document.querySelector('[data-calendar-prev]')?.addEventListener('click', async () => {
      state.month = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() - 1, 1));
      await refreshEvents();
    });
    document.querySelector('[data-calendar-next]')?.addEventListener('click', async () => {
      state.month = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
      await refreshEvents();
    });
    document.querySelector('[data-calendar-today]')?.addEventListener('click', async () => {
      state.month = startOfMonth(new Date());
      await refreshEvents();
    });
    document.querySelector('#eventsSearch')?.addEventListener('input', debounce(async (event) => {
      state.q = event.target.value || '';
      await refreshEvents();
    }, 200));
    document.querySelector('#eventsVisibilityFilter')?.addEventListener('change', async (event) => {
      state.visibility = event.target.value || '';
      await refreshEvents();
    });
    document.querySelectorAll('[data-open-event-editor]').forEach((button) => button.addEventListener('click', () => openEditor()));
    document.querySelector('[data-edit-selected-event]')?.addEventListener('click', () => openEditor(state.selected));
    document.querySelector('[data-delete-selected-event]')?.addEventListener('click', deleteSelectedEvent);
    document.querySelector('[data-save-event-permissions]')?.addEventListener('click', savePermissions);
    document.querySelector('[data-close-event-editor]')?.addEventListener('click', closeEditor);
    document.querySelector('#eventEditorForm')?.addEventListener('submit', saveEvent);
  }

  async function refreshSupport() {
    try {
      const support = await fetchJson('/api/admin/events/support-data');
      state.support = {
        roles: Array.isArray(support.roles) ? support.roles : [],
        users: Array.isArray(support.users) ? support.users : [],
        permissions: support.permissions || {},
        permissionKeys: Array.isArray(support.permissionKeys) ? support.permissionKeys : []
      };
      renderPermissions();
    } catch {
      state.support = { roles: [], users: [], permissions: {}, permissionKeys: [] };
    }
  }

  async function refreshEvents() {
    const params = new URLSearchParams();
    params.set('from', rangeStart().toISOString());
    params.set('to', rangeEnd().toISOString());
    if (state.q) params.set('q', state.q);
    if (state.visibility) params.set('visibility', state.visibility);
    if (adminRoot) params.set('admin', '1');
    const response = await fetchJson(`/api/events?${params.toString()}`);
    state.items = Array.isArray(response.items) ? response.items : [];
    state.can = response.can || {};
    document.querySelectorAll('[data-open-event-editor]').forEach((button) => {
      if (!adminRoot) button.hidden = !state.can.create;
    });
    renderCalendar();
    renderList();
    const selected = state.items.find((item) => item.slug === state.selectedSlug) || state.items[0] || null;
    if (selected) await selectEvent(selected.slug);
    else renderEmptyDetail();
  }

  async function selectEvent(slug) {
    try {
      state.selectedSlug = slug;
      state.selected = await fetchJson(`/api/events/event?slug=${encodeURIComponent(slug)}`);
      renderList();
      renderCalendar();
      renderDetail();
      if (publicRoot) history.replaceState(null, '', `/events/${encodeURIComponent(slug)}`);
    } catch (error) {
      showNotice(error.message || msg('eventNotFound', 'Event not found.'));
    }
  }

  function renderCalendar() {
    const target = document.querySelector('#eventsCalendarGrid');
    if (!target) return;
    const title = document.querySelector('#eventsCalendarTitle');
    if (title) title.textContent = state.month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const first = startOfCalendar(state.month);
    const days = Array.from({ length: 42 }, (_, index) => addDays(first, index));
    const weekdayLabels = Array.from({ length: 7 }, (_, index) => addDays(first, index).toLocaleDateString(undefined, { weekday: 'short' }));
    target.innerHTML = `
      ${weekdayLabels.map((label) => `<div class="events-weekday">${esc(label)}</div>`).join('')}
      ${days.map((day) => renderCalendarDay(day)).join('')}
    `;
    target.querySelectorAll('[data-event-slug]').forEach((button) => {
      button.addEventListener('click', () => selectEvent(button.dataset.eventSlug));
    });
  }

  function renderCalendarDay(day) {
    const inMonth = day.getUTCMonth() === state.month.getUTCMonth();
    const dateKey = dayKey(day);
    const events = state.items.filter((item) => dayKey(new Date(item.startDateTime)) === dateKey).slice(0, 4);
    return `
      <div class="events-calendar-day ${inMonth ? '' : 'muted'}">
        <span class="events-day-number">${day.getUTCDate()}</span>
        <div class="events-day-items">
          ${events.map((event) => `
            <button class="events-day-event ${state.selectedSlug === event.slug ? 'active' : ''}" type="button" data-event-slug="${esc(event.slug)}">
              ${esc(event.title)}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderList() {
    const target = adminRoot ? document.querySelector('#eventsAdminList') : document.querySelector('#eventsList');
    if (!target) return;
    target.innerHTML = state.items.length ? state.items.map((event) => `
      <button class="events-list-item ${state.selectedSlug === event.slug ? 'active' : ''}" type="button" data-list-event="${esc(event.slug)}">
        <span class="events-list-date">${esc(formatShortDate(event.startDateTime))}</span>
        <span><strong>${esc(event.title)}</strong><small>${esc(event.location || event.visibility)}</small></span>
        <span class="pill">${esc(event.myStatus || event.visibility)}</span>
      </button>
    `).join('') : `<div class="empty-state"><h1>${msg('noEvents', 'No events')}</h1><p>${msg('noEventsText', 'No events match the current view.')}</p></div>`;
    target.querySelectorAll('[data-list-event]').forEach((button) => button.addEventListener('click', () => selectEvent(button.dataset.listEvent)));
  }

  function renderDetail() {
    const target = adminRoot ? document.querySelector('#eventAdminDetail') : document.querySelector('#eventDetail');
    if (!target || !state.selected) return;
    const event = state.selected;
    const counts = event.participantCounts || {};
    target.innerHTML = `
      <article class="events-detail-card">
        <div class="events-detail-head">
          <div>
            <p class="eyebrow">${esc(event.visibility)}</p>
            <h2>${esc(event.title)}</h2>
            <p class="hint">${esc(formatDateRange(event))}</p>
          </div>
          <span class="pill">${esc(event.myStatus || msg('notRegistered', 'Not registered'))}</span>
        </div>
        ${event.location ? `<p><strong>${msg('location', 'Location')}:</strong> ${esc(event.location)}</p>` : ''}
        ${event.description ? `<p>${esc(event.description)}</p>` : ''}
        <dl class="events-stats">
          <div><dt>${msg('yes', 'Yes')}</dt><dd>${counts.yes || 0}</dd></div>
          <div><dt>${msg('maybe', 'Maybe')}</dt><dd>${counts.maybe || 0}</dd></div>
          <div><dt>${msg('waitlist', 'Waitlist')}</dt><dd>${counts.waitlist || 0}</dd></div>
          <div><dt>${msg('capacity', 'Capacity')}</dt><dd>${event.maxParticipants || msg('open', 'Open')}</dd></div>
        </dl>
        <div class="events-detail-actions">
          ${event.can?.rsvp ? renderRsvpButtons(event) : ''}
          ${event.can?.export ? `<a class="button ghost" href="/api/events/ical?slug=${encodeURIComponent(event.slug)}">${msg('icalExport', 'iCal export')}</a>` : ''}
          ${event.can?.edit ? `<button class="button ghost" type="button" data-detail-edit>${msg('edit', 'Edit')}</button>` : ''}
        </div>
        ${renderParticipants(event)}
      </article>
    `;
    target.querySelectorAll('[data-rsvp]').forEach((button) => button.addEventListener('click', () => rsvp(button.dataset.rsvp)));
    target.querySelector('[data-detail-edit]')?.addEventListener('click', () => openEditor(event));
    document.querySelector('[data-edit-selected-event]')?.toggleAttribute('hidden', !event.can?.edit);
    document.querySelector('[data-delete-selected-event]')?.toggleAttribute('hidden', !event.can?.delete);
  }

  function renderEmptyDetail() {
    const target = adminRoot ? document.querySelector('#eventAdminDetail') : document.querySelector('#eventDetail');
    if (target) target.innerHTML = `<div class="empty-state"><h1>${msg('selectEvent', 'Select an event')}</h1><p>${msg('selectEventText', 'Choose an event to see details and participants.')}</p></div>`;
  }

  function renderRsvpButtons(event) {
    return ['yes', 'maybe', 'no'].map((status) => `
      <button class="button ${event.myStatus === status ? 'primary' : 'ghost'}" type="button" data-rsvp="${status}">
        ${esc(statusLabel(status))}
      </button>
    `).join('');
  }

  function renderParticipants(event) {
    if (!Array.isArray(event.participants) || !event.participants.length) return '';
    return `
      <section class="events-participants">
        <h3>${msg('participants', 'Participants')}</h3>
        <div class="events-participant-list">
          ${event.participants.map((participant) => `
            <div class="events-participant-row">
              <span>${esc(participant.user?.name || participant.user?.email || '')}</span>
              <span class="pill">${esc(statusLabel(participant.status))}</span>
            </div>
          `).join('')}
        </div>
      </section>
    `;
  }

  async function rsvp(status) {
    if (!state.selected) return;
    const response = await fetchJson('/api/events/rsvp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: state.selected.slug, status })
    });
    state.selected = response.event;
    await refreshEvents();
  }

  function openEditor(event = null) {
    const dialog = document.querySelector('#eventEditorDialog');
    const form = document.querySelector('#eventEditorForm');
    if (!dialog || !form) return;
    hydrateRoleSelects();
    form.reset();
    form.elements.id.value = event?.id || '';
    form.elements.title.value = event?.title || '';
    form.elements.slug.value = event?.slug || '';
    form.elements.location.value = event?.location || '';
    form.elements.description.value = event?.description || '';
    form.elements.start_datetime.value = toLocalInput(event?.startDateTime || new Date().toISOString());
    form.elements.end_datetime.value = toLocalInput(event?.endDateTime || new Date(Date.now() + 60 * 60 * 1000).toISOString());
    form.elements.is_all_day.checked = Boolean(event?.isAllDay);
    form.elements.visibility.value = event?.visibility || 'public';
    form.elements.max_participants.value = event?.maxParticipants || '';
    form.elements.recurrence_type.value = event?.recurrence?.type || 'none';
    form.elements.recurrence_interval.value = event?.recurrence?.interval || 1;
    form.elements.recurrence_ends_at.value = event?.recurrence?.endsAt ? event.recurrence.endsAt.slice(0, 10) : '';
    form.elements.reminder_enabled.checked = Boolean(event?.reminder?.enabled);
    form.elements.reminder_minutes_before.value = event?.reminder?.minutesBefore ?? '';
    Array.from(form.elements.roles.options).forEach((option) => {
      option.selected = (event?.roles || []).includes(option.value);
    });
    dialog.showModal();
  }

  function closeEditor() {
    document.querySelector('#eventEditorDialog')?.close();
  }

  async function saveEvent(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const selectedRoles = Array.from(form.elements.roles.selectedOptions).map((option) => option.value);
    const payload = {
      id: form.elements.id.value ? Number(form.elements.id.value) : undefined,
      title: form.elements.title.value,
      slug: form.elements.slug.value,
      description: form.elements.description.value,
      location: form.elements.location.value,
      start_datetime: fromLocalInput(form.elements.start_datetime.value),
      end_datetime: fromLocalInput(form.elements.end_datetime.value),
      is_all_day: form.elements.is_all_day.checked,
      visibility: form.elements.visibility.value,
      max_participants: form.elements.max_participants.value,
      roles: selectedRoles,
      recurrence_type: form.elements.recurrence_type.value,
      recurrence_interval: form.elements.recurrence_interval.value,
      recurrence_ends_at: form.elements.recurrence_ends_at.value,
      reminder_enabled: form.elements.reminder_enabled.checked,
      reminder_minutes_before: form.elements.reminder_minutes_before.value
    };
    const response = await fetchJson('/api/events/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    closeEditor();
    state.selectedSlug = response.event.slug;
    await refreshEvents();
  }

  async function deleteSelectedEvent() {
    if (!state.selected || !confirm(msg('deleteEventConfirm', 'Delete this event?'))) return;
    await fetchJson(`/api/events/event/${state.selected.id}`, { method: 'DELETE' });
    state.selectedSlug = '';
    state.selected = null;
    await refreshEvents();
  }

  function hydrateRoleSelects() {
    document.querySelectorAll('[data-event-role-select]').forEach((select) => {
      select.innerHTML = state.support.roles.map((role) => `<option value="${esc(role.name)}">${esc(role.name)}</option>`).join('');
    });
  }

  function renderPermissions() {
    const target = document.querySelector('#eventsPermissionMatrix');
    if (!target) return;
    target.innerHTML = state.support.permissionKeys.map((key) => `
      <section class="permission-card">
        <div><strong>${esc(key)}</strong><p class="hint">${esc(permissionHint(key))}</p></div>
        <div class="permission-grid compact">
          ${state.support.roles.map((role) => `
            <label class="check">
              <input type="checkbox" data-event-permission="${esc(key)}" value="${esc(role.name)}" ${(state.support.permissions[key] || []).includes(role.name) ? 'checked' : ''}>
              <span>${esc(role.name)}</span>
            </label>
          `).join('')}
        </div>
      </section>
    `).join('');
  }

  async function savePermissions() {
    const permissions = {};
    state.support.permissionKeys.forEach((key) => { permissions[key] = []; });
    document.querySelectorAll('[data-event-permission]:checked').forEach((input) => {
      permissions[input.dataset.eventPermission].push(input.value);
    });
    const response = await fetchJson('/api/admin/events/permissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions })
    });
    state.support.permissions = response.permissions || permissions;
    renderPermissions();
    alert(msg('permissionsSaved', 'Permissions saved.'));
  }

  function permissionHint(key) {
    return ({
      'events.view': msg('eventsViewHint', 'May see events that match visibility rules.'),
      'events.create': msg('eventsCreateHint', 'May create new events.'),
      'events.edit_own': msg('eventsEditOwnHint', 'May edit own events.'),
      'events.manage_all': msg('eventsManageAllHint', 'May manage all events and permissions.'),
      'events.delete': msg('eventsDeleteHint', 'May delete events.'),
      'events.rsvp': msg('eventsRsvpHint', 'May answer RSVPs.'),
      'events.export': msg('eventsExportHint', 'May export iCal files.')
    })[key] || key;
  }

  function showNotice(message) {
    const target = adminRoot ? document.querySelector('#eventAdminDetail') : document.querySelector('#eventDetail');
    if (target) target.innerHTML = `<div class="notice">${esc(message)}</div>`;
  }

  function rangeStart() {
    return startOfCalendar(state.month);
  }

  function rangeEnd() {
    return addDays(rangeStart(), 42);
  }

  function startOfMonth(date) {
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), 1));
  }

  function startOfCalendar(date) {
    const first = startOfMonth(date);
    const day = first.getUTCDay();
    return addDays(first, -day);
  }

  function addDays(date, count) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + count);
    return next;
  }

  function dayKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function formatShortDate(value) {
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatDateRange(event) {
    const start = new Date(event.startDateTime);
    const end = new Date(event.endDateTime);
    return `${start.toLocaleString()} - ${end.toLocaleString()}`;
  }

  function statusLabel(status) {
    return ({ yes: msg('yes', 'Yes'), no: msg('no', 'No'), maybe: msg('maybe', 'Maybe'), waitlist: msg('waitlist', 'Waitlist') })[status] || status;
  }

  function toLocalInput(value) {
    const date = new Date(value);
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  function fromLocalInput(value) {
    return value ? new Date(value).toISOString() : '';
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
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
})();
