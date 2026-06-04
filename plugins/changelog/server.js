import { join } from 'node:path';

const CHANGELOG_COLUMN_TYPES = new Set([
  'text',
  'long_text',
  'number',
  'date',
  'single_select',
  'multi_select',
  'status',
  'user',
  'tags',
  'boolean'
]);

const CHANGELOG_PERMISSION_KEYS = ['viewer', 'editor', 'admin'];
const CHANGELOG_RESERVED_COLUMN_KEYS = new Set(['created_by_name', 'updated_at', 'created_at', 'updated_by_name']);
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export default function createChangelogPlugin({ manifest, rootDir }) {
  let db = null;
  let helpers = null;

  const feature = {
    key: manifest.key || 'changelog',
    label: manifest.name || 'Changelog',
    href: '/changelogs',
    description: manifest.description || 'Configurable changelog lists with permissions, filters, analytics and export.',
    defaultEnabled: true
  };

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    localesDir: join(rootDir, 'locales'),
    adminPage: {
      href: '/admin/changelogs',
      label: manifest.name || 'Changelog'
    },
    init(context) {
      db = context.db;
      helpers = context;
      db.exec(`
        CREATE TABLE IF NOT EXISTS changelog_lists (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          intro_text TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          tag_suggestions_json TEXT NOT NULL DEFAULT '[]',
          creator_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          creator_name TEXT NOT NULL DEFAULT '',
          updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS changelog_list_roles (
          list_id INTEGER NOT NULL REFERENCES changelog_lists(id) ON DELETE CASCADE,
          permission_key TEXT NOT NULL,
          role_name TEXT NOT NULL,
          PRIMARY KEY (list_id, permission_key, role_name)
        );
        CREATE TABLE IF NOT EXISTS changelog_columns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          list_id INTEGER NOT NULL REFERENCES changelog_lists(id) ON DELETE CASCADE,
          column_key TEXT NOT NULL,
          label TEXT NOT NULL,
          type TEXT NOT NULL,
          required INTEGER NOT NULL DEFAULT 0,
          default_value_json TEXT NOT NULL DEFAULT 'null',
          options_json TEXT NOT NULL DEFAULT '[]',
          width TEXT NOT NULL DEFAULT '',
          visible INTEGER NOT NULL DEFAULT 1,
          sortable INTEGER NOT NULL DEFAULT 1,
          filterable INTEGER NOT NULL DEFAULT 1,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(list_id, column_key)
        );
        CREATE TABLE IF NOT EXISTS changelog_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          list_id INTEGER NOT NULL REFERENCES changelog_lists(id) ON DELETE CASCADE,
          created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_by_name TEXT NOT NULL DEFAULT '',
          updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_by_name TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS changelog_entry_values (
          entry_id INTEGER NOT NULL REFERENCES changelog_entries(id) ON DELETE CASCADE,
          column_id INTEGER NOT NULL REFERENCES changelog_columns(id) ON DELETE CASCADE,
          value_text TEXT NOT NULL DEFAULT '',
          value_json TEXT NOT NULL DEFAULT 'null',
          sort_text TEXT NOT NULL DEFAULT '',
          sort_number REAL,
          sort_date TEXT,
          PRIMARY KEY (entry_id, column_id)
        );
        CREATE INDEX IF NOT EXISTS idx_changelog_lists_status ON changelog_lists(status);
        CREATE INDEX IF NOT EXISTS idx_changelog_list_roles_lookup ON changelog_list_roles(list_id, permission_key, role_name);
        CREATE INDEX IF NOT EXISTS idx_changelog_columns_list_position ON changelog_columns(list_id, position);
        CREATE INDEX IF NOT EXISTS idx_changelog_entries_list_created ON changelog_entries(list_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_changelog_entries_list_updated ON changelog_entries(list_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_changelog_entries_list_creator ON changelog_entries(list_id, created_by_user_id);
        CREATE INDEX IF NOT EXISTS idx_changelog_entry_values_column_sort_text ON changelog_entry_values(column_id, sort_text);
        CREATE INDEX IF NOT EXISTS idx_changelog_entry_values_column_sort_number ON changelog_entry_values(column_id, sort_number);
        CREATE INDEX IF NOT EXISTS idx_changelog_entry_values_column_sort_date ON changelog_entry_values(column_id, sort_date);
      `);
    },
    resetToFactoryDefaults(context) {
      context.db.exec(`
        DELETE FROM changelog_entry_values;
        DELETE FROM changelog_entries;
        DELETE FROM changelog_columns;
        DELETE FROM changelog_list_roles;
        DELETE FROM changelog_lists;
        DELETE FROM sqlite_sequence WHERE name IN ('changelog_lists', 'changelog_columns', 'changelog_entries');
      `);
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/changelogs/support-data' && req.method === 'GET') {
        return await requireChangelogAdmin(context, async () => {
          context.sendJson(res, 200, {
            users: getUserDirectory(),
            roles: context.listRoles(),
            manageableLists: listManageableLists(user)
          });
        });
      }
      if (url.pathname === '/api/admin/changelogs/lists' && req.method === 'GET') {
        return await requireChangelogAdmin(context, async () => context.sendJson(res, 200, { items: listManageableLists(user) }));
      }
      if (url.pathname === '/api/admin/changelogs/list' && req.method === 'GET') {
        return await requireChangelogAdmin(context, async () => handleGetAdminList(context));
      }
      if (url.pathname === '/api/admin/changelogs/list' && req.method === 'POST') {
        return await requireChangelogAdmin(context, async () => handleSaveAdminList(context));
      }
      if (url.pathname === '/api/admin/changelogs/columns' && req.method === 'POST') {
        return await requireChangelogAdmin(context, async () => handleSaveColumns(context));
      }
      if (url.pathname === '/api/admin/changelogs/permissions' && req.method === 'POST') {
        return await requireChangelogAdmin(context, async () => handleSavePermissions(context));
      }

      if (url.pathname === '/api/changelogs/list' && req.method === 'GET') {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendJson(res, 404, { error: context.tf(locale, 'changelogFeatureDisabled', 'This feature is currently disabled.') });
          return true;
        }
        handleGetPublicList(context);
        return true;
      }
      if (url.pathname === '/api/changelogs/entries' && req.method === 'GET') {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendJson(res, 404, { error: context.tf(locale, 'changelogFeatureDisabled', 'This feature is currently disabled.') });
          return true;
        }
        handleGetEntries(context);
        return true;
      }
      if (url.pathname === '/api/changelogs/entry' && req.method === 'POST') {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendJson(res, 404, { error: context.tf(locale, 'changelogFeatureDisabled', 'This feature is currently disabled.') });
          return true;
        }
        await handleSaveEntry(context);
        return true;
      }
      if (url.pathname === '/api/changelogs/analytics' && req.method === 'GET') {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendJson(res, 404, { error: context.tf(locale, 'changelogFeatureDisabled', 'This feature is currently disabled.') });
          return true;
        }
        handleGetAnalytics(context);
        return true;
      }
      if (url.pathname === '/api/changelogs/export.csv' && req.method === 'GET') {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendJson(res, 404, { error: context.tf(locale, 'changelogFeatureDisabled', 'This feature is currently disabled.') });
          return true;
        }
        handleExportCsv(context);
        return true;
      }

      if (url.pathname === '/changelogs') {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'changelogFeatureDisabledNotice', 'The changelog feature is currently disabled.') }));
          return true;
        }
        context.sendHtml(res, 200, renderChangelogLandingPage(context));
        return true;
      }
      if (url.pathname.startsWith('/changelogs/')) {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'changelogFeatureDisabledNotice', 'The changelog feature is currently disabled.') }));
          return true;
        }
        context.sendHtml(res, 200, renderChangelogListPage(context));
        return true;
      }

      if (url.pathname === '/admin/changelogs' || url.pathname.startsWith('/admin/changelogs/')) {
        return await requireChangelogAdmin(context, async () => context.sendHtml(res, 200, renderChangelogAdminPage(context)));
      }

      return false;
    }
  };

  async function requireChangelogAdmin(context, callback) {
    if (!canAccessAdminArea(context.user)) {
      if (context.url.pathname.startsWith('/api/')) {
        context.sendJson(context.res, 403, { error: context.tf(context.locale, 'changelogAdminRequired', 'Changelog admin access is required.') });
      } else {
        context.sendHtml(context.res, 403, renderChangelogAdminDeniedPage(context));
      }
      return true;
    }
    await callback();
    return true;
  }

  function canAccessAdminArea(user) {
    if (user?.is_admin) return true;
    return listManageableLists(user).length > 0;
  }

  function renderChangelogLandingPage(context) {
    const settings = context.getSettings();
    const featureCopy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const manageableCount = listManageableLists(context.user).length;
    const visibleLists = listVisibleLists(context.user);
    const body = `
      <div class="app-shell changelog-shell">
        ${context.renderTopbar(context.user, context.locale, '/changelogs')}
        <main class="content changelog-page-shell">
          <section class="policy changelog-landing">
            <div class="policy-header">
              <div>
                <p class="eyebrow">${context.tf(context.locale, 'changelog', 'Changelog')}</p>
                <h1>${context.escapeHtml(featureCopy.label)}</h1>
                <p>${context.escapeHtml(featureCopy.description)}</p>
              </div>
              <dl class="meta-grid">
                <div><dt>${context.tf(context.locale, 'featureType', 'Feature')}</dt><dd>${context.tf(context.locale, 'sortableTables', 'Sortable lists')}</dd></div>
                <div><dt>${context.tf(context.locale, 'access', 'Access')}</dt><dd>${context.tf(context.locale, 'roleBased', 'Role based')}</dd></div>
                <div><dt>${context.tf(context.locale, 'management', 'Management')}</dt><dd>${manageableCount ? `${manageableCount} ${context.tf(context.locale, 'lists', 'lists')}` : context.tf(context.locale, 'manualLinksOnly', 'Use direct links')}</dd></div>
              </dl>
            </div>
            <div class="panel changelog-landing-panel">
              <h2>${context.tf(context.locale, 'availableChangelogs', 'Available changelogs')}</h2>
              <p>${visibleLists.length ? context.tf(context.locale, 'availableChangelogsText', 'Open one of the changelogs you can access. Individual changelog pages stay focused on exactly one list without sidebars for the others.') : context.tf(context.locale, 'noVisibleChangelogsText', 'No changelog is visible to you yet. Ask an administrator for access or add a direct link later.')}</p>
              ${visibleLists.length ? `
                <div class="cms-card-grid">
                  ${visibleLists.map((item) => `
                    <a class="cms-card changelog-list-card" href="/changelogs/${encodeURIComponent(item.slug)}">
                      <div class="cms-card-body">
                        <h2>${context.escapeHtml(item.title)}</h2>
                        <p>${context.escapeHtml(item.description || context.tf(context.locale, 'noDescription', 'No description yet.'))}</p>
                        <div class="filter-chip-row">
                          <span class="pill">${context.escapeHtml(item.status || 'active')}</span>
                          <span class="pill">${item.entryCount} ${context.escapeHtml(context.tf(context.locale, 'entries', 'entries'))}</span>
                        </div>
                      </div>
                    </a>
                  `).join('')}
                </div>
              ` : ''}
              ${manageableCount ? `<div class="row-actions"><a class="button primary" href="/admin/changelogs">${context.tf(context.locale, 'openChangelogAdmin', 'Open changelog admin')}</a></div>` : ''}
            </div>
          </section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: featureCopy.label,
      body,
      settings,
      locale: context.locale,
      pluginKeys: [feature.key]
    });
  }

  function renderChangelogListPage(context) {
    const settings = context.getSettings();
    const slug = decodeSlugFromPath(context.url.pathname, '/changelogs/');
    const body = `
      <div class="app-shell changelog-shell changelog-single-shell" data-changelog-app data-list-slug="${context.escapeAttribute(slug)}">
        ${context.renderTopbar(context.user, context.locale, '/changelogs')}
        <main class="content changelog-page-shell">
          <section class="policy changelog-page">
            <div id="changelogPublicError" class="notice admin-error" hidden></div>
            <div id="changelogPublicRoot" class="changelog-root">
              <div class="empty-state">
                <h1>${context.tf(context.locale, 'loading', 'Loading')}</h1>
                <p>${context.tf(context.locale, 'loadingChangelog', 'Atlas is loading this changelog.')}</p>
              </div>
            </div>
          </section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: slug || feature.label,
      body,
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'changelog.js')],
      pluginKeys: [feature.key]
    });
  }

  function renderChangelogAdminDeniedPage(context) {
    const settings = context.getSettings();
    const body = `
      <div class="app-shell">
        ${context.renderTopbar(context.user, context.locale, '/admin/changelogs')}
        <main class="admin-page">
          <div class="empty-state">
            <h1>${context.tf(context.locale, 'changelogAdminRequired', 'Changelog admin access is required.')}</h1>
            <p>${context.tf(context.locale, 'contactAdministrator', 'Ask an Atlas administrator to grant the required roles for this area.')}</p>
          </div>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: feature.label,
      body,
      settings,
      locale: context.locale,
      pluginKeys: [feature.key]
    });
  }

  function renderChangelogAdminPage(context) {
    const settings = context.getSettings();
    const slug = decodeSlugFromPath(context.url.pathname, '/admin/changelogs/');
    const featureCopy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell">
        ${context.renderTopbar(context.user, context.locale, '/admin/changelogs')}
        <main class="admin-page changelog-admin-page" data-changelog-admin-page data-list-slug="${context.escapeAttribute(slug)}">
          <div class="admin-header">
            <div>
              <h1>${context.escapeHtml(featureCopy.label)}</h1>
              <p class="hint">${context.escapeHtml(featureCopy.description)}</p>
            </div>
            <div class="row-actions">
              <a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a>
              <button class="button primary" type="button" data-new-changelog-list>${context.tf(context.locale, 'createList', 'Create list')}</button>
            </div>
          </div>
          <div id="changelogAdminError" class="notice admin-error" hidden></div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <section class="admin-grid changelog-admin-grid">
            <div class="panel content-nav-panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'lists', 'Lists')}</h2>
              </div>
              <div id="changelogListTree" class="content-tree"></div>
            </div>
            <div class="panel content-editor-panel changelog-admin-detail-panel">
              <div class="panel-head">
                <div>
                  <h2 id="changelogAdminTitle">${context.tf(context.locale, 'selectList', 'Select a list')}</h2>
                  <p class="hint" id="changelogAdminSubtitle">${context.tf(context.locale, 'selectListToManage', 'Choose a changelog list to manage entries, columns, access and settings.')}</p>
                </div>
                <div class="panel-head-actions">
                  <a class="button ghost" id="openLiveChangelogButton" href="/changelogs" hidden>${context.tf(context.locale, 'openLiveList', 'Open live list')}</a>
                </div>
              </div>
              <div class="content-editor-body">
                <div id="changelogAdminEmpty" class="empty-state content-empty-state">
                  <h1>${context.tf(context.locale, 'selectList', 'Select a list')}</h1>
                  <p>${context.tf(context.locale, 'selectListToManage', 'Choose a changelog list to manage entries, columns, access and settings.')}</p>
                </div>
                <div id="changelogAdminDetail" hidden>
                  <nav class="builder-subnav changelog-subtabs" aria-label="${context.tf(context.locale, 'changelogSections', 'Changelog sections')}">
                    <button class="admin-tab-button active" type="button" data-changelog-tab="entries">${context.tf(context.locale, 'entries', 'Entries')}</button>
                    <button class="admin-tab-button" type="button" data-changelog-tab="columns">${context.tf(context.locale, 'columns', 'Columns')}</button>
                    <button class="admin-tab-button" type="button" data-changelog-tab="permissions">${context.tf(context.locale, 'permissions', 'Permissions')}</button>
                    <button class="admin-tab-button" type="button" data-changelog-tab="analytics">${context.tf(context.locale, 'analytics', 'Analytics')}</button>
                    <button class="admin-tab-button" type="button" data-changelog-tab="settings">${context.tf(context.locale, 'settings', 'Settings')}</button>
                  </nav>
                  <section data-changelog-panel="entries">
                    <div class="panel-inline-section">
                      <div class="panel-head compact">
                        <h2>${context.tf(context.locale, 'entries', 'Entries')}</h2>
                        <div class="panel-head-actions">
                          <button class="button" type="button" data-new-entry>${context.tf(context.locale, 'newEntry', 'New entry')}</button>
                          <button class="button ghost" type="button" data-export-entries>${context.tf(context.locale, 'exportCsv', 'Export CSV')}</button>
                        </div>
                      </div>
                      <div id="changelogEntryToolbar"></div>
                      <div id="changelogEntryEditor"></div>
                      <div id="changelogEntryTable"></div>
                    </div>
                  </section>
                  <section data-changelog-panel="columns" hidden>
                    <div class="panel-inline-section">
                      <div class="panel-head compact">
                        <h2>${context.tf(context.locale, 'columns', 'Columns')}</h2>
                        <div class="panel-head-actions">
                          <button class="button" type="button" data-add-column>${context.tf(context.locale, 'addColumn', 'Add column')}</button>
                          <button class="button primary" type="button" data-save-columns>${context.tf(context.locale, 'saveColumns', 'Save columns')}</button>
                        </div>
                      </div>
                      <div id="changelogColumnsEditor"></div>
                    </div>
                  </section>
                  <section data-changelog-panel="permissions" hidden>
                    <div class="panel-inline-section">
                      <div class="panel-head compact">
                        <h2>${context.tf(context.locale, 'permissions', 'Permissions')}</h2>
                        <div class="panel-head-actions">
                          <button class="button primary" type="button" data-save-permissions>${context.tf(context.locale, 'savePermissions', 'Save permissions')}</button>
                        </div>
                      </div>
                      <div id="changelogPermissionsEditor"></div>
                    </div>
                  </section>
                  <section data-changelog-panel="analytics" hidden>
                    <div class="panel-inline-section">
                      <div class="panel-head compact">
                        <h2>${context.tf(context.locale, 'analytics', 'Analytics')}</h2>
                        <div class="panel-head-actions">
                          <button class="button ghost" type="button" data-refresh-analytics>${context.tf(context.locale, 'refreshAnalytics', 'Refresh analytics')}</button>
                        </div>
                      </div>
                      <div id="changelogAnalyticsPanel"></div>
                    </div>
                  </section>
                  <section data-changelog-panel="settings" hidden>
                    <form id="changelogSettingsForm" class="modal-form changelog-settings-form">
                      <input name="id" type="hidden">
                      <div class="content-meta">
                        <label>${context.tf(context.locale, 'slug', 'Slug')} <input name="slug" required></label>
                        <label>${context.tf(context.locale, 'title', 'Title')} <input name="title" required></label>
                        <label>${context.tf(context.locale, 'status', 'Status')}
                          <select name="status">
                            <option value="active">${context.tf(context.locale, 'active', 'Active')}</option>
                            <option value="archived">${context.tf(context.locale, 'archived', 'Archived')}</option>
                          </select>
                        </label>
                      </div>
                      <label>${context.tf(context.locale, 'description', 'Description')} <textarea name="description"></textarea></label>
                      <label>${context.tf(context.locale, 'introText', 'Intro text')} <textarea name="intro_text"></textarea></label>
                      <input name="tag_suggestions" type="hidden">
                      <section class="changelog-tag-admin panel-inline-section">
                        <div class="panel-head compact">
                          <div>
                            <h2>${context.tf(context.locale, 'tagSuggestions', 'Tag suggestions')}</h2>
                            <p class="hint">${context.tf(context.locale, 'tagSuggestionsHint', 'These tags are offered in tag dropdowns and can be extended with tags that already exist in entries.')}</p>
                          </div>
                        </div>
                        <div id="changelogTagSuggestionManager"></div>
                      </section>
                      <div class="modal-actions">
                        <button class="button primary" type="submit">${context.t(context.locale, 'save')}</button>
                      </div>
                    </form>
                  </section>
                </div>
              </div>
            </div>
          </section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: featureCopy.label,
      body,
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'changelog.js')],
      pluginKeys: [feature.key]
    });
  }

  function decodeSlugFromPath(pathname, prefix) {
    return decodeURIComponent(String(pathname || '').slice(prefix.length)).trim();
  }

  function handleGetAdminList(context) {
    const slug = String(context.url.searchParams.get('slug') || '').trim();
    const list = getListBySlug(slug);
    if (!list) return context.sendJson(context.res, 404, { error: 'Changelog list not found.' });
    if (!canManageList(context.user, list)) return context.sendJson(context.res, 403, { error: 'You do not have access to this list.' });
    context.sendJson(context.res, 200, serializeListDetail(context, list, { includePermissions: true }));
  }

  async function handleSaveAdminList(context) {
    const payload = await context.readJson(context.req);
    const now = new Date().toISOString();
    const slug = context.slugify(String(payload.slug || '').trim());
    const title = String(payload.title || '').trim();
    const description = String(payload.description || '').trim();
    const introText = String(payload.intro_text || payload.introText || '').trim();
    const status = normalizeListStatus(payload.status);
    const tagSuggestions = normalizeStringArray(payload.tag_suggestions ?? payload.tagSuggestions);
    const id = Number(payload.id || 0);

    if (!slug) return context.sendJson(context.res, 400, { error: 'A list slug is required.' });
    if (!title) return context.sendJson(context.res, 400, { error: 'A list title is required.' });

    if (id) {
      const existing = getListById(id);
      if (!existing) return context.sendJson(context.res, 404, { error: 'Changelog list not found.' });
      if (!canManageList(context.user, existing)) return context.sendJson(context.res, 403, { error: 'You do not have access to this list.' });
      const duplicate = db.prepare('SELECT id FROM changelog_lists WHERE slug = ? AND id != ?').get(slug, id);
      if (duplicate) return context.sendJson(context.res, 409, { error: 'This list slug is already in use.' });
      db.prepare(`
        UPDATE changelog_lists
        SET slug = ?, title = ?, description = ?, intro_text = ?, status = ?, tag_suggestions_json = ?, updated_by_user_id = ?, updated_at = ?
        WHERE id = ?
      `).run(slug, title, description, introText, status, JSON.stringify(tagSuggestions), context.user.id, now, id);
      return context.sendJson(context.res, 200, { ok: true, slug });
    }

    const duplicate = db.prepare('SELECT id FROM changelog_lists WHERE slug = ?').get(slug);
    if (duplicate) return context.sendJson(context.res, 409, { error: 'This list slug is already in use.' });
    const result = db.prepare(`
      INSERT INTO changelog_lists (
        slug, title, description, intro_text, status, tag_suggestions_json,
        creator_user_id, creator_name, updated_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slug,
      title,
      description,
      introText,
      status,
      JSON.stringify(tagSuggestions),
      context.user.id,
      context.user.name || context.user.email || '',
      context.user.id,
      now,
      now
    );
    createDefaultColumns(result.lastInsertRowid);
    context.sendJson(context.res, 200, { ok: true, slug });
  }

  async function handleSaveColumns(context) {
    const payload = await context.readJson(context.req);
    const list = getListBySlug(String(payload.slug || '').trim());
    if (!list) return context.sendJson(context.res, 404, { error: 'Changelog list not found.' });
    if (!canManageList(context.user, list)) return context.sendJson(context.res, 403, { error: 'You do not have access to this list.' });
    const columns = Array.isArray(payload.columns) ? payload.columns : [];
    const nextColumns = [];
    const seenKeys = new Set();
    const existing = listColumns(list.id);
    const existingIds = new Set(existing.map((column) => column.id));
    const keepIds = new Set();
    const now = new Date().toISOString();

    for (let index = 0; index < columns.length; index += 1) {
      const normalized = normalizeColumnPayload(columns[index], index);
      if (CHANGELOG_RESERVED_COLUMN_KEYS.has(normalized.key)) {
        return context.sendJson(context.res, 400, { error: `Column key is reserved: ${normalized.key}` });
      }
      if (seenKeys.has(normalized.key)) return context.sendJson(context.res, 400, { error: `Duplicate column key: ${normalized.key}` });
      seenKeys.add(normalized.key);
      nextColumns.push(normalized);
    }

    if (!nextColumns.length) return context.sendJson(context.res, 400, { error: 'At least one column is required.' });

    for (const column of nextColumns) {
      if (column.id && existingIds.has(column.id)) {
        keepIds.add(column.id);
        db.prepare(`
          UPDATE changelog_columns
          SET column_key = ?, label = ?, type = ?, required = ?, default_value_json = ?, options_json = ?, width = ?, visible = ?, sortable = ?, filterable = ?, position = ?, updated_at = ?
          WHERE id = ? AND list_id = ?
        `).run(
          column.key,
          column.label,
          column.type,
          column.required ? 1 : 0,
          JSON.stringify(column.defaultValue),
          JSON.stringify(column.options),
          column.width,
          column.visible ? 1 : 0,
          column.sortable ? 1 : 0,
          column.filterable ? 1 : 0,
          column.position,
          now,
          column.id,
          list.id
        );
      } else {
        const result = db.prepare(`
          INSERT INTO changelog_columns (
            list_id, column_key, label, type, required, default_value_json, options_json,
            width, visible, sortable, filterable, position, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          list.id,
          column.key,
          column.label,
          column.type,
          column.required ? 1 : 0,
          JSON.stringify(column.defaultValue),
          JSON.stringify(column.options),
          column.width,
          column.visible ? 1 : 0,
          column.sortable ? 1 : 0,
          column.filterable ? 1 : 0,
          column.position,
          now,
          now
        );
        keepIds.add(result.lastInsertRowid);
      }
    }

    for (const column of existing) {
      if (keepIds.has(column.id)) continue;
      db.prepare('DELETE FROM changelog_entry_values WHERE column_id = ?').run(column.id);
      db.prepare('DELETE FROM changelog_columns WHERE id = ?').run(column.id);
    }

    context.sendJson(context.res, 200, { ok: true, columns: listColumns(list.id) });
  }

  async function handleSavePermissions(context) {
    const payload = await context.readJson(context.req);
    const list = getListBySlug(String(payload.slug || '').trim());
    if (!list) return context.sendJson(context.res, 404, { error: 'Changelog list not found.' });
    if (!canManageList(context.user, list)) return context.sendJson(context.res, 403, { error: 'You do not have access to this list.' });
    const permissions = payload.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};
    const validRoles = new Set(context.listRoles().map((role) => role.name));
    db.prepare('DELETE FROM changelog_list_roles WHERE list_id = ?').run(list.id);
    for (const permissionKey of CHANGELOG_PERMISSION_KEYS) {
      const roles = normalizeStringArray(permissions[permissionKey]);
      for (const roleName of roles) {
        if (!validRoles.has(roleName)) continue;
        db.prepare('INSERT INTO changelog_list_roles (list_id, permission_key, role_name) VALUES (?, ?, ?)').run(list.id, permissionKey, roleName);
      }
    }
    context.sendJson(context.res, 200, { ok: true, permissions: getListPermissions(list.id) });
  }

  function handleGetPublicList(context) {
    const slug = String(context.url.searchParams.get('slug') || '').trim();
    const list = getListBySlug(slug);
    if (!list) return context.sendJson(context.res, 404, { error: 'Changelog list not found.' });
    if (!canViewList(context.user, list)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'changelogNoAccess', 'You do not have access to this changelog.') });
    context.sendJson(context.res, 200, serializeListDetail(context, list, { includePermissions: canManageList(context.user, list) }));
  }

  function handleGetEntries(context) {
    const slug = String(context.url.searchParams.get('slug') || '').trim();
    const list = getListBySlug(slug);
    if (!list) return context.sendJson(context.res, 404, { error: 'Changelog list not found.' });
    if (!canViewList(context.user, list)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'changelogNoAccess', 'You do not have access to this changelog.') });
    const columns = listColumns(list.id);
    const queryOptions = parseEntryQuery(context.url.searchParams, columns);
    const pageResult = queryEntries(list, columns, queryOptions, context.user);
    context.sendJson(context.res, 200, pageResult);
  }

  async function handleSaveEntry(context) {
    const payload = await context.readJson(context.req);
    const list = getListBySlug(String(payload.slug || '').trim());
    if (!list) return context.sendJson(context.res, 404, { error: 'Changelog list not found.' });
    if (!canEditList(context.user, list)) return context.sendJson(context.res, 403, { error: 'You do not have permission to create entries for this list.' });
    const columns = listColumns(list.id);
    const values = payload.values && typeof payload.values === 'object' ? payload.values : {};
    const normalizedByColumnId = new Map();

    for (const column of columns) {
      const sourceValue = Object.prototype.hasOwnProperty.call(values, column.key) ? values[column.key] : parseStoredJson(column.defaultValueJson, null);
      const normalized = normalizeEntryValue(column, sourceValue);
      if (column.required && isEmptyNormalizedValue(normalized)) {
        return context.sendJson(context.res, 400, { error: `${column.label} is required.` });
      }
      normalizedByColumnId.set(column.id, normalized);
    }

    const now = new Date().toISOString();
    const entryId = Number(payload.id || 0);
    if (entryId) {
      const entry = getEntryById(entryId);
      if (!entry || entry.list_id !== list.id) return context.sendJson(context.res, 404, { error: 'Entry not found.' });
      if (!canEditEntry(context.user, list, entry)) return context.sendJson(context.res, 403, { error: 'You may only edit your own entries unless you are a changelog admin.' });
      db.prepare(`
        UPDATE changelog_entries
        SET updated_by_user_id = ?, updated_by_name = ?, updated_at = ?
        WHERE id = ?
      `).run(context.user.id, context.user.name || context.user.email || '', now, entryId);
      for (const column of columns) {
        persistEntryValue(entryId, column, normalizedByColumnId.get(column.id));
      }
      return context.sendJson(context.res, 200, { ok: true, id: entryId });
    }

    const result = db.prepare(`
      INSERT INTO changelog_entries (
        list_id, created_by_user_id, created_by_name, updated_by_user_id, updated_by_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      list.id,
      context.user.id,
      context.user.name || context.user.email || '',
      context.user.id,
      context.user.name || context.user.email || '',
      now,
      now
    );
    for (const column of columns) {
      persistEntryValue(result.lastInsertRowid, column, normalizedByColumnId.get(column.id));
    }
    context.sendJson(context.res, 200, { ok: true, id: result.lastInsertRowid });
  }

  function handleGetAnalytics(context) {
    const slug = String(context.url.searchParams.get('slug') || '').trim();
    const list = getListBySlug(slug);
    if (!list) return context.sendJson(context.res, 404, { error: 'Changelog list not found.' });
    if (!canViewList(context.user, list)) return context.sendJson(context.res, 403, { error: 'You do not have access to this changelog.' });
    const columns = listColumns(list.id);
    const queryOptions = parseEntryQuery(context.url.searchParams, columns);
    const analytics = buildAnalytics(list, columns, queryOptions);
    context.sendJson(context.res, 200, analytics);
  }

  function handleExportCsv(context) {
    const slug = String(context.url.searchParams.get('slug') || '').trim();
    const list = getListBySlug(slug);
    if (!list) return context.sendJson(context.res, 404, { error: 'Changelog list not found.' });
    if (!canViewList(context.user, list)) return context.sendJson(context.res, 403, { error: 'You do not have access to this changelog.' });
    const columns = listColumns(list.id);
    const queryOptions = parseEntryQuery(context.url.searchParams, columns);
    const rows = queryAllEntryRows(list, columns, queryOptions);
    const csv = exportRowsToCsv(columns, rows);
    const fileName = `${list.slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    context.res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store, max-age=0'
    });
    context.res.end(csv);
  }

  function listManageableLists(user) {
    return listLists()
      .filter((list) => canManageList(user, list))
      .map((list) => ({
        id: list.id,
        slug: list.slug,
        title: list.title,
        description: list.description,
        status: list.status,
        entryCount: countEntriesForList(list.id),
        liveHref: `/changelogs/${encodeURIComponent(list.slug)}`,
        adminHref: `/admin/changelogs/${encodeURIComponent(list.slug)}`
      }))
      .sort((a, b) => a.title.localeCompare(b.title, 'de'));
  }

  function listVisibleLists(user) {
    return listLists()
      .filter((list) => canViewList(user, list))
      .map((list) => ({
        id: list.id,
        slug: list.slug,
        title: list.title,
        description: list.description,
        status: list.status,
        entryCount: countEntriesForList(list.id)
      }))
      .sort((a, b) => a.title.localeCompare(b.title, 'de'));
  }

  function listLists() {
    return db.prepare('SELECT * FROM changelog_lists ORDER BY title COLLATE NOCASE').all();
  }

  function getListBySlug(slug) {
    if (!slug) return null;
    return db.prepare('SELECT * FROM changelog_lists WHERE slug = ?').get(slug) || null;
  }

  function getListById(id) {
    return db.prepare('SELECT * FROM changelog_lists WHERE id = ?').get(id) || null;
  }

  function getEntryById(id) {
    return db.prepare('SELECT * FROM changelog_entries WHERE id = ?').get(id) || null;
  }

  function listColumns(listId) {
    return db.prepare('SELECT * FROM changelog_columns WHERE list_id = ? ORDER BY position, id').all(listId).map(normalizeColumnRecord);
  }

  function normalizeColumnRecord(row) {
    return {
      id: row.id,
      listId: row.list_id,
      key: row.column_key,
      label: row.label,
      type: row.type,
      required: Boolean(row.required),
      defaultValue: parseStoredJson(row.default_value_json, null),
      defaultValueJson: row.default_value_json,
      options: normalizeStringArray(parseStoredJson(row.options_json, [])),
      width: row.width || '',
      visible: Boolean(row.visible),
      sortable: Boolean(row.sortable),
      filterable: Boolean(row.filterable),
      position: Number(row.position || 0)
    };
  }

  function getListPermissions(listId) {
    const rows = db.prepare('SELECT permission_key, role_name FROM changelog_list_roles WHERE list_id = ? ORDER BY permission_key, role_name').all(listId);
    const permissions = {
      viewer: [],
      editor: [],
      admin: []
    };
    for (const row of rows) {
      if (!permissions[row.permission_key]) permissions[row.permission_key] = [];
      permissions[row.permission_key].push(row.role_name);
    }
    return permissions;
  }

  function getUserDirectory() {
    return helpers.listUsers()
      .filter((user) => user.active)
      .map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name || user.email
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  function canViewList(user, list) {
    if (user?.is_admin) return true;
    if (!user?.active) return false;
    if (Number(list.creator_user_id || 0) === Number(user.id || 0)) return true;
    const permissions = getListPermissions(list.id);
    if (hasRoleIntersection(user.roles, permissions.admin)) return true;
    if (hasRoleIntersection(user.roles, permissions.editor)) return true;
    return hasRoleIntersection(user.roles, permissions.viewer);
  }

  function canEditList(user, list) {
    if (user?.is_admin) return true;
    if (!user?.active) return false;
    if (Number(list.creator_user_id || 0) === Number(user.id || 0)) return true;
    const permissions = getListPermissions(list.id);
    if (hasRoleIntersection(user.roles, permissions.admin)) return true;
    return hasRoleIntersection(user.roles, permissions.editor);
  }

  function canManageList(user, list) {
    if (user?.is_admin) return true;
    if (!user?.active) return false;
    if (Number(list.creator_user_id || 0) === Number(user.id || 0)) return true;
    const permissions = getListPermissions(list.id);
    return hasRoleIntersection(user.roles, permissions.admin);
  }

  function canEditEntry(user, list, entry) {
    if (canManageList(user, list)) return true;
    return Number(entry.created_by_user_id || 0) === Number(user?.id || 0);
  }

  function hasRoleIntersection(userRoles, requiredRoles) {
    const userRoleSet = new Set(Array.isArray(userRoles) ? userRoles : []);
    return Array.isArray(requiredRoles) && requiredRoles.some((role) => userRoleSet.has(role));
  }

  function normalizeListStatus(value) {
    return String(value || '').trim().toLowerCase() === 'archived' ? 'archived' : 'active';
  }

  function normalizeColumnPayload(payload, index = 0) {
    const type = String(payload?.type || 'text').trim().toLowerCase();
    if (!CHANGELOG_COLUMN_TYPES.has(type)) throw new Error(`Unsupported column type: ${type}`);
    const key = helpers.slugify(String(payload?.key || payload?.label || `column-${index + 1}`).trim()).replace(/-/g, '_');
    if (!key) throw new Error('A column key is required.');
    const label = String(payload?.label || key).trim();
    if (!label) throw new Error('A column label is required.');
    return {
      id: Number(payload?.id || 0) || null,
      key,
      label,
      type,
      required: Boolean(payload?.required),
      defaultValue: normalizeDefaultValue(type, payload?.defaultValue),
      options: normalizeStringArray(payload?.options),
      width: sanitizeWidth(payload?.width),
      visible: payload?.visible !== false,
      sortable: payload?.sortable !== false,
      filterable: payload?.filterable !== false,
      position: index
    };
  }

  function normalizeDefaultValue(type, value) {
    if (value === undefined) return defaultValueForType(type);
    return normalizeEntryValue({ type, options: normalizeStringArray([]), required: false }, value).raw;
  }

  function defaultValueForType(type) {
    if (type === 'multi_select' || type === 'tags') return [];
    if (type === 'boolean') return false;
    return null;
  }

  function sanitizeWidth(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^\d+(px|fr|rem|%)$/i.test(text)) return text;
    return '';
  }

  function createDefaultColumns(listId) {
    const defaults = [
      { key: 'summary', label: 'Summary', type: 'text', required: true, defaultValue: null, options: [], width: '24rem', visible: true, sortable: true, filterable: true, position: 0 },
      { key: 'status', label: 'Status', type: 'status', required: false, defaultValue: 'open', options: ['open', 'in_progress', 'done'], width: '10rem', visible: true, sortable: true, filterable: true, position: 1 },
      { key: 'change_date', label: 'Date', type: 'date', required: false, defaultValue: null, options: [], width: '10rem', visible: true, sortable: true, filterable: true, position: 2 },
      { key: 'tags', label: 'Tags', type: 'tags', required: false, defaultValue: [], options: [], width: '14rem', visible: true, sortable: false, filterable: true, position: 3 }
    ];
    const now = new Date().toISOString();
    for (const column of defaults) {
      db.prepare(`
        INSERT INTO changelog_columns (
          list_id, column_key, label, type, required, default_value_json, options_json,
          width, visible, sortable, filterable, position, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        listId,
        column.key,
        column.label,
        column.type,
        column.required ? 1 : 0,
        JSON.stringify(column.defaultValue),
        JSON.stringify(column.options),
        column.width,
        column.visible ? 1 : 0,
        column.sortable ? 1 : 0,
        column.filterable ? 1 : 0,
        column.position,
        now,
        now
      );
    }
  }

  function parseEntryQuery(searchParams, columns) {
    const page = Math.max(1, Number(searchParams.get('page') || 1) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(10, Number(searchParams.get('page_size') || DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE));
    const sort = String(searchParams.get('sort') || 'updated_at').trim();
    const dir = String(searchParams.get('dir') || 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
    const q = String(searchParams.get('q') || '').trim();
    let filters = {};
    try {
      filters = JSON.parse(String(searchParams.get('filters') || '{}'));
    } catch {
      filters = {};
    }
    if (!filters || typeof filters !== 'object') filters = {};
    const filterMap = {};
    const columnByKey = new Map(columns.map((column) => [column.key, column]));
    for (const [key, rawValue] of Object.entries(filters)) {
      const column = columnByKey.get(key);
      if (!column || !column.filterable) continue;
      filterMap[key] = normalizeFilterValue(column, rawValue);
    }
    const creator = String(searchParams.get('creator') || '').trim();
    const updatedFrom = normalizeDateString(searchParams.get('updated_from'));
    const updatedTo = normalizeDateString(searchParams.get('updated_to'));
    return {
      page,
      pageSize,
      sort,
      dir,
      q,
      filters: filterMap,
      creator,
      updatedFrom,
      updatedTo
    };
  }

  function normalizeFilterValue(column, rawValue) {
    if (column.type === 'multi_select' || column.type === 'tags') return normalizeStringArray(rawValue);
    if (column.type === 'boolean') return rawValue === true || rawValue === 'true' ? 'true' : rawValue === false || rawValue === 'false' ? 'false' : '';
    if (column.type === 'number' && rawValue && typeof rawValue === 'object') {
      return {
        min: rawValue.min === '' || rawValue.min === null || rawValue.min === undefined ? null : Number(rawValue.min),
        max: rawValue.max === '' || rawValue.max === null || rawValue.max === undefined ? null : Number(rawValue.max)
      };
    }
    if (column.type === 'date' && rawValue && typeof rawValue === 'object') {
      return {
        from: normalizeDateString(rawValue.from),
        to: normalizeDateString(rawValue.to)
      };
    }
    return String(rawValue || '').trim();
  }

  function queryEntries(list, columns, queryOptions, currentUser = null) {
    const { rows, total } = queryEntryRows(list, columns, queryOptions, false, currentUser);
    const totalPages = Math.max(1, Math.ceil(total / queryOptions.pageSize));
    return {
      items: rows,
      total,
      page: queryOptions.page,
      pageSize: queryOptions.pageSize,
      totalPages,
      sort: queryOptions.sort,
      dir: queryOptions.dir
    };
  }

  function queryAllEntryRows(list, columns, queryOptions) {
    return queryEntryRows(list, columns, { ...queryOptions, page: 1, pageSize: 100000 }, true, null).rows;
  }

  function queryEntryRows(list, columns, queryOptions, includeAll, currentUser = null) {
    const columnByKey = new Map(columns.map((column) => [column.key, column]));
    const { where, params } = buildEntryWhereClause(list, columns, queryOptions);
    const sortMeta = resolveSort(queryOptions.sort, queryOptions.dir, columnByKey);
    const countSql = `SELECT COUNT(*) AS total FROM changelog_entries e WHERE ${where.join(' AND ')}`;
    const total = Number(db.prepare(countSql).get(...params)?.total || 0);
    const sortJoin = sortMeta.join ? ` ${sortMeta.join}` : '';
    const pagingSql = includeAll ? '' : ' LIMIT ? OFFSET ?';
    const selectSql = `SELECT e.* FROM changelog_entries e${sortJoin} WHERE ${where.join(' AND ')} ORDER BY ${sortMeta.orderBy}${pagingSql}`;
    const selectParams = sortMeta.params.concat(params);
    if (!includeAll) {
      selectParams.push(queryOptions.pageSize, (queryOptions.page - 1) * queryOptions.pageSize);
    }
    const entryRows = db.prepare(selectSql).all(...selectParams);
    const valuesByEntry = loadEntryValues(entryRows.map((row) => row.id), columns);
    const rows = entryRows.map((row) => serializeEntryRow(row, valuesByEntry.get(row.id) || new Map(), columns, list, currentUser));
    return { rows, total };
  }

  function resolveSort(sortKey, dir, columnByKey) {
    const direction = dir === 'asc' ? 'ASC' : 'DESC';
    if (sortKey === 'created_at') return { join: '', params: [], orderBy: `e.created_at ${direction}, e.id DESC` };
    if (sortKey === 'updated_at') return { join: '', params: [], orderBy: `e.updated_at ${direction}, e.id DESC` };
    if (sortKey === 'created_by_name') return { join: '', params: [], orderBy: `LOWER(e.created_by_name) ${direction}, e.updated_at DESC` };
    const column = columnByKey.get(sortKey);
    if (!column || !column.sortable) return { join: '', params: [], orderBy: 'e.updated_at DESC, e.id DESC' };
    const join = ' LEFT JOIN changelog_entry_values sortv ON sortv.entry_id = e.id AND sortv.column_id = ?';
    const params = [column.id];
    if (column.type === 'number') return { join, params, orderBy: `CASE WHEN sortv.sort_number IS NULL THEN 1 ELSE 0 END ASC, sortv.sort_number ${direction}, e.updated_at DESC` };
    if (column.type === 'date') return { join, params, orderBy: `COALESCE(sortv.sort_date, '') ${direction}, e.updated_at DESC` };
    return { join, params, orderBy: `LOWER(COALESCE(sortv.sort_text, '')) ${direction}, e.updated_at DESC` };
  }

  function buildEntryWhereClause(list, columns, queryOptions) {
    const where = ['e.list_id = ?'];
    const params = [list.id];
    const columnByKey = new Map(columns.map((column) => [column.key, column]));

    if (queryOptions.q) {
      const needle = `%${queryOptions.q.toLowerCase()}%`;
      where.push(`(
        LOWER(e.created_by_name) LIKE ?
        OR EXISTS (
          SELECT 1 FROM changelog_entry_values qv
          WHERE qv.entry_id = e.id
            AND LOWER(qv.sort_text) LIKE ?
        )
      )`);
      params.push(needle, needle);
    }

    if (queryOptions.creator) {
      where.push('LOWER(e.created_by_name) = ?');
      params.push(queryOptions.creator.toLowerCase());
    }

    if (queryOptions.updatedFrom) {
      where.push('e.updated_at >= ?');
      params.push(queryOptions.updatedFrom);
    }
    if (queryOptions.updatedTo) {
      where.push('e.updated_at <= ?');
      params.push(`${queryOptions.updatedTo}T23:59:59.999Z`);
    }

    let aliasIndex = 0;
    for (const [key, value] of Object.entries(queryOptions.filters || {})) {
      const column = columnByKey.get(key);
      if (!column) continue;
      aliasIndex += 1;
      const alias = `f${aliasIndex}`;
      if (column.type === 'number' && value && typeof value === 'object') {
        if (Number.isFinite(value.min)) {
          where.push(`EXISTS (SELECT 1 FROM changelog_entry_values ${alias} WHERE ${alias}.entry_id = e.id AND ${alias}.column_id = ? AND ${alias}.sort_number >= ?)`);
          params.push(column.id, value.min);
        }
        if (Number.isFinite(value.max)) {
          where.push(`EXISTS (SELECT 1 FROM changelog_entry_values ${alias}b WHERE ${alias}b.entry_id = e.id AND ${alias}b.column_id = ? AND ${alias}b.sort_number <= ?)`);
          params.push(column.id, value.max);
        }
        continue;
      }
      if (column.type === 'date' && value && typeof value === 'object') {
        if (value.from) {
          where.push(`EXISTS (SELECT 1 FROM changelog_entry_values ${alias} WHERE ${alias}.entry_id = e.id AND ${alias}.column_id = ? AND ${alias}.sort_date >= ?)`);
          params.push(column.id, value.from);
        }
        if (value.to) {
          where.push(`EXISTS (SELECT 1 FROM changelog_entry_values ${alias}b WHERE ${alias}b.entry_id = e.id AND ${alias}b.column_id = ? AND ${alias}b.sort_date <= ?)`);
          params.push(column.id, value.to);
        }
        continue;
      }
      if (Array.isArray(value) && value.length) {
        const fragments = value.map(() => `${alias}.sort_text LIKE ?`);
        where.push(`EXISTS (SELECT 1 FROM changelog_entry_values ${alias} WHERE ${alias}.entry_id = e.id AND ${alias}.column_id = ? AND (${fragments.join(' OR ')}))`);
        params.push(column.id, ...value.map((item) => `%|${item.toLowerCase()}|%`));
        continue;
      }
      if (column.type === 'boolean' && value) {
        where.push(`EXISTS (SELECT 1 FROM changelog_entry_values ${alias} WHERE ${alias}.entry_id = e.id AND ${alias}.column_id = ? AND ${alias}.sort_text = ?)`);
        params.push(column.id, value);
        continue;
      }
      const text = String(value || '').trim().toLowerCase();
      if (!text) continue;
      if (column.type === 'text' || column.type === 'long_text') {
        where.push(`EXISTS (SELECT 1 FROM changelog_entry_values ${alias} WHERE ${alias}.entry_id = e.id AND ${alias}.column_id = ? AND LOWER(${alias}.sort_text) LIKE ?)`);
        params.push(column.id, `%${text}%`);
      } else {
        where.push(`EXISTS (SELECT 1 FROM changelog_entry_values ${alias} WHERE ${alias}.entry_id = e.id AND ${alias}.column_id = ? AND LOWER(${alias}.sort_text) = ?)`);
        params.push(column.id, text);
      }
    }

    return { where, params };
  }

  function loadEntryValues(entryIds, columns) {
    const map = new Map();
    if (!entryIds.length || !columns.length) return map;
    const placeholders = entryIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT * FROM changelog_entry_values
      WHERE entry_id IN (${placeholders})
    `).all(...entryIds);
    const columnById = new Map(columns.map((column) => [column.id, column]));
    for (const row of rows) {
      if (!map.has(row.entry_id)) map.set(row.entry_id, new Map());
      const column = columnById.get(row.column_id);
      if (!column) continue;
      map.get(row.entry_id).set(column.key, deserializeEntryValue(column, row));
    }
    return map;
  }

  function serializeEntryRow(row, valuesMap, columns, list, userOverride = null) {
    const currentUser = userOverride && userOverride.id ? userOverride : null;
    const values = {};
    const displayValues = {};
    for (const column of columns) {
      const normalized = valuesMap.get(column.key) ?? normalizeEntryValue(column, parseStoredJson(column.defaultValueJson, null));
      values[column.key] = normalized.raw;
      displayValues[column.key] = formatEntryDisplayValue(column, normalized.raw);
    }
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdByName: row.created_by_name,
      updatedByName: row.updated_by_name,
      canEdit: currentUser ? canEditEntry(currentUser, list, row) : false,
      values,
      displayValues
    };
  }

  function serializeListDetail(context, list, { includePermissions = false } = {}) {
    const columns = listColumns(list.id);
    const permissions = getListPermissions(list.id);
    const dynamicOptions = getDynamicColumnOptions(list.id, columns);
    const creators = db.prepare(`
      SELECT DISTINCT created_by_name
      FROM changelog_entries
      WHERE list_id = ? AND created_by_name != ''
      ORDER BY created_by_name COLLATE NOCASE
    `).all(list.id).map((row) => row.created_by_name);
    const payload = {
      id: list.id,
      slug: list.slug,
      title: list.title,
      description: list.description || '',
      introText: list.intro_text || '',
      status: list.status || 'active',
      tagSuggestions: normalizeStringArray(parseStoredJson(list.tag_suggestions_json, [])),
      columns,
      liveHref: `/changelogs/${encodeURIComponent(list.slug)}`,
      adminHref: `/admin/changelogs/${encodeURIComponent(list.slug)}`,
      can: {
        view: canViewList(context.user, list),
        edit: canEditList(context.user, list),
        manage: canManageList(context.user, list)
      },
      dynamicOptions,
      creators,
      users: getUserDirectory()
    };
    if (includePermissions) payload.permissions = permissions;
    return payload;
  }

  function normalizeEntryValue(column, value) {
    const type = String(column.type || 'text');
    if (type === 'number') {
      if (value === null || value === undefined || value === '') return { raw: null, valueText: '', valueJson: 'null', sortText: '', sortNumber: null, sortDate: null };
      const numeric = Number(value);
      return Number.isFinite(numeric)
        ? { raw: numeric, valueText: String(numeric), valueJson: JSON.stringify(numeric), sortText: String(numeric), sortNumber: numeric, sortDate: null }
        : { raw: null, valueText: '', valueJson: 'null', sortText: '', sortNumber: null, sortDate: null };
    }
    if (type === 'date') {
      const date = normalizeDateString(value);
      return { raw: date || null, valueText: date || '', valueJson: JSON.stringify(date || null), sortText: date || '', sortNumber: null, sortDate: date || null };
    }
    if (type === 'multi_select' || type === 'tags') {
      const items = normalizeStringArray(value);
      const lowered = items.map((item) => item.toLowerCase());
      return {
        raw: items,
        valueText: items.join(', '),
        valueJson: JSON.stringify(items),
        sortText: lowered.length ? `|${lowered.join('|')}|` : '',
        sortNumber: null,
        sortDate: null
      };
    }
    if (type === 'boolean') {
      const bool = value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
      return {
        raw: bool,
        valueText: bool ? 'true' : 'false',
        valueJson: JSON.stringify(bool),
        sortText: bool ? 'true' : 'false',
        sortNumber: bool ? 1 : 0,
        sortDate: null
      };
    }
    const text = String(value ?? '').trim();
    return {
      raw: text || null,
      valueText: text,
      valueJson: JSON.stringify(text || null),
      sortText: text.toLowerCase(),
      sortNumber: null,
      sortDate: null
    };
  }

  function isEmptyNormalizedValue(normalized) {
    if (Array.isArray(normalized.raw)) return normalized.raw.length === 0;
    return normalized.raw === null || normalized.raw === undefined || normalized.raw === '';
  }

  function persistEntryValue(entryId, column, normalized) {
    db.prepare(`
      INSERT INTO changelog_entry_values (entry_id, column_id, value_text, value_json, sort_text, sort_number, sort_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id, column_id)
      DO UPDATE SET value_text = excluded.value_text, value_json = excluded.value_json, sort_text = excluded.sort_text, sort_number = excluded.sort_number, sort_date = excluded.sort_date
    `).run(
      entryId,
      column.id,
      normalized.valueText,
      normalized.valueJson,
      normalized.sortText,
      normalized.sortNumber,
      normalized.sortDate
    );
  }

  function deserializeEntryValue(column, row) {
    if (column.type === 'number') return normalizeEntryValue(column, row.sort_number);
    if (column.type === 'date') return normalizeEntryValue(column, row.sort_date || row.value_text);
    return normalizeEntryValue(column, parseStoredJson(row.value_json, row.value_text || null));
  }

  function formatEntryDisplayValue(column, value) {
    if (value === null || value === undefined || value === '') return '';
    if (Array.isArray(value)) return value.join(', ');
    if (column.type === 'boolean') return value ? 'Yes' : 'No';
    return String(value);
  }

  function normalizeStringArray(value) {
    if (Array.isArray(value)) return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
    if (typeof value === 'string') return Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)));
    return [];
  }

  function normalizeDateString(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }

  function parseStoredJson(value, fallback) {
    try {
      return JSON.parse(String(value));
    } catch {
      return fallback;
    }
  }

  function getDynamicColumnOptions(listId, columns) {
    const optionColumns = columns.filter((column) => column.type === 'tags' || column.type === 'multi_select');
    if (!optionColumns.length) return {};
    const columnIds = optionColumns.map((column) => column.id);
    const placeholders = columnIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT column_id, value_json
      FROM changelog_entry_values
      WHERE column_id IN (${placeholders})
    `).all(...columnIds);
    const byId = new Map(optionColumns.map((column) => [column.id, new Set(column.options || [])]));
    for (const row of rows) {
      const values = parseStoredJson(row.value_json, []);
      if (!Array.isArray(values)) continue;
      const set = byId.get(row.column_id);
      if (!set) continue;
      values.map(String).map((item) => item.trim()).filter(Boolean).forEach((item) => set.add(item));
    }
    return Object.fromEntries(optionColumns.map((column) => [
      column.key,
      Array.from(byId.get(column.id) || []).sort((a, b) => String(a).localeCompare(String(b), 'de'))
    ]));
  }

  function buildAnalytics(list, columns, queryOptions) {
    const rows = queryAllEntryRows(list, columns, queryOptions);
    const tagCounts = new Map();
    const statusCounts = new Map();
    const creatorCounts = new Map();
    let latestUpdatedAt = '';
    let recentChanges = 0;
    const recentThreshold = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const tagColumns = columns.filter((column) => column.type === 'tags' || column.type === 'multi_select');
    const statusColumns = columns.filter((column) => column.type === 'status' || column.type === 'single_select');

    for (const row of rows) {
      creatorCounts.set(row.createdByName || 'Unknown', (creatorCounts.get(row.createdByName || 'Unknown') || 0) + 1);
      if (!latestUpdatedAt || row.updatedAt > latestUpdatedAt) latestUpdatedAt = row.updatedAt;
      if (new Date(row.updatedAt).getTime() >= recentThreshold) recentChanges += 1;
      for (const column of tagColumns) {
        const items = Array.isArray(row.values[column.key]) ? row.values[column.key] : [];
        for (const item of items) tagCounts.set(item, (tagCounts.get(item) || 0) + 1);
      }
      for (const column of statusColumns) {
        const value = row.values[column.key];
        if (!value) continue;
        statusCounts.set(String(value), (statusCounts.get(String(value)) || 0) + 1);
      }
    }

    return {
      totalEntries: rows.length,
      recentChanges,
      latestUpdatedAt,
      topTags: mapCounts(tagCounts, 6),
      statusDistribution: mapCounts(statusCounts, 8),
      entriesByCreator: mapCounts(creatorCounts, 8),
      filtered: Boolean(queryOptions.q || queryOptions.creator || Object.keys(queryOptions.filters || {}).length || queryOptions.updatedFrom || queryOptions.updatedTo)
    };
  }

  function mapCounts(map, limit) {
    return Array.from(map.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label), 'de'))
      .slice(0, limit);
  }

  function exportRowsToCsv(columns, rows) {
    const header = ['Created By', 'Created At', 'Updated At', ...columns.map((column) => column.label)];
    const lines = [header.map(csvEscape).join(',')];
    for (const row of rows) {
      const values = [
        row.createdByName || '',
        row.createdAt || '',
        row.updatedAt || '',
        ...columns.map((column) => formatEntryDisplayValue(column, row.values[column.key]))
      ];
      lines.push(values.map(csvEscape).join(','));
    }
    return `\uFEFF${lines.join('\r\n')}`;
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    if (!/[",\r\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function countEntriesForList(listId) {
    return Number(db.prepare('SELECT COUNT(*) AS total FROM changelog_entries WHERE list_id = ?').get(listId)?.total || 0);
  }
}
