import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTENT_DIR = join(ROOT, 'content');
const LOCALES_DIR = join(ROOT, 'locales');
const DOCS_DIR = join(CONTENT_DIR, 'docs');
const HOME_PATH = join(CONTENT_DIR, 'home.md');
const POLICY_DIR = join(CONTENT_DIR, 'policies');
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? normalize(process.env.DATA_DIR) : join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'data.sqlite');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE_NAME = 'atlas_session';
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const LOCALES = loadLocales();
const FONT_FAMILIES = {
  manrope: '"Manrope", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  jakarta: '"Plus Jakarta Sans", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  inter: '"Inter", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  plex: '"IBM Plex Sans", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  serif: '"Source Serif 4", Georgia, serif'
};

const DEFAULT_ROLES = [
  ['Admins', 'Full administration access for Atlas.', '#b45309'],
  ['Users', 'Standard access to shared Atlas documentation.', '#2368c4']
];

const DEFAULT_SETTINGS = {
  app_name: 'Atlas',
  sidebar_title: 'Atlas Docs',
  logo_text: 'AT',
  logo_image: '',
  default_language: 'en',
  default_theme: 'light',
  theme_color: '#2368c4',
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
    { label: 'Documentation', href: '/', roles: [] }
  ])
};

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

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
initializeDatabase();

let catalog = loadCatalog();

if (process.argv.includes('--check')) {
  logInfo(`Catalog check completed: loaded ${catalog.policies.length} documents.`);
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

  if (url.pathname.startsWith('/assets/')) return serveAsset(res, url.pathname);
  if (url.pathname === '/login') return sendHtml(res, 200, renderLogin(req, user, locale));
  if (url.pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res, locale);
  if (url.pathname === '/api/logout' && req.method === 'POST') return handleLogout(req, res);
  if (url.pathname === '/auth/entra/start') return handleEntraStart(req, res);
  if (url.pathname === '/auth/entra/callback') return handleEntraCallback(req, res, url);

  if (!user) return redirect(res, '/login');

  if (url.pathname === '/api/me') return sendJson(res, 200, publicUser(user));
  if (url.pathname === '/api/profile' && req.method === 'GET') return sendJson(res, 200, publicUser(user));
  if (url.pathname === '/api/profile' && req.method === 'POST') return handleUpdateProfile(req, res, user);
  if (url.pathname === '/api/admin/users' && req.method === 'GET') return requireAdmin(user, res, () => sendJson(res, 200, listUsers()));
  if (url.pathname === '/api/admin/users' && req.method === 'POST') return requireAdmin(user, res, () => handleUpsertUser(req, res));
  if (url.pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') return requireAdmin(user, res, () => handleDeleteUser(res, url.pathname));
  if (url.pathname === '/api/admin/roles' && req.method === 'GET') return requireAdmin(user, res, () => sendJson(res, 200, listRoles()));
  if (url.pathname === '/api/admin/roles' && req.method === 'POST') return requireAdmin(user, res, () => handleUpsertRole(req, res));
  if (url.pathname.startsWith('/api/admin/roles/') && req.method === 'DELETE') return requireAdmin(user, res, () => handleDeleteRole(res, url.pathname));
  if (url.pathname === '/api/admin/settings' && req.method === 'GET') return requireAdmin(user, res, () => sendJson(res, 200, getSettings()));
  if (url.pathname === '/api/admin/settings' && req.method === 'POST') return requireAdmin(user, res, () => handleUpdateSettings(req, res));
  if (url.pathname === '/api/admin/reset' && req.method === 'POST') return requireAdmin(user, res, () => handleFactoryReset(req, res));
  if (url.pathname === '/api/admin/reload' && req.method === 'POST') return requireAdmin(user, res, () => {
    logInfo(`Admin content reload requested by ${user.email}`);
    catalog = loadCatalog();
    logInfo(`Admin content reload completed: ${catalog.policies.length} documents loaded`);
    sendJson(res, 200, { ok: true, policies: catalog.policies.length });
  });

  if (url.pathname === '/') return sendHtml(res, 200, renderApp({ user, activeSlug: null, locale }));
  if (url.pathname === '/admin') return requireAdmin(user, res, () => sendHtml(res, 200, renderAdmin(user, locale)));
  if (url.pathname.startsWith('/policy/')) {
    const slug = decodeURIComponent(url.pathname.slice('/policy/'.length));
    const policy = catalog.bySlug.get(slug);
    if (!policy) return sendHtml(res, 404, renderApp({ user, activeSlug: null, notice: t(locale, 'notFoundPolicy'), locale }));
    if (!canReadPolicy(user, policy)) return sendHtml(res, 403, renderApp({ user, activeSlug: null, notice: t(locale, 'noPermission'), locale }));
    return sendHtml(res, 200, renderApp({ user, activeSlug: slug, policy, locale }));
  }

  sendHtml(res, 404, renderApp({ user, activeSlug: null, notice: t(locale, 'notFoundPage'), locale }));
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
  `);

  ensureColumn('roles', 'color', "TEXT NOT NULL DEFAULT '#5d6b82'");
  ensureColumn('users', 'language', 'TEXT');

  seedFactoryData();
  logInfo('Database initialization completed');
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

  migrateLegacySettings();
  removeAdminFromDefaultMenuLinks();
  ensureFactoryAdminUser();
  ensureDefaultRoleCoverage();
}

function migrateLegacyRoles() {
  const roleRows = db.prepare('SELECT id, name FROM roles').all();
  const adminsRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('Admins')?.id;
  const usersRoleId = db.prepare('SELECT id FROM roles WHERE name = ?').get('Users')?.id;
  const adminAliases = new Set(['admin', 'isms-admin']);
  const userAliases = new Set(['employee', 'it', 'auditor']);

  for (const role of roleRows) {
    if (role.name === 'Admins' || role.name === 'Users') continue;

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
      DELETE FROM sqlite_sequence WHERE name IN ('users', 'roles');
    `);
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

  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
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
    if (!line.trim()) {
      closeList();
      continue;
    }
    if (/^\s*<\/?[a-z][\s\S]*>\s*$/i.test(line)) {
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
  return { html, headings };
}

function inlineMarkdown(text, baseSlug = '') {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const resolved = resolveMarkdownHref(href, baseSlug);
      const external = /^(https?:|mailto:|tel:)/i.test(resolved);
      const attrs = external ? ' target="_blank" rel="noreferrer"' : '';
      return `<a href="${escapeAttribute(resolved)}"${attrs}>${label}</a>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
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
      ${renderTopbar(user, locale)}
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
          ${current ? renderPolicy(current, locale) : renderEmptyState(locale)}
        </main>
      </div>
      ${renderFooter(settings)}
    </div>
  `;
  return renderShell({ title: current?.title || settings.app_name, body, settings, locale });
}

function renderTopbar(user, locale) {
  const settings = getSettings();
  const links = parseMenuLinks(settings.menu_links).filter((link) => canSeeMenuLink(user, link));
  return `
    <header class="topbar">
      <div class="brand">
        <button class="icon-button mobile-only" data-sidebar-open aria-label="Open navigation">☰</button>
        <a href="/" class="brand-mark">${settings.logo_image ? `<img src="${escapeAttribute(settings.logo_image)}" alt="">` : escapeHtml(settings.logo_text)}</a>
        <a href="/" class="brand-title">${escapeHtml(settings.app_name)}</a>
      </div>
      <nav class="top-links">${links.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join('')}</nav>
      <div class="top-actions">
        ${user.is_admin ? `<a class="button ghost" href="/admin">${t(locale, 'admin')}</a>` : ''}
        <button class="theme-toggle" type="button" data-theme-toggle aria-label="Toggle theme"><span></span></button>
        <button class="button user-menu-trigger" type="button" data-profile-open>👤 ${escapeHtml(user.name)}</button>
        <form action="/api/logout" method="post"><button class="button" type="submit">${t(locale, 'logout')}</button></form>
      </div>
    </header>
    ${renderProfileDialog(user, locale)}
  `;
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

function renderProfileDialog(user, locale) {
  return `
    <div class="profile-popover" data-profile-popover hidden>
      <form class="profile-form" data-profile-form>
        <h2>${t(locale, 'profileTitle')}</h2>
        <label>${t(locale, 'name')} <input name="name" value="${escapeHtml(user.name)}" required></label>
        <label>${t(locale, 'email')} <input name="email" type="email" value="${escapeHtml(user.email)}" required></label>
        <label>${t(locale, 'language')} ${renderLanguageSelect(user.language || '', locale)}</label>
        <div class="profile-roles">
          <span>${t(locale, 'groups')}</span>
          <div>${renderRolePills(user.roles) || `<span class="hint">${t(locale, 'noGroups')}</span>`}</div>
        </div>
        <button class="button" type="button" data-password-open>${t(locale, 'changePassword')}</button>
        <div class="modal-actions"><button class="button" type="button" data-profile-close>${t(locale, 'close')}</button><button class="button primary" type="submit">${t(locale, 'save')}</button></div>
      </form>
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

function renderPolicy(policy, locale) {
  const breadcrumbs = findBreadcrumbs(catalog.sidebar, policy.slug);
  return `
    <article class="policy">
      ${renderBreadcrumbs(breadcrumbs, policy)}
      <div class="policy-header">
        <div>
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
      ${renderTopbar(user, locale)}
      <main class="admin-page">
        <div class="admin-header">
          <div>
            <p class="eyebrow">${t(locale, 'administration')}</p>
            <h1>${t(locale, 'adminPortal')}</h1>
          </div>
          <button class="button primary" data-reload-content type="button">${t(locale, 'reloadMarkdown')}</button>
        </div>
        <div id="adminError" class="notice admin-error" hidden></div>
        <section class="admin-grid">
          <div class="panel">
            <div class="panel-head">
              <h2>${t(locale, 'users')}</h2>
              <button class="button" data-new-user type="button">${t(locale, 'createUser')}</button>
            </div>
            <div id="usersTable" class="table-wrap"></div>
          </div>
          <div class="panel">
            <div class="panel-head">
              <h2>${t(locale, 'roles')}</h2>
              <button class="button" data-new-role type="button">${t(locale, 'createRole')}</button>
            </div>
            <div id="rolesTable" class="table-wrap"></div>
          </div>
          <div class="panel settings-panel">
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
              <label>${t(locale, 'themeColor')} <input name="theme_color" type="color" value="${escapeHtml(settings.theme_color)}"></label>
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
          <div class="panel danger-panel">
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

function renderShell({ title, body, admin = false, settings = getSettings(), locale = 'en' }) {
  const themeColor = sanitizeColor(settings.theme_color);
  const fontScale = Math.min(1.25, Math.max(0.9, Number(settings.font_scale) || 1));
  const fontFamily = FONT_FAMILIES[normalizeFontFamily(settings.font_family)];
  const cssUrl = assetUrl('app.css');
  const appJsUrl = assetUrl('app.js');
  const adminScript = admin ? inlineScriptTag('admin.js') : '';
  return `<!doctype html>
    <html lang="${escapeHtml(locale)}">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(title)} · ${escapeHtml(settings.app_name)}</title>
        <link rel="stylesheet" href="${cssUrl}">
        <script id="portal-i18n" type="application/json">${JSON.stringify(getClientI18n(locale)).replace(/</g, '\\u003c')}</script>
        <script defer src="${appJsUrl}"></script>
        ${adminScript}
      </head>
      <body data-default-theme="${escapeHtml(settings.default_theme)}" style="--primary: ${themeColor}; --font-scale: ${fontScale}; --app-font: ${escapeHtml(fontFamily)};">${body}</body>
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
  catalog = loadCatalog();
  logInfo(`Factory reset reloaded catalog with ${catalog.policies.length} documents`);
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
    theme_color: sanitizeColor(payload.theme_color || DEFAULT_SETTINGS.theme_color),
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

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) settings[row.key] = row.value;
  settings.theme_color = sanitizeColor(settings.theme_color);
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

function parseMenuLinks(value) {
  try {
    const links = JSON.parse(value);
    if (!Array.isArray(links)) return [];
    return links
      .map((link) => ({
        label: String(link.label || '').trim(),
        href: String(link.href || '#').trim(),
        roles: Array.isArray(link.roles) ? link.roles.map(String) : []
      }))
      .filter((link) => link.label && link.href);
  } catch {
    return [];
  }
}

function normalizeMenuLinks(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || []);
  return JSON.stringify(parseMenuLinks(text), null, 2);
}

function loadLocales() {
  const fallback = {
    en: {
      code: 'en',
      flag: 'EN',
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
    } catch {
      // Invalid locale files should not prevent the portal from starting.
    }
  }
  return Object.keys(locales).length ? locales : fallback;
}

function getAvailableLanguages() {
  return Object.values(LOCALES).sort((a, b) => a.nativeName.localeCompare(b.nativeName));
}

function isSupportedLocale(code) {
  return Boolean(code && LOCALES[String(code).toLowerCase()]);
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
  const active = LOCALES[locale]?.ui || {};
  const fallback = LOCALES[DEFAULT_SETTINGS.default_language]?.ui || LOCALES.en?.ui || {};
  return active[key] || fallback[key] || key;
}

function getClientI18n(locale) {
  return {
    locale,
    languages: getAvailableLanguages().map((item) => ({
      code: item.code,
      flag: item.flag,
      nativeName: item.nativeName
    })),
    messages: {
      ...(LOCALES[DEFAULT_SETTINGS.default_language]?.ui || LOCALES.en?.ui || {}),
      ...(LOCALES[locale]?.ui || {})
    }
  };
}

function renderLanguageSelect(selected, locale, name = 'language') {
  const current = isSupportedLocale(selected) ? String(selected).toLowerCase() : locale;
  return `
    <select name="${escapeAttribute(name)}" class="language-select">
      ${getAvailableLanguages().map((language) => `
        <option value="${escapeHtml(language.code)}" ${language.code === current ? 'selected' : ''}>
          ${escapeHtml(language.flag)} ${escapeHtml(language.nativeName)}
        </option>
      `).join('')}
    </select>
  `;
}

function removeAdminFromDefaultMenuLinks() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('menu_links');
  if (!row) return;
  const links = parseMenuLinks(row.value);
  const filtered = links.filter((link) => link.href !== '/admin');
  if (filtered.length !== links.length) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(filtered, null, 2), 'menu_links');
  }
}

function canSeeMenuLink(user, link) {
  if (!link.roles.length) return true;
  if (user.is_admin) return true;
  return link.roles.some((role) => user.roles.includes(role));
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

function requireAdmin(user, res, callback) {
  if (!user?.is_admin) return sendJson(res, 403, { error: 'Admin permissions required.' });
  return callback();
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
  const type = extname(file) === '.css' ? 'text/css' : 'text/javascript';
  res.writeHead(200, {
    'content-type': `${type}; charset=utf-8`,
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

function sanitizeColor(value = '') {
  return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : DEFAULT_SETTINGS.theme_color;
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
