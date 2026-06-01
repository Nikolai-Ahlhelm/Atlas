import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTENT_DIR = join(ROOT, 'content');
const LOCALES_DIR = join(ROOT, 'locales');
const CMS_DIR = join(CONTENT_DIR, 'cms');
const PUBLIC_DIR = join(ROOT, 'public');
const PLUGINS_DIR = join(ROOT, 'plugins');
const DATA_DIR = process.env.DATA_DIR ? normalize(process.env.DATA_DIR) : join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'data.sqlite');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE_NAME = 'atlas_session';
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
let localesCache = null;
let localesCacheSignature = '';
let pluginLocalesCache = null;
let pluginLocalesCacheSignature = '';
const FONT_FAMILIES = {
  manrope: '"Manrope", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  jakarta: '"Plus Jakarta Sans", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  inter: '"Inter", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  plex: '"IBM Plex Sans", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  serif: '"Source Serif 4", Georgia, serif'
};

const DEFAULT_ROLES = [
  ['Admins', 'Full administration access for Atlas.', '#b45309'],
  ['Users', 'Standard access to shared Atlas documentation.', '#2368c4'],
  ['Blog-Editor', 'Can create and manage blog posts without full admin access.', '#0f9d92'],
  ['CMS-Editor', 'Can create and manage CMS pages without full admin access.', '#8b5cf6']
];

const DEFAULT_SETTINGS = {
  app_name: 'Atlas',
  sidebar_title: 'Atlas Docs',
  logo_text: 'AT',
  logo_image: '',
  default_language: 'en',
  default_theme: 'light',
  theme_color: '#2368c4',
  light_theme_color: '#2368c4',
  dark_theme_color: '#6f8cff',
  light_bg_color: '#eff4ff',
  dark_bg_color: '#091120',
  light_bg_glow: '#599cff',
  dark_bg_glow: '#5580ff',
  light_ui_color: '#ffffff',
  dark_ui_color: '#172339',
  light_ui_opacity: '0.82',
  dark_ui_opacity: '0.84',
  font_scale: '1',
  font_family: 'manrope',
  login_eyebrow: 'Atlas',
  login_title: 'Documentation your team can shape in minutes.',
  login_text: 'Atlas turns Markdown folders into a secure, searchable workspace with role-based access and a built-in admin area.',
  login_background_mode: 'network',
  login_background_image: '',
  entra_enabled: 'false',
  entra_tenant_id: '',
  entra_client_id: '',
  entra_client_secret: '',
  entra_redirect_uri: '',
  footer_text: 'Atlas',
  copyright_holder: '',
  menu_links: JSON.stringify([
    { label: 'Home', href: '/', roles: [] }
  ])
};

const CORE_FEATURE_DEFINITIONS = {
  cms: {
    key: 'cms',
    label: 'Pages',
    href: '/pages',
    description: 'Standalone content pages with Markdown and HTML support, managed like a lightweight CMS.',
    defaultEnabled: true
  }
};

const loadedPlugins = await loadPlugins();
const FEATURE_DEFINITIONS = buildFeatureDefinitions(loadedPlugins);

const LEGACY_SETTING_MIGRATIONS = {
  app_name: { from: 'Dokumentenportal', to: DEFAULT_SETTINGS.app_name },
  sidebar_title: { from: 'Dokumente', to: DEFAULT_SETTINGS.sidebar_title },
  logo_text: { from: 'DP', to: DEFAULT_SETTINGS.logo_text },
  default_language: { from: 'de', to: DEFAULT_SETTINGS.default_language },
  font_family: { from: 'inter', to: DEFAULT_SETTINGS.font_family },
  login_eyebrow: { from: 'Dokumentenportal', to: DEFAULT_SETTINGS.login_eyebrow },
  login_title: { from: ['Richtlinien zentral, sicher und schnell auffindbar.', 'Dokumente zentral, sicher und schnell auffindbar.'], to: DEFAULT_SETTINGS.login_title },
  login_text: { from: ['Markdown-basierte Inhalte, rollenbasierter Zugriff und ein Adminbereich fuer Benutzerverwaltung.', 'Markdown-basierte Inhalte, rollenbasierter Zugriff und ein umfangreicher Adminbereich.'], to: DEFAULT_SETTINGS.login_text },
  footer_text: { from: 'Internes Dokumentenportal', to: DEFAULT_SETTINGS.footer_text },
  menu_links: {
    from: JSON.stringify([{ label: 'Dokumente', href: '/', roles: [] }], null, 2),
    to: JSON.stringify([{ label: 'Documentation', href: '/', roles: [] }], null, 2)
  }
};

function buildFeatureDefinitions(plugins) {
  const definitions = { ...CORE_FEATURE_DEFINITIONS };
  for (const plugin of plugins) {
    if (plugin?.feature?.key) definitions[plugin.feature.key] = plugin.feature;
  }
  return definitions;
}

async function loadPlugins() {
  if (!existsSync(PLUGINS_DIR)) return [];
  const pluginDirs = readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const plugins = [];

  for (const entry of pluginDirs) {
    const rootDir = join(PLUGINS_DIR, entry.name);
    const manifestPath = join(rootDir, 'plugin.json');
    const serverPath = join(rootDir, 'server.js');
    if (!existsSync(manifestPath) || !existsSync(serverPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const module = await import(pathToFileURL(serverPath).href);
      const factory = typeof module.default === 'function' ? module.default : null;
      if (!factory) continue;
      const plugin = factory({ manifest, rootDir });
      if (!plugin?.key || !plugin?.feature) continue;
      plugins.push({
        ...plugin,
        rootDir,
        manifest,
        publicDir: plugin.publicDir || join(rootDir, 'public'),
        localesDir: plugin.localesDir || join(rootDir, 'locales'),
        adminPage: plugin.adminPage || null
      });
    } catch (error) {
      console.error(`[PLUGIN] Failed to load ${entry.name}`, error);
    }
  }

  return plugins;
}

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
initializeDatabase();

let cmsCatalog = loadCmsCatalog();

if (process.argv.includes('--check')) {
  logInfo(`Catalog check completed: loaded ${cmsCatalog.pages.length} CMS pages.`);
  process.exit(0);
}

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    logError('Unhandled server error', error);
    sendHtml(res, 500, renderShell({ title: 'Error', body: errorPage('An unexpected error occurred.') }));
  }
});

server.listen(PORT, HOST, () => {
  logInfo(`Atlas is running at http://${HOST}:${PORT}`);
});

function timestamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function writeLog(level, message, details) {
  const prefix = `[${timestamp()}] [${level}]`;
  if (details === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, details);
}

function renderFontFamilySelect(selected, name = 'font_family') {
  const current = normalizeFontFamily(selected);
  const options = [
    ['manrope', 'Manrope'],
    ['jakarta', 'Plus Jakarta Sans'],
    ['inter', 'Inter'],
    ['plex', 'IBM Plex Sans'],
    ['serif', 'Source Serif 4']
  ];
  return `
    <select name="${escapeAttribute(name)}" class="font-family-select">
      ${options.map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
    </select>
  `;
}

function normalizeFontFamily(value) {
  const key = String(value || '').trim().toLowerCase();
  return FONT_FAMILIES[key] ? key : DEFAULT_SETTINGS.font_family;
}

function logInfo(message, details) {
  writeLog('INFO', message, details);
}

function logWarn(message, details) {
  writeLog('WARN', message, details);
}

function logError(message, details) {
  const prefix = `[${timestamp()}] [ERROR]`;
  if (details === undefined) {
    console.error(`${prefix} ${message}`);
    return;
  }
  console.error(`${prefix} ${message}`, details);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const user = getCurrentUser(req);
  const settings = getSettings();
  const locale = resolveLocale(req, user, settings);

  if (url.pathname.startsWith('/assets/plugins/')) return servePluginAsset(res, url.pathname);
  if (url.pathname.startsWith('/assets/')) return serveAsset(res, url.pathname);
  if (url.pathname === '/login') return sendHtml(res, 200, renderLogin(req, user, locale));
  if (url.pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res, locale);
  if (url.pathname === '/api/logout' && req.method === 'POST') return handleLogout(req, res);
  if (url.pathname === '/auth/entra/start') return handleEntraStart(req, res);
  if (url.pathname === '/auth/entra/callback') return handleEntraCallback(req, res, url);

  if (!user) return redirect(res, '/login');

  if (await handlePluginRequest({ req, res, url, user, locale, settings })) return;

  if (url.pathname === '/api/me') return sendJson(res, 200, publicUser(user));
  if (url.pathname === '/api/profile' && req.method === 'GET') return sendJson(res, 200, publicUser(user));
  if (url.pathname === '/api/profile' && req.method === 'POST') return handleUpdateProfile(req, res, user);
  if (url.pathname === '/api/plugins' && req.method === 'GET') return sendJson(res, 200, listPlugins(locale));
  if (url.pathname === '/api/admin/users' && req.method === 'GET') return requireAdmin(user, res, () => sendJson(res, 200, listUsers()));
  if (url.pathname === '/api/admin/users' && req.method === 'POST') return requireAdmin(user, res, () => handleUpsertUser(req, res));
  if (url.pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') return requireAdmin(user, res, () => handleDeleteUser(res, url.pathname));
  if (url.pathname === '/api/admin/roles' && req.method === 'GET') return requireAdmin(user, res, () => sendJson(res, 200, listRoles()));
  if (url.pathname === '/api/admin/roles' && req.method === 'POST') return requireAdmin(user, res, () => handleUpsertRole(req, res));
  if (url.pathname.startsWith('/api/admin/roles/') && req.method === 'DELETE') return requireAdmin(user, res, () => handleDeleteRole(res, url.pathname));
  if (url.pathname === '/api/admin/plugins' && req.method === 'GET') return requireAdmin(user, res, () => sendJson(res, 200, listPlugins(locale)));
  if (url.pathname === '/api/admin/plugins' && req.method === 'POST') return requireAdmin(user, res, () => handleUpdatePlugin(req, res, locale));
  if (url.pathname === '/api/admin/settings' && req.method === 'GET') return requireAdmin(user, res, () => sendJson(res, 200, getSettings()));
  if (url.pathname === '/api/admin/settings' && req.method === 'POST') return requireAdmin(user, res, () => handleUpdateSettings(req, res));
  if (url.pathname === '/api/cms/studio/tree' && req.method === 'GET') return requireCmsEditor(user, res, () => sendJson(res, 200, getCmsStudioTree()));
  if (url.pathname === '/api/cms/studio/page' && req.method === 'GET') return requireCmsEditor(user, res, () => handleGetCmsStudioPage(res, url));
  if (url.pathname === '/api/cms/studio/page' && req.method === 'POST') return requireCmsEditor(user, res, () => handleSaveCmsStudioPage(req, res, user));
  if (url.pathname.startsWith('/api/cms/studio/page/') && req.method === 'DELETE') return requireCmsEditor(user, res, () => handleDeleteCmsStudioPage(res, url.pathname));
  if (url.pathname === '/api/admin/reset' && req.method === 'POST') return requireAdmin(user, res, () => handleFactoryReset(req, res));
  if (url.pathname === '/api/admin/reload' && req.method === 'POST') return requireAdmin(user, res, () => {
    logInfo(`CMS reload requested by ${user.email}`);
    cmsCatalog = loadCmsCatalog();
    logInfo(`CMS reload completed: ${cmsCatalog.pages.length} pages loaded`);
    sendJson(res, 200, { ok: true, cmsPages: cmsCatalog.pages.length });
  });

  if (url.pathname === '/') {
    return sendHtml(res, 200, renderFeatureHub({ user, locale }));
  }
  if (url.pathname === '/pages') {
    if (!isPluginEnabled('cms')) return sendHtml(res, 404, renderFeatureHub({ user, locale, notice: 'The CMS feature is currently disabled.' }));
    return sendHtml(res, 200, renderCmsIndexPage({ user, locale }));
  }
  if (url.pathname === '/cms-studio') {
    if (!canManageCms(user)) return sendHtml(res, 403, renderCmsIndexPage({ user, locale, notice: 'CMS editor permissions are required.' }));
    return sendHtml(res, 200, renderCmsStudio(user, locale));
  }
  if (url.pathname === '/admin') return requireAdmin(user, res, () => sendHtml(res, 200, renderAdmin(user, locale)));
  if (url.pathname.startsWith('/page/')) {
    if (!isPluginEnabled('cms')) return sendHtml(res, 404, renderFeatureHub({ user, locale, notice: 'The CMS feature is currently disabled.' }));
    const slug = decodeURIComponent(url.pathname.slice('/page/'.length));
    const page = cmsCatalog.bySlug.get(slug);
    if (!page) return sendHtml(res, 404, renderCmsIndexPage({ user, locale, notice: t(locale, 'notFoundPage') }));
    if (!canReadCmsPage(user, page)) return sendHtml(res, 403, renderCmsIndexPage({ user, locale, notice: t(locale, 'noPermission') }));
    return sendHtml(res, 200, renderCmsPage({ user, locale, page }));
  }

  sendHtml(res, 404, renderFeatureHub({ user, locale, notice: t(locale, 'notFoundPage') }));
}

function initializeDatabase() {
  logInfo(`Initializing database at ${DB_PATH}`);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT,
      provider TEXT NOT NULL DEFAULT 'local',
      is_admin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugins (
      key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS forms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      intro_text TEXT NOT NULL DEFAULT '',
      creator_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      fields_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS form_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      submitter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submitter_name TEXT NOT NULL DEFAULT '',
      submitter_email TEXT NOT NULL DEFAULT '',
      values_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'submitted',
      notes TEXT NOT NULL DEFAULT '',
      reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  ensureColumn('roles', 'color', "TEXT NOT NULL DEFAULT '#5d6b82'");
  ensureColumn('users', 'language', 'TEXT');
  initializePlugins();

  seedFactoryData();
  logInfo('Database initialization completed');
}

function initializePlugins() {
  for (const plugin of loadedPlugins) {
    try {
      plugin.init?.(buildPluginContext());
    } catch (error) {
      logError(`Plugin initialization failed for ${plugin.key}`, error);
    }
  }
}

function resetPluginsToFactoryDefaults() {
  for (const plugin of loadedPlugins) {
    try {
      plugin.resetToFactoryDefaults?.(buildPluginContext({ plugin }));
    } catch (error) {
      logError(`Plugin reset failed for ${plugin.key}`, error);
      throw error;
    }
  }
}

function seedFactoryData() {
  logInfo('Seeding factory defaults');
  for (const [name, description, color] of DEFAULT_ROLES) {
    db.prepare('INSERT OR IGNORE INTO roles (name, description, color) VALUES (?, ?, ?)').run(name, description, color);
    db.prepare('UPDATE roles SET description = ?, color = ? WHERE name = ?').run(description, color, name);
  }

  migrateLegacyRoles();

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  ensureDefaultPlugins();
  migrateLegacySettings();
  removeAdminFromDefaultMenuLinks();
  ensureFactoryAdminUser();
  ensureDefaultRoleCoverage();
}

function ensureDefaultPlugins() {
  for (const feature of Object.values(FEATURE_DEFINITIONS)) {
    db.prepare('INSERT OR IGNORE INTO plugins (key, enabled) VALUES (?, ?)').run(feature.key, feature.defaultEnabled ? 1 : 0);
  }
}

function migrateLegacyRoles() {
  const roleRows = db.prepare('SELECT id, name FROM roles').all();
  const adminsRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('Admins')?.id;
  const usersRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('Users')?.id;
  const adminAliases = new Set(['admin', 'isms-admin']);
  const userAliases = new Set(['employee', 'it', 'auditor']);
  const preservedRoles = new Set(DEFAULT_ROLES.map(([name]) => name));

  for (const role of roleRows) {
    if (preservedRoles.has(role.name)) continue;

    const targetRoleId = adminAliases.has(role.name) ? adminsRoleId : usersRoleId;
    if (targetRoleId) {
      db.prepare(`
        INSERT OR IGNORE INTO user_roles (user_id, role_id)
        SELECT user_id, ? FROM user_roles WHERE role_id = ?
      `).run(targetRoleId, role.id);
    }
    db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(role.id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  }
}

function migrateLegacySettings() {
  for (const [key, migration] of Object.entries(LEGACY_SETTING_MIGRATIONS)) {
    const fromValues = Array.isArray(migration.from) ? migration.from : [migration.from];
    for (const fromValue of fromValues) {
      db.prepare(`
        UPDATE settings
        SET value = ?
        WHERE key = ? AND value = ?
      `).run(migration.to, key, fromValue);
    }
  }
}

function ensureFactoryAdminUser() {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (userCount === 0) {
    db.prepare(`
      INSERT INTO users (email, name, password_hash, is_admin)
      VALUES (?, ?, ?, 1)
    `).run('admin@admin.com', 'Admin', hashPassword('admin'));
  }
}

function ensureDefaultRoleCoverage() {
  const adminsRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('Admins')?.id;
  const usersRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('Users')?.id;

  if (adminsRoleId) {
    db.prepare(`
      INSERT OR IGNORE INTO user_roles (user_id, role_id)
      SELECT id, ? FROM users WHERE is_admin = 1
    `).run(adminsRoleId);
  }

  if (usersRoleId) {
    db.prepare(`
      INSERT OR IGNORE INTO user_roles (user_id, role_id)
      SELECT u.id, ?
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.is_admin = 0 AND ur.user_id IS NULL
    `).run(usersRoleId);
  }
}

function resetDatabaseToFactoryDefaults() {
  logWarn('Resetting database to factory defaults');
  db.exec('BEGIN');
  try {
    db.exec(`
      DELETE FROM user_roles;
      DELETE FROM sessions;
      DELETE FROM oauth_states;
      DELETE FROM users;
      DELETE FROM roles;
      DELETE FROM settings;
      DELETE FROM plugins;
      DELETE FROM sqlite_sequence WHERE name IN ('users', 'roles');
    `);
    resetPluginsToFactoryDefaults();
    seedFactoryData();
    db.exec('COMMIT');
    logInfo('Database reset completed');
  } catch (error) {
    db.exec('ROLLBACK');
    logError('Database reset failed', error);
    throw error;
  }
}

function loadCatalog() {
  logInfo(`Loading catalog from ${DOCS_DIR}`);
  const home = existsSync(HOME_PATH) ? createPolicy(HOME_PATH, '__home', []) : null;
  if (existsSync(DOCS_DIR)) {
    const policies = [];
    const sidebar = scanDocsDirectory(DOCS_DIR, '', [], policies).items;
    const bySlug = new Map(policies.map((policy) => [policy.slug, policy]));
    if (home) bySlug.set(home.slug, home);
    logInfo(`Catalog loaded from docs directory: ${policies.length} documents, ${sidebar.length} top-level sidebar entries`);
    return { policies, bySlug, sidebar, home };
  }

  const policies = existsSync(POLICY_DIR) ? readdirSync(POLICY_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => createPolicy(join(POLICY_DIR, file), file.replace(/\.md$/, ''), []))
    .sort((a, b) => a.title.localeCompare(b.title, 'de')) : [];

  const sidebarPath = join(CONTENT_DIR, 'sidebar.json');
  const sidebar = existsSync(sidebarPath) ? JSON.parse(readFileSync(sidebarPath, 'utf8')) : policies.map((policy) => policy.slug);
  const bySlug = new Map(policies.map((policy) => [policy.slug, policy]));
  if (home) bySlug.set(home.slug, home);
  logInfo(`Catalog loaded from legacy policies directory: ${policies.length} documents`);
  return { policies, bySlug, sidebar, home };
}

function scanDocsDirectory(dir, relativeDir, inheritedRoles, policies) {
  const categoryPath = join(dir, 'category.json');
  const category = existsSync(categoryPath) ? JSON.parse(readFileSync(categoryPath, 'utf8')) : {};
  const categoryRoles = Array.isArray(category.roles) ? category.roles : inheritedRoles;
  const entries = readdirSync(dir)
    .filter((entry) => !entry.startsWith('.') && entry !== 'category.json')
    .map((entry) => {
      const fullPath = join(dir, entry);
      return { entry, fullPath, isDirectory: statSync(fullPath).isDirectory() };
    })
    .sort((a, b) => {
      if (a.entry === 'index.md') return -1;
      if (b.entry === 'index.md') return 1;
      const positionDiff = getEntryPosition(a) - getEntryPosition(b);
      if (positionDiff !== 0) return positionDiff;
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.entry.localeCompare(b.entry, 'de');
    });

  const items = [];
  let categorySlug = '';

  for (const item of entries) {
    if (item.isDirectory) {
      const childRelative = relativeDir ? `${relativeDir}/${item.entry}` : item.entry;
      const child = scanDocsDirectory(item.fullPath, childRelative, categoryRoles, policies);
      if (child.items.length || child.categoryItem.slug) items.push(child.categoryItem);
      continue;
    }

    if (!item.entry.endsWith('.md')) continue;
    const basename = item.entry.replace(/\.md$/, '');
    const slug = basename === 'index' ? relativeDir : (relativeDir ? `${relativeDir}/${basename}` : basename);
    if (!slug) continue;
    const policy = createPolicy(item.fullPath, slug, categoryRoles);
    policies.push(policy);
    if (basename === 'index') categorySlug = slug;
    else items.push(slug);
  }

  const fallbackLabel = relativeDir ? titleFromSlug(relativeDir.split('/').pop()) : 'Documentation';
  return {
    items,
    categoryItem: {
      type: 'category',
      label: category.label || fallbackLabel,
      slug: categorySlug,
      roles: categoryRoles,
      items
    }
  };
}

function createPolicy(filePath, slug, inheritedRoles) {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, markdown } = parseFrontmatter(raw);
  const rendered = markdownToHtml(markdown, slug);
  const roles = Array.isArray(meta.roles) ? meta.roles : inheritedRoles;
  return {
    slug,
    file: filePath,
    title: meta.title || titleFromSlug(slug.split('/').pop()),
    description: meta.description || '',
    roles,
    owner: meta.owner || '',
    version: meta.version || '',
    reviewDate: meta.reviewDate || '',
    html: rendered.html,
    headings: rendered.headings
  };
}

function getEntryPosition(item) {
  try {
    if (item.isDirectory) {
      const categoryPath = join(item.fullPath, 'category.json');
      if (!existsSync(categoryPath)) return 999;
      const category = JSON.parse(readFileSync(categoryPath, 'utf8'));
      return Number(category.position ?? category.sidebar_position ?? 999);
    }
    if (!item.entry.endsWith('.md')) return 999;
    const { meta } = parseFrontmatter(readFileSync(item.fullPath, 'utf8'));
    return Number(meta.position ?? meta.sidebar_position ?? 999);
  } catch {
    return 999;
  }
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, markdown: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, markdown: raw };
  const block = raw.slice(3, end).trim();
  const markdown = raw.slice(end + 4).trim();
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
    } else {
      meta[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, markdown };
}

function markdownToHtml(markdown, baseSlug = '') {
  const lines = markdown.split(/\r?\n/);
  let html = '';
  const headings = [];
  let inList = false;
  let inCode = false;
  let codeLanguage = '';
  let codeTitle = '';
  let codeFenceMarker = '';
  let codeFenceLength = 0;
  let code = [];
  let codeBlockCount = 0;
  let inHtmlBlock = false;
  let htmlBlockLines = [];
  let htmlBlockTag = '';

  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  const closeHtmlBlock = () => {
    if (!inHtmlBlock) return;
    html += htmlBlockLines.join('\n');
    inHtmlBlock = false;
    htmlBlockLines = [];
    htmlBlockTag = '';
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const admonition = line.match(/^:::(note|tip|info|warning|danger)(?:\s+(.*))?\s*$/i);
    if (admonition && !inCode) {
      closeList();
      const type = admonition[1].toLowerCase();
      const title = admonition[2]?.trim();
      const content = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== ':::') {
        content.push(lines[index]);
        index += 1;
      }
      const inner = markdownToHtml(content.join('\n'), baseSlug).html;
      const displayTitle = title ? inlineMarkdown(title, baseSlug) : escapeHtml(type);
      html += `<div class="admonition admonition-${type}"><div class="admonition-title">${displayTitle}</div><div class="admonition-body">${inner}</div></div>`;
      continue;
    }

    const fence = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (inCode) {
        const closingMarker = fence[1][0];
        const closingLength = fence[1].length;
        if (closingMarker === codeFenceMarker && closingLength >= codeFenceLength) {
          const languageClass = codeLanguage ? ` class="language-${escapeAttribute(codeLanguage)}"` : '';
          const displayLabel = codeTitle || codeLanguage || 'code';
          const codeId = `code-block-${slugify(baseSlug || 'doc')}-${codeBlockCount += 1}`;
          html += `
            <div class="code-block-wrap">
              <div class="code-block-head">
                <span class="code-block-label">${escapeHtml(displayLabel)}</span>
                <button class="code-copy-button" type="button" data-copy-code aria-label="Copy code" data-copy-default="Copy" data-copy-success="Copied">Copy</button>
              </div>
              <pre class="code-block"><code id="${codeId}"${languageClass}>${escapeHtml(code.join('\n'))}</code></pre>
            </div>
          `;
          code = [];
          codeLanguage = '';
          codeTitle = '';
          codeFenceMarker = '';
          codeFenceLength = 0;
          inCode = false;
          continue;
        }
        code.push(line);
        continue;
      } else {
        closeList();
        inCode = true;
        codeFenceMarker = fence[1][0];
        codeFenceLength = fence[1].length;
        const fenceInfo = parseFenceInfo(fence[2].trim());
        codeLanguage = fenceInfo.language;
        codeTitle = fenceInfo.title;
        continue;
      }
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (inHtmlBlock) {
      htmlBlockLines.push(line);
      if (htmlBlockTag && new RegExp(`</${htmlBlockTag}>`, 'i').test(line)) {
        closeHtmlBlock();
      }
      continue;
    }
    if (!line.trim()) {
      closeList();
      closeHtmlBlock();
      continue;
    }

    const htmlBlockStart = line.match(/^\s*<([a-z][a-z0-9-]*)(?:\s[^>]*)?>\s*$/i);
    if (htmlBlockStart && !/\/>\s*$/i.test(line) && !new RegExp(`</${htmlBlockStart[1]}>`, 'i').test(line)) {
      closeList();
      inHtmlBlock = true;
      htmlBlockTag = htmlBlockStart[1].toLowerCase();
      htmlBlockLines = [line];
      continue;
    }

    if (/^\s*<\/?[a-z!][\s\S]*>\s*$/i.test(line)) {
      closeList();
      html += line;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const text = inlineMarkdown(heading[2], baseSlug);
      const id = slugify(stripHtml(heading[2]));
      if (level >= 1 && level <= 4) headings.push({ id, level, text: stripHtml(heading[2]) });
      html += `<h${level} id="${id}">${text}</h${level}>`;
      continue;
    }
    const list = line.match(/^-\s+(.+)$/);
    if (list) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inlineMarkdown(list[1], baseSlug)}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inlineMarkdown(line, baseSlug)}</p>`;
  }
  closeList();
  closeHtmlBlock();
  return { html, headings };
}

function inlineMarkdown(text, baseSlug = '') {
  const rawHtml = [];
  const withPlaceholders = String(text).replace(/<[^>\n]+>/g, (tag) => {
    const token = `@@RAWHTML${rawHtml.length}@@`;
    rawHtml.push(tag);
    return token;
  });

  let rendered = escapeHtml(withPlaceholders)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const resolved = resolveMarkdownHref(href, baseSlug);
      const external = /^(https?:|mailto:|tel:)/i.test(resolved);
      const attrs = external ? ' target="_blank" rel="noreferrer"' : '';
      return `<a href="${escapeAttribute(resolved)}"${attrs}>${label}</a>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

  rendered = rendered.replace(/@@RAWHTML(\d+)@@/g, (_, index) => rawHtml[Number(index)] || '');
  return rendered;
}

function parseFenceInfo(info) {
  const raw = String(info || '').trim();
  if (!raw) return { language: '', title: '' };
  const titleMatch = raw.match(/title=(["'])(.*?)\1/i);
  const language = raw.replace(/title=(["'])(.*?)\1/i, '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  return {
    language,
    title: titleMatch?.[2]?.trim() || ''
  };
}

function resolveMarkdownHref(href, baseSlug) {
  const value = String(href || '').trim();
  if (!value) return '#';
  if (value.startsWith('#')) return value;
  if (/^(https?:|mailto:|tel:|\/)/i.test(value)) return value;

  const normalized = value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.(md|mdx)$/i, '');

  const baseParts = String(baseSlug || '').split('/').filter(Boolean);
  if (!value.startsWith('./') && !value.startsWith('../')) {
    return `/policy/${encodeURIComponent(normalized)}`;
  }

  const targetParts = value.split('/').filter(Boolean);
  if (!baseParts.length) {
    return `/policy/${encodeURIComponent(normalized)}`;
  }

  const currentDir = baseParts.slice(0, -1);
  for (const part of targetParts) {
    if (part === '.') continue;
    if (part === '..') currentDir.pop();
    else currentDir.push(part.replace(/\.(md|mdx)$/i, ''));
  }
  return `/policy/${encodeURIComponent(currentDir.join('/'))}`;
}

function renderApp({ user, activeSlug, policy, notice, locale }) {
  const settings = getSettings();
  const readable = catalog.policies.filter((item) => canReadPolicy(user, item));
  const current = policy || catalog.home || readable[0];
  const active = activeSlug || (policy ? policy.slug : '__home');
  const body = `
    <div class="app-shell">
      ${renderTopbar(user, locale, '/')}
      <div class="workspace">
        <aside class="sidebar" id="sidebar">
          <div class="sidebar-head">
            <span>${escapeHtml(settings.sidebar_title)}</span>
            <button class="icon-button mobile-only" data-sidebar-close aria-label="Close navigation">x</button>
          </div>
          <nav class="doc-nav">${renderSidebar(catalog.sidebar, user, active)}</nav>
        </aside>
        <main class="content">
          ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
          ${current ? renderPolicy(current, locale, user) : renderEmptyState(locale)}
        </main>
      </div>
      ${renderFooter(settings)}
    </div>
  `;
  return renderShell({ title: current?.title || settings.app_name, body, settings, locale });
}

function renderTopbar(user, locale, currentHref = '/') {
  const settings = getSettings();
  const pluginLinks = listPlugins()
    .filter((plugin) => plugin.enabled)
    .map((plugin) => ({ label: plugin.label, href: plugin.href, roles: [], automatic: true }));
  const customLinks = filterVisibleMenuLinks(parseMenuLinks(settings.menu_links), user);
  const links = [...pluginLinks, ...customLinks.filter((link) => !pluginLinks.some((plugin) => plugin.href === link.href))];
  return `
    <header class="topbar">
      <div class="brand">
        <button class="icon-button mobile-only" data-sidebar-open aria-label="Open navigation">☰</button>
        <a href="/" class="brand-mark">${settings.logo_image ? `<img src="${escapeAttribute(settings.logo_image)}" alt="">` : escapeHtml(settings.logo_text)}</a>
        <a href="/" class="brand-title">${escapeHtml(settings.app_name)}</a>
      </div>
      <nav class="top-links">${links.map((link) => renderTopbarLink(link, currentHref)).join('')}</nav>
      <div class="top-actions">
        <button class="button user-menu-trigger" type="button" data-profile-open>👤 ${escapeHtml(user.name)}</button>
      </div>
    </header>
    ${renderProfileDialog(user, locale)}
  `;
}
function renderTopbarLink(link, currentHref) {
  if (Array.isArray(link.children) && link.children.length) {
    const active = link.children.some((child) => isNavActive(currentHref, child.href));
    return `
      <div class="top-link-dropdown ${active ? 'active' : ''}" data-nav-dropdown>
        <button class="top-link-trigger ${active ? 'active' : ''}" type="button" data-nav-dropdown-trigger aria-expanded="false">
          <span>${escapeHtml(link.label)}</span>
          <span class="top-link-caret">▾</span>
        </button>
        <div class="top-link-menu">
          ${link.children.map((child) => `<a class="top-link-menu-item ${isNavActive(currentHref, child.href) ? 'active' : ''}" href="${escapeHtml(child.href)}">${escapeHtml(child.label)}</a>`).join('')}
        </div>
      </div>
    `;
  }
  return `<a class="${isNavActive(currentHref, link.href) ? 'active' : ''}" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`;
}

function renderSidebar(items, user, activeSlug) {
  return items.map((item) => {
    if (typeof item === 'string') {
      const policy = catalog.bySlug.get(item);
      if (!policy || !canReadPolicy(user, policy)) return '';
      return `<a class="nav-link ${activeSlug === policy.slug ? 'active' : ''}" href="/policy/${encodeURIComponent(policy.slug)}">${escapeHtml(policy.title)}</a>`;
    }
    const categoryPolicy = item.slug ? catalog.bySlug.get(item.slug) : null;
    const canSeeCategory = !categoryPolicy || canReadPolicy(user, categoryPolicy);
    const children = renderSidebar(item.items || [], user, activeSlug);
    if (!canSeeCategory && !children.trim()) return '';
    const isActive = categoryPolicy && activeSlug === categoryPolicy.slug;
    const containsActive = sidebarContainsActive(item.items || [], activeSlug);
    const title = categoryPolicy && canSeeCategory
      ? `<a class="nav-category-link ${isActive ? 'active' : ''}" href="/policy/${encodeURIComponent(categoryPolicy.slug)}">${escapeHtml(item.label || categoryPolicy.title)}</a>`
      : `<span class="nav-category-label">${escapeHtml(item.label || 'Category')}</span>`;
    return `
      <section class="nav-group ${containsActive || isActive ? 'active-group' : ''}">
        <div class="nav-group-title">
          ${title}
          <button class="nav-caret" data-toggle-section type="button" aria-label="Collapse category"></button>
        </div>
        <div class="nav-group-items">${children}</div>
      </section>
    `;
  }).join('');
}

function isNavActive(currentHref, href) {
  if (href === '/') return currentHref === '/';
  return currentHref === href || currentHref.startsWith(`${href}/`);
}

function renderFeatureHub({ user, locale, notice = '' }) {
  const settings = getSettings();
  const activePlugins = listPlugins(locale).filter((plugin) => plugin.enabled);
  const body = `
    <div class="app-shell">
      ${renderTopbar(user, locale, '/')}
      <main class="content feature-hub">
        ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
        <section class="policy">
          <div class="policy-header feature-hub-header">
            <div>
              <p class="eyebrow">${escapeHtml(settings.app_name)}</p>
              <h1>${escapeHtml(settings.app_name)} Workspace</h1>
              <p>Choose one of the active features below. Admins can manage which plugins are available from the administration area.</p>
            </div>
          </div>
          <div class="feature-card-grid">
            ${activePlugins.map((plugin) => `
              <a class="feature-card" href="${escapeHtml(plugin.href)}">
                <span class="feature-card-label">${escapeHtml(plugin.label)}</span>
                <strong>${escapeHtml(plugin.description)}</strong>
              </a>
            `).join('')}
          </div>
        </section>
      </main>
      ${renderFooter(settings)}
    </div>
  `;
  return renderShell({ title: settings.app_name, body, settings, locale });
}

function renderFormsPage({ user, locale, notice = '' }) {
  const settings = getSettings();
  const body = `
    <div class="app-shell forms-page" data-forms-app>
      ${renderTopbar(user, locale, '/forms')}
      <div class="workspace">
        <aside class="sidebar" id="sidebar">
          <div class="sidebar-head">
            <span>${tf(locale, 'forms', 'Forms')}</span>
            <button class="icon-button mobile-only" data-sidebar-close aria-label="Close navigation">x</button>
          </div>
          <div id="formsNav" class="doc-nav"></div>
        </aside>
        <main class="content">
          ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
          <section class="policy">
            <div class="policy-header">
              <div>
                <p class="eyebrow">${tf(locale, 'forms', 'Forms')}</p>
                <h1>${tf(locale, 'workflowForms', 'Workflow forms')}</h1>
                <p>${tf(locale, 'workflowFormsText', 'Submit structured requests, review incoming submissions and keep access aligned to the right people and groups.')}</p>
              </div>
              <dl class="meta-grid">
                <div><dt>${tf(locale, 'featureType', 'Feature')}</dt><dd>${tf(locale, 'structuredForms', 'Structured forms')}</dd></div>
                <div><dt>${tf(locale, 'access', 'Access')}</dt><dd>${tf(locale, 'perFormAccess', 'Per-form access')}</dd></div>
                <div><dt>${tf(locale, 'management', 'Management')}</dt><dd>${user.is_admin ? tf(locale, 'manageViaAdmin', 'Manageable in admin portal') : tf(locale, 'roleBased', 'Role based')}</dd></div>
              </dl>
            </div>
            <div class="forms-layout">
              <div id="formsEmptyState" class="empty-state">
                <h1>${tf(locale, 'loadingForms', 'Loading forms')}</h1>
                <p>${tf(locale, 'loadingFormsText', 'Atlas is fetching the forms you can access.')}</p>
              </div>
              <div id="formDetailView" class="panel forms-detail-panel" hidden></div>
            </div>
          </section>
        </main>
      </div>
      ${renderFooter(settings)}
    </div>
  `;
  return renderShell({ title: tf(locale, 'forms', 'Forms'), body, settings, locale, scripts: ['forms.js'] });
}

function renderCmsIndexPage({ user, locale, notice = '' }) {
  const settings = getSettings();
  const pages = cmsCatalog.pages.filter((page) => page.slug !== 'index' && canReadCmsPage(user, page));
  const home = cmsCatalog.home && canReadCmsPage(user, cmsCatalog.home) ? cmsCatalog.home : null;
  const body = `
    <div class="app-shell">
      ${renderTopbar(user, locale, '/pages')}
      <main class="content cms-page-shell">
        ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
        ${home ? `
          <section class="cms-hero">
            ${home.coverImage ? `<div class="cms-hero-media"><img src="${escapeAttribute(home.coverImage)}" alt=""></div>` : ''}
            <div class="cms-hero-copy">
              <p class="eyebrow">${tf(locale, 'pages', 'Pages')}</p>
              <h1>${escapeHtml(home.title)}</h1>
              <p>${escapeHtml(home.description || home.excerpt || '')}</p>
            </div>
          </section>
          <section class="cms-body markdown-body">${home.html}</section>
        ` : `
          <section class="policy-header cms-header">
            <div>
              <p class="eyebrow">${tf(locale, 'pages', 'Pages')}</p>
              <h1>${tf(locale, 'cmsWelcome', 'Flexible content pages')}</h1>
              <p>${tf(locale, 'cmsWelcomeText', 'Create full-width pages in Markdown with optional raw HTML sections for richer layouts and embedded content.')}</p>
            </div>
          </section>
        `}
        ${pages.length ? `<section class="cms-card-grid">${pages.map((page) => renderCmsCard(page)).join('')}</section>` : renderCmsEmptyState(locale, canManageCms(user))}
      </main>
      ${renderFooter(settings)}
    </div>
  `;
  return renderShell({ title: tf(locale, 'pages', 'Pages'), body, settings, locale });
}

function renderCmsCard(page) {
  return `
    <a class="cms-card" href="/page/${encodeURIComponent(page.slug)}">
      ${page.coverImage ? `<div class="cms-card-media"><img src="${escapeAttribute(page.coverImage)}" alt=""></div>` : ''}
      <div class="cms-card-body">
        <h2>${escapeHtml(page.title)}</h2>
        <p>${escapeHtml(page.excerpt || page.description || '')}</p>
      </div>
    </a>
  `;
}

function renderCmsPage({ user, locale, page }) {
  const settings = getSettings();
  const body = `
    <div class="app-shell">
      ${renderTopbar(user, locale, '/pages')}
      <main class="content cms-page-shell">
        <article class="cms-full-page">
          ${page.coverImage ? `<div class="cms-hero-media cms-page-cover"><img src="${escapeAttribute(page.coverImage)}" alt=""></div>` : ''}
          <header class="cms-page-header">
            ${canManageCms(user) ? `<div class="policy-admin-actions"><a class="button ghost policy-admin-button" href="/cms-studio?page=${encodeURIComponent(page.slug)}">${tf(locale, 'editPage', 'Edit page')}</a></div>` : ''}
            <h1>${escapeHtml(page.title)}</h1>
            ${page.description ? `<p>${escapeHtml(page.description)}</p>` : ''}
          </header>
          <section class="cms-body markdown-body">${page.html}</section>
        </article>
      </main>
      ${renderFooter(settings)}
    </div>
  `;
  return renderShell({ title: page.title, body, settings, locale });
}

function renderCmsStudio(user, locale) {
  const settings = getSettings();
  const body = `
    <div class="app-shell">
      ${renderTopbar(user, locale, '/cms-studio')}
      <main class="admin-page cms-studio-page">
        <div class="admin-header">
          <div>
            <h1>${tf(locale, 'cmsStudio', 'CMS Studio')}</h1>
            <p class="hint">${tf(locale, 'cmsStudioText', 'Create full-width Markdown or HTML-backed pages that appear in the Pages plugin.')}</p>
          </div>
          <div class="panel-head-actions">
            <a class="button ghost" href="/pages">${tf(locale, 'openPages', 'Open pages')}</a>
            <button class="button primary" type="button" data-new-cms-page>${tf(locale, 'createPage', 'Create page')}</button>
          </div>
        </div>
        <div id="cmsStudioError" class="notice admin-error" hidden></div>
        <section class="admin-grid cms-studio-grid">
          <div class="panel content-nav-panel">
            <div class="panel-head">
              <h2>${tf(locale, 'pages', 'Pages')}</h2>
            </div>
            <div id="cmsPageTree" class="content-tree"></div>
          </div>
          <div class="panel content-editor-panel">
            <div class="panel-head">
              <h2 id="cmsEditorTitle">${tf(locale, 'cmsEditor', 'CMS editor')}</h2>
            </div>
            <div class="content-editor-body">
              <div id="cmsEditorEmpty" class="empty-state content-empty-state">
                <h1>${tf(locale, 'selectPage', 'Select a page')}</h1>
                <p>${tf(locale, 'selectCmsPageText', 'Choose a page from the list or create a new one to start editing.')}</p>
              </div>
              <form id="cmsEditorForm" class="modal-form" hidden>
                <input name="slug" type="hidden">
                <div class="content-meta">
                  <label>${tf(locale, 'pageSlug', 'Page slug')} <input name="display_slug" readonly></label>
                  <label>${tf(locale, 'filePath', 'File path')} <input name="relative_path" readonly></label>
                  <label>${tf(locale, 'title', 'Title')} <input name="title" required></label>
                  <label>${tf(locale, 'coverImageUrl', 'Cover image URL')} <input name="coverImage" placeholder="https://..."></label>
                  <label>${tf(locale, 'rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Users"></label>
                </div>
                <label>${tf(locale, 'description', 'Description')} <textarea name="description"></textarea></label>
                <label>${tf(locale, 'excerpt', 'Excerpt')} <textarea name="excerpt"></textarea></label>
                <label>${tf(locale, 'rawMarkdown', 'Raw Markdown / HTML')}
                  <textarea name="markdown" class="code-input content-raw-input" spellcheck="false"></textarea>
                </label>
                <div class="modal-actions">
                  <button class="button danger" type="button" data-delete-cms-page>${tf(locale, 'delete', 'Delete')}</button>
                  <button class="button primary" type="submit">${t(locale, 'save')}</button>
                </div>
              </form>
            </div>
          </div>
        </section>
      </main>
      ${renderFooter(settings)}
    </div>
  `;
  return renderShell({ title: tf(locale, 'cmsStudio', 'CMS Studio'), body, settings, locale, scripts: ['cms-studio.js'] });
}

function renderCmsEmptyState(locale, canEdit = false) {
  return `
    <section class="empty-state">
      <h1>${tf(locale, 'noCmsPages', 'No pages yet')}</h1>
      <p>${canEdit ? tf(locale, 'noCmsPagesEditorText', 'Open CMS Studio to create the first page for this section.') : tf(locale, 'noCmsPagesText', 'No pages have been published in this section yet.')}</p>
    </section>
  `;
}

function renderProfileDialog(user, locale) {
  return `
    <div class="profile-popover" data-profile-popover hidden>
      <div class="profile-popover-head">
        <h2>${t(locale, 'profileTitle')}</h2>
        <button class="button" type="button" data-profile-close>${t(locale, 'close')}</button>
      </div>
      <div class="profile-shortcuts">
        ${user.is_admin ? `<a class="button ghost profile-shortcut" href="/admin">${t(locale, 'admin')}</a>` : ''}
        ${canManageCms(user) ? `<a class="button ghost profile-shortcut" href="/cms-studio">📄 ${tf(locale, 'cmsStudio', 'CMS Studio')}</a>` : ''}
        <button class="button ghost profile-shortcut profile-theme-toggle" type="button" data-theme-toggle>
          <span>${tf(locale, 'theme', 'Theme')}</span>
          <span class="theme-toggle inline-theme-toggle" aria-hidden="true"><span></span></span>
        </button>
      </div>
      <form class="profile-form" data-profile-form>
        <label>${t(locale, 'name')} <input name="name" value="${escapeHtml(user.name)}" required></label>
        <label>${t(locale, 'email')} <input name="email" type="email" value="${escapeHtml(user.email)}" required></label>
        <label>${t(locale, 'language')} ${renderLanguageSelect(user.language || '', locale)}</label>
        <div class="profile-roles">
          <span>${t(locale, 'groups')}</span>
          <div>${renderRolePills(user.roles) || `<span class="hint">${t(locale, 'noGroups')}</span>`}</div>
        </div>
        <div class="modal-actions"><button class="button primary" type="submit">${t(locale, 'save')}</button></div>
      </form>
      <div class="profile-secondary-actions">
        <button class="button" type="button" data-password-open>${t(locale, 'changePassword')}</button>
        <form class="profile-logout-form" action="/api/logout" method="post">
          <button class="button" type="submit">🚪 ${t(locale, 'logout')}</button>
        </form>
      </div>
    </div>
    <div class="modal-backdrop password-modal" data-password-modal hidden>
      <div class="modal">
        <form class="modal-form" data-password-form>
          <h2>${t(locale, 'changePassword')}</h2>
          <label>${t(locale, 'currentPassword')} <input name="current_password" type="password" autocomplete="current-password" required></label>
          <label>${t(locale, 'newPassword')} <input name="password" type="password" autocomplete="new-password" required></label>
          <label>${t(locale, 'confirmPassword')} <input name="password_confirm" type="password" autocomplete="new-password" required></label>
          <div class="modal-actions"><button class="button" type="button" data-password-close>${t(locale, 'cancel')}</button><button class="button primary" type="submit">${t(locale, 'savePassword')}</button></div>
        </form>
      </div>
    </div>
  `;
}

function renderPolicy(policy, locale, user) {
  const breadcrumbs = findBreadcrumbs(catalog.sidebar, policy.slug);
  const editLinks = user?.is_admin ? renderPolicyAdminActions(policy, locale) : '';
  return `
    <article class="policy">
      ${renderBreadcrumbs(breadcrumbs, policy)}
      <div class="policy-header">
        <div>
          ${editLinks}
          <!--<p class="eyebrow">${escapeHtml(policy.owner || 'Atlas')}</p>-->
          <h1>${escapeHtml(policy.title)}</h1>
          <p>${escapeHtml(policy.description)}</p>
        </div>
        <dl class="meta-grid">
          <div><dt>${t(locale, 'version')}</dt><dd>${escapeHtml(policy.version || '-')}</dd></div>
          <div><dt>${t(locale, 'review')}</dt><dd>${escapeHtml(policy.reviewDate || '-')}</dd></div>
          <div><dt>${t(locale, 'access')}</dt><dd>${renderRolePills(policy.roles) || t(locale, 'all')}</dd></div>
        </dl>
      </div>
      <div class="policy-body">
        <div class="markdown-body">${policy.html}</div>
        ${renderToc(policy)}
      </div>
    </article>
  `;
}
function renderPolicyAdminActions(policy, locale) {
  const pageHref = `/admin?tab=content&page=${encodeURIComponent(policy.slug)}`;
  const actions = [
    `<a class="button ghost policy-admin-button" href="${pageHref}">${tf(locale, 'editPage', 'Edit page')}</a>`
  ];
  const categoryDir = getCategoryDirFromPolicySlug(policy.slug);
  if (categoryDir) {
    actions.push(`<a class="button ghost policy-admin-button" href="/admin?tab=content&dir=${encodeURIComponent(categoryDir)}">${tf(locale, 'editCategory', 'Edit category')}</a>`);
  }
  return `<div class="policy-admin-actions">${actions.join('')}</div>`;
}

function renderBreadcrumbs(breadcrumbs, policy) {
  const trail = breadcrumbs.length ? breadcrumbs : [{ label: policy.title, href: `/policy/${encodeURIComponent(policy.slug)}` }];
  return `
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a class="crumb-home-icon"href="/" aria-label="Home">💠</a>
      ${trail.map((item, index) => `
        <span class="crumb-separator">›</span>
        <a class="${index === trail.length - 1 ? 'current' : ''}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>
      `).join('')}
    </nav>
  `;
}

function renderToc(policy) {
  if (!policy.headings?.length) return '';
  return `
    <aside class="toc" aria-label="Table of contents">
      ${policy.headings.map((heading) => `<a class="toc-level-${heading.level}" href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>`).join('')}
    </aside>
  `;
}

function renderEmptyState(locale) {
  return `
    <section class="empty-state">
      <h1>${t(locale, 'noPolicies')}</h1>
      <p>${t(locale, 'noPoliciesText')}</p>
    </section>
  `;
}

function renderAdmin(user, locale) {
  const settings = getSettings();
  const body = `
    <div class="app-shell">
      ${renderTopbar(user, locale, '/admin')}
      <main class="admin-page">
        <div class="admin-header">
          <div>
            <!--<p class="eyebrow">${t(locale, 'administration')}</p>-->
            <h1>${t(locale, 'adminPortal')}</h1>
          </div>
        </div>
        <div id="adminError" class="notice admin-error" hidden></div>
        ${renderAdminTabsNav(locale, { mode: 'buttons', activeTab: 'content' })}
        <section class="admin-grid">
          <div class="panel settings-panel" data-admin-panel="plugins">
            <div class="panel-head">
              <h2>${tf(locale, 'pluginManager', 'Plugin manager')}</h2>
            </div>
            <div id="pluginsPanel" class="plugin-grid content-editor-body"></div>
          </div>
          <div class="panel settings-panel" data-admin-panel="content">
            <div class="panel-head">
              <h2>${tf(locale, 'pages', 'Pages')}</h2>
            </div>
            <div class="content-editor-body">
              <div class="empty-state content-empty-state">
                <h1>${tf(locale, 'cmsStudio', 'CMS Studio')}</h1>
                <p>${tf(locale, 'cmsStudioText', 'Create full-width Markdown or HTML-backed pages that appear in the Pages plugin.')}</p>
                <div class="panel-head-actions">
                  <a class="button ghost" href="/pages">${tf(locale, 'openPages', 'Open pages')}</a>
                  <a class="button primary" href="/cms-studio">${tf(locale, 'openCmsStudio', 'Open CMS Studio')}</a>
                </div>
              </div>
            </div>
          </div>
          <div class="panel" data-admin-panel="access">
            <div class="panel-head">
              <h2>${t(locale, 'users')}</h2>
              <button class="button" data-new-user type="button">${t(locale, 'createUser')}</button>
            </div>
            <div id="usersTable" class="table-wrap"></div>
          </div>
          <div class="panel" data-admin-panel="access">
            <div class="panel-head">
              <h2>${t(locale, 'roles')}</h2>
              <button class="button" data-new-role type="button">${t(locale, 'createRole')}</button>
            </div>
            <div id="rolesTable" class="table-wrap"></div>
          </div>
          <div class="panel settings-panel" data-admin-panel="instance">
            <div class="panel-head">
              <h2>${t(locale, 'designLogin')}</h2>
            </div>
            <form id="settingsForm" class="settings-form">
              <label>${t(locale, 'portalName')} <input name="app_name" value="${escapeHtml(settings.app_name)}"></label>
              <label>${t(locale, 'sidebarTitle')} <input name="sidebar_title" value="${escapeHtml(settings.sidebar_title)}"></label>
              <label>${t(locale, 'logoText')} <input name="logo_text" maxlength="6" value="${escapeHtml(settings.logo_text)}"></label>
              <label>${t(locale, 'logoUpload')} <input name="logo_upload" type="file" accept="image/*"><input name="logo_image" type="hidden" value="${escapeHtml(settings.logo_image)}"></label>
              <label>${t(locale, 'language')} ${renderLanguageSelect(settings.default_language, locale, 'default_language')}</label>
              <label>${t(locale, 'fontFamily')} ${renderFontFamilySelect(settings.font_family, 'font_family')}</label>
              <label>${t(locale, 'defaultTheme')}
                <select name="default_theme">
                  <option value="light" ${settings.default_theme === 'light' ? 'selected' : ''}>Light</option>
                  <option value="dark" ${settings.default_theme === 'dark' ? 'selected' : ''}>Dark</option>
                </select>
              </label>
              <label>${tf(locale, 'lightThemeColor', 'Light accent color')} <input name="light_theme_color" type="color" value="${escapeHtml(settings.light_theme_color)}"></label>
              <label>${tf(locale, 'darkThemeColor', 'Dark accent color')} <input name="dark_theme_color" type="color" value="${escapeHtml(settings.dark_theme_color)}"></label>
              <label>${tf(locale, 'lightBackgroundColor', 'Light background color')} <input name="light_bg_color" type="color" value="${escapeHtml(settings.light_bg_color)}"></label>
              <label>${tf(locale, 'darkBackgroundColor', 'Dark background color')} <input name="dark_bg_color" type="color" value="${escapeHtml(settings.dark_bg_color)}"></label>
              <label>${tf(locale, 'lightBackgroundGlow', 'Light background glow')} <input name="light_bg_glow" type="color" value="${escapeHtml(settings.light_bg_glow)}"></label>
              <label>${tf(locale, 'darkBackgroundGlow', 'Dark background glow')} <input name="dark_bg_glow" type="color" value="${escapeHtml(settings.dark_bg_glow)}"></label>
              <label>${tf(locale, 'lightUiColor', 'Light UI surface color')} <input name="light_ui_color" type="color" value="${escapeHtml(settings.light_ui_color)}"></label>
              <label>${tf(locale, 'darkUiColor', 'Dark UI surface color')} <input name="dark_ui_color" type="color" value="${escapeHtml(settings.dark_ui_color)}"></label>
              <label>${tf(locale, 'lightUiOpacity', 'Light UI opacity')} <input name="light_ui_opacity" type="range" min="0.3" max="1" step="0.02" value="${escapeHtml(settings.light_ui_opacity)}"><span data-ui-opacity-preview="light">${Math.round(Number(settings.light_ui_opacity) * 100)}%</span></label>
              <label>${tf(locale, 'darkUiOpacity', 'Dark UI opacity')} <input name="dark_ui_opacity" type="range" min="0.3" max="1" step="0.02" value="${escapeHtml(settings.dark_ui_opacity)}"><span data-ui-opacity-preview="dark">${Math.round(Number(settings.dark_ui_opacity) * 100)}%</span></label>
              <label>${t(locale, 'fontSize')} <input name="font_scale" type="range" min="0.9" max="1.25" step="0.05" value="${escapeHtml(settings.font_scale)}"><span data-font-preview>${Math.round(Number(settings.font_scale) * 100)}%</span></label>
              <label>${t(locale, 'loginEyebrow')} <input name="login_eyebrow" value="${escapeHtml(settings.login_eyebrow)}"></label>
              <label>${t(locale, 'loginTitle')} <input name="login_title" value="${escapeHtml(settings.login_title)}"></label>
              <label>${t(locale, 'loginText')} <textarea name="login_text">${escapeHtml(settings.login_text)}</textarea></label>
              <label>${t(locale, 'loginBackground')}
                <select name="login_background_mode">
                  <option value="network" ${settings.login_background_mode === 'network' ? 'selected' : ''}>${t(locale, 'animatedNetwork')}</option>
                  <option value="image" ${settings.login_background_mode === 'image' ? 'selected' : ''}>${t(locale, 'imageUrl')}</option>
                  <option value="static" ${settings.login_background_mode === 'static' ? 'selected' : ''}>${t(locale, 'static')}</option>
                </select>
              </label>
              <label>${t(locale, 'backgroundImageUrl')} <input name="login_background_image" placeholder="https://..." value="${escapeHtml(settings.login_background_image)}"></label>
              <div class="switch-field">
                <span>${t(locale, 'entraId')}</span>
                <label class="switch">
                  <input name="entra_enabled" type="checkbox" value="true" ${settings.entra_enabled === 'true' ? 'checked' : ''}>
                  <span class="switch-track"></span>
                  <span class="switch-label">${settings.entra_enabled === 'true' ? t(locale, 'enabled') : t(locale, 'disabled')}</span>
                </label>
              </div>
              <label>Entra Tenant ID <input name="entra_tenant_id" value="${escapeHtml(settings.entra_tenant_id)}"></label>
              <label>Entra Client ID <input name="entra_client_id" value="${escapeHtml(settings.entra_client_id)}"></label>
              <label>Entra Client Secret <input name="entra_client_secret" type="password" value="${escapeHtml(settings.entra_client_secret)}"></label>
              <label>Entra Redirect URI <input name="entra_redirect_uri" placeholder="http://localhost:3000/auth/entra/callback" value="${escapeHtml(settings.entra_redirect_uri)}"></label>
              <label>${t(locale, 'footerLine')} <input name="footer_text" value="${escapeHtml(settings.footer_text)}"></label>
              <label>${t(locale, 'copyrightHolder')} <input name="copyright_holder" placeholder="${escapeHtml(settings.app_name)}" value="${escapeHtml(settings.copyright_holder)}"></label>
              <label>${t(locale, 'menuLinksJson')} <textarea name="menu_links" class="code-input">${escapeHtml(settings.menu_links)}</textarea></label>
              <button class="button primary" type="submit">${t(locale, 'saveSettings')}</button>
            </form>
          </div>
          <div class="panel danger-panel" data-admin-panel="instance">
            <div class="panel-head">
              <h2>${t(locale, 'factoryReset')}</h2>
            </div>
            <div class="danger-panel-body">
              <p>${t(locale, 'factoryResetText')}</p>
              <button class="button danger" data-factory-reset type="button">${t(locale, 'factoryResetButton')}</button>
            </div>
          </div>
        </section>
      </main>
      ${renderFooter(settings)}
    </div>
  `;
  return renderShell({ title: t(locale, 'admin'), body, admin: true, settings, locale });
}

function renderAdminTabsNav(locale, { mode = 'buttons', activeTab = '', activePluginKey = '' } = {}) {
  const pluginAdminPages = loadedPlugins.filter((plugin) => plugin.adminPage);
  const items = [
    { key: 'instance', label: tf(locale, 'instanceSettings', 'Instance') },
    { key: 'access', label: tf(locale, 'accessManagement', 'Access') },
    { key: 'plugins', label: tf(locale, 'plugins', 'Plugins') },
    { key: 'content', label: tf(locale, 'pages', 'Pages') }
  ];
  const renderItem = (item) => {
    const activeClass = item.key === activeTab ? ' active' : '';
    if (mode === 'links') {
      return `<a class="admin-tab-button${activeClass}" href="/admin?tab=${escapeAttribute(item.key)}">${escapeHtml(item.label)}</a>`;
    }
    return `<button class="admin-tab-button${activeClass}" type="button" data-admin-tab="${escapeAttribute(item.key)}">${escapeHtml(item.label)}</button>`;
  };
  const hasActivePlugin = pluginAdminPages.some((plugin) => plugin.key === activePluginKey);
  const pluginMenu = pluginAdminPages.length
    ? `
      <details class="admin-plugin-menu ${hasActivePlugin ? 'is-active' : ''}" ${hasActivePlugin ? 'open' : ''}>
        <summary class="admin-tab-button${hasActivePlugin ? ' active' : ''}">${tf(locale, 'pluginPages', 'Plugin pages')}</summary>
        <div class="admin-plugin-menu-list">
          ${pluginAdminPages.map((plugin) => `
            <a class="admin-plugin-menu-link ${plugin.key === activePluginKey ? 'active' : ''}" href="${escapeHtml(plugin.adminPage.href)}">
              <strong>${escapeHtml(getPluginFeatureCopy(plugin.key, locale, plugin.feature).label)}</strong>
              <span>${escapeHtml(getPluginFeatureCopy(plugin.key, locale, plugin.feature).description)}</span>
            </a>
          `).join('')}
        </div>
      </details>
    `
    : '';
  return `
    <nav class="admin-tabs" aria-label="${tf(locale, 'adminSections', 'Admin sections')}">
      ${items.map(renderItem).join('')}
      ${pluginMenu}
    </nav>
  `;
}

function renderLogin(req, user, locale) {
  const settings = getSettings();
  if (user) return renderShell({ title: t(locale, 'login'), body: '<meta http-equiv="refresh" content="0; url=/">', settings, locale });
  const entra = getEntraConfig(settings, req);
  const hasEntra = Boolean(entra.enabled && entra.tenant && entra.clientId && entra.clientSecret);
  const backgroundStyle = settings.login_background_mode === 'image' && settings.login_background_image
    ? ` style="--login-image: url('${escapeAttribute(settings.login_background_image)}')"`
    : '';
  const body = `
    <main class="login-page">
      <section class="login-visual login-${escapeHtml(settings.login_background_mode)}"${backgroundStyle}>
        ${settings.login_background_mode === 'network' ? '<canvas class="network-canvas" data-network-bg></canvas>' : ''}
        <div class="login-copy">
          <p class="eyebrow">${escapeHtml(settings.login_eyebrow)}</p>
          <h1>${escapeHtml(settings.login_title)}</h1>
          <p>${escapeHtml(settings.login_text)}</p>
        </div>
      </section>
      <section class="login-card">
        <form class="auth-form" action="/api/login" method="post">
          <h2>${t(locale, 'login')}</h2>
          <label>${t(locale, 'email')} <input name="email" type="email" autocomplete="email" required></label>
          <label>${t(locale, 'password')} <input name="password" type="password" autocomplete="current-password" required></label>
          <button class="button primary full" type="submit">${t(locale, 'login')}</button>
        </form>
        <a class="button full ${hasEntra ? 'ghost' : 'disabled'}" href="${hasEntra ? '/auth/entra/start' : '#'}">${t(locale, 'entraLogin')}</a>
        ${hasEntra ? '' : `<p class="hint">${t(locale, 'entraNotConfigured')}</p>`}
      </section>
    </main>
  `;
  return renderShell({ title: t(locale, 'login'), body, settings, locale });
}

function renderShell({ title, body, admin = false, settings = getSettings(), locale = 'en', scripts = [], pluginKeys = [] }) {
  const lightThemeColor = sanitizeColor(settings.light_theme_color || settings.theme_color, DEFAULT_SETTINGS.light_theme_color);
  const darkThemeColor = sanitizeColor(settings.dark_theme_color, DEFAULT_SETTINGS.dark_theme_color);
  const lightBgColor = sanitizeColor(settings.light_bg_color, DEFAULT_SETTINGS.light_bg_color);
  const darkBgColor = sanitizeColor(settings.dark_bg_color, DEFAULT_SETTINGS.dark_bg_color);
  const lightBgGlow = sanitizeColor(settings.light_bg_glow, DEFAULT_SETTINGS.light_bg_glow);
  const darkBgGlow = sanitizeColor(settings.dark_bg_glow, DEFAULT_SETTINGS.dark_bg_glow);
  const lightUiColor = sanitizeColor(settings.light_ui_color, DEFAULT_SETTINGS.light_ui_color);
  const darkUiColor = sanitizeColor(settings.dark_ui_color, DEFAULT_SETTINGS.dark_ui_color);
  const lightUiOpacity = Number(sanitizeOpacity(settings.light_ui_opacity, DEFAULT_SETTINGS.light_ui_opacity));
  const darkUiOpacity = Number(sanitizeOpacity(settings.dark_ui_opacity, DEFAULT_SETTINGS.dark_ui_opacity));
  const lightUiSurface = hexToRgba(lightUiColor, lightUiOpacity);
  const lightUiStrong = hexToRgba(lightUiColor, Math.min(1, lightUiOpacity + 0.12));
  const lightUiSoft = hexToRgba(lightUiColor, Math.max(0.18, lightUiOpacity - 0.18));
  const lightUiElevated = hexToRgba(lightUiColor, Math.min(1, lightUiOpacity + 0.08));
  const darkUiSurface = hexToRgba(darkUiColor, darkUiOpacity);
  const darkUiStrong = hexToRgba(darkUiColor, Math.min(1, darkUiOpacity + 0.1));
  const darkUiSoft = hexToRgba(darkUiColor, Math.max(0.18, darkUiOpacity - 0.18));
  const darkUiElevated = hexToRgba(darkUiColor, Math.min(1, darkUiOpacity + 0.08));
  const fontScale = Math.min(1.25, Math.max(0.9, Number(settings.font_scale) || 1));
  const fontFamily = FONT_FAMILIES[normalizeFontFamily(settings.font_family)];
  const cssUrl = assetUrl('app.css');
  const appJsUrl = assetUrl('app.js');
  const adminScript = admin ? inlineScriptTag('admin.js') : '';
  const extraScripts = scripts
    .map((file) => `<script defer src="${String(file).startsWith('/') ? file : assetUrl(file)}"></script>`)
    .join('');
  return `<!doctype html>
    <html lang="${escapeHtml(locale)}" style="--primary-light: ${lightThemeColor}; --primary-dark-mode: ${darkThemeColor}; --bg-light-base: ${lightBgColor}; --bg-dark-base: ${darkBgColor}; --bg-light-glow: ${lightBgGlow}; --bg-dark-glow: ${darkBgGlow}; --surface-light-base: ${lightUiColor}; --surface-dark-base: ${darkUiColor}; --surface-light: ${lightUiSurface}; --surface-light-strong: ${lightUiStrong}; --surface-light-soft: ${lightUiSoft}; --surface-light-elevated: ${lightUiElevated}; --surface-dark: ${darkUiSurface}; --surface-dark-strong: ${darkUiStrong}; --surface-dark-soft: ${darkUiSoft}; --surface-dark-elevated: ${darkUiElevated};">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(title)} · ${escapeHtml(settings.app_name)}</title>
        <link rel="stylesheet" href="${cssUrl}">
        <script id="portal-i18n" type="application/json">${JSON.stringify(getClientI18n(locale, pluginKeys)).replace(/</g, '\\u003c')}</script>
        <script defer src="${appJsUrl}"></script>
        ${extraScripts}
        ${adminScript}
      </head>
      <body data-default-theme="${escapeHtml(settings.default_theme)}" style="--font-scale: ${fontScale}; --app-font: ${escapeHtml(fontFamily)};">${body}</body>
    </html>`;
}

function renderFooter(settings) {
  const year = new Date().getFullYear();
  const holder = settings.copyright_holder || settings.app_name;
  return `
    <footer class="site-footer">
      <!-- <span>${escapeHtml(settings.footer_text)}</span> -->
      <span>© ${year} ${escapeHtml(holder)}</span>
      <span>Version ${escapeHtml(PACKAGE_JSON.version)}</span>
      <a href="https://atlas.example.com" target="_blank" rel="noopener noreferrer">Made with ♥️ by Atlas</a>
    </footer>
  `;
}

async function handleLogin(req, res, locale) {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const email = String(params.get('email') || '').trim().toLowerCase();
  const password = String(params.get('password') || '');
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? AND active = 1').get(email);
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    logWarn(`Failed login attempt for email ${email}`);
    return sendHtml(res, 401, renderShell({
      title: t(locale, 'loginFailed'),
      body: errorPage(t(locale, 'emailPasswordWrong'), '/login', locale),
      locale
    }));
  }
  createSession(res, user.id);
  redirect(res, '/');
  logInfo(`User ${email} logged in successfully`);
}

function handleLogout(req, res) {
  const token = getCookie(req, COOKIE_NAME);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  redirect(res, '/login');
}

function handleEntraStart(req, res) {
  const { tenant, clientId, clientSecret, redirectUri, enabled } = getEntraConfig(getSettings(), req);
  if (!enabled || !tenant || !clientId || !clientSecret) return redirect(res, '/login');
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  db.prepare('INSERT INTO oauth_states (state, verifier, expires_at) VALUES (?, ?, ?)').run(state, verifier, Date.now() + 600000);
  const authUrl = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  redirect(res, authUrl.toString());
}

async function handleEntraCallback(req, res, url) {
  const { tenant, clientId, clientSecret, redirectUri, enabled } = getEntraConfig(getSettings(), req);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const saved = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND expires_at > ?').get(state, Date.now());
  if (!enabled || !tenant || !clientId || !clientSecret || !code || !saved) return redirect(res, '/login');
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: saved.verifier
    })
  });
  if (!tokenResponse.ok) return redirect(res, '/login');
  const token = await tokenResponse.json();
  const claims = JSON.parse(Buffer.from(token.id_token.split('.')[1], 'base64url').toString('utf8'));
  const email = String(claims.preferred_username || claims.email || '').toLowerCase();
  if (!email) return redirect(res, '/login');
  let local = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
  if (!local) {
    const info = db.prepare('INSERT INTO users (email, name, provider, password_hash) VALUES (?, ?, ?, NULL)').run(email, claims.name || email, 'entra');
    const usersRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('Users');
    if (usersRole) db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(info.lastInsertRowid, usersRole.id);
    local = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  createSession(res, local.id);
  redirect(res, '/');
}

async function handleUpsertUser(req, res) {
  const payload = await readJson(req);
  const email = String(payload.email || '').trim().toLowerCase();
  const name = String(payload.name || '').trim();
  if (!email || !name) return sendJson(res, 400, { error: 'Email and name are required.' });
  const isAdmin = payload.is_admin ? 1 : 0;
  const active = payload.active === false ? 0 : 1;
  let userId = Number(payload.id || 0);
  const isUpdate = Boolean(userId);
  if (userId) {
    const fields = [email, name, isAdmin, active, userId];
    db.prepare('UPDATE users SET email = ?, name = ?, is_admin = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(...fields);
    if (payload.password) db.prepare('UPDATE users SET password_hash = ?, provider = ? WHERE id = ?').run(hashPassword(String(payload.password)), 'local', userId);
  } else {
    const info = db.prepare('INSERT INTO users (email, name, password_hash, is_admin, active) VALUES (?, ?, ?, ?, ?)').run(email, name, hashPassword(String(payload.password || randomBytes(18).toString('base64url'))), isAdmin, active);
    userId = Number(info.lastInsertRowid);
  }
  setUserRoles(userId, normalizeUserRoles(Array.isArray(payload.roles) ? payload.roles : [], Boolean(isAdmin)));
  logInfo(`User ${isUpdate ? 'updated' : 'created'}: ${email}`, {
    userId,
    isAdmin: Boolean(isAdmin),
    active: Boolean(active)
  });
  sendJson(res, 200, { ok: true, user: listUsers().find((item) => item.id === userId) });
}

function handleDeleteUser(res, pathname) {
  const id = Number(pathname.split('/').pop());
  if (!id) return sendJson(res, 400, { error: 'Invalid user ID.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  sendJson(res, 200, { ok: true });
}

async function handleUpsertRole(req, res) {
  const payload = await readJson(req);
  const id = Number(payload.id || 0);
  const name = String(payload.name || '').trim();
  const description = String(payload.description || '').trim();
  const color = sanitizeColor(payload.color || '#5d6b82');
  if (!name) return sendJson(res, 400, { error: 'Role name is required.' });
  if (id) {
    const duplicate = db.prepare('SELECT id FROM roles WHERE name = ? AND id != ?').get(name, id);
    if (duplicate) return sendJson(res, 409, { error: 'This role already exists.' });
    db.prepare('UPDATE roles SET name = ?, description = ?, color = ? WHERE id = ?').run(name, description, color, id);
  } else {
    db.prepare('INSERT INTO roles (name, description, color) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, color = excluded.color').run(name, description, color);
  }
  logInfo(`Role saved: ${name}`, { roleId: id || 'new', color });
  sendJson(res, 200, { ok: true, roles: listRoles() });
}

function handleDeleteRole(res, pathname) {
  const id = Number(pathname.split('/').pop());
  if (!id) return sendJson(res, 400, { error: 'Invalid role ID.' });
  db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(id);
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  sendJson(res, 200, { ok: true });
}

async function handleFactoryReset(req, res) {
  const payload = await readJson(req);
  if (String(payload.confirmation || '').trim() !== 'RESET ATLAS') {
    logWarn('Factory reset rejected because confirmation text did not match');
    return sendJson(res, 400, { error: 'Type RESET ATLAS to confirm the factory reset.' });
  }

  logWarn('Factory reset confirmed by admin');
  resetDatabaseToFactoryDefaults();
  cmsCatalog = loadCmsCatalog();
  logInfo(`Factory reset reloaded CMS with ${cmsCatalog.pages.length} pages`);
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

async function handleUpdateProfile(req, res, user) {
  const payload = await readJson(req);
  const email = String(payload.email || '').trim().toLowerCase();
  const name = String(payload.name || '').trim();
  const language = isSupportedLocale(payload.language) ? String(payload.language) : null;
  const password = String(payload.password || '');
  const passwordConfirm = String(payload.password_confirm || '');
  const currentPassword = String(payload.current_password || '');
  if (!email || !name) return sendJson(res, 400, { error: t(resolveLocale(req, user, getSettings()), 'nameEmailRequired') });

  const existingUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (password || passwordConfirm) {
    if (existingUser?.password_hash && !verifyPassword(currentPassword, existingUser.password_hash)) {
      return sendJson(res, 403, { error: t(resolveLocale(req, user, getSettings()), 'currentPasswordWrong') });
    }
    if (password !== passwordConfirm) return sendJson(res, 400, { error: t(resolveLocale(req, user, getSettings()), 'passwordMismatch') });
    if (password.length < 8) return sendJson(res, 400, { error: t(resolveLocale(req, user, getSettings()), 'passwordMinLength') });
  }

  const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(email, user.id);
  if (existing) return sendJson(res, 409, { error: t(resolveLocale(req, user, getSettings()), 'emailAlreadyUsed') });

  db.prepare('UPDATE users SET email = ?, name = ?, language = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(email, name, language, user.id);
  if (password) {
    db.prepare('UPDATE users SET password_hash = ?, provider = ? WHERE id = ?').run(hashPassword(password), 'local', user.id);
  }
  sendJson(res, 200, { ok: true, user: publicUser(getCurrentUserFromId(user.id)) });
}

async function handleUpdateSettings(req, res) {
  const payload = await readJson(req);
  const settings = {
    app_name: String(payload.app_name || DEFAULT_SETTINGS.app_name).trim() || DEFAULT_SETTINGS.app_name,
    sidebar_title: String(payload.sidebar_title || DEFAULT_SETTINGS.sidebar_title).trim() || DEFAULT_SETTINGS.sidebar_title,
    logo_text: String(payload.logo_text || DEFAULT_SETTINGS.logo_text).trim().slice(0, 6) || DEFAULT_SETTINGS.logo_text,
    logo_image: sanitizeDataImage(payload.logo_image || ''),
    default_language: isSupportedLocale(payload.default_language) ? String(payload.default_language) : DEFAULT_SETTINGS.default_language,
    default_theme: payload.default_theme === 'dark' ? 'dark' : 'light',
    theme_color: sanitizeColor(payload.light_theme_color || payload.theme_color || DEFAULT_SETTINGS.light_theme_color, DEFAULT_SETTINGS.light_theme_color),
    light_theme_color: sanitizeColor(payload.light_theme_color || payload.theme_color || DEFAULT_SETTINGS.light_theme_color, DEFAULT_SETTINGS.light_theme_color),
    dark_theme_color: sanitizeColor(payload.dark_theme_color || DEFAULT_SETTINGS.dark_theme_color, DEFAULT_SETTINGS.dark_theme_color),
    light_bg_color: sanitizeColor(payload.light_bg_color || DEFAULT_SETTINGS.light_bg_color, DEFAULT_SETTINGS.light_bg_color),
    dark_bg_color: sanitizeColor(payload.dark_bg_color || DEFAULT_SETTINGS.dark_bg_color, DEFAULT_SETTINGS.dark_bg_color),
    light_bg_glow: sanitizeColor(payload.light_bg_glow || DEFAULT_SETTINGS.light_bg_glow, DEFAULT_SETTINGS.light_bg_glow),
    dark_bg_glow: sanitizeColor(payload.dark_bg_glow || DEFAULT_SETTINGS.dark_bg_glow, DEFAULT_SETTINGS.dark_bg_glow),
    light_ui_color: sanitizeColor(payload.light_ui_color || DEFAULT_SETTINGS.light_ui_color, DEFAULT_SETTINGS.light_ui_color),
    dark_ui_color: sanitizeColor(payload.dark_ui_color || DEFAULT_SETTINGS.dark_ui_color, DEFAULT_SETTINGS.dark_ui_color),
    light_ui_opacity: sanitizeOpacity(payload.light_ui_opacity, DEFAULT_SETTINGS.light_ui_opacity),
    dark_ui_opacity: sanitizeOpacity(payload.dark_ui_opacity, DEFAULT_SETTINGS.dark_ui_opacity),
    font_scale: String(Math.min(1.25, Math.max(0.9, Number(payload.font_scale) || 1))),
    font_family: normalizeFontFamily(payload.font_family),
    login_eyebrow: String(payload.login_eyebrow || ''),
    login_title: String(payload.login_title || ''),
    login_text: String(payload.login_text || ''),
    login_background_mode: ['network', 'image', 'static'].includes(payload.login_background_mode) ? payload.login_background_mode : 'network',
    login_background_image: String(payload.login_background_image || ''),
    entra_enabled: payload.entra_enabled === 'true' ? 'true' : 'false',
    entra_tenant_id: String(payload.entra_tenant_id || '').trim(),
    entra_client_id: String(payload.entra_client_id || '').trim(),
    entra_client_secret: String(payload.entra_client_secret || '').trim(),
    entra_redirect_uri: String(payload.entra_redirect_uri || '').trim(),
    footer_text: String(payload.footer_text || '').trim(),
    copyright_holder: String(payload.copyright_holder || '').trim(),
    menu_links: normalizeMenuLinks(payload.menu_links)
  };

  logInfo('Applying settings update', {
    app_name: settings.app_name,
    sidebar_title: settings.sidebar_title,
    default_theme: settings.default_theme,
    default_language: settings.default_language,
    login_background_mode: settings.login_background_mode
  });

  for (const [key, value] of Object.entries(settings)) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  logInfo('Settings update persisted successfully');
  sendJson(res, 200, { ok: true, settings: getSettings() });
}

function getEditableContentTree() {
  const directories = [];
  const docs = existsSync(DOCS_DIR) ? scanEditableDocsDirectory(DOCS_DIR, '', directories) : [];
  return {
    tree: [
      {
        type: 'page',
        slug: '__home',
        title: 'Home',
        relativePath: 'home.md'
      },
      ...docs
    ],
    directories
  };
}

function scanEditableDocsDirectory(dir, relativeDir, directories) {
  const categoryMeta = readCategoryMeta(relativeDir);
  const label = categoryMeta.label || titleFromSlug(relativeDir.split('/').pop() || 'docs');
  if (!directories.some((item) => item.relativeDir === relativeDir)) {
    directories.push({ relativeDir, label });
  }

  const entries = readdirSync(dir)
    .filter((entry) => !entry.startsWith('.') && entry !== 'category.json')
    .map((entry) => {
      const fullPath = join(dir, entry);
      return { entry, fullPath, isDirectory: statSync(fullPath).isDirectory() };
    })
    .sort((a, b) => {
      if (a.entry === 'index.md') return -1;
      if (b.entry === 'index.md') return 1;
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.entry.localeCompare(b.entry, 'de');
    });

  const children = [];
  for (const item of entries) {
    if (item.isDirectory) {
      const childRelative = relativeDir ? `${relativeDir}/${item.entry}` : item.entry;
      children.push({
        type: 'category',
        relativeDir: childRelative,
        label: readCategoryMeta(childRelative).label || titleFromSlug(item.entry),
        children: scanEditableDocsDirectory(item.fullPath, childRelative, directories)
      });
      continue;
    }

    if (!item.entry.endsWith('.md')) continue;
    const basename = item.entry.replace(/\.md$/i, '');
    const slug = basename === 'index' ? relativeDir : (relativeDir ? `${relativeDir}/${basename}` : basename);
    if (!slug) continue;
    const policy = catalog.bySlug.get(slug);
    children.push({
      type: 'page',
      slug,
      title: policy?.title || titleFromSlug(basename === 'index' ? relativeDir.split('/').pop() || 'index' : basename),
      relativePath: toContentRelativePath(item.fullPath)
    });
  }
  return children;
}

function handleGetEditablePage(res, url) {
  const slug = String(url.searchParams.get('slug') || '').trim();
  const page = getEditablePage(slug);
  if (!page) return sendJson(res, 404, { error: 'Page not found.' });
  sendJson(res, 200, page);
}

async function handleSaveEditablePage(req, res) {
  const payload = await readJson(req);
  const mode = payload.mode === 'create' ? 'create' : 'update';
  const meta = normalizeEditablePageMeta(payload);
  const markdown = String(payload.markdown || '');

  if (mode === 'create') {
    const parentDir = sanitizeRelativeDir(payload.parentDir);
    const asIndex = payload.asIndex === true;
    const slugSegment = sanitizeSlugSegment(payload.slug);
    if (asIndex && !parentDir) return sendJson(res, 400, { error: 'A root index page is not supported.' });
    if (!asIndex && !slugSegment) return sendJson(res, 400, { error: 'A page slug is required.' });

    const targetDir = resolveDocsDirectory(parentDir);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const fileName = asIndex ? 'index.md' : `${slugSegment}.md`;
    const filePath = resolveDocsPath(parentDir ? `${parentDir}/${fileName}` : fileName);
    if (existsSync(filePath)) return sendJson(res, 409, { error: 'This page already exists.' });

    if (!meta.title) {
      meta.title = titleFromSlug(asIndex ? parentDir.split('/').pop() || 'index' : slugSegment);
    }
    const initialRaw = serializeEditablePage({
      meta,
      extraMeta: normalizeExtraMeta(payload.extraMeta),
      markdown: markdown.trim() || `# ${meta.title}\n\nWrite your content here.\n`
    });
    writeFileSync(filePath, ensureTrailingNewline(initialRaw), 'utf8');
    catalog = loadCatalog();
    const slug = asIndex ? parentDir : (parentDir ? `${parentDir}/${slugSegment}` : slugSegment);
    logInfo(`Content page created: ${slug}`, { file: filePath });
    return sendJson(res, 200, { ok: true, slug });
  }

  const slug = String(payload.slug || '').trim();
  const page = getEditablePage(slug);
  if (!page) return sendJson(res, 404, { error: 'Page not found.' });
  const nextRaw = serializeEditablePage({
    meta,
    extraMeta: normalizeExtraMeta(payload.extraMeta),
    markdown
  });
  writeFileSync(page.filePath, ensureTrailingNewline(nextRaw), 'utf8');
  catalog = loadCatalog();
  logInfo(`Content page updated: ${slug}`, { file: page.filePath });
  sendJson(res, 200, { ok: true, slug });
}

function handleGetEditableCategory(res, url) {
  const relativeDir = sanitizeRelativeDir(url.searchParams.get('dir') || '');
  const directoryPath = resolveDocsDirectory(relativeDir);
  if (!existsSync(directoryPath)) return sendJson(res, 404, { error: 'Category not found.' });

  const meta = readCategoryMeta(relativeDir);
  sendJson(res, 200, {
    relativeDir,
    label: meta.label || titleFromSlug(relativeDir.split('/').pop() || 'docs'),
    position: Number(meta.position ?? meta.sidebar_position ?? 999),
    roles: Array.isArray(meta.roles) ? meta.roles : [],
    configPath: toContentRelativePath(join(directoryPath, 'category.json'))
  });
}

async function handleSaveEditableCategory(req, res) {
  const payload = await readJson(req);
  const mode = payload.mode === 'create' ? 'create' : 'update';

  if (mode === 'create') {
    const parentDir = sanitizeRelativeDir(payload.parentDir);
    const slugSegment = sanitizeSlugSegment(payload.slug);
    if (!slugSegment) return sendJson(res, 400, { error: 'A category slug is required.' });
    const relativeDir = parentDir ? `${parentDir}/${slugSegment}` : slugSegment;
    const directoryPath = resolveDocsDirectory(relativeDir);
    if (existsSync(directoryPath)) return sendJson(res, 409, { error: 'This category already exists.' });
    mkdirSync(directoryPath, { recursive: true });

    const label = String(payload.label || '').trim() || titleFromSlug(slugSegment);
    writeCategoryMeta(relativeDir, {
      label,
      position: Number(payload.position ?? 999),
      roles: normalizeRoleList(payload.roles)
    });

    if (payload.createIndex === true) {
      const indexPath = resolveDocsPath(`${relativeDir}/index.md`);
      const indexTitle = String(payload.indexTitle || '').trim() || label;
      const raw = String(payload.raw || '').trim() || buildMarkdownTemplate({
        title: indexTitle,
        description: '',
        roles: normalizeRoleList(payload.roles)
      });
      writeFileSync(indexPath, ensureTrailingNewline(raw), 'utf8');
    }

    catalog = loadCatalog();
    logInfo(`Content category created: ${relativeDir}`, { directory: directoryPath });
    return sendJson(res, 200, { ok: true, relativeDir });
  }

  const relativeDir = sanitizeRelativeDir(payload.relative_dir || payload.relativeDir || '');
  const directoryPath = resolveDocsDirectory(relativeDir);
  if (!existsSync(directoryPath)) return sendJson(res, 404, { error: 'Category not found.' });

  writeCategoryMeta(relativeDir, {
    label: String(payload.label || '').trim() || titleFromSlug(relativeDir.split('/').pop() || 'docs'),
    position: Number(payload.position ?? 999),
    roles: normalizeRoleList(payload.roles)
  });
  catalog = loadCatalog();
  logInfo(`Content category updated: ${relativeDir}`, { directory: directoryPath });
  sendJson(res, 200, { ok: true, relativeDir });
}

function getCmsStudioTree() {
  return {
    tree: cmsCatalog.pages.map((page) => ({
      slug: page.slug,
      title: page.title,
      relativePath: toContentRelativePath(page.file),
      coverImage: page.coverImage
    }))
  };
}

function getEditableCmsPage(slug) {
  const safeSlug = sanitizeSlugSegment(slug);
  if (!safeSlug) return null;
  const filePath = normalize(join(CMS_DIR, `${safeSlug}.md`));
  if (!filePath.startsWith(CMS_DIR) || !existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(raw);
  return {
    slug: safeSlug,
    filePath,
    relativePath: toContentRelativePath(filePath),
    markdown: parsed.markdown,
    meta: {
      title: String(parsed.meta.title || '').trim(),
      description: String(parsed.meta.description || '').trim(),
      excerpt: String(parsed.meta.excerpt || '').trim(),
      coverImage: String(parsed.meta.coverImage || '').trim(),
      roles: Array.isArray(parsed.meta.roles) ? parsed.meta.roles : []
    }
  };
}

function handleGetCmsStudioPage(res, url) {
  const slug = String(url.searchParams.get('slug') || '').trim();
  const page = getEditableCmsPage(slug);
  if (!page) return sendJson(res, 404, { error: 'CMS page not found.' });
  sendJson(res, 200, page);
}

async function handleSaveCmsStudioPage(req, res, user) {
  const payload = await readJson(req);
  const mode = payload.mode === 'create' ? 'create' : 'update';
  const slug = sanitizeSlugSegment(payload.slug);
  const title = String(payload.title || '').trim();
  const description = String(payload.description || '').trim();
  const excerpt = String(payload.excerpt || '').trim();
  const coverImage = String(payload.coverImage || '').trim();
  const roles = normalizeRoleList(payload.roles);
  const markdown = String(payload.markdown || '');

  if (!slug) return sendJson(res, 400, { error: 'A page slug is required.' });
  if (!title) return sendJson(res, 400, { error: 'A page title is required.' });

  const filePath = normalize(join(CMS_DIR, `${slug}.md`));
  if (!filePath.startsWith(CMS_DIR)) return sendJson(res, 400, { error: 'Invalid CMS path.' });
  if (mode === 'create' && existsSync(filePath)) return sendJson(res, 409, { error: 'This CMS page already exists.' });
  if (mode === 'update' && !existsSync(filePath)) return sendJson(res, 404, { error: 'CMS page not found.' });

  const raw = serializeCmsPage({
    meta: { title, description, excerpt, coverImage, roles, editor: user.name || '' },
    markdown: markdown.trim() || `# ${title}\n\nWrite your page here.\n`
  });
  writeFileSync(filePath, ensureTrailingNewline(raw), 'utf8');
  cmsCatalog = loadCmsCatalog();
  sendJson(res, 200, { ok: true, slug });
}

function handleDeleteCmsStudioPage(res, pathname) {
  const slug = sanitizeSlugSegment(decodeURIComponent(pathname.split('/').pop() || ''));
  if (!slug) return sendJson(res, 400, { error: 'Invalid CMS slug.' });
  const filePath = normalize(join(CMS_DIR, `${slug}.md`));
  if (!filePath.startsWith(CMS_DIR) || !existsSync(filePath)) return sendJson(res, 404, { error: 'CMS page not found.' });
  unlinkSync(filePath);
  cmsCatalog = loadCmsCatalog();
  sendJson(res, 200, { ok: true });
}

function serializeCmsPage({ meta, markdown = '' }) {
  const lines = ['---'];
  lines.push(`title: ${String(meta.title || '').trim()}`);
  if (meta.description) lines.push(`description: ${String(meta.description).trim()}`);
  if (meta.excerpt) lines.push(`excerpt: ${String(meta.excerpt).trim()}`);
  if (meta.coverImage) lines.push(`coverImage: ${String(meta.coverImage).trim()}`);
  lines.push(`roles: [${normalizeRoleList(meta.roles).join(', ')}]`);
  lines.push('---', '', String(markdown || '').replace(/\r\n/g, '\n').replace(/^\n+/, ''));
  return lines.join('\n');
}

function listUsers() {
  const users = db.prepare('SELECT id, email, name, provider, is_admin, active, created_at FROM users ORDER BY name').all();
  const roles = db.prepare(`
    SELECT u.id AS user_id, r.name
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON r.id = ur.role_id
  `).all();
  return users.map((user) => ({
    ...user,
    is_admin: Boolean(user.is_admin),
    active: Boolean(user.active),
    roles: roles.filter((role) => role.user_id === user.id).map((role) => role.name)
  }));
}

function listRoles() {
  return db.prepare('SELECT id, name, description, color FROM roles ORDER BY name').all();
}

function listPlugins(locale = DEFAULT_SETTINGS.default_language) {
  const rows = db.prepare('SELECT key, enabled FROM plugins').all();
  const enabledByKey = new Map(rows.map((row) => [row.key, Boolean(row.enabled)]));
  return Object.values(FEATURE_DEFINITIONS).map((feature) => {
    const localized = getPluginFeatureCopy(feature.key, locale, feature);
    return {
      ...feature,
      label: localized.label,
      description: localized.description,
      enabled: enabledByKey.has(feature.key) ? enabledByKey.get(feature.key) : feature.defaultEnabled
    };
  });
}

function isPluginEnabled(key) {
  const plugin = listPlugins().find((item) => item.key === key);
  return Boolean(plugin?.enabled);
}

function requirePlugin(key, res, callback) {
  if (!isPluginEnabled(key)) {
    return sendJson(res, 404, { error: 'This feature is currently disabled.' });
  }
  return callback();
}

async function handleUpdatePlugin(req, res, locale = DEFAULT_SETTINGS.default_language) {
  const payload = await readJson(req);
  const key = String(payload.key || '').trim();
  if (!FEATURE_DEFINITIONS[key]) return sendJson(res, 404, { error: 'Plugin not found.' });
  const enabled = payload.enabled === true;
  db.prepare('INSERT INTO plugins (key, enabled) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled').run(key, enabled ? 1 : 0);
  sendJson(res, 200, { ok: true, plugins: listPlugins(locale) });
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) settings[row.key] = row.value;
  settings.theme_color = sanitizeColor(settings.theme_color, DEFAULT_SETTINGS.light_theme_color);
  settings.light_theme_color = sanitizeColor(settings.light_theme_color || settings.theme_color, DEFAULT_SETTINGS.light_theme_color);
  settings.dark_theme_color = sanitizeColor(settings.dark_theme_color, DEFAULT_SETTINGS.dark_theme_color);
  settings.light_bg_color = sanitizeColor(settings.light_bg_color, DEFAULT_SETTINGS.light_bg_color);
  settings.dark_bg_color = sanitizeColor(settings.dark_bg_color, DEFAULT_SETTINGS.dark_bg_color);
  settings.light_bg_glow = sanitizeColor(settings.light_bg_glow, DEFAULT_SETTINGS.light_bg_glow);
  settings.dark_bg_glow = sanitizeColor(settings.dark_bg_glow, DEFAULT_SETTINGS.dark_bg_glow);
  settings.light_ui_color = sanitizeColor(settings.light_ui_color, DEFAULT_SETTINGS.light_ui_color);
  settings.dark_ui_color = sanitizeColor(settings.dark_ui_color, DEFAULT_SETTINGS.dark_ui_color);
  settings.light_ui_opacity = sanitizeOpacity(settings.light_ui_opacity, DEFAULT_SETTINGS.light_ui_opacity);
  settings.dark_ui_opacity = sanitizeOpacity(settings.dark_ui_opacity, DEFAULT_SETTINGS.dark_ui_opacity);
  settings.font_scale = String(Math.min(1.25, Math.max(0.9, Number(settings.font_scale) || 1)));
  settings.font_family = normalizeFontFamily(settings.font_family);
  settings.logo_image = sanitizeDataImage(settings.logo_image);
  settings.default_language = isSupportedLocale(settings.default_language) ? settings.default_language : DEFAULT_SETTINGS.default_language;
  settings.default_theme = settings.default_theme === 'dark' ? 'dark' : 'light';
  settings.entra_enabled = settings.entra_enabled === 'true' ? 'true' : 'false';
  if (!['network', 'image', 'static'].includes(settings.login_background_mode)) settings.login_background_mode = 'network';
  settings.menu_links = normalizeMenuLinks(settings.menu_links);
  return settings;
}

function getEntraConfig(settings, req) {
  return {
    enabled: settings.entra_enabled === 'true' || process.env.ENTRA_ENABLED === 'true',
    tenant: settings.entra_tenant_id || process.env.ENTRA_TENANT_ID || '',
    clientId: settings.entra_client_id || process.env.ENTRA_CLIENT_ID || '',
    clientSecret: settings.entra_client_secret || process.env.ENTRA_CLIENT_SECRET || '',
    redirectUri: settings.entra_redirect_uri || process.env.ENTRA_REDIRECT_URI || `http://${req.headers.host}/auth/entra/callback`
  };
}

function getRoleColors() {
  return new Map(listRoles().map((role) => [role.name, role.color || '#5d6b82']));
}

function renderRolePills(roleNames = []) {
  const colors = getRoleColors();
  return roleNames.map((role) => {
    const color = sanitizeColor(colors.get(role) || '#5d6b82');
    return `<span class="pill" style="--role-color: ${color};">${escapeHtml(role)}</span>`;
  }).join('');
}

function sanitizeExplorerSegment(value = '') {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeExplorerDir(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => sanitizeExplorerSegment(part))
    .filter(Boolean)
    .join('/');
}

function sanitizeFileName(value = '') {
  return sanitizeExplorerSegment(value).replace(/^\.+/, '').slice(0, 180);
}

function normalizeTagList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
  return Array.from(new Set(items.map((item) => String(item).trim()).filter(Boolean)));
}

function loadCmsCatalog() {
  logInfo(`Loading CMS catalog from ${CMS_DIR}`);
  if (!existsSync(CMS_DIR)) {
    mkdirSync(CMS_DIR, { recursive: true });
    return { pages: [], bySlug: new Map(), home: null };
  }

  const pages = readdirSync(CMS_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => createCmsPage(join(CMS_DIR, file), file.replace(/\.md$/i, '')))
    .sort((a, b) => a.title.localeCompare(b.title, 'de'));
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const home = bySlug.get('index') || null;
  logInfo(`CMS catalog loaded: ${pages.length} pages`);
  return { pages, bySlug, home };
}

function createCmsPage(filePath, slug) {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, markdown } = parseFrontmatter(raw);
  const rendered = markdownToHtml(markdown, `page/${slug}`);
  const roles = Array.isArray(meta.roles) ? meta.roles : [];
  return {
    slug,
    file: filePath,
    title: meta.title || titleFromSlug(slug),
    description: meta.description || '',
    excerpt: meta.excerpt || meta.description || '',
    coverImage: meta.coverImage || '',
    roles,
    html: rendered.html,
    headings: rendered.headings,
    markdown
  };
}


const FORM_PERMISSION_KEYS = ['manage', 'view', 'evaluate', 'submit'];
const FORM_FIELD_TYPES = new Set(['text', 'textarea', 'email', 'select', 'date', 'number', 'checkbox', 'divider']);
const FORM_SUBMISSION_STATUSES = new Set(['submitted', 'in_review', 'approved', 'rejected']);

function normalizeEmailList(values) {
  const list = Array.isArray(values) ? values : [values];
  return Array.from(new Set(list
    .flatMap((value) => String(value || '').split(/[,\n]/))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)));
}

function normalizeFormPermissionEntry(value) {
  return {
    roles: normalizeRoleList(value?.roles || []),
    users: normalizeEmailList(value?.users || [])
  };
}

function normalizeFormPermissions(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {};
  for (const key of FORM_PERMISSION_KEYS) normalized[key] = normalizeFormPermissionEntry(source[key]);
  return normalized;
}

function normalizeFormFieldKey(value, fallback = 'field') {
  const base = slugify(String(value || '').trim()) || slugify(fallback) || 'field';
  return base.replace(/-/g, '_');
}

function normalizeFormFieldVisibility(value) {
  const fieldKey = normalizeFormFieldKey(value?.fieldKey || value?.field_key || '', '');
  if (!fieldKey) return null;
  const mode = String(value?.mode || '').trim() === 'equals' ? 'equals' : 'filled';
  const expectedValue = mode === 'equals' ? String(value?.expectedValue ?? value?.expected_value ?? '').trim() : '';
  return { fieldKey, mode, expectedValue };
}

function normalizeFormFields(value) {
  const list = Array.isArray(value) ? value : [];
  const usedKeys = new Set();
  const normalized = [];

  for (const [index, field] of list.entries()) {
    const label = String(field?.label || '').trim();
    const type = FORM_FIELD_TYPES.has(String(field?.type || '').trim()) ? String(field.type).trim() : 'text';
    let key = type === 'divider'
      ? normalizeFormFieldKey(field?.key || label || `divider_${index + 1}`, `divider_${index + 1}`)
      : normalizeFormFieldKey(field?.key || label || `field_${index + 1}`, `field_${index + 1}`);
    while (usedKeys.has(key)) key = `${key}_${index + 1}`;
    usedKeys.add(key);
    const visibility = normalizeFormFieldVisibility(field?.visibility);
    normalized.push({
      key,
      label: label || (type === 'divider' ? 'Section' : titleFromSlug(key.replace(/_/g, '-'))),
      type,
      required: type === 'divider' ? false : Boolean(field?.required),
      placeholder: String(field?.placeholder || '').trim(),
      helpText: String(field?.helpText || '').trim(),
      options: type === 'select' ? normalizeTagList(field?.options || []) : [],
      visibility
    });
  }

  return normalized;
}

function normalizeFormStatus(value) {
  return String(value || '').trim().toLowerCase() === 'archived' ? 'archived' : 'active';
}

function parseJsonObject(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function normalizeFormRecord(row) {
  const permissions = normalizeFormPermissions(parseJsonObject(row.permissions_json, {}));
  const fields = normalizeFormFields(parseJsonObject(row.fields_json, []));
  const creator = row.creator_email ? {
    id: row.creator_user_id || null,
    name: row.creator_name || row.creator_email,
    email: row.creator_email
  } : null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description || '',
    introText: row.intro_text || '',
    status: normalizeFormStatus(row.status),
    permissions,
    fields,
    creator,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listFormsAdmin() {
  return db.prepare(`
    SELECT
      f.*,
      u.name AS creator_name,
      u.email AS creator_email
    FROM forms f
    LEFT JOIN users u ON u.id = f.creator_user_id
    ORDER BY f.title, f.slug
  `).all().map(normalizeFormRecord);
}

function getFormBySlug(slug) {
  const value = String(slug || '').trim();
  if (!value) return null;
  const row = db.prepare(`
    SELECT
      f.*,
      u.name AS creator_name,
      u.email AS creator_email
    FROM forms f
    LEFT JOIN users u ON u.id = f.creator_user_id
    WHERE f.slug = ?
  `).get(value);
  return row ? normalizeFormRecord(row) : null;
}

function getFormById(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const row = db.prepare(`
    SELECT
      f.*,
      u.name AS creator_name,
      u.email AS creator_email
    FROM forms f
    LEFT JOIN users u ON u.id = f.creator_user_id
    WHERE f.id = ?
  `).get(numericId);
  return row ? normalizeFormRecord(row) : null;
}

function getSubmissionCountByFormId() {
  const rows = db.prepare('SELECT form_id, COUNT(*) AS count FROM form_submissions GROUP BY form_id').all();
  return new Map(rows.map((row) => [row.form_id, row.count]));
}

function canMatchFormPermission(user, scope) {
  if (!user) return false;
  if (user.is_admin) return true;
  if (Array.isArray(scope?.users) && scope.users.includes(String(user.email || '').toLowerCase())) return true;
  return Array.isArray(scope?.roles) && scope.roles.some((role) => user.roles.includes(role));
}

function isFormCreator(user, form) {
  return Boolean(user?.id && form?.creator?.id && Number(user.id) === Number(form.creator.id));
}

function canManageForm(user, form) {
  return Boolean(user?.is_admin || isFormCreator(user, form) || canMatchFormPermission(user, form.permissions.manage));
}

function canEvaluateForm(user, form) {
  return Boolean(canManageForm(user, form) || canMatchFormPermission(user, form.permissions.evaluate));
}

function canSubmitForm(user, form) {
  return Boolean(canManageForm(user, form) || canMatchFormPermission(user, form.permissions.submit));
}

function canViewForm(user, form) {
  return Boolean(canManageForm(user, form) || canEvaluateForm(user, form) || canSubmitForm(user, form) || canMatchFormPermission(user, form.permissions.view));
}

function listFormsForUser(user) {
  const submissionCounts = getSubmissionCountByFormId();
  return listFormsAdmin()
    .filter((form) => form.status === 'active')
    .map((form) => ({
      ...form,
      actions: {
        canManage: canManageForm(user, form),
        canView: canViewForm(user, form),
        canEvaluate: canEvaluateForm(user, form),
        canSubmit: canSubmitForm(user, form)
      },
      submissionCount: submissionCounts.get(form.id) || 0
    }))
    .filter((form) => form.actions.canView);
}

function getFormAdminTree() {
  const submissionCounts = getSubmissionCountByFormId();
  const tree = listFormsAdmin().map((form) => ({
    id: form.id,
    slug: form.slug,
    title: form.title,
    status: form.status,
    submissionCount: submissionCounts.get(form.id) || 0,
    updatedAt: form.updatedAt
  }));
  return { tree };
}

function getDefaultFormPayload() {
  return {
    title: 'User request',
    description: 'Collect structured user requests and route them for review.',
    introText: 'Please complete all relevant fields before submitting your request.',
    status: 'active',
    permissions: {
      manage: { roles: ['Admins'], users: [] },
      view: { roles: [], users: [] },
      evaluate: { roles: ['Admins'], users: [] },
      submit: { roles: ['Users'], users: [] }
    },
    fields: [
      { key: 'request_title', label: 'Request title', type: 'text', required: true, placeholder: 'New user account for...', helpText: '', options: [] },
      { key: 'department', label: 'Department', type: 'text', required: true, placeholder: 'Sales', helpText: '', options: [] },
      { key: 'details', label: 'Details', type: 'textarea', required: true, placeholder: 'Describe what is needed and why.', helpText: '', options: [] },
      { key: 'needed_by', label: 'Needed by', type: 'date', required: false, placeholder: '', helpText: '', options: [] }
    ]
  };
}

function handleGetAdminForm(res, url) {
  const slug = url.searchParams.get('slug');
  const id = url.searchParams.get('id');
  const form = slug ? getFormBySlug(slug) : getFormById(id);
  if (!form) return sendJson(res, 404, { error: 'Form not found.' });
  sendJson(res, 200, form);
}

async function handleSaveAdminForm(req, res, user) {
  const payload = await readJson(req);
  const id = payload.id ? Number(payload.id) : null;
  const title = String(payload.title || '').trim();
  const slug = slugify(String(payload.slug || '').trim() || title);
  const description = String(payload.description || '').trim();
  const introText = String(payload.introText || payload.intro_text || '').trim();
  const status = normalizeFormStatus(payload.status);
  const permissions = normalizeFormPermissions(payload.permissions);
  const fields = normalizeFormFields(payload.fields);

  if (!title) return sendJson(res, 400, { error: 'A form title is required.' });
  if (!slug) return sendJson(res, 400, { error: 'A form slug is required.' });
  if (!fields.length) return sendJson(res, 400, { error: 'Please add at least one form field.' });

  const existingBySlug = getFormBySlug(slug);
  if (existingBySlug && (!id || existingBySlug.id !== id)) return sendJson(res, 400, { error: 'This slug is already in use.' });

  if (!id) {
    const result = db.prepare(`
      INSERT INTO forms (slug, title, description, intro_text, creator_user_id, status, permissions_json, fields_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(slug, title, description, introText, user.id, status, JSON.stringify(permissions), JSON.stringify(fields));
    return sendJson(res, 200, { ok: true, id: result.lastInsertRowid, slug });
  }

  const current = getFormById(id);
  if (!current) return sendJson(res, 404, { error: 'Form not found.' });
  db.prepare(`
    UPDATE forms
    SET slug = ?, title = ?, description = ?, intro_text = ?, status = ?, permissions_json = ?, fields_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(slug, title, description, introText, status, JSON.stringify(permissions), JSON.stringify(fields), id);
  sendJson(res, 200, { ok: true, id, slug });
}

function handleDeleteAdminForm(res, pathname) {
  const id = Number(pathname.split('/').pop());
  const current = getFormById(id);
  if (!current) return sendJson(res, 404, { error: 'Form not found.' });
  db.prepare('DELETE FROM forms WHERE id = ?').run(id);
  sendJson(res, 200, { ok: true });
}

function validateSubmissionValue(field, rawValue) {
  if (field.type === 'divider') return '';
  if (field.type === 'checkbox') return Boolean(rawValue);
  const value = String(rawValue ?? '').trim();
  if (field.required && !value) throw new Error(`Please fill "${field.label}".`);
  if (!value) return '';
  if (field.type === 'select' && field.options.length && !field.options.includes(value)) throw new Error(`Please choose a valid option for "${field.label}".`);
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`Please enter a valid email for "${field.label}".`);
  if (field.type === 'number' && Number.isNaN(Number(value))) throw new Error(`Please enter a number for "${field.label}".`);
  return value;
}

function isFormFieldVisible(field, values) {
  if (!field?.visibility?.fieldKey) return true;
  const dependency = values[field.visibility.fieldKey];
  if (field.visibility.mode === 'equals') return String(dependency ?? '').trim() === String(field.visibility.expectedValue || '');
  if (typeof dependency === 'boolean') return dependency === true;
  return String(dependency ?? '').trim() !== '';
}

function normalizeSubmissionValues(form, values) {
  const source = values && typeof values === 'object' ? values : {};
  const normalized = {};
  for (const field of form.fields) {
    const rawValue = source[field.key];
    if (!isFormFieldVisible(field, { ...source, ...normalized })) {
      normalized[field.key] = field.type === 'checkbox' ? false : '';
      continue;
    }
    normalized[field.key] = validateSubmissionValue(field, rawValue);
  }
  return normalized;
}

function normalizeSubmissionStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return FORM_SUBMISSION_STATUSES.has(normalized) ? normalized : 'submitted';
}

function normalizeFormSubmissionRecord(row, form) {
  const values = parseJsonObject(row.values_json, {});
  return {
    id: row.id,
    formId: row.form_id,
    formSlug: form.slug,
    submitter: {
      id: row.submitter_user_id || null,
      name: row.submitter_name || row.submitter_email,
      email: row.submitter_email
    },
    status: normalizeSubmissionStatus(row.status),
    notes: row.notes || '',
    values: form.fields
      .filter((field) => field.type !== 'divider')
      .map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        value: values[field.key] ?? (field.type === 'checkbox' ? false : ''),
        visibility: field.visibility || null
      })),
    reviewedBy: row.reviewer_email ? {
      id: row.reviewed_by_user_id || null,
      name: row.reviewer_name || row.reviewer_email,
      email: row.reviewer_email
    } : null,
    reviewedAt: row.reviewed_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listFormSubmissions(form, user) {
  const rows = db.prepare(`
    SELECT
      s.*,
      reviewer.name AS reviewer_name,
      reviewer.email AS reviewer_email
    FROM form_submissions s
    LEFT JOIN users reviewer ON reviewer.id = s.reviewed_by_user_id
    WHERE s.form_id = ?
    ORDER BY s.created_at DESC, s.id DESC
  `).all(form.id);

  return rows
    .filter((row) => canEvaluateForm(user, form) || Number(row.submitter_user_id) === Number(user.id))
    .map((row) => normalizeFormSubmissionRecord(row, form));
}

function handleGetPublicForm(res, url, user) {
  const form = getFormBySlug(url.searchParams.get('slug'));
  if (!form || form.status !== 'active') return sendJson(res, 404, { error: 'Form not found.' });
  if (!canViewForm(user, form)) return sendJson(res, 403, { error: 'You do not have access to this form.' });
  sendJson(res, 200, {
    ...form,
    actions: {
      canManage: canManageForm(user, form),
      canView: canViewForm(user, form),
      canEvaluate: canEvaluateForm(user, form),
      canSubmit: canSubmitForm(user, form)
    }
  });
}

async function handleSubmitForm(req, res, user) {
  const payload = await readJson(req);
  const form = getFormBySlug(payload.slug);
  if (!form || form.status !== 'active') return sendJson(res, 404, { error: 'Form not found.' });
  if (!canSubmitForm(user, form)) return sendJson(res, 403, { error: 'You do not have permission to submit this form.' });
  const values = normalizeSubmissionValues(form, payload.values);
  const result = db.prepare(`
    INSERT INTO form_submissions (form_id, submitter_user_id, submitter_name, submitter_email, values_json, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'submitted', CURRENT_TIMESTAMP)
  `).run(form.id, user.id, user.name, user.email, JSON.stringify(values));
  sendJson(res, 200, { ok: true, submissionId: result.lastInsertRowid });
}

function handleGetFormSubmissions(res, url, user) {
  const form = getFormBySlug(url.searchParams.get('slug'));
  if (!form || form.status !== 'active') return sendJson(res, 404, { error: 'Form not found.' });
  if (!canViewForm(user, form)) return sendJson(res, 403, { error: 'You do not have access to this form.' });
  sendJson(res, 200, {
    form: {
      id: form.id,
      slug: form.slug,
      title: form.title
    },
    canEvaluate: canEvaluateForm(user, form),
    submissions: listFormSubmissions(form, user)
  });
}

async function handleReviewFormSubmission(req, res, user) {
  const payload = await readJson(req);
  const submissionId = Number(payload.submissionId);
  if (!Number.isInteger(submissionId) || submissionId <= 0) return sendJson(res, 400, { error: 'Submission not found.' });
  const row = db.prepare('SELECT form_id FROM form_submissions WHERE id = ?').get(submissionId);
  if (!row) return sendJson(res, 404, { error: 'Submission not found.' });
  const form = getFormById(row.form_id);
  if (!form) return sendJson(res, 404, { error: 'Form not found.' });
  if (!canEvaluateForm(user, form)) return sendJson(res, 403, { error: 'You do not have permission to review this submission.' });
  const status = normalizeSubmissionStatus(payload.status);
  const notes = String(payload.notes || '').trim();
  db.prepare(`
    UPDATE form_submissions
    SET status = ?, notes = ?, reviewed_by_user_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, notes, user.id, submissionId);
  sendJson(res, 200, { ok: true });
}

function parseMenuLinks(value) {
  try {
    const links = JSON.parse(value);
    if (!Array.isArray(links)) return [];
    return normalizeMenuLinkList(links);
  } catch {
    return [];
  }
}

function normalizeMenuLinks(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || []);
  return JSON.stringify(parseMenuLinks(text), null, 2);
}

function normalizeMenuLinkList(links) {
  return links
    .map((link) => normalizeMenuLink(link))
    .filter(Boolean);
}

function normalizeMenuLink(link) {
  const label = String(link?.label || '').trim();
  const roles = Array.isArray(link?.roles) ? link.roles.map(String) : [];
  const children = Array.isArray(link?.children) ? normalizeMenuLinkList(link.children) : [];
  const href = String(link?.href || '').trim();

  if (!label) return null;
  if (children.length) {
    return { label, roles, children };
  }
  if (!href) return null;
  return { label, href, roles };
}

function loadLocales() {
  const fallback = {
    en: {
      code: 'en',
      flag: 'gb',
      nativeName: 'English',
      ui: {}
    }
  };
  if (!existsSync(LOCALES_DIR)) return fallback;

  const locales = {};
  for (const file of readdirSync(LOCALES_DIR).filter((name) => name.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const code = String(parsed.code || file.replace(/\.json$/i, '')).toLowerCase();
      if (code) locales[code] = { ...parsed, code, ui: parsed.ui || {} };
    } catch (error) {
      logWarn(`Skipping invalid locale file ${file}`, error instanceof Error ? error.message : String(error));
    }
  }
  return Object.keys(locales).length ? locales : fallback;
}

function getLocalesSignature() {
  if (!existsSync(LOCALES_DIR)) return 'missing';
  try {
    return readdirSync(LOCALES_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = join(LOCALES_DIR, name);
        const stats = statSync(filePath);
        return `${name}:${stats.mtimeMs}:${stats.size}`;
      })
      .sort()
      .join('|');
  } catch (error) {
    logWarn('Failed to inspect locale directory', error instanceof Error ? error.message : String(error));
    return 'error';
  }
}

function loadPluginLocales() {
  const bundles = {};
  for (const plugin of loadedPlugins) {
    const localesDir = plugin.localesDir;
    const pluginBundle = {};
    if (existsSync(localesDir)) {
      for (const file of readdirSync(localesDir).filter((name) => name.endsWith('.json'))) {
        try {
          const parsed = JSON.parse(readFileSync(join(localesDir, file), 'utf8'));
          const code = String(parsed.code || file.replace(/\.json$/i, '')).toLowerCase();
          if (!code) continue;
          pluginBundle[code] = {
            code,
            ui: parsed.ui && typeof parsed.ui === 'object' ? parsed.ui : {},
            feature: parsed.feature && typeof parsed.feature === 'object' ? parsed.feature : {}
          };
        } catch (error) {
          logWarn(`Skipping invalid plugin locale file ${plugin.key}/${file}`, error instanceof Error ? error.message : String(error));
        }
      }
    }
    bundles[plugin.key] = pluginBundle;
  }
  return bundles;
}

function getPluginLocalesSignature() {
  try {
    return loadedPlugins.map((plugin) => {
      if (!existsSync(plugin.localesDir)) return `${plugin.key}:missing`;
      const parts = readdirSync(plugin.localesDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const filePath = join(plugin.localesDir, name);
          const stats = statSync(filePath);
          return `${name}:${stats.mtimeMs}:${stats.size}`;
        })
        .sort()
        .join('|');
      return `${plugin.key}:${parts}`;
    }).sort().join('||');
  } catch (error) {
    logWarn('Failed to inspect plugin locale directories', error instanceof Error ? error.message : String(error));
    return 'error';
  }
}

function getLocales() {
  const signature = getLocalesSignature();
  if (!localesCache || signature !== localesCacheSignature) {
    localesCache = loadLocales();
    localesCacheSignature = signature;
    logInfo(`Loaded locales: ${Object.keys(localesCache).sort().join(', ')}`);
  }
  return localesCache;
}

function getPluginLocales() {
  const signature = getPluginLocalesSignature();
  if (!pluginLocalesCache || signature !== pluginLocalesCacheSignature) {
    pluginLocalesCache = loadPluginLocales();
    pluginLocalesCacheSignature = signature;
    logInfo(`Loaded plugin locales: ${loadedPlugins.map((plugin) => `${plugin.key}(${Object.keys(pluginLocalesCache[plugin.key] || {}).sort().join(',') || 'none'})`).join(', ')}`);
  }
  return pluginLocalesCache;
}

function getAvailableLanguages() {
  return Object.values(getLocales()).sort((a, b) => a.nativeName.localeCompare(b.nativeName));
}

function isSupportedLocale(code) {
  const locales = getLocales();
  return Boolean(code && locales[String(code).toLowerCase()]);
}

function detectBrowserLocale(req) {
  const header = String(req.headers['accept-language'] || '');
  const candidates = header
    .split(',')
    .map((entry) => entry.trim().split(';')[0].toLowerCase())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (isSupportedLocale(candidate)) return candidate;
    const base = candidate.split('-')[0];
    if (isSupportedLocale(base)) return base;
  }
  return null;
}

function resolveLocale(req, user, settings) {
  if (isSupportedLocale(user?.language)) return user.language.toLowerCase();
  return detectBrowserLocale(req)
    || (isSupportedLocale(settings.default_language) ? settings.default_language : DEFAULT_SETTINGS.default_language);
}

function t(locale, key) {
  const locales = getLocales();
  const active = locales[locale]?.ui || {};
  const fallback = locales[DEFAULT_SETTINGS.default_language]?.ui || locales.en?.ui || {};
  return active[key] || fallback[key] || key;
}

function tf(locale, key, fallback) {
  const value = t(locale, key);
  return value === key ? fallback : value;
}

function tp(pluginKey, locale, key) {
  const pluginLocales = getPluginLocales();
  const bundle = pluginLocales[String(pluginKey || '')] || {};
  const active = bundle[locale]?.ui || {};
  const fallback = bundle[DEFAULT_SETTINGS.default_language]?.ui || bundle.en?.ui || {};
  return active[key] || fallback[key] || key;
}

function tpf(pluginKey, locale, key, fallback) {
  const value = tp(pluginKey, locale, key);
  return value === key ? fallback : value;
}

function getPluginFeatureCopy(pluginKey, locale, fallback = {}) {
  const pluginLocales = getPluginLocales();
  const bundle = pluginLocales[String(pluginKey || '')] || {};
  const active = bundle[locale]?.feature || {};
  const fallbackFeature = bundle[DEFAULT_SETTINGS.default_language]?.feature || bundle.en?.feature || {};
  return {
    label: active.label || fallbackFeature.label || fallback.label || pluginKey,
    description: active.description || fallbackFeature.description || fallback.description || ''
  };
}

function getClientI18n(locale, pluginKeys = []) {
  const locales = getLocales();
  const uniquePluginKeys = Array.from(new Set((Array.isArray(pluginKeys) ? pluginKeys : []).filter(Boolean)));
  const pluginMessages = Object.fromEntries(uniquePluginKeys.map((pluginKey) => {
    const messages = {
      ...(getPluginLocales()[pluginKey]?.[DEFAULT_SETTINGS.default_language]?.ui || getPluginLocales()[pluginKey]?.en?.ui || {}),
      ...(getPluginLocales()[pluginKey]?.[locale]?.ui || {})
    };
    return [pluginKey, {
      messages,
      feature: getPluginFeatureCopy(pluginKey, locale)
    }];
  }));
  const mergedPluginMessages = Object.assign({}, ...Object.values(pluginMessages).map((entry) => entry.messages || {}));
  return {
    locale,
    languages: getAvailableLanguages().map((item) => ({
      code: item.code,
      flag: item.flag,
      nativeName: item.nativeName
    })),
    messages: {
      ...(locales[DEFAULT_SETTINGS.default_language]?.ui || locales.en?.ui || {}),
      ...(locales[locale]?.ui || {}),
      ...mergedPluginMessages
    },
    plugins: pluginMessages
  };
}

function renderLanguageSelect(selected, locale, name = 'language') {
  const current = isSupportedLocale(selected) ? String(selected).toLowerCase() : locale;
  const languages = getAvailableLanguages();
  const currentLanguage = languages.find((language) => language.code === current) || languages[0] || { flag: '', nativeName: '' };
  const flagUrl = currentLanguage.flag ? `/assets/flags/4x3/${escapeAttribute(currentLanguage.flag)}.svg` : '';
  return `
    <div class="language-select-wrapper">
      <img class="language-select-flag" src="${escapeHtml(flagUrl)}" alt="${escapeHtml(currentLanguage.nativeName)}" aria-hidden="true">
      <select name="${escapeAttribute(name)}" class="language-select">
        ${languages.map((language) => `
          <option value="${escapeHtml(language.code)}" data-flag="${escapeHtml(language.flag)}" ${language.code === current ? 'selected' : ''}>
            ${escapeHtml(language.nativeName)}
          </option>
        `).join('')}
      </select>
    </div>
  `;
}

function removeAdminFromDefaultMenuLinks() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('menu_links');
  if (!row) return;
  const links = parseMenuLinks(row.value);
  const filtered = removeMenuLinkByHref(links, '/admin');
  if (filtered.length !== links.length) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(filtered, null, 2), 'menu_links');
  }
}

function canSeeMenuLink(user, link) {
  if (!link.roles.length) return true;
  if (user.is_admin) return true;
  return link.roles.some((role) => user.roles.includes(role));
}

function filterVisibleMenuLinks(links, user) {
  return links
    .map((link) => {
      if (Array.isArray(link.children) && link.children.length) {
        const children = filterVisibleMenuLinks(link.children, user);
        if (!children.length) return null;
        return { ...link, children };
      }
      return canSeeMenuLink(user, link) ? link : null;
    })
    .filter(Boolean);
}

function removeMenuLinkByHref(links, href) {
  return links
    .map((link) => {
      if (Array.isArray(link.children) && link.children.length) {
        const children = removeMenuLinkByHref(link.children, href);
        if (!children.length) return null;
        return { ...link, children };
      }
      return link.href === href ? null : link;
    })
    .filter(Boolean);
}

function sidebarContainsActive(items, activeSlug) {
  return items.some((item) => {
    if (typeof item === 'string') return item === activeSlug;
    if (item.slug === activeSlug) return true;
    return sidebarContainsActive(item.items || [], activeSlug);
  });
}

function findBreadcrumbs(items, activeSlug, trail = []) {
  for (const item of items) {
    if (typeof item === 'string') {
      const policy = catalog.bySlug.get(item);
      if (item === activeSlug && policy) return [...trail, { label: policy.title, href: `/policy/${encodeURIComponent(policy.slug)}` }];
      continue;
    }

    const categoryPolicy = item.slug ? catalog.bySlug.get(item.slug) : null;
    const nextTrail = categoryPolicy
      ? [...trail, { label: item.label || categoryPolicy.title, href: `/policy/${encodeURIComponent(categoryPolicy.slug)}` }]
      : [...trail, { label: item.label || 'Category', href: '#' }];
    if (item.slug === activeSlug) return nextTrail;
    const found = findBreadcrumbs(item.items || [], activeSlug, nextTrail);
    if (found.length) return found;
  }
  return [];
}

function setUserRoles(userId, roleNames) {
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
  for (const roleName of roleNames) {
    const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
    if (role) db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, role.id);
  }
}

function normalizeUserRoles(roleNames, isAdmin) {
  const names = Array.from(new Set(roleNames.map(String).map((item) => item.trim()).filter(Boolean)));
  if (isAdmin && !names.includes('Admins')) names.push('Admins');
  if (!isAdmin && names.length === 0) names.push('Users');
  return names;
}

function getCurrentUser(req) {
  const token = getCookie(req, COOKIE_NAME);
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), Date.now());
  if (!session) return null;
  const user = db.prepare('SELECT id, email, name, provider, is_admin, active, language FROM users WHERE id = ? AND active = 1').get(session.user_id);
  if (!user) return null;
  user.is_admin = Boolean(user.is_admin);
  user.roles = db.prepare(`
    SELECT r.name FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?
  `).all(user.id).map((role) => role.name);
  return user;
}

function getCurrentUserFromId(id) {
  const user = db.prepare('SELECT id, email, name, provider, is_admin, active, language FROM users WHERE id = ? AND active = 1').get(id);
  if (!user) return null;
  user.is_admin = Boolean(user.is_admin);
  user.roles = db.prepare(`
    SELECT r.name FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?
  `).all(user.id).map((role) => role.name);
  return user;
}

function canReadPolicy(user, policy) {
  if (user.is_admin) return true;
  if (!policy.roles.length) return true;
  return policy.roles.some((role) => user.roles.includes(role));
}

function canManageCms(user) {
  return Boolean(user?.is_admin || user?.roles?.includes('CMS-Editor'));
}

function canReadCmsPage(user, page) {
  if (user?.is_admin) return true;
  if (!page.roles.length) return true;
  return page.roles.some((role) => user.roles.includes(role));
}

function requireAdmin(user, res, callback) {
  if (!user?.is_admin) return sendJson(res, 403, { error: 'Admin permissions required.' });
  return callback();
}

function requireCmsEditor(user, res, callback) {
  if (!canManageCms(user)) return sendJson(res, 403, { error: 'CMS editor permissions required.' });
  return callback();
}

function getCategoryDirFromPolicySlug(slug) {
  const value = String(slug || '').trim();
  if (!value || value === '__home') return '';
  const parts = value.split('/').filter(Boolean);
  if (parts.length === 1) return '';
  return parts.slice(0, -1).join('/');
}

function getEditablePage(slug) {
  if (slug === '__home') {
    if (!existsSync(HOME_PATH)) return null;
    const raw = readFileSync(HOME_PATH, 'utf8');
    const parsed = parseFrontmatter(raw);
    return {
      slug,
      title: 'Home',
      relativePath: 'home.md',
      filePath: HOME_PATH,
      raw,
      markdown: parsed.markdown,
      meta: extractEditablePageMeta(parsed.meta),
      extraMeta: extractExtraPageMeta(parsed.meta)
    };
  }

  const policy = catalog.bySlug.get(slug);
  if (!policy?.file || !existsSync(policy.file)) return null;
  const raw = readFileSync(policy.file, 'utf8');
  const parsed = parseFrontmatter(raw);
  return {
    slug,
    title: policy.title,
    relativePath: toContentRelativePath(policy.file),
    filePath: policy.file,
    raw,
    markdown: parsed.markdown,
    meta: extractEditablePageMeta(parsed.meta),
    extraMeta: extractExtraPageMeta(parsed.meta)
  };
}

function readCategoryMeta(relativeDir) {
  const filePath = resolveDocsPath(relativeDir ? `${relativeDir}/category.json` : 'category.json');
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    logWarn(`Invalid category file ignored for ${relativeDir || '.'}`, error instanceof Error ? error.message : String(error));
    return {};
  }
}

function writeCategoryMeta(relativeDir, meta) {
  const directoryPath = resolveDocsDirectory(relativeDir);
  if (!existsSync(directoryPath)) mkdirSync(directoryPath, { recursive: true });
  const filePath = resolveDocsPath(relativeDir ? `${relativeDir}/category.json` : 'category.json');
  const payload = {
    label: String(meta.label || '').trim(),
    position: Number.isFinite(Number(meta.position)) ? Number(meta.position) : 999,
    roles: Array.isArray(meta.roles) ? meta.roles : []
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sanitizeRelativeDir(value = '') {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => sanitizeSlugSegment(part))
    .filter(Boolean)
    .join('/');
  return normalized;
}

function sanitizeSlugSegment(value = '') {
  return slugify(String(value || '').trim());
}

function normalizeRoleList(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\n]/);
  return Array.from(new Set(items.map((item) => String(item).trim()).filter(Boolean)));
}

function ensureTrailingNewline(value = '') {
  const normalized = String(value || '').replace(/\r\n/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function resolveDocsDirectory(relativeDir = '') {
  const fullPath = normalize(join(DOCS_DIR, relativeDir || '.'));
  if (!fullPath.startsWith(DOCS_DIR)) throw new Error('Invalid docs directory.');
  return fullPath;
}

function resolveDocsPath(relativePath = '') {
  const fullPath = normalize(join(DOCS_DIR, relativePath || '.'));
  if (!fullPath.startsWith(DOCS_DIR)) throw new Error('Invalid docs path.');
  return fullPath;
}

function toContentRelativePath(filePath) {
  return normalize(filePath).slice(CONTENT_DIR.length + 1).replace(/\\/g, '/');
}

function extractEditablePageMeta(meta = {}) {
  return {
    title: String(meta.title || '').trim(),
    description: String(meta.description || '').trim(),
    owner: String(meta.owner || '').trim(),
    version: String(meta.version || '').trim(),
    reviewDate: String(meta.reviewDate || '').trim(),
    roles: Array.isArray(meta.roles) ? meta.roles : [],
    position: Number(meta.position ?? meta.sidebar_position ?? 999)
  };
}

function extractExtraPageMeta(meta = {}) {
  const known = new Set(['title', 'description', 'owner', 'version', 'reviewDate', 'roles', 'position', 'sidebar_position']);
  return Object.fromEntries(Object.entries(meta).filter(([key]) => !known.has(key)));
}

function normalizeEditablePageMeta(payload = {}) {
  const positionValue = Number(payload.position ?? 999);
  return {
    title: String(payload.title || '').trim(),
    description: String(payload.description || '').trim(),
    owner: String(payload.owner || '').trim(),
    version: String(payload.version || '').trim(),
    reviewDate: String(payload.reviewDate || '').trim(),
    roles: normalizeRoleList(payload.roles),
    position: Number.isFinite(positionValue) ? positionValue : 999
  };
}

function normalizeExtraMeta(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function serializeEditablePage({ meta, extraMeta = {}, markdown = '' }) {
  const merged = { ...extraMeta };
  if (meta.title) merged.title = meta.title;
  if (meta.description) merged.description = meta.description;
  if (meta.owner) merged.owner = meta.owner;
  if (meta.version) merged.version = meta.version;
  if (meta.reviewDate) merged.reviewDate = meta.reviewDate;
  merged.roles = Array.isArray(meta.roles) ? meta.roles : [];
  merged.position = Number.isFinite(Number(meta.position)) ? Number(meta.position) : 999;

  const lines = ['---'];
  for (const [key, value] of Object.entries(merged)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((item) => String(item).trim()).filter(Boolean).join(', ')}]`);
      continue;
    }
    lines.push(`${key}: ${String(value ?? '').trim()}`);
  }
  lines.push('---', '', String(markdown || '').replace(/\r\n/g, '\n').replace(/^\n+/, ''));
  return lines.join('\n');
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function createSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 1000 * 60 * 60 * 12;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expiresAt);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

async function readJson(req) {
  return JSON.parse(await readBody(req) || '{}');
}

function serveAsset(res, pathname) {
  const rel = pathname.replace('/assets/', '');
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return sendText(res, 404, 'Not found');
  const extension = extname(file).toLowerCase();
  const type = ({
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.json': 'application/json'
  })[extension] || 'application/octet-stream';
  const isTextLike = type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml';
  res.writeHead(200, {
    'content-type': isTextLike ? `${type}; charset=utf-8` : type,
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache'
  });
  res.end(readFileSync(file));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function errorPage(message, href = '/', locale = 'de') {
  return `<main class="error-page"><h1>${escapeHtml(message)}</h1><a class="button primary" href="${href}">${t(locale, 'back')}</a></main>`;
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, roles: user.roles, is_admin: user.is_admin, language: user.language || '' };
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeAttribute(value = '') {
  return String(value).replace(/['"\\\n\r]/g, '');
}

function sanitizeColor(value = '', fallback = DEFAULT_SETTINGS.light_theme_color) {
  return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : fallback;
}

function sanitizeOpacity(value = '', fallback = '0.82') {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return String(Math.min(1, Math.max(0.3, number)));
}

function hexToRgba(hex, alpha) {
  const color = sanitizeColor(hex, '#000000').slice(1);
  const r = Number.parseInt(color.slice(0, 2), 16);
  const g = Number.parseInt(color.slice(2, 4), 16);
  const b = Number.parseInt(color.slice(4, 6), 16);
  const a = Math.min(1, Math.max(0, Number(alpha) || 0));
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

function sanitizeDataImage(value = '') {
  const text = String(value || '');
  if (!text) return '';
  return /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(text) ? text : '';
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function stripHtml(value = '') {
  return String(value).replace(/<[^>]*>/g, '');
}

function assetUrl(file) {
  const assetPath = join(PUBLIC_DIR, file);
  const version = existsSync(assetPath) ? statSync(assetPath).mtimeMs.toString(36) : PACKAGE_JSON.version;
  return `/assets/${file}?v=${encodeURIComponent(version)}`;
}

function pluginAssetUrl(pluginKey, file) {
  const plugin = loadedPlugins.find((item) => item.key === pluginKey);
  const assetPath = plugin ? join(plugin.publicDir, file) : '';
  const version = assetPath && existsSync(assetPath) ? statSync(assetPath).mtimeMs.toString(36) : PACKAGE_JSON.version;
  return `/assets/plugins/${encodeURIComponent(pluginKey)}/${encodeURIComponent(file)}?v=${encodeURIComponent(version)}`;
}

function servePluginAsset(res, pathname) {
  const relative = pathname.slice('/assets/plugins/'.length);
  const [pluginKey, ...rest] = relative.split('/').map((part) => decodeURIComponent(part));
  const plugin = loadedPlugins.find((item) => item.key === pluginKey);
  if (!plugin || !rest.length) return sendText(res, 404, 'Not found');
  const filePath = normalize(join(plugin.publicDir, rest.join('/')));
  if (!filePath.startsWith(plugin.publicDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) return sendText(res, 404, 'Not found');
  res.writeHead(200, { 'content-type': mimeForPath(filePath) });
  res.end(readFileSync(filePath));
}

function mimeForPath(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function buildPluginContext(extra = {}) {
  const pluginKey = extra.plugin?.key || '';
  const pluginT = (locale, key) => {
    if (!pluginKey) return t(locale, key);
    const pluginValue = tp(pluginKey, locale, key);
    return pluginValue === key ? t(locale, key) : pluginValue;
  };
  const pluginTf = (locale, key, fallback) => {
    const value = pluginT(locale, key);
    return value === key ? fallback : value;
  };
  return {
    db,
    ROOT,
    DATA_DIR,
    normalize,
    existsSync,
    readFileSync,
    writeFileSync,
    unlinkSync,
    mkdirSync,
    statSync,
    join,
    sendJson,
    sendHtml,
    sendText,
    readJson,
    readBody,
    redirect,
    requireAdmin,
    requirePlugin,
    listRoles,
    listUsers,
    listPlugins,
    isPluginEnabled,
    getSettings,
    resolveLocale,
    renderShell,
    renderTopbar,
    renderAdminTabsNav,
    renderFooter,
    renderFeatureHub,
    renderToc,
    escapeHtml,
    escapeAttribute,
    tf: pluginTf,
    t: pluginT,
    tp,
    tpf,
    getPluginFeatureCopy,
    assetUrl,
    pluginAssetUrl,
    slugify,
    titleFromSlug,
    normalizeRoleList,
    parseJsonObject,
    parseFrontmatter,
    markdownToHtml,
    formatDisplayDate,
    getCurrentUser,
    publicUser,
    logInfo,
    logWarn,
    logError,
    ensureColumn,
    ensureTrailingNewline,
    ...extra
  };
}

async function handlePluginRequest({ req, res, url, user, locale, settings }) {
  for (const plugin of loadedPlugins) {
    try {
      const handled = await plugin.handleRequest?.(buildPluginContext({ req, res, url, user, locale, settings, plugin }));
      if (handled) return true;
    } catch (error) {
      logError(`Plugin request failed for ${plugin.key}`, error);
      sendHtml(res, 500, renderShell({ title: 'Error', body: errorPage('An unexpected error occurred.') }));
      return true;
    }
  }
  return false;
}

function inlineScriptTag(file) {
  const assetPath = join(PUBLIC_DIR, file);
  if (!existsSync(assetPath)) return '';
  const script = readFileSync(assetPath, 'utf8')
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');
  return `<script>${script}</script>`;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9äöüß]+/gi, '-').replace(/^-|-$/g, '');
}

function titleFromSlug(slug) {
  return slug.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function formatDisplayDate(value, locale = 'en') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

