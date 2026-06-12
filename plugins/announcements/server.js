import { join } from 'node:path';

const PERMISSION_KEYS = [
  'announcements.view',
  'announcements.create',
  'announcements.edit',
  'announcements.delete',
  'announcements.acknowledge',
  'announcements.manage'
];
const PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const PRIORITY_WEIGHT = { critical: 4, high: 3, normal: 2, low: 1 };

export default function createAnnouncementsPlugin({ manifest, rootDir }) {
  let db = null;

  const feature = {
    key: manifest.key || 'announcements',
    label: manifest.name || 'Announcements',
    href: '/announcements',
    description: manifest.description || 'Important announcements with targeting, banners, expiry dates and acknowledgements.',
    defaultEnabled: true
  };

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    localesDir: join(rootDir, 'locales'),
    globalAssets: { styles: ['announcements.css'], scripts: ['announcements.js'] },
    adminPage: { href: '/admin/announcements', label: manifest.name || 'Announcements' },
    init(context) {
      db = context.db;
      db.exec(`
        CREATE TABLE IF NOT EXISTS announcements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          priority TEXT NOT NULL DEFAULT 'normal',
          starts_at TEXT,
          ends_at TEXT,
          is_pinned INTEGER NOT NULL DEFAULT 0,
          requires_acknowledgement INTEGER NOT NULL DEFAULT 0,
          target_roles_json TEXT NOT NULL DEFAULT '[]',
          target_user_ids_json TEXT NOT NULL DEFAULT '[]',
          created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS announcement_acknowledgements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          acknowledged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(announcement_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS announcement_permissions (
          permission_key TEXT NOT NULL,
          role_name TEXT NOT NULL,
          PRIMARY KEY (permission_key, role_name)
        );
        CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(starts_at, ends_at, is_pinned, priority);
        CREATE INDEX IF NOT EXISTS idx_announcement_ack_user ON announcement_acknowledgements(user_id, announcement_id);
      `);
      seedDefaultPermissions();
    },
    resetToFactoryDefaults(context) {
      context.db.exec(`
        DELETE FROM announcement_acknowledgements;
        DELETE FROM announcements;
        DELETE FROM announcement_permissions;
        DELETE FROM sqlite_sequence WHERE name IN ('announcements', 'announcement_acknowledgements');
      `);
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/announcements/support-data' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'announcements.manage', () => sendAdminSupport(context)));
      if (url.pathname === '/api/admin/announcements' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'announcements.manage', () => listAdminAnnouncements(context)));
      if (url.pathname === '/api/admin/announcements' && req.method === 'POST') return requireEnabled(context, () => saveAnnouncement(context));
      if (url.pathname.startsWith('/api/admin/announcements/') && url.pathname.endsWith('/acknowledgements') && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'announcements.manage', () => sendAcknowledgements(context)));
      if (url.pathname.startsWith('/api/admin/announcements/') && req.method === 'DELETE') return requireEnabled(context, () => requirePermission(context, 'announcements.delete', () => deleteAnnouncement(context)));
      if (url.pathname === '/api/admin/announcements/permissions' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'announcements.manage', () => savePermissions(context)));

      if (url.pathname === '/api/announcements' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'announcements.view', () => listPublicAnnouncements(context)));
      if (url.pathname === '/api/announcements/banner' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'announcements.view', () => sendBanner(context)));
      if (url.pathname === '/api/announcements/detail' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'announcements.view', () => sendPublicDetail(context)));
      if (url.pathname === '/api/announcements/acknowledge' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'announcements.acknowledge', () => acknowledgeAnnouncement(context)));

      if (url.pathname === '/announcements' || url.pathname.startsWith('/announcements/')) {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'announcementsFeatureDisabledNotice', 'Announcements are currently disabled.') }));
          return true;
        }
        if (!hasPermission(user, 'announcements.view')) {
          context.sendHtml(res, 403, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'announcementsViewRequired', 'Announcement permissions are required.') }));
          return true;
        }
        context.sendHtml(res, 200, renderAnnouncementsPage(context));
        return true;
      }
      if (url.pathname === '/admin/announcements') return requireEnabled(context, () => requirePermission(context, 'announcements.manage', () => context.sendHtml(res, 200, renderAdminPage(context))));
      return false;
    }
  };

  async function requireEnabled(context, callback) {
    if (!context.isPluginEnabled(feature.key)) {
      context.sendJson(context.res, 404, { error: context.tf(context.locale, 'announcementsFeatureDisabled', 'Announcements are currently disabled.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requirePermission(context, key, callback) {
    if (!hasPermission(context.user, key)) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'announcementsPermissionRequired', 'Announcement permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  function renderAnnouncementsPage(context) {
    const settings = context.getSettings();
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const requestedId = context.url.pathname.startsWith('/announcements/') ? decodeURIComponent(context.url.pathname.slice('/announcements/'.length)) : '';
    const body = `
      <div class="app-shell announcements-page" data-announcements-app data-announcement-id="${context.escapeAttribute(requestedId)}">
        ${context.renderTopbar(context.user, context.locale, '/announcements')}
        <main class="announcements-workspace">
          <section class="announcements-header">
            <div><p class="eyebrow">${context.tf(context.locale, 'announcements', 'Announcements')}</p><h1>${context.escapeHtml(copy.label)}</h1><p class="hint">${context.escapeHtml(copy.description)}</p></div>
            <div class="row-actions">
              ${hasPermission(context.user, 'announcements.manage') ? `<a class="button ghost" href="/admin/announcements">${context.tf(context.locale, 'admin', 'Admin')}</a>` : ''}
            </div>
          </section>
          <section class="announcements-toolbar">
            <input id="announcementSearch" type="search" placeholder="${context.tf(context.locale, 'searchAnnouncements', 'Search announcements')}">
            <select id="announcementPriorityFilter">
              <option value="">${context.tf(context.locale, 'allPriorities', 'All priorities')}</option>
              ${Array.from(PRIORITIES).map((item) => `<option value="${item}">${context.tf(context.locale, item, item)}</option>`).join('')}
            </select>
            <select id="announcementStatusFilter">
              <option value="active">${context.tf(context.locale, 'active', 'Active')}</option>
              <option value="acknowledged">${context.tf(context.locale, 'acknowledged', 'Acknowledged')}</option>
              <option value="requires_acknowledgement">${context.tf(context.locale, 'requiresAcknowledgement', 'Requires acknowledgement')}</option>
            </select>
          </section>
          <section class="announcements-layout">
            <div id="announcementsList" class="announcements-list"></div>
            <div id="announcementDetail" class="announcement-detail"></div>
          </section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'announcements.js')], pluginKeys: [feature.key] });
  }

  function renderAdminPage(context) {
    const settings = context.getSettings();
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell announcements-admin-page" data-announcements-admin-page>
        ${context.renderTopbar(context.user, context.locale, '/admin/announcements')}
        <main class="admin-page">
          <div class="admin-header"><div><h1>${context.escapeHtml(copy.label)}</h1><p class="hint">${context.escapeHtml(copy.description)}</p></div><div class="row-actions"><a class="button ghost" href="/announcements">${context.tf(context.locale, 'openAnnouncements', 'Open announcements')}</a><a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a></div></div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <section class="announcements-admin-grid">
            <div class="panel">
              <div class="panel-head"><h2>${context.tf(context.locale, 'announcements', 'Announcements')}</h2><button class="button primary" type="button" data-new-announcement>${context.tf(context.locale, 'newAnnouncement', 'New announcement')}</button></div>
              <div id="announcementsAdminList" class="announcements-list"></div>
            </div>
            <div class="panel">
              <div class="panel-head"><h2>${context.tf(context.locale, 'details', 'Details')}</h2><div class="row-actions"><button class="button ghost" type="button" data-edit-announcement hidden>${context.tf(context.locale, 'edit', 'Edit')}</button><button class="button danger" type="button" data-delete-announcement hidden>${context.tf(context.locale, 'delete', 'Delete')}</button></div></div>
              <div id="announcementsAdminDetail" class="announcement-detail"></div>
            </div>
            <div class="panel announcements-permissions-panel">
              <div class="panel-head"><h2>${context.tf(context.locale, 'permissions', 'Permissions')}</h2><button class="button primary" type="button" data-save-announcement-permissions>${context.tf(context.locale, 'savePermissions', 'Save permissions')}</button></div>
              <div id="announcementsPermissions"></div>
            </div>
          </section>
        </main>
        ${renderEditorDialog(context)}
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'announcements.js')], pluginKeys: [feature.key] });
  }

  function renderEditorDialog(context) {
    return `
      <dialog id="announcementEditorDialog" class="modal-dialog announcement-dialog">
        <form id="announcementEditorForm" class="modal-form">
          <div class="qa-dialog-head"><div><p class="eyebrow">${context.tf(context.locale, 'announcements', 'Announcements')}</p><h2>${context.tf(context.locale, 'editAnnouncement', 'Edit announcement')}</h2></div><button class="button ghost" type="button" data-close-announcement-editor>${context.tf(context.locale, 'close', 'Close')}</button></div>
          <input name="id" type="hidden">
          <label>${context.tf(context.locale, 'title', 'Title')}<input name="title" required></label>
          <label>${context.tf(context.locale, 'content', 'Content')}<textarea name="content" required></textarea></label>
          <div class="content-meta">
            <label>${context.tf(context.locale, 'priority', 'Priority')}<select name="priority">${Array.from(PRIORITIES).map((item) => `<option value="${item}">${context.tf(context.locale, item, item)}</option>`).join('')}</select></label>
            <label>${context.tf(context.locale, 'startsAt', 'Starts at')}<input name="starts_at" type="datetime-local"></label>
            <label>${context.tf(context.locale, 'endsAt', 'Ends at')}<input name="ends_at" type="datetime-local"></label>
          </div>
          <div class="content-meta">
            <label class="check"><input name="is_pinned" type="checkbox"><span>${context.tf(context.locale, 'pinned', 'Pinned')}</span></label>
            <label class="check"><input name="requires_acknowledgement" type="checkbox"><span>${context.tf(context.locale, 'requiresAcknowledgement', 'Requires acknowledgement')}</span></label>
          </div>
          <section class="announcement-targets"><h3>${context.tf(context.locale, 'targetGroups', 'Target groups')}</h3><div id="announcementRoleTargets" class="permission-grid compact"></div><div id="announcementUserTargets" class="permission-grid compact"></div></section>
          <div class="modal-actions"><button class="button primary" type="submit">${context.tf(context.locale, 'save', 'Save')}</button></div>
        </form>
      </dialog>
    `;
  }

  function sendAdminSupport(context) {
    context.sendJson(context.res, 200, {
      roles: context.listRoles(),
      users: context.listUsers().map((user) => context.publicUser(user)),
      permissions: getPermissionMatrix(),
      permissionKeys: PERMISSION_KEYS,
      can: getCapabilities(context.user)
    });
  }

  function listPublicAnnouncements(context) {
    const q = String(context.url.searchParams.get('q') || '').trim().toLowerCase();
    const priority = String(context.url.searchParams.get('priority') || '').trim();
    const status = String(context.url.searchParams.get('status') || 'active').trim();
    let rows = listAnnouncements().filter((item) => isActive(item) && isTargetedToUser(item, context.user));
    if (q) rows = rows.filter((item) => [item.title, item.content].some((value) => String(value || '').toLowerCase().includes(q)));
    if (PRIORITIES.has(priority)) rows = rows.filter((item) => item.priority === priority);
    if (status === 'acknowledged') rows = rows.filter((item) => item.acknowledged);
    if (status === 'requires_acknowledgement') rows = rows.filter((item) => item.requiresAcknowledgement && !item.acknowledged);
    context.sendJson(context.res, 200, { items: rows.map((item) => serializeAnnouncement(item, context.user)), can: getCapabilities(context.user) });
  }

  function listAdminAnnouncements(context) {
    context.sendJson(context.res, 200, { items: listAnnouncements().map((item) => serializeAnnouncement(item, context.user, { admin: true })), can: getCapabilities(context.user) });
  }

  function sendBanner(context) {
    const items = listAnnouncements()
      .filter((item) => isActive(item) && isTargetedToUser(item, context.user))
      .filter((item) => item.isPinned || ['high', 'critical'].includes(item.priority) || (item.requiresAcknowledgement && !isAcknowledged(item.id, context.user.id)))
      .slice(0, 5)
      .map((item) => serializeAnnouncement(item, context.user));
    context.sendJson(context.res, 200, { items, can: getCapabilities(context.user) });
  }

  function sendPublicDetail(context) {
    const item = getAnnouncement(context.url.searchParams.get('id'));
    if (!item || !isActive(item) || !isTargetedToUser(item, context.user)) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'announcementNotFound', 'Announcement not found.') });
    context.sendJson(context.res, 200, serializeAnnouncement(item, context.user));
  }

  async function saveAnnouncement(context) {
    const payload = await context.readJson(context.req);
    const id = Number(payload.id || 0);
    const existing = id ? getAnnouncement(id) : null;
    if (id && !existing) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'announcementNotFound', 'Announcement not found.') });
    if (!existing && !hasPermission(context.user, 'announcements.create')) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'announcementsCreateRequired', 'Create permissions required.') });
    if (existing && !hasPermission(context.user, 'announcements.edit')) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'announcementsEditRequired', 'Edit permissions required.') });
    const normalized = normalizePayload(payload);
    if (!normalized.title) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'announcementTitleRequired', 'A title is required.') });
    let savedId = id;
    if (id) {
      db.prepare(`
        UPDATE announcements
        SET title = ?, content = ?, priority = ?, starts_at = ?, ends_at = ?, is_pinned = ?, requires_acknowledgement = ?, target_roles_json = ?, target_user_ids_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(normalized.title, normalized.content, normalized.priority, normalized.startsAt, normalized.endsAt, normalized.isPinned ? 1 : 0, normalized.requiresAcknowledgement ? 1 : 0, JSON.stringify(normalized.targetRoles), JSON.stringify(normalized.targetUserIds), id);
    } else {
      const result = db.prepare(`
        INSERT INTO announcements (title, content, priority, starts_at, ends_at, is_pinned, requires_acknowledgement, target_roles_json, target_user_ids_json, created_by_user_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(normalized.title, normalized.content, normalized.priority, normalized.startsAt, normalized.endsAt, normalized.isPinned ? 1 : 0, normalized.requiresAcknowledgement ? 1 : 0, JSON.stringify(normalized.targetRoles), JSON.stringify(normalized.targetUserIds), context.user.id);
      savedId = Number(result.lastInsertRowid);
    }
    const saved = getAnnouncement(savedId);
    await context.emitPluginEvent(existing ? 'announcement.updated' : 'announcement.created', serializeAnnouncement(saved, context.user, { admin: true }), { source: { plugin: feature.key } });
    context.sendJson(context.res, 200, { ok: true, items: listAnnouncements().map((item) => serializeAnnouncement(item, context.user, { admin: true })) });
  }

  function deleteAnnouncement(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/admin/announcements/'.length)));
    db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
    context.sendJson(context.res, 200, { ok: true });
  }

  async function acknowledgeAnnouncement(context) {
    const payload = await context.readJson(context.req);
    const item = getAnnouncement(payload.id || payload.announcement_id);
    if (!item || !isActive(item) || !isTargetedToUser(item, context.user)) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'announcementNotFound', 'Announcement not found.') });
    db.prepare('INSERT OR IGNORE INTO announcement_acknowledgements (announcement_id, user_id) VALUES (?, ?)').run(item.id, context.user.id);
    context.sendJson(context.res, 200, { ok: true, item: serializeAnnouncement(getAnnouncement(item.id), context.user) });
  }

  function sendAcknowledgements(context) {
    const id = Number(decodeURIComponent(context.url.pathname.split('/')[4] || 0));
    const item = getAnnouncement(id);
    if (!item) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'announcementNotFound', 'Announcement not found.') });
    const targetUsers = context.listUsers().filter((user) => isTargetedToUser(item, user));
    const ackRows = db.prepare('SELECT user_id, acknowledged_at FROM announcement_acknowledgements WHERE announcement_id = ?').all(item.id);
    const byUser = new Map(ackRows.map((row) => [row.user_id, row.acknowledged_at]));
    context.sendJson(context.res, 200, {
      announcementId: item.id,
      users: targetUsers.map((user) => ({ user: context.publicUser(user), acknowledgedAt: byUser.get(user.id) || null }))
    });
  }

  async function savePermissions(context) {
    const payload = await context.readJson(context.req);
    const permissions = payload.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};
    const validRoles = new Set(context.listRoles().map((role) => role.name));
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM announcement_permissions').run();
      for (const key of PERMISSION_KEYS) {
        for (const role of normalizeStringArray(permissions[key]).filter((role) => validRoles.has(role))) {
          db.prepare('INSERT OR IGNORE INTO announcement_permissions (permission_key, role_name) VALUES (?, ?)').run(key, role);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    context.sendJson(context.res, 200, { ok: true, permissions: getPermissionMatrix() });
  }

  function seedDefaultPermissions() {
    if (db.prepare('SELECT COUNT(*) AS count FROM announcement_permissions').get().count) return;
    for (const key of PERMISSION_KEYS) db.prepare('INSERT OR IGNORE INTO announcement_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Admins');
    for (const key of ['announcements.view', 'announcements.acknowledge']) db.prepare('INSERT OR IGNORE INTO announcement_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Users');
  }

  function hasPermission(user, key) {
    if (user?.is_admin) return true;
    return Boolean(user?.roles?.some((role) => db.prepare('SELECT 1 FROM announcement_permissions WHERE permission_key = ? AND role_name = ?').get(key, role)));
  }

  function getPermissionMatrix() {
    const matrix = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, []]));
    for (const row of db.prepare('SELECT permission_key, role_name FROM announcement_permissions ORDER BY permission_key, role_name').all()) {
      if (!matrix[row.permission_key]) matrix[row.permission_key] = [];
      matrix[row.permission_key].push(row.role_name);
    }
    return matrix;
  }

  function getCapabilities(user) {
    return Object.fromEntries(PERMISSION_KEYS.map((key) => [key.replace('announcements.', ''), hasPermission(user, key)]));
  }

  function listAnnouncements() {
    return db.prepare(`
      SELECT a.*, u.name AS creator_name, u.email AS creator_email
      FROM announcements a
      LEFT JOIN users u ON u.id = a.created_by_user_id
      ORDER BY a.is_pinned DESC, CASE a.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC, COALESCE(a.starts_at, a.created_at) DESC, a.id DESC
    `).all().map(normalizeAnnouncementRow);
  }

  function getAnnouncement(id) {
    const row = db.prepare(`
      SELECT a.*, u.name AS creator_name, u.email AS creator_email
      FROM announcements a
      LEFT JOIN users u ON u.id = a.created_by_user_id
      WHERE a.id = ?
    `).get(Number(id || 0));
    return row ? normalizeAnnouncementRow(row) : null;
  }

  function normalizeAnnouncementRow(row) {
    return {
      id: row.id,
      title: row.title,
      content: row.content || '',
      priority: PRIORITIES.has(row.priority) ? row.priority : 'normal',
      startsAt: row.starts_at || '',
      endsAt: row.ends_at || '',
      isPinned: Boolean(row.is_pinned),
      requiresAcknowledgement: Boolean(row.requires_acknowledgement),
      targetRoles: parseJsonArray(row.target_roles_json),
      targetUserIds: parseJsonArray(row.target_user_ids_json).map(Number).filter(Boolean),
      createdByUserId: row.created_by_user_id,
      creator: row.creator_email ? { id: row.created_by_user_id, name: row.creator_name || row.creator_email, email: row.creator_email } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function serializeAnnouncement(item, user, options = {}) {
    const acknowledged = isAcknowledged(item.id, user.id);
    return {
      ...item,
      active: isActive(item),
      acknowledged,
      acknowledgementCount: options.admin ? acknowledgementCount(item.id) : undefined,
      targetCount: options.admin ? targetCount(item) : undefined,
      priorityWeight: PRIORITY_WEIGHT[item.priority] || 2,
      can: {
        acknowledge: hasPermission(user, 'announcements.acknowledge') && isActive(item) && isTargetedToUser(item, user) && !acknowledged,
        edit: hasPermission(user, 'announcements.edit'),
        delete: hasPermission(user, 'announcements.delete'),
        manage: hasPermission(user, 'announcements.manage')
      }
    };
  }

  function isActive(item) {
    const now = Date.now();
    const starts = item.startsAt ? Date.parse(item.startsAt) : 0;
    const ends = item.endsAt ? Date.parse(item.endsAt) : 0;
    return (!starts || starts <= now) && (!ends || ends > now);
  }

  function isTargetedToUser(item, user) {
    if (!user) return false;
    if (!item.targetRoles.length && !item.targetUserIds.length) return true;
    if (item.targetUserIds.includes(user.id)) return true;
    return item.targetRoles.some((role) => user.roles?.includes(role));
  }

  function isAcknowledged(announcementId, userId) {
    return Boolean(db.prepare('SELECT 1 FROM announcement_acknowledgements WHERE announcement_id = ? AND user_id = ?').get(announcementId, userId));
  }

  function acknowledgementCount(announcementId) {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM announcement_acknowledgements WHERE announcement_id = ?').get(announcementId).count || 0);
  }

  function targetCount(item) {
    if (!item.targetRoles.length && !item.targetUserIds.length) return null;
    const users = new Map();
    for (const user of db.prepare('SELECT id FROM users WHERE active = 1').all()) {
      if (item.targetUserIds.includes(user.id)) users.set(user.id, true);
    }
    for (const role of item.targetRoles) {
      for (const row of db.prepare('SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = ?').all(role)) users.set(row.user_id, true);
    }
    return users.size;
  }

  function normalizePayload(payload) {
    return {
      title: String(payload.title || '').trim(),
      content: String(payload.content || '').trim(),
      priority: PRIORITIES.has(String(payload.priority || 'normal')) ? String(payload.priority || 'normal') : 'normal',
      startsAt: normalizeDateTime(payload.startsAt || payload.starts_at),
      endsAt: normalizeDateTime(payload.endsAt || payload.ends_at),
      isPinned: Boolean(payload.isPinned || payload.is_pinned),
      requiresAcknowledgement: Boolean(payload.requiresAcknowledgement || payload.requires_acknowledgement),
      targetRoles: normalizeStringArray(payload.targetRoles || payload.target_roles),
      targetUserIds: normalizeIdArray(payload.targetUserIds || payload.target_user_ids)
    };
  }

  function normalizeDateTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  function normalizeStringArray(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
    return Array.from(new Set(source.map((item) => String(item).trim()).filter(Boolean)));
  }

  function normalizeIdArray(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
    return Array.from(new Set(source.map(Number).filter((item) => Number.isInteger(item) && item > 0)));
  }

  function parseJsonArray(value) {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
