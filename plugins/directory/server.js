import { join } from 'node:path';

const DIRECTORY_PERMISSION_KEYS = [
  'directory.view',
  'directory.view_private_fields',
  'directory.edit_own',
  'directory.manage_profiles',
  'directory.manage_fields'
];
const FIELD_TYPES = new Set(['text', 'textarea', 'url', 'email', 'phone', 'select', 'multi_select']);
const VISIBILITIES = new Set(['public', 'members', 'private']);

export default function createDirectoryPlugin({ manifest, rootDir }) {
  let db = null;

  const feature = {
    key: manifest.key || 'directory',
    label: manifest.name || 'Directory',
    href: '/directory',
    description: manifest.description || 'Member profiles with searchable directory, configurable fields, skills, roles and visibility.',
    defaultEnabled: true
  };

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    localesDir: join(rootDir, 'locales'),
    adminPage: { href: '/admin/directory', label: manifest.name || 'Directory' },
    init(context) {
      db = context.db;
      db.exec(`
        CREATE TABLE IF NOT EXISTS directory_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          display_name TEXT NOT NULL DEFAULT '',
          bio TEXT NOT NULL DEFAULT '',
          avatar_url TEXT NOT NULL DEFAULT '',
          location TEXT NOT NULL DEFAULT '',
          job_title TEXT NOT NULL DEFAULT '',
          department TEXT NOT NULL DEFAULT '',
          visibility TEXT NOT NULL DEFAULT 'members',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS directory_profile_fields (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          field_type TEXT NOT NULL DEFAULT 'text',
          is_required INTEGER NOT NULL DEFAULT 0,
          visibility_default TEXT NOT NULL DEFAULT 'members',
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS directory_profile_field_values (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES directory_profiles(id) ON DELETE CASCADE,
          field_id INTEGER NOT NULL REFERENCES directory_profile_fields(id) ON DELETE CASCADE,
          value TEXT NOT NULL DEFAULT '',
          visibility TEXT NOT NULL DEFAULT 'members',
          UNIQUE(profile_id, field_id)
        );
        CREATE TABLE IF NOT EXISTS directory_skills (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS directory_profile_skills (
          profile_id INTEGER NOT NULL REFERENCES directory_profiles(id) ON DELETE CASCADE,
          skill_id INTEGER NOT NULL REFERENCES directory_skills(id) ON DELETE CASCADE,
          PRIMARY KEY (profile_id, skill_id)
        );
        CREATE TABLE IF NOT EXISTS directory_permissions (
          permission_key TEXT NOT NULL,
          role_name TEXT NOT NULL,
          PRIMARY KEY (permission_key, role_name)
        );
        CREATE INDEX IF NOT EXISTS idx_directory_profiles_user ON directory_profiles(user_id);
        CREATE INDEX IF NOT EXISTS idx_directory_profile_values_lookup ON directory_profile_field_values(profile_id, field_id);
      `);
      seedDefaultPermissions();
    },
    resetToFactoryDefaults(context) {
      context.db.exec(`
        DELETE FROM directory_profile_skills;
        DELETE FROM directory_profile_field_values;
        DELETE FROM directory_profiles;
        DELETE FROM directory_profile_fields;
        DELETE FROM directory_skills;
        DELETE FROM directory_permissions;
        DELETE FROM sqlite_sequence WHERE name IN ('directory_profiles', 'directory_profile_fields', 'directory_profile_field_values', 'directory_skills');
      `);
    },
    seedInitialData(context) {
      if (context.db.prepare('SELECT COUNT(*) AS count FROM directory_profile_fields').get().count) return;
      const fields = [
        ['Focus area', 'text', 0, 'members', 0],
        ['Office hours', 'text', 0, 'members', 1],
        ['Emergency contact', 'email', 0, 'private', 2]
      ].map(([name, type, required, visibility, sortOrder]) => ({
        name,
        id: context.db.prepare(`
          INSERT INTO directory_profile_fields (name, field_type, is_required, visibility_default, sort_order)
          VALUES (?, ?, ?, ?, ?)
        `).run(name, type, required, visibility, sortOrder).lastInsertRowid
      }));
      const skills = ['Policy Review', 'Incident Response', 'Risk Assessment', 'Access Management'].map((name) => ({
        name,
        id: context.db.prepare('INSERT OR IGNORE INTO directory_skills (name) VALUES (?)').run(name).lastInsertRowid
          || context.db.prepare('SELECT id FROM directory_skills WHERE name = ?').get(name)?.id
      }));
      const users = context.listUsers().filter((user) => user.active).slice(0, 4);
      users.forEach((user, index) => {
        const existing = getProfileByUserId(user.id);
        const profile = existing || (() => {
          context.db.prepare('INSERT INTO directory_profiles (user_id, display_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(user.id, user.name || user.email || 'User');
          return getProfileByUserId(user.id);
        })();
        if (!profile) return;
        if (!profile.bio && !profile.jobTitle && !profile.department) {
          context.db.prepare(`
            UPDATE directory_profiles SET bio = ?, location = ?, job_title = ?, department = ?, visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(
            index === 0 ? 'Maintains the Atlas workspace and sample data.' : 'Example profile used to demonstrate the member directory.',
            index === 0 ? 'Berlin' : 'Remote',
            index === 0 ? 'Workspace Administrator' : 'Policy Contributor',
            index === 0 ? 'Security' : 'Operations',
            'members',
            profile.id
          );
        }
        fields.forEach((field, fieldIndex) => {
          const value = fieldIndex === 0 ? (index === 0 ? 'Platform governance' : 'Policy operations') : fieldIndex === 1 ? 'Tuesdays 10:00-11:00' : user.email;
          context.db.prepare(`
            INSERT OR IGNORE INTO directory_profile_field_values (profile_id, field_id, value, visibility)
            VALUES (?, ?, ?, ?)
          `).run(profile.id, field.id, value, fieldIndex === 2 ? 'private' : 'members');
        });
        for (const skill of skills.slice(index % 2, (index % 2) + 2)) context.db.prepare('INSERT OR IGNORE INTO directory_profile_skills (profile_id, skill_id) VALUES (?, ?)').run(profile.id, skill.id);
      });
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/directory/support-data' && req.method === 'GET') return requireAny(context, ['directory.manage_profiles', 'directory.manage_fields'], () => sendSupportData(context, true));
      if (url.pathname === '/api/admin/directory/fields' && req.method === 'POST') return requirePermission(context, 'directory.manage_fields', () => saveField(context));
      if (url.pathname.startsWith('/api/admin/directory/fields/') && req.method === 'DELETE') return requirePermission(context, 'directory.manage_fields', () => deleteField(context));
      if (url.pathname === '/api/admin/directory/profile' && req.method === 'POST') return requirePermission(context, 'directory.manage_profiles', () => saveProfile(context, true));
      if (url.pathname === '/api/admin/directory/skills' && req.method === 'POST') return requirePermission(context, 'directory.manage_fields', () => saveSkill(context));
      if (url.pathname.startsWith('/api/admin/directory/skills/') && req.method === 'DELETE') return requirePermission(context, 'directory.manage_fields', () => deleteSkill(context));
      if (url.pathname === '/api/admin/directory/permissions' && req.method === 'POST') return requirePermission(context, 'directory.manage_fields', () => savePermissions(context));

      if (url.pathname === '/api/directory/profiles' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'directory.view', () => listProfiles(context)));
      if (url.pathname === '/api/directory/profile' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'directory.view', () => getProfile(context)));
      if (url.pathname === '/api/directory/me' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'directory.edit_own', () => getMyProfile(context)));
      if (url.pathname === '/api/directory/me' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'directory.edit_own', () => saveProfile(context, false)));
      if (url.pathname === '/api/directory/support-data' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'directory.view', () => sendSupportData(context, false)));

      if (url.pathname === '/directory' || url.pathname === '/directory/me' || url.pathname.startsWith('/directory/profile/')) {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'directoryFeatureDisabledNotice', 'The directory feature is currently disabled.') }));
          return true;
        }
        if (!hasPermission(user, 'directory.view') && url.pathname !== '/directory/me') {
          context.sendHtml(res, 403, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'directoryViewRequired', 'Directory permissions are required.') }));
          return true;
        }
        if (url.pathname === '/directory/me' && !hasPermission(user, 'directory.edit_own')) {
          context.sendHtml(res, 403, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'directoryEditRequired', 'Profile edit permissions are required.') }));
          return true;
        }
        context.sendHtml(res, 200, renderDirectoryPage(context));
        return true;
      }
      if (url.pathname === '/admin/directory') return requireAny(context, ['directory.manage_profiles', 'directory.manage_fields'], () => context.sendHtml(res, 200, renderDirectoryAdminPage(context)));
      return false;
    }
  };

  async function requireEnabled(context, callback) {
    if (!context.isPluginEnabled(feature.key)) {
      context.sendJson(context.res, 404, { error: context.tf(context.locale, 'directoryFeatureDisabled', 'The directory feature is currently disabled.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requirePermission(context, key, callback) {
    if (!hasPermission(context.user, key)) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'directoryPermissionRequired', 'Directory permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requireAny(context, keys, callback) {
    if (!keys.some((key) => hasPermission(context.user, key))) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'directoryPermissionRequired', 'Directory permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  function renderDirectoryPage(context) {
    const settings = context.getSettings();
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const mode = context.url.pathname === '/directory/me' ? 'me' : context.url.pathname.startsWith('/directory/profile/') ? 'profile' : 'list';
    const userId = mode === 'profile' ? decodeURIComponent(context.url.pathname.slice('/directory/profile/'.length)) : '';
    const body = `
      <div class="app-shell directory-page" data-directory-app data-directory-mode="${context.escapeAttribute(mode)}" data-directory-user-id="${context.escapeAttribute(userId)}">
        ${context.renderTopbar(context.user, context.locale, '/directory')}
        <main class="directory-workspace">
          <section class="directory-header">
            <div>
              <p class="eyebrow">${context.tf(context.locale, 'directory', 'Directory')}</p>
              <h1>${context.escapeHtml(copy.label)}</h1>
              <p class="hint">${context.escapeHtml(copy.description)}</p>
            </div>
            <div class="row-actions">
              <a class="button ghost" href="/directory">${context.tf(context.locale, 'directoryHome', 'Directory home')}</a>
              <a class="button primary" href="/directory/me">${context.tf(context.locale, 'editMyProfile', 'Edit my profile')}</a>
              ${hasPermission(context.user, 'directory.manage_profiles') ? `<a class="button ghost" href="/admin/directory">${context.tf(context.locale, 'admin', 'Admin')}</a>` : ''}
            </div>
          </section>
          <section class="directory-toolbar" data-directory-toolbar>
            <input id="directorySearch" type="search" placeholder="${context.tf(context.locale, 'searchMembers', 'Search members')}">
            <select id="directorySkillFilter"><option value="">${context.tf(context.locale, 'allSkills', 'All skills')}</option></select>
            <select id="directoryDepartmentFilter"><option value="">${context.tf(context.locale, 'allDepartments', 'All departments')}</option></select>
            <select id="directoryRoleFilter"><option value="">${context.tf(context.locale, 'allRoles', 'All roles')}</option></select>
          </section>
          <section id="directoryRoot" class="directory-root"></section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'directory.js')], pluginKeys: [feature.key] });
  }

  function renderDirectoryAdminPage(context) {
    const settings = context.getSettings();
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell" data-directory-admin-page>
        ${context.renderTopbar(context.user, context.locale, '/admin/directory')}
        <main class="admin-page directory-admin-page">
          <div class="admin-header">
            <div><h1>${context.escapeHtml(copy.label)}</h1><p class="hint">${context.escapeHtml(copy.description)}</p></div>
            <div class="row-actions"><a class="button ghost" href="/directory">${context.tf(context.locale, 'openDirectory', 'Open directory')}</a><a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a></div>
          </div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <nav class="builder-subnav">
            <button class="admin-tab-button active" type="button" data-directory-admin-tab="profiles">${context.tf(context.locale, 'profiles', 'Profiles')}</button>
            <button class="admin-tab-button" type="button" data-directory-admin-tab="fields">${context.tf(context.locale, 'fields', 'Fields')}</button>
            <button class="admin-tab-button" type="button" data-directory-admin-tab="skills">${context.tf(context.locale, 'skills', 'Skills')}</button>
            <button class="admin-tab-button" type="button" data-directory-admin-tab="permissions">${context.tf(context.locale, 'permissions', 'Permissions')}</button>
          </nav>
          <section id="directoryAdminRoot" class="directory-admin-root"></section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'directory.js')], pluginKeys: [feature.key] });
  }

  function sendSupportData(context, admin = false) {
    ensureProfilesForUsers(context);
    const profiles = context.listUsers().map((user) => serializeProfile(ensureProfile(user), context.user, { summary: false, admin }));
    context.sendJson(context.res, 200, {
      profiles,
      fields: listFields(),
      skills: listSkills(),
      roles: context.listRoles(),
      permissions: admin ? getPermissionMatrix() : undefined,
      permissionKeys: admin ? DIRECTORY_PERMISSION_KEYS : undefined,
      can: getCapabilities(context.user)
    });
  }

  function listProfiles(context) {
    ensureProfilesForUsers(context);
    const q = String(context.url.searchParams.get('q') || '').trim().toLowerCase();
    const skill = String(context.url.searchParams.get('skill') || '').trim();
    const department = String(context.url.searchParams.get('department') || '').trim();
    const role = String(context.url.searchParams.get('role') || '').trim();
    let items = context.listUsers().map((user) => serializeProfile(ensureProfile(user), context.user, { summary: true }));
    if (q) items = items.filter((profile) => searchBlob(profile).includes(q));
    if (skill) items = items.filter((profile) => profile.skills.some((item) => item.name === skill || String(item.id) === skill));
    if (department) items = items.filter((profile) => profile.department === department);
    if (role) items = items.filter((profile) => profile.roles.includes(role));
    context.sendJson(context.res, 200, { items, filters: buildFilters(items), can: getCapabilities(context.user) });
  }

  function getProfile(context) {
    const user = context.listUsers().find((item) => item.id === Number(context.url.searchParams.get('user_id') || 0));
    if (!user) return context.sendJson(context.res, 404, { error: 'Profile not found.' });
    context.sendJson(context.res, 200, serializeProfile(ensureProfile(user), context.user, { summary: false }));
  }

  function getMyProfile(context) {
    context.sendJson(context.res, 200, serializeProfile(ensureProfile(context.user), context.user, { summary: false, owner: true }));
  }

  async function saveProfile(context, admin = false) {
    const payload = await context.readJson(context.req);
    const targetUserId = admin ? Number(payload.userId || payload.user_id || 0) : context.user.id;
    const user = context.listUsers().find((item) => item.id === targetUserId);
    if (!user) return context.sendJson(context.res, 404, { error: 'User not found.' });
    const profile = ensureProfile(user);
    const data = normalizeProfilePayload(payload);
    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE directory_profiles SET display_name = ?, bio = ?, avatar_url = ?, location = ?, job_title = ?,
        department = ?, visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(data.displayName, data.bio, data.avatarUrl, data.location, data.jobTitle, data.department, data.visibility, profile.id);
      saveFieldValues(profile.id, payload.fieldValues || payload.field_values || {});
      saveProfileSkills(profile.id, payload.skills || []);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    context.sendJson(context.res, 200, { ok: true, profile: serializeProfile(getProfileByUserId(user.id), context.user, { summary: false, admin }) });
  }

  async function saveField(context) {
    const payload = await context.readJson(context.req);
    const id = Number(payload.id || 0);
    const name = String(payload.name || '').trim();
    if (!name) return context.sendJson(context.res, 400, { error: 'Name is required.' });
    const type = FIELD_TYPES.has(String(payload.fieldType || payload.field_type || 'text')) ? String(payload.fieldType || payload.field_type || 'text') : 'text';
    const visibility = normalizeVisibility(payload.visibilityDefault || payload.visibility_default || 'members');
    const sortOrder = Number(payload.sortOrder ?? payload.sort_order ?? 0) || 0;
    if (id) db.prepare('UPDATE directory_profile_fields SET name = ?, field_type = ?, is_required = ?, visibility_default = ?, sort_order = ? WHERE id = ?').run(name, type, payload.isRequired || payload.is_required ? 1 : 0, visibility, sortOrder, id);
    else db.prepare('INSERT INTO directory_profile_fields (name, field_type, is_required, visibility_default, sort_order) VALUES (?, ?, ?, ?, ?)').run(name, type, payload.isRequired || payload.is_required ? 1 : 0, visibility, sortOrder);
    context.sendJson(context.res, 200, { ok: true, fields: listFields() });
  }

  function deleteField(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/admin/directory/fields/'.length)));
    db.prepare('DELETE FROM directory_profile_fields WHERE id = ?').run(id);
    context.sendJson(context.res, 200, { ok: true });
  }

  async function saveSkill(context) {
    const payload = await context.readJson(context.req);
    const name = String(payload.name || '').trim();
    if (!name) return context.sendJson(context.res, 400, { error: 'Name is required.' });
    if (payload.id) db.prepare('UPDATE directory_skills SET name = ? WHERE id = ?').run(name, Number(payload.id));
    else db.prepare('INSERT OR IGNORE INTO directory_skills (name) VALUES (?)').run(name);
    context.sendJson(context.res, 200, { ok: true, skills: listSkills() });
  }

  function deleteSkill(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/admin/directory/skills/'.length)));
    db.prepare('DELETE FROM directory_skills WHERE id = ?').run(id);
    context.sendJson(context.res, 200, { ok: true });
  }

  async function savePermissions(context) {
    const payload = await context.readJson(context.req);
    const permissions = payload.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};
    const validRoles = new Set(context.listRoles().map((role) => role.name));
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM directory_permissions').run();
      for (const key of DIRECTORY_PERMISSION_KEYS) {
        for (const role of normalizeStringArray(permissions[key]).filter((item) => validRoles.has(item))) db.prepare('INSERT OR IGNORE INTO directory_permissions (permission_key, role_name) VALUES (?, ?)').run(key, role);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    context.sendJson(context.res, 200, { ok: true, permissions: getPermissionMatrix() });
  }

  function seedDefaultPermissions() {
    if (db.prepare('SELECT COUNT(*) AS count FROM directory_permissions').get().count) return;
    for (const key of DIRECTORY_PERMISSION_KEYS) db.prepare('INSERT OR IGNORE INTO directory_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Admins');
    for (const key of ['directory.view', 'directory.edit_own']) db.prepare('INSERT OR IGNORE INTO directory_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Users');
  }

  function hasPermission(user, key) {
    if (user?.is_admin) return true;
    return Boolean(user?.roles?.some((role) => db.prepare('SELECT 1 FROM directory_permissions WHERE permission_key = ? AND role_name = ?').get(key, role)));
  }

  function getCapabilities(user) {
    return Object.fromEntries(DIRECTORY_PERMISSION_KEYS.map((key) => [key.replace('directory.', '').replace(/_/g, ''), hasPermission(user, key)]));
  }

  function getPermissionMatrix() {
    const matrix = Object.fromEntries(DIRECTORY_PERMISSION_KEYS.map((key) => [key, []]));
    for (const row of db.prepare('SELECT permission_key, role_name FROM directory_permissions ORDER BY permission_key, role_name').all()) {
      if (!matrix[row.permission_key]) matrix[row.permission_key] = [];
      matrix[row.permission_key].push(row.role_name);
    }
    return matrix;
  }

  function ensureProfilesForUsers(context) {
    context.listUsers().forEach((user) => ensureProfile(user));
  }

  function ensureProfile(user) {
    const existing = getProfileByUserId(user.id);
    if (existing) return existing;
    db.prepare('INSERT INTO directory_profiles (user_id, display_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(user.id, user.name || user.email || 'User');
    return getProfileByUserId(user.id);
  }

  function getProfileByUserId(userId) {
    const row = db.prepare(`
      SELECT dp.*, u.email, u.name AS user_name, u.is_admin
      FROM directory_profiles dp JOIN users u ON u.id = dp.user_id
      WHERE dp.user_id = ?
    `).get(Number(userId || 0));
    return row ? normalizeProfileRow(row) : null;
  }

  function normalizeProfileRow(row) {
    const user = getUserWithRoles(row.user_id);
    return {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name || row.user_name || row.email,
      bio: row.bio || '',
      avatarUrl: row.avatar_url || '',
      location: row.location || '',
      jobTitle: row.job_title || '',
      department: row.department || '',
      visibility: row.visibility || 'members',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      user: { id: row.user_id, email: row.email, name: row.user_name, isAdmin: Boolean(row.is_admin) },
      roles: user.roles
    };
  }

  function getUserWithRoles(userId) {
    const user = db.prepare('SELECT id, email, name, is_admin FROM users WHERE id = ?').get(userId) || {};
    const roles = db.prepare('SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? ORDER BY r.name').all(userId).map((row) => row.name);
    return { ...user, roles };
  }

  function serializeProfile(profile, viewer, options = {}) {
    const isOwner = viewer?.id === profile.userId;
    const canPrivate = Boolean(options.admin || isOwner || hasPermission(viewer, 'directory.view_private_fields') || hasPermission(viewer, 'directory.manage_profiles'));
    const values = getProfileFieldValues(profile.id).filter((item) => canSeeFieldValue(item, canPrivate));
    const skills = getProfileSkills(profile.id);
    const summary = {
      ...profile,
      avatarUrl: sanitizeAvatar(profile.avatarUrl),
      fields: options.summary ? [] : values,
      skills,
      badges: [...profile.roles.slice(0, 2), ...skills.slice(0, 3).map((skill) => skill.name)],
      canEdit: isOwner && hasPermission(viewer, 'directory.edit_own'),
      canManage: hasPermission(viewer, 'directory.manage_profiles')
    };
    if (options.summary) summary.bio = profile.bio.slice(0, 180);
    return summary;
  }

  function canSeeFieldValue(item, canPrivate) {
    if (item.visibility === 'private') return canPrivate;
    return true;
  }

  function getProfileFieldValues(profileId) {
    const rows = db.prepare(`
      SELECT f.id AS field_id, f.name, f.field_type, f.is_required, f.visibility_default, f.sort_order, v.value, COALESCE(v.visibility, f.visibility_default) AS visibility
      FROM directory_profile_fields f
      LEFT JOIN directory_profile_field_values v ON v.field_id = f.id AND v.profile_id = ?
      ORDER BY f.sort_order, f.name
    `).all(profileId);
    return rows.map((row) => ({ fieldId: row.field_id, name: row.name, fieldType: row.field_type, isRequired: Boolean(row.is_required), visibilityDefault: row.visibility_default, sortOrder: row.sort_order, value: row.value || '', visibility: row.visibility || row.visibility_default }));
  }

  function listFields() {
    return db.prepare('SELECT id, name, field_type, is_required, visibility_default, sort_order FROM directory_profile_fields ORDER BY sort_order, name').all().map((row) => ({
      id: row.id,
      name: row.name,
      fieldType: row.field_type,
      isRequired: Boolean(row.is_required),
      visibilityDefault: row.visibility_default,
      sortOrder: row.sort_order
    }));
  }

  function listSkills() {
    return db.prepare('SELECT id, name FROM directory_skills ORDER BY name').all();
  }

  function getProfileSkills(profileId) {
    return db.prepare('SELECT ds.id, ds.name FROM directory_skills ds JOIN directory_profile_skills dps ON dps.skill_id = ds.id WHERE dps.profile_id = ? ORDER BY ds.name').all(profileId);
  }

  function saveFieldValues(profileId, values) {
    const byField = values && typeof values === 'object' ? values : {};
    for (const field of listFields()) {
      const payload = byField[field.id] || byField[String(field.id)] || {};
      if (payload.value === undefined && payload.visibility === undefined) continue;
      const visibility = normalizeVisibility(payload.visibility || field.visibilityDefault);
      db.prepare(`
        INSERT INTO directory_profile_field_values (profile_id, field_id, value, visibility)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_id, field_id) DO UPDATE SET value = excluded.value, visibility = excluded.visibility
      `).run(profileId, field.id, String(payload.value ?? ''), visibility);
    }
  }

  function saveProfileSkills(profileId, skills) {
    db.prepare('DELETE FROM directory_profile_skills WHERE profile_id = ?').run(profileId);
    for (const skillId of normalizeIdArray(skills)) db.prepare('INSERT OR IGNORE INTO directory_profile_skills (profile_id, skill_id) VALUES (?, ?)').run(profileId, skillId);
  }

  function normalizeProfilePayload(payload) {
    return {
      displayName: String(payload.displayName || payload.display_name || '').trim(),
      bio: String(payload.bio || '').trim(),
      avatarUrl: sanitizeAvatar(payload.avatarUrl || payload.avatar_url || ''),
      location: String(payload.location || '').trim(),
      jobTitle: String(payload.jobTitle || payload.job_title || '').trim(),
      department: String(payload.department || '').trim(),
      visibility: normalizeVisibility(payload.visibility || 'members')
    };
  }

  function sanitizeAvatar(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^https?:\/\/[^\s]+$/i.test(text)) return text;
    if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(text)) return text;
    return '';
  }

  function normalizeVisibility(value) {
    const text = String(value || '').trim();
    return VISIBILITIES.has(text) ? text : 'members';
  }

  function normalizeStringArray(value) {
    if (Array.isArray(value)) return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
    return String(value || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  }

  function normalizeIdArray(value) {
    return Array.from(new Set((Array.isArray(value) ? value : []).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)));
  }

  function searchBlob(profile) {
    return [
      profile.displayName,
      profile.bio,
      profile.location,
      profile.jobTitle,
      profile.department,
      profile.roles.join(' '),
      profile.skills.map((skill) => skill.name).join(' '),
      profile.fields.map((field) => field.value).join(' ')
    ].join(' ').toLowerCase();
  }

  function buildFilters(items) {
    return {
      skills: Array.from(new Map(items.flatMap((profile) => profile.skills).map((skill) => [skill.id, skill])).values()).sort((a, b) => a.name.localeCompare(b.name)),
      departments: Array.from(new Set(items.map((profile) => profile.department).filter(Boolean))).sort(),
      roles: Array.from(new Set(items.flatMap((profile) => profile.roles))).sort()
    };
  }
}
