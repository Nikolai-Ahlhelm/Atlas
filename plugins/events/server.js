import { join } from 'node:path';

const EVENT_PERMISSION_KEYS = [
  'events.view',
  'events.create',
  'events.edit_own',
  'events.manage_all',
  'events.delete',
  'events.rsvp',
  'events.export'
];
const RSVP_STATUSES = new Set(['yes', 'no', 'maybe']);
const PARTICIPANT_STATUSES = new Set(['yes', 'no', 'maybe', 'waitlist']);
const RECURRENCE_TYPES = new Set(['none', 'daily', 'weekly', 'monthly']);
const VISIBILITIES = new Set(['public', 'private', 'roles']);
const MAX_OCCURRENCES = 370;

export default function createEventsPlugin({ manifest, rootDir }) {
  let db = null;
  let helpers = null;

  const feature = {
    key: manifest.key || 'events',
    label: manifest.name || 'Events',
    href: '/events',
    description: manifest.description || 'Calendar events with RSVP, recurrence, waitlists and iCal export.',
    defaultEnabled: true
  };

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    localesDir: join(rootDir, 'locales'),
    adminPage: {
      href: '/admin/events',
      label: manifest.name || 'Events'
    },
    init(context) {
      db = context.db;
      helpers = context;
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          location TEXT NOT NULL DEFAULT '',
          start_datetime TEXT NOT NULL,
          end_datetime TEXT NOT NULL,
          is_all_day INTEGER NOT NULL DEFAULT 0,
          visibility TEXT NOT NULL DEFAULT 'public',
          max_participants INTEGER,
          roles_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active',
          reminder_enabled INTEGER NOT NULL DEFAULT 0,
          reminder_minutes_before INTEGER,
          created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS event_participants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(event_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS event_recurrences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
          recurrence_type TEXT NOT NULL DEFAULT 'none',
          interval INTEGER NOT NULL DEFAULT 1,
          ends_at TEXT
        );
        CREATE TABLE IF NOT EXISTS event_permissions (
          permission_key TEXT NOT NULL,
          role_name TEXT NOT NULL,
          PRIMARY KEY (permission_key, role_name)
        );
        CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_datetime);
        CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
        CREATE INDEX IF NOT EXISTS idx_event_participants_event ON event_participants(event_id, status);
      `);
      seedDefaultPermissions();
    },
    resetToFactoryDefaults(context) {
      context.db.exec(`
        DELETE FROM event_participants;
        DELETE FROM event_recurrences;
        DELETE FROM event_permissions;
        DELETE FROM events;
        DELETE FROM sqlite_sequence WHERE name IN ('events', 'event_participants', 'event_recurrences');
      `);
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/events/support-data' && req.method === 'GET') {
        return requirePermission(context, 'events.manage_all', () => context.sendJson(res, 200, {
          roles: context.listRoles(),
          users: context.listUsers().map((item) => context.publicUser(item)),
          permissions: getPermissionMatrix(),
          permissionKeys: EVENT_PERMISSION_KEYS
        }));
      }
      if (url.pathname === '/api/admin/events/permissions' && req.method === 'POST') {
        return requirePermission(context, 'events.manage_all', () => handleSavePermissions(context));
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        return requireEnabled(context, () => requirePermission(context, 'events.view', () => handleListEvents(context)));
      }
      if (url.pathname === '/api/events/event' && req.method === 'GET') {
        return requireEnabled(context, () => requirePermission(context, 'events.view', () => handleGetEvent(context)));
      }
      if (url.pathname === '/api/events/event' && req.method === 'POST') {
        return requireEnabled(context, () => handleSaveEvent(context));
      }
      if (url.pathname.startsWith('/api/events/event/') && req.method === 'DELETE') {
        return requireEnabled(context, () => handleDeleteEvent(context));
      }
      if (url.pathname === '/api/events/rsvp' && req.method === 'POST') {
        return requireEnabled(context, () => requirePermission(context, 'events.rsvp', () => handleRsvp(context)));
      }
      if (url.pathname === '/api/events/ical' && req.method === 'GET') {
        return requireEnabled(context, () => requirePermission(context, 'events.export', () => handleIcal(context)));
      }

      if (url.pathname === '/events' || url.pathname.startsWith('/events/')) {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'eventsFeatureDisabledNotice', 'The events feature is currently disabled.') }));
          return true;
        }
        if (!hasPermission(user, 'events.view')) {
          context.sendHtml(res, 403, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'eventsViewRequired', 'Events permissions are required.') }));
          return true;
        }
        context.sendHtml(res, 200, renderEventsPage(context));
        return true;
      }

      if (url.pathname === '/admin/events') {
        return requirePermission(context, 'events.manage_all', () => context.sendHtml(res, 200, renderEventsAdminPage(context)));
      }

      return false;
    }
  };

  async function requireEnabled(context, callback) {
    if (!context.isPluginEnabled(feature.key)) {
      context.sendJson(context.res, 404, { error: context.tf(context.locale, 'eventsFeatureDisabled', 'The events feature is currently disabled.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requirePermission(context, permissionKey, callback) {
    if (!hasPermission(context.user, permissionKey)) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'eventsPermissionRequired', 'Events permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  function renderEventsPage(context) {
    const settings = context.getSettings();
    const featureCopy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const requestedSlug = context.url.pathname.startsWith('/events/') ? decodeURIComponent(context.url.pathname.slice('/events/'.length)) : '';
    const body = `
      <div class="app-shell events-page" data-events-app data-event-slug="${context.escapeAttribute(requestedSlug)}">
        ${context.renderTopbar(context.user, context.locale, '/events')}
        <main class="events-workspace">
          <section class="events-toolbar">
            <div>
              <p class="eyebrow">${context.tf(context.locale, 'events', 'Events')}</p>
              <h1>${context.escapeHtml(featureCopy.label)}</h1>
              <p class="hint">${context.escapeHtml(featureCopy.description)}</p>
            </div>
            <div class="row-actions">
              <button class="button ghost" type="button" data-calendar-prev aria-label="${context.tf(context.locale, 'previousMonth', 'Previous month')}">&lt;</button>
              <button class="button ghost" type="button" data-calendar-today>${context.tf(context.locale, 'today', 'Today')}</button>
              <button class="button ghost" type="button" data-calendar-next aria-label="${context.tf(context.locale, 'nextMonth', 'Next month')}">&gt;</button>
              <button class="button primary" type="button" data-open-event-editor hidden>${context.tf(context.locale, 'createEvent', 'Create event')}</button>
              ${hasPermission(context.user, 'events.manage_all') ? `<a class="button ghost" href="/admin/events">${context.tf(context.locale, 'admin', 'Admin')}</a>` : ''}
            </div>
          </section>
          <section class="events-filterbar">
            <strong id="eventsCalendarTitle"></strong>
            <input id="eventsSearch" type="search" placeholder="${context.tf(context.locale, 'searchEvents', 'Search events')}">
            <select id="eventsVisibilityFilter">
              <option value="">${context.tf(context.locale, 'allVisibility', 'All visibility')}</option>
              <option value="public">${context.tf(context.locale, 'public', 'Public')}</option>
              <option value="private">${context.tf(context.locale, 'private', 'Private')}</option>
              <option value="roles">${context.tf(context.locale, 'roles', 'Roles')}</option>
            </select>
          </section>
          <section class="events-layout">
            <div class="events-calendar-panel">
              <div id="eventsCalendarGrid" class="events-calendar-grid"></div>
            </div>
            <aside class="events-side-panel">
              <div id="eventsList" class="events-list"></div>
              <div id="eventDetail" class="events-detail"></div>
            </aside>
          </section>
        </main>
        ${renderEventDialog(context)}
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: featureCopy.label,
      body,
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'events.js')],
      pluginKeys: [feature.key]
    });
  }

  function renderEventsAdminPage(context) {
    const settings = context.getSettings();
    const featureCopy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell" data-events-admin-page>
        ${context.renderTopbar(context.user, context.locale, '/admin/events')}
        <main class="admin-page events-admin-page">
          <div class="admin-header">
            <div>
              <h1>${context.escapeHtml(featureCopy.label)}</h1>
              <p class="hint">${context.escapeHtml(featureCopy.description)}</p>
            </div>
            <div class="row-actions">
              <a class="button ghost" href="/events">${context.tf(context.locale, 'openEvents', 'Open events')}</a>
              <a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a>
            </div>
          </div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <section class="events-admin-grid">
            <div class="panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'events', 'Events')}</h2>
                <button class="button primary" type="button" data-open-event-editor>${context.tf(context.locale, 'createEvent', 'Create event')}</button>
              </div>
              <div id="eventsAdminList" class="events-list"></div>
            </div>
            <div class="panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'eventDetails', 'Event details')}</h2>
                <div class="row-actions">
                  <button class="button ghost" type="button" data-edit-selected-event hidden>${context.tf(context.locale, 'edit', 'Edit')}</button>
                  <button class="button danger" type="button" data-delete-selected-event hidden>${context.tf(context.locale, 'delete', 'Delete')}</button>
                </div>
              </div>
              <div id="eventAdminDetail" class="events-detail"></div>
            </div>
            <div class="panel events-permissions-panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'permissions', 'Permissions')}</h2>
                <button class="button primary" type="button" data-save-event-permissions>${context.tf(context.locale, 'savePermissions', 'Save permissions')}</button>
              </div>
              <div id="eventsPermissionMatrix"></div>
            </div>
          </section>
        </main>
        ${renderEventDialog(context)}
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: featureCopy.label,
      body,
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'events.js')],
      pluginKeys: [feature.key]
    });
  }

  function renderEventDialog(context) {
    return `
      <dialog id="eventEditorDialog" class="modal-dialog events-dialog">
        <form id="eventEditorForm" class="modal-form">
          <input name="id" type="hidden">
          <h2 id="eventEditorTitle">${context.tf(context.locale, 'eventEditor', 'Event editor')}</h2>
          <div class="content-meta">
            <label>${context.tf(context.locale, 'title', 'Title')} <input name="title" required></label>
            <label>${context.tf(context.locale, 'slug', 'Slug')} <input name="slug" placeholder="community-meetup"></label>
            <label>${context.tf(context.locale, 'location', 'Location')} <input name="location"></label>
          </div>
          <label>${context.tf(context.locale, 'description', 'Description')} <textarea name="description"></textarea></label>
          <div class="content-meta">
            <label>${context.tf(context.locale, 'start', 'Start')} <input name="start_datetime" type="datetime-local" required></label>
            <label>${context.tf(context.locale, 'end', 'End')} <input name="end_datetime" type="datetime-local" required></label>
            <label class="check"><input name="is_all_day" type="checkbox"> <span>${context.tf(context.locale, 'allDay', 'All day')}</span></label>
          </div>
          <div class="content-meta">
            <label>${context.tf(context.locale, 'visibility', 'Visibility')}
              <select name="visibility">
                <option value="public">${context.tf(context.locale, 'public', 'Public')}</option>
                <option value="private">${context.tf(context.locale, 'private', 'Private')}</option>
                <option value="roles">${context.tf(context.locale, 'roles', 'Roles')}</option>
              </select>
            </label>
            <label>${context.tf(context.locale, 'maxParticipants', 'Max participants')} <input name="max_participants" type="number" min="0" placeholder="0"></label>
            <label>${context.tf(context.locale, 'roles', 'Roles')} <select name="roles" multiple size="4" data-event-role-select></select></label>
          </div>
          <div class="content-meta">
            <label>${context.tf(context.locale, 'recurrence', 'Recurrence')}
              <select name="recurrence_type">
                <option value="none">${context.tf(context.locale, 'none', 'None')}</option>
                <option value="daily">${context.tf(context.locale, 'daily', 'Daily')}</option>
                <option value="weekly">${context.tf(context.locale, 'weekly', 'Weekly')}</option>
                <option value="monthly">${context.tf(context.locale, 'monthly', 'Monthly')}</option>
              </select>
            </label>
            <label>${context.tf(context.locale, 'interval', 'Interval')} <input name="recurrence_interval" type="number" min="1" value="1"></label>
            <label>${context.tf(context.locale, 'endsAt', 'Ends at')} <input name="recurrence_ends_at" type="date"></label>
          </div>
          <div class="content-meta">
            <label class="check"><input name="reminder_enabled" type="checkbox"> <span>${context.tf(context.locale, 'reminderEnabled', 'Reminder enabled')}</span></label>
            <label>${context.tf(context.locale, 'reminderMinutes', 'Reminder minutes')} <input name="reminder_minutes_before" type="number" min="0" placeholder="30"></label>
          </div>
          <div class="modal-actions">
            <button class="button ghost" type="button" data-close-event-editor>${context.tf(context.locale, 'cancel', 'Cancel')}</button>
            <button class="button primary" type="submit">${context.tf(context.locale, 'save', 'Save')}</button>
          </div>
        </form>
      </dialog>
    `;
  }

  function handleListEvents(context) {
    const includeAll = context.url.searchParams.get('admin') === '1' && hasPermission(context.user, 'events.manage_all');
    const q = String(context.url.searchParams.get('q') || '').trim().toLowerCase();
    const visibility = String(context.url.searchParams.get('visibility') || '').trim();
    const rangeStart = parseDate(context.url.searchParams.get('from')) || startOfMonth(new Date());
    const rangeEnd = parseDate(context.url.searchParams.get('to')) || endOfMonth(rangeStart);
    let events = db.prepare('SELECT * FROM events WHERE status != ? ORDER BY start_datetime ASC').all('deleted').map(normalizeEventRow);
    events = events.filter((event) => includeAll || canSeeEvent(context.user, event));
    if (visibility && VISIBILITIES.has(visibility)) events = events.filter((event) => event.visibility === visibility);
    if (q) events = events.filter((event) => [event.title, event.description, event.location].some((value) => String(value || '').toLowerCase().includes(q)));
    const items = events.flatMap((event) => expandEvent(event, rangeStart, rangeEnd)).sort((a, b) => a.startDateTime.localeCompare(b.startDateTime));
    context.sendJson(context.res, 200, {
      items,
      can: getUserCapabilities(context.user),
      range: { from: toIso(rangeStart), to: toIso(rangeEnd) }
    });
  }

  function handleGetEvent(context) {
    const event = getEventBySlug(context.url.searchParams.get('slug'));
    if (!event || !canSeeEvent(context.user, event)) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'eventNotFound', 'Event not found.') });
    context.sendJson(context.res, 200, serializeEvent(event, context.user, { detail: true }));
  }

  async function handleSaveEvent(context) {
    const payload = await context.readJson(context.req);
    const id = Number(payload.id || 0);
    const existing = id ? getEventById(id) : null;
    if (id && !existing) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'eventNotFound', 'Event not found.') });
    if (!existing && !hasPermission(context.user, 'events.create')) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'eventsCreateRequired', 'Create permissions required.') });
    if (existing && !canEditEvent(context.user, existing)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'eventsEditRequired', 'Edit permissions required.') });

    const normalized = normalizeEventPayload(payload, existing);
    if (normalized.error) return context.sendJson(context.res, 400, { error: normalized.error });

    try {
      db.exec('BEGIN');
      if (existing) {
        db.prepare(`
          UPDATE events SET title = ?, slug = ?, description = ?, location = ?, start_datetime = ?, end_datetime = ?,
          is_all_day = ?, visibility = ?, max_participants = ?, roles_json = ?, reminder_enabled = ?,
          reminder_minutes_before = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(
          normalized.title,
          normalized.slug,
          normalized.description,
          normalized.location,
          normalized.startDateTime,
          normalized.endDateTime,
          normalized.isAllDay ? 1 : 0,
          normalized.visibility,
          normalized.maxParticipants,
          JSON.stringify(normalized.roles),
          normalized.reminderEnabled ? 1 : 0,
          normalized.reminderMinutesBefore,
          existing.id
        );
        db.prepare(`
          INSERT INTO event_recurrences (event_id, recurrence_type, interval, ends_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET recurrence_type = excluded.recurrence_type, interval = excluded.interval, ends_at = excluded.ends_at
        `).run(existing.id, normalized.recurrence.type, normalized.recurrence.interval, normalized.recurrence.endsAt);
      } else {
        const result = db.prepare(`
          INSERT INTO events (title, slug, description, location, start_datetime, end_datetime, is_all_day, visibility,
          max_participants, roles_json, reminder_enabled, reminder_minutes_before, created_by_user_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          normalized.title,
          normalized.slug,
          normalized.description,
          normalized.location,
          normalized.startDateTime,
          normalized.endDateTime,
          normalized.isAllDay ? 1 : 0,
          normalized.visibility,
          normalized.maxParticipants,
          JSON.stringify(normalized.roles),
          normalized.reminderEnabled ? 1 : 0,
          normalized.reminderMinutesBefore,
          context.user.id
        );
        db.prepare('INSERT INTO event_recurrences (event_id, recurrence_type, interval, ends_at) VALUES (?, ?, ?, ?)').run(result.lastInsertRowid, normalized.recurrence.type, normalized.recurrence.interval, normalized.recurrence.endsAt);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error?.message || '').includes('UNIQUE')) return context.sendJson(context.res, 409, { error: context.tf(context.locale, 'slugAlreadyExists', 'This slug already exists.') });
      throw error;
    }

    const saved = getEventBySlug(normalized.slug);
    if (!existing) await context.emitPluginEvent('events.event.created', serializeEvent(saved, context.user, { detail: true }), { source: { plugin: feature.key } });
    context.sendJson(context.res, 200, { ok: true, event: serializeEvent(saved, context.user, { detail: true }) });
  }

  function handleDeleteEvent(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/events/event/'.length)));
    const event = getEventById(id);
    if (!event) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'eventNotFound', 'Event not found.') });
    if (!canDeleteEvent(context.user, event)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'eventsDeleteRequired', 'Delete permissions required.') });
    db.prepare('UPDATE events SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('deleted', id);
    context.sendJson(context.res, 200, { ok: true });
  }

  async function handleRsvp(context) {
    const payload = await context.readJson(context.req);
    const event = getEventBySlug(payload.slug);
    if (!event || !canSeeEvent(context.user, event)) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'eventNotFound', 'Event not found.') });
    const requested = String(payload.status || '').trim();
    if (!RSVP_STATUSES.has(requested)) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'invalidRsvpStatus', 'Invalid RSVP status.') });
    let status = requested;
    if (requested === 'yes' && event.maxParticipants && countParticipants(event.id, 'yes') >= event.maxParticipants) {
      const current = getParticipant(event.id, context.user.id);
      if (!current || current.status !== 'yes') status = 'waitlist';
    }
    db.prepare(`
      INSERT INTO event_participants (event_id, user_id, status, registered_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, registered_at = CURRENT_TIMESTAMP
    `).run(event.id, context.user.id, status);
    context.sendJson(context.res, 200, { ok: true, status, event: serializeEvent(getEventById(event.id), context.user, { detail: true }) });
  }

  function handleIcal(context) {
    const event = getEventBySlug(context.url.searchParams.get('slug'));
    if (!event || !canSeeEvent(context.user, event)) return context.sendText(context.res, 404, 'Event not found');
    const ics = renderIcal(event);
    context.res.writeHead(200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${event.slug}.ics"`
    });
    context.res.end(ics);
  }

  async function handleSavePermissions(context) {
    const payload = await context.readJson(context.req);
    const permissions = payload.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};
    const validRoles = new Set(context.listRoles().map((role) => role.name));
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM event_permissions').run();
      for (const key of EVENT_PERMISSION_KEYS) {
        const roles = normalizeStringArray(permissions[key]).filter((role) => validRoles.has(role));
        for (const role of roles) db.prepare('INSERT OR IGNORE INTO event_permissions (permission_key, role_name) VALUES (?, ?)').run(key, role);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    context.sendJson(context.res, 200, { ok: true, permissions: getPermissionMatrix() });
  }

  function seedDefaultPermissions() {
    const existing = db.prepare('SELECT COUNT(*) AS count FROM event_permissions').get().count;
    if (existing > 0) return;
    for (const key of EVENT_PERMISSION_KEYS) db.prepare('INSERT OR IGNORE INTO event_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Admins');
    for (const key of ['events.view', 'events.create', 'events.edit_own', 'events.rsvp', 'events.export']) {
      db.prepare('INSERT OR IGNORE INTO event_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Users');
    }
  }

  function hasPermission(user, permissionKey) {
    if (user?.is_admin) return true;
    const roles = user?.roles || [];
    if (!roles.length) return false;
    return roles.some((role) => db.prepare('SELECT 1 FROM event_permissions WHERE permission_key = ? AND role_name = ?').get(permissionKey, role));
  }

  function getPermissionMatrix() {
    const matrix = Object.fromEntries(EVENT_PERMISSION_KEYS.map((key) => [key, []]));
    const rows = db.prepare('SELECT permission_key, role_name FROM event_permissions ORDER BY permission_key, role_name').all();
    for (const row of rows) {
      if (!matrix[row.permission_key]) matrix[row.permission_key] = [];
      matrix[row.permission_key].push(row.role_name);
    }
    return matrix;
  }

  function getUserCapabilities(user) {
    return Object.fromEntries(EVENT_PERMISSION_KEYS.map((key) => [key.replace('events.', '').replace('_', ''), hasPermission(user, key)]));
  }

  function canSeeEvent(user, event) {
    if (user?.is_admin || hasPermission(user, 'events.manage_all')) return true;
    if (!hasPermission(user, 'events.view')) return false;
    if (event.visibility === 'public') return true;
    if (event.createdByUserId === user?.id) return true;
    if (getParticipant(event.id, user?.id)) return true;
    if (event.visibility === 'roles') return event.roles.some((role) => user?.roles?.includes(role));
    return false;
  }

  function canEditEvent(user, event) {
    if (user?.is_admin || hasPermission(user, 'events.manage_all')) return true;
    return event.createdByUserId === user?.id && hasPermission(user, 'events.edit_own');
  }

  function canDeleteEvent(user, event) {
    return Boolean(user?.is_admin || hasPermission(user, 'events.delete') || (event.createdByUserId === user?.id && hasPermission(user, 'events.edit_own')));
  }

  function getEventBySlug(slug) {
    const value = String(slug || '').trim();
    if (!value) return null;
    const row = db.prepare('SELECT * FROM events WHERE slug = ? AND status != ?').get(value, 'deleted');
    return row ? normalizeEventRow(row) : null;
  }

  function getEventById(id) {
    const row = db.prepare('SELECT * FROM events WHERE id = ? AND status != ?').get(Number(id), 'deleted');
    return row ? normalizeEventRow(row) : null;
  }

  function normalizeEventRow(row) {
    const recurrence = db.prepare('SELECT * FROM event_recurrences WHERE event_id = ?').get(row.id) || {};
    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      description: row.description || '',
      location: row.location || '',
      startDateTime: row.start_datetime,
      endDateTime: row.end_datetime,
      isAllDay: Boolean(row.is_all_day),
      visibility: row.visibility || 'public',
      maxParticipants: row.max_participants === null || row.max_participants === undefined ? null : Number(row.max_participants),
      roles: parseJsonArray(row.roles_json),
      status: row.status || 'active',
      reminder: {
        enabled: Boolean(row.reminder_enabled),
        minutesBefore: row.reminder_minutes_before === null || row.reminder_minutes_before === undefined ? null : Number(row.reminder_minutes_before)
      },
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      recurrence: {
        type: recurrence.recurrence_type || 'none',
        interval: Math.max(1, Number(recurrence.interval || 1)),
        endsAt: recurrence.ends_at || ''
      }
    };
  }

  function serializeEvent(event, user, options = {}) {
    const participants = getParticipants(event.id);
    const mine = participants.find((item) => item.userId === user?.id) || null;
    return {
      ...event,
      participantCounts: {
        yes: participants.filter((item) => item.status === 'yes').length,
        maybe: participants.filter((item) => item.status === 'maybe').length,
        no: participants.filter((item) => item.status === 'no').length,
        waitlist: participants.filter((item) => item.status === 'waitlist').length
      },
      myStatus: mine?.status || '',
      can: {
        edit: canEditEvent(user, event),
        delete: canDeleteEvent(user, event),
        rsvp: hasPermission(user, 'events.rsvp'),
        export: hasPermission(user, 'events.export')
      },
      participants: options.detail && (user?.is_admin || hasPermission(user, 'events.manage_all') || canEditEvent(user, event)) ? participants : []
    };
  }

  function expandEvent(event, rangeStart, rangeEnd) {
    const start = parseDate(event.startDateTime);
    const end = parseDate(event.endDateTime);
    if (!start || !end) return [];
    const duration = end.getTime() - start.getTime();
    const recurrence = event.recurrence || { type: 'none', interval: 1 };
    if (recurrence.type === 'none') return overlaps(start, end, rangeStart, rangeEnd) ? [serializeOccurrence(event, start, end)] : [];
    const until = recurrence.endsAt ? endOfDay(parseDate(recurrence.endsAt)) : rangeEnd;
    const stopAt = new Date(Math.min(rangeEnd.getTime(), until?.getTime() || rangeEnd.getTime()));
    const items = [];
    let cursor = new Date(start);
    for (let i = 0; i < MAX_OCCURRENCES && cursor <= stopAt; i += 1) {
      const occurrenceEnd = new Date(cursor.getTime() + duration);
      if (overlaps(cursor, occurrenceEnd, rangeStart, rangeEnd)) items.push(serializeOccurrence(event, cursor, occurrenceEnd));
      cursor = addRecurrence(cursor, recurrence.type, recurrence.interval);
    }
    return items;
  }

  function serializeOccurrence(event, start, end) {
    return {
      ...serializeEvent(event, null),
      occurrenceStartDateTime: toIso(start),
      occurrenceEndDateTime: toIso(end),
      startDateTime: toIso(start),
      endDateTime: toIso(end),
      isOccurrence: event.recurrence?.type !== 'none'
    };
  }

  function normalizeEventPayload(payload, existing) {
    const title = String(payload.title || '').trim();
    if (!title) return { error: 'Title is required.' };
    const slug = helpers.slugify(String(payload.slug || title).trim());
    if (!slug) return { error: 'Slug is required.' };
    const start = parseDate(payload.startDateTime || payload.start_datetime);
    const end = parseDate(payload.endDateTime || payload.end_datetime);
    if (!start || !end) return { error: 'Start and end are required.' };
    if (end <= start) return { error: 'End must be after start.' };
    const recurrenceType = RECURRENCE_TYPES.has(String(payload.recurrenceType || payload.recurrence_type || 'none')) ? String(payload.recurrenceType || payload.recurrence_type || 'none') : 'none';
    const recurrenceEndsAt = String(payload.recurrenceEndsAt || payload.recurrence_ends_at || '').trim();
    const visibility = VISIBILITIES.has(String(payload.visibility || 'public')) ? String(payload.visibility || 'public') : 'public';
    const maxParticipants = Number(payload.maxParticipants ?? payload.max_participants ?? 0);
    const reminderMinutes = Number(payload.reminderMinutesBefore ?? payload.reminder_minutes_before ?? '');
    return {
      title,
      slug,
      description: String(payload.description || '').trim(),
      location: String(payload.location || '').trim(),
      startDateTime: toIso(start),
      endDateTime: toIso(end),
      isAllDay: payload.isAllDay === true || payload.is_all_day === true,
      visibility,
      maxParticipants: Number.isFinite(maxParticipants) && maxParticipants > 0 ? Math.floor(maxParticipants) : null,
      roles: normalizeStringArray(payload.roles),
      reminderEnabled: payload.reminderEnabled === true || payload.reminder_enabled === true,
      reminderMinutesBefore: Number.isFinite(reminderMinutes) && reminderMinutes >= 0 ? Math.floor(reminderMinutes) : null,
      recurrence: {
        type: recurrenceType,
        interval: Math.max(1, Math.floor(Number(payload.recurrenceInterval || payload.recurrence_interval || 1) || 1)),
        endsAt: recurrenceEndsAt || ''
      },
      existing
    };
  }

  function getParticipants(eventId) {
    return db.prepare(`
      SELECT ep.id, ep.event_id, ep.user_id, ep.status, ep.registered_at, u.name, u.email
      FROM event_participants ep
      JOIN users u ON u.id = ep.user_id
      WHERE ep.event_id = ?
      ORDER BY ep.registered_at ASC
    `).all(eventId).filter((item) => PARTICIPANT_STATUSES.has(item.status)).map((item) => ({
      id: item.id,
      eventId: item.event_id,
      userId: item.user_id,
      status: item.status,
      registeredAt: item.registered_at,
      user: { id: item.user_id, name: item.name, email: item.email }
    }));
  }

  function getParticipant(eventId, userId) {
    if (!eventId || !userId) return null;
    return db.prepare('SELECT * FROM event_participants WHERE event_id = ? AND user_id = ?').get(eventId, userId);
  }

  function countParticipants(eventId, status) {
    return db.prepare('SELECT COUNT(*) AS count FROM event_participants WHERE event_id = ? AND status = ?').get(eventId, status).count;
  }

  function renderIcal(event) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Atlas//Events//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:atlas-event-${event.id}@atlas`,
      `DTSTAMP:${formatIcalDate(new Date())}`,
      `${event.isAllDay ? 'DTSTART;VALUE=DATE' : 'DTSTART'}:${event.isAllDay ? formatIcalDay(event.startDateTime) : formatIcalDate(parseDate(event.startDateTime))}`,
      `${event.isAllDay ? 'DTEND;VALUE=DATE' : 'DTEND'}:${event.isAllDay ? formatIcalDay(event.endDateTime) : formatIcalDate(parseDate(event.endDateTime))}`,
      `SUMMARY:${escapeIcal(event.title)}`,
      `DESCRIPTION:${escapeIcal(event.description)}`,
      `LOCATION:${escapeIcal(event.location)}`
    ];
    if (event.recurrence?.type && event.recurrence.type !== 'none') {
      const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' }[event.recurrence.type];
      const parts = [`FREQ=${freq}`, `INTERVAL=${event.recurrence.interval || 1}`];
      if (event.recurrence.endsAt) parts.push(`UNTIL=${formatIcalDate(endOfDay(parseDate(event.recurrence.endsAt)))}`);
      lines.push(`RRULE:${parts.join(';')}`);
    }
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
  }

  function parseJsonArray(value) {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function normalizeStringArray(value) {
    if (Array.isArray(value)) return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
    return String(value || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function toIso(date) {
    return date.toISOString();
  }

  function startOfMonth(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  function endOfMonth(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  }

  function endOfDay(date) {
    if (!date) return null;
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
  }

  function overlaps(start, end, rangeStart, rangeEnd) {
    return start <= rangeEnd && end >= rangeStart;
  }

  function addRecurrence(date, type, interval) {
    const next = new Date(date);
    if (type === 'daily') next.setUTCDate(next.getUTCDate() + interval);
    else if (type === 'weekly') next.setUTCDate(next.getUTCDate() + (interval * 7));
    else if (type === 'monthly') next.setUTCMonth(next.getUTCMonth() + interval);
    else next.setUTCFullYear(next.getUTCFullYear() + 100);
    return next;
  }

  function formatIcalDate(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function formatIcalDay(value) {
    return formatIcalDate(parseDate(value)).slice(0, 8);
  }

  function escapeIcal(value = '') {
    return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  }
}
