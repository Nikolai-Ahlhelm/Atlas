import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';

export default function createDownloadCenterPlugin({ manifest, rootDir }) {
  const feature = {
    key: manifest.key || 'download_center',
    label: manifest.name || 'Download Center',
    href: '/downloads',
    description: manifest.description || 'Permission-based file explorer with tags, descriptions and browser-based editing.',
    defaultEnabled: true
  };

  let db = null;
  let helpers = null;

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    adminPage: {
      href: '/admin/downloads',
      label: manifest.name || 'Download Center'
    },
    init(context) {
      db = context.db;
      helpers = context;
      db.exec(`
        CREATE TABLE IF NOT EXISTS download_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          relative_dir TEXT NOT NULL DEFAULT '',
          storage_name TEXT NOT NULL,
          storage_path TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          tags_json TEXT NOT NULL DEFAULT '[]',
          mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          encoding TEXT NOT NULL DEFAULT 'binary',
          file_size INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS download_file_roles (
          file_id INTEGER NOT NULL REFERENCES download_files(id) ON DELETE CASCADE,
          role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          PRIMARY KEY (file_id, role_id)
        );
      `);
    },
    resetToFactoryDefaults(context) {
      const rows = context.db.prepare('SELECT storage_path FROM download_files').all();
      for (const row of rows) {
        if (row?.storage_path && context.existsSync(row.storage_path)) {
          context.unlinkSync(row.storage_path);
        }
      }
      context.db.exec(`
        DELETE FROM download_file_roles;
        DELETE FROM download_files;
        DELETE FROM sqlite_sequence WHERE name IN ('download_files');
      `);
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/downloads/tree' && req.method === 'GET') {
        context.requireAdmin(user, res, () => context.sendJson(res, 200, getDownloadAdminTree()));
        return true;
      }
      if (url.pathname === '/api/admin/downloads/file' && req.method === 'GET') {
        context.requireAdmin(user, res, () => handleGetDownloadFile(context, true));
        return true;
      }
      if (url.pathname === '/api/admin/downloads/file' && req.method === 'POST') {
        context.requireAdmin(user, res, async () => handleSaveDownloadFile(context));
        return true;
      }
      if (url.pathname.startsWith('/api/admin/downloads/file/') && req.method === 'DELETE') {
        context.requireAdmin(user, res, () => handleDeleteDownloadFile(context));
        return true;
      }

      if (url.pathname === '/api/downloads/tree') {
        context.requirePlugin(feature.key, res, () => context.sendJson(res, 200, getDownloadTreeForUser(user)));
        return true;
      }
      if (url.pathname === '/api/downloads/file' && req.method === 'GET') {
        context.requirePlugin(feature.key, res, () => handleGetDownloadFile(context, false));
        return true;
      }
      if (url.pathname.startsWith('/download/')) {
        context.requirePlugin(feature.key, res, () => handleDownloadAsset(context));
        return true;
      }

      if (url.pathname === '/downloads') {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: 'The download center is currently disabled.' }));
          return true;
        }
        context.sendHtml(res, 200, renderDownloadsPage(context));
        return true;
      }

      if (url.pathname === '/admin/downloads') {
        context.requireAdmin(user, res, () => context.sendHtml(res, 200, renderDownloadsAdminPage(context)));
        return true;
      }

      return false;
    }
  };

  function downloadsDir() {
    return join(helpers.DATA_DIR, 'downloads');
  }

  function createStoredDownloadName(fileName) {
    const safeName = sanitizeFileName(fileName) || 'file';
    return `${Date.now()}-${randomBytes(6).toString('hex')}-${safeName}`;
  }

  function getDownloadStoragePath(storageName) {
    const target = normalize(join(downloadsDir(), storageName));
    if (!target.startsWith(downloadsDir())) throw new Error('Invalid download storage path.');
    return target;
  }

  function inferMimeType(fileName, fallback = 'application/octet-stream') {
    const extension = extname(String(fileName || '')).toLowerCase();
    return ({
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.markdown': 'text/markdown',
      '.json': 'application/json',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.cjs': 'text/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.xml': 'application/xml',
      '.csv': 'text/csv',
      '.tsv': 'text/tab-separated-values',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.zip': 'application/zip',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    })[extension] || fallback;
  }

  function isTextLikeFile(fileName = '', mimeType = '') {
    const extension = extname(String(fileName || '')).toLowerCase();
    if (String(mimeType || '').startsWith('text/')) return true;
    return ['.md', '.markdown', '.txt', '.json', '.js', '.mjs', '.cjs', '.css', '.html', '.xml', '.csv', '.tsv', '.svg'].includes(extension);
  }

  function parseTagsJson(value = '[]') {
    try {
      const tags = JSON.parse(value);
      return Array.isArray(tags) ? tags.map(String).map((item) => item.trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function normalizeDownloadRecord(row) {
    const roles = db.prepare(`
      SELECT r.name FROM roles r
      JOIN download_file_roles dfr ON dfr.role_id = r.id
      WHERE dfr.file_id = ?
      ORDER BY r.name
    `).all(row.id).map((item) => item.name);
    return {
      id: row.id,
      name: row.name,
      relativeDir: row.relative_dir || '',
      relativePath: row.relative_dir ? `${row.relative_dir}/${row.name}` : row.name,
      description: row.description || '',
      tags: parseTagsJson(row.tags_json),
      roles,
      mimeType: row.mime_type || inferMimeType(row.name),
      encoding: row.encoding || 'binary',
      fileSize: Number(row.file_size || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isText: row.encoding === 'text' || isTextLikeFile(row.name, row.mime_type),
      downloadHref: `/download/${row.id}`
    };
  }

  function listDownloadFiles() {
    return db.prepare('SELECT * FROM download_files ORDER BY relative_dir, name').all().map(normalizeDownloadRecord);
  }

  function canReadDownloadFile(user, file) {
    if (user?.is_admin) return true;
    if (!file.roles.length) return true;
    return file.roles.some((role) => user.roles.includes(role));
  }

  function buildDownloadTree(files) {
    const root = [];
    const groups = new Map();

    const ensureGroup = (relativeDir) => {
      const key = String(relativeDir || '');
      if (groups.has(key)) return groups.get(key);
      const node = { type: 'directory', relativeDir: key, label: key.split('/').pop() || 'Root', children: [] };
      groups.set(key, node);
      if (!key) {
        root.push(node);
        return node;
      }
      const parentDir = key.includes('/') ? key.split('/').slice(0, -1).join('/') : '';
      const parent = ensureGroup(parentDir);
      parent.children.push(node);
      parent.children.sort((a, b) => a.label.localeCompare(b.label, 'de'));
      return node;
    };

    for (const file of files) {
      const relativeDir = String(file.relativeDir || '');
      if (!relativeDir) {
        root.push({ ...file, type: 'file' });
        continue;
      }
      ensureGroup(relativeDir).children.push({ ...file, type: 'file' });
    }

    const sortNodes = (nodes) => {
      nodes.sort((a, b) => {
        if (a.type === b.type) return String(a.label || a.name).localeCompare(String(b.label || b.name), 'de');
        return a.type === 'directory' ? -1 : 1;
      });
      nodes.filter((node) => node.type === 'directory').forEach((node) => sortNodes(node.children));
    };
    sortNodes(root);
    return root;
  }

  function listDirectorySuggestions(files) {
    const dirs = Array.from(new Set(files.map((file) => file.relativeDir).filter((dir) => dir !== undefined)))
      .sort((a, b) => String(a).localeCompare(String(b), 'de'));
    return dirs.map((relativeDir) => ({ relativeDir: relativeDir || '', label: relativeDir || 'Root' }));
  }

  function getDownloadAdminTree() {
    const files = listDownloadFiles();
    return { tree: buildDownloadTree(files), directories: listDirectorySuggestions(files) };
  }

  function getDownloadTreeForUser(user) {
    const files = listDownloadFiles().filter((file) => canReadDownloadFile(user, file));
    return { tree: buildDownloadTree(files) };
  }

  function getDownloadFileById(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const row = db.prepare('SELECT * FROM download_files WHERE id = ?').get(numericId);
    return row ? normalizeDownloadRecord(row) : null;
  }

  function setDownloadFileRoles(fileId, roleNames) {
    db.prepare('DELETE FROM download_file_roles WHERE file_id = ?').run(fileId);
    for (const roleName of roleNames) {
      const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
      if (role) db.prepare('INSERT OR IGNORE INTO download_file_roles (file_id, role_id) VALUES (?, ?)').run(fileId, role.id);
    }
  }

  function getDownloadContent(file) {
    const row = db.prepare('SELECT storage_path FROM download_files WHERE id = ?').get(file.id);
    if (!row?.storage_path || !helpers.existsSync(row.storage_path)) return file.isText ? '' : null;
    return helpers.readFileSync(row.storage_path, file.isText ? 'utf8' : null);
  }

  function handleGetDownloadFile(context, adminMode = false) {
    const file = getDownloadFileById(context.url.searchParams.get('id'));
    if (!file) return context.sendJson(context.res, 404, { error: 'File not found.' });
    if (!adminMode && !canReadDownloadFile(context.user, file)) return context.sendJson(context.res, 403, { error: 'You do not have access to this file.' });
    const content = getDownloadContent(file);
    context.sendJson(context.res, 200, {
      ...file,
      contentText: file.isText && typeof content === 'string' ? content : ''
    });
  }

  async function handleSaveDownloadFile(context) {
    const payload = await context.readJson(context.req);
    const id = payload.id ? Number(payload.id) : null;
    const name = sanitizeFileName(payload.name);
    const relativeDir = sanitizeExplorerDir(payload.relative_dir || payload.relativeDir || '');
    const description = String(payload.description || '').trim();
    const tags = normalizeTagList(payload.tags);
    const roleNames = helpers.normalizeRoleList(payload.roles);
    const mimeType = String(payload.mime_type || payload.mimeType || '').trim() || inferMimeType(name);
    const encoding = payload.encoding === 'binary' ? 'binary' : 'text';
    const base64Content = String(payload.content_base64 || payload.contentBase64 || '').trim();
    const textContent = String(payload.content_text || payload.contentText || '');

    if (!name) return context.sendJson(context.res, 400, { error: 'A file name is required.' });
    if (!helpers.existsSync(downloadsDir())) helpers.mkdirSync(downloadsDir(), { recursive: true });

    const buffer = base64Content
      ? Buffer.from(base64Content, 'base64')
      : encoding === 'binary'
        ? null
        : Buffer.from(textContent, 'utf8');

    if (!id) {
      if (!buffer) return context.sendJson(context.res, 400, { error: 'Please provide file content or upload a file.' });
      const storageName = createStoredDownloadName(name);
      const storagePath = getDownloadStoragePath(storageName);
      helpers.writeFileSync(storagePath, buffer);
      const result = db.prepare(`
        INSERT INTO download_files (name, relative_dir, storage_name, storage_path, description, tags_json, mime_type, encoding, file_size, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(name, relativeDir, storageName, storagePath, description, JSON.stringify(tags), mimeType, encoding, buffer.length);
      setDownloadFileRoles(result.lastInsertRowid, roleNames);
      return context.sendJson(context.res, 200, { ok: true, id: result.lastInsertRowid });
    }

    const current = db.prepare('SELECT * FROM download_files WHERE id = ?').get(id);
    if (!current) return context.sendJson(context.res, 404, { error: 'File not found.' });
    let storagePath = current.storage_path;
    let storageName = current.storage_name;
    let fileSize = Number(current.file_size || 0);
    if (buffer) {
      if (!storagePath) {
        storageName = createStoredDownloadName(name);
        storagePath = getDownloadStoragePath(storageName);
      }
      helpers.writeFileSync(storagePath, buffer);
      fileSize = buffer.length;
    }

    db.prepare(`
      UPDATE download_files
      SET name = ?, relative_dir = ?, storage_name = ?, storage_path = ?, description = ?, tags_json = ?, mime_type = ?, encoding = ?, file_size = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, relativeDir, storageName, storagePath, description, JSON.stringify(tags), mimeType, encoding, fileSize, id);
    setDownloadFileRoles(id, roleNames);
    context.sendJson(context.res, 200, { ok: true, id });
  }

  function handleDeleteDownloadFile(context) {
    const id = Number(context.url.pathname.split('/').pop());
    const row = db.prepare('SELECT storage_path FROM download_files WHERE id = ?').get(id);
    if (!row) return context.sendJson(context.res, 404, { error: 'File not found.' });
    if (row.storage_path && helpers.existsSync(row.storage_path)) helpers.unlinkSync(row.storage_path);
    db.prepare('DELETE FROM download_files WHERE id = ?').run(id);
    context.sendJson(context.res, 200, { ok: true });
  }

  function handleDownloadAsset(context) {
    const id = Number(context.url.pathname.slice('/download/'.length));
    const file = getDownloadFileById(id);
    if (!file) return context.sendText(context.res, 404, 'Not found');
    if (!canReadDownloadFile(context.user, file)) return context.sendText(context.res, 403, 'Forbidden');
    const row = db.prepare('SELECT storage_path FROM download_files WHERE id = ?').get(id);
    if (!row?.storage_path || !helpers.existsSync(row.storage_path)) return context.sendText(context.res, 404, 'Not found');
    context.res.writeHead(200, {
      'content-type': file.mimeType,
      'content-length': helpers.statSync(row.storage_path).size,
      'content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`
    });
    context.res.end(helpers.readFileSync(row.storage_path));
  }

  function renderDownloadsPage(context) {
    const settings = context.getSettings();
    const body = `
      <div class="app-shell downloads-page" data-downloads-app data-is-admin="${context.user.is_admin ? 'true' : 'false'}">
        ${context.renderTopbar(context.user, context.locale, '/downloads')}
        <div class="workspace">
          <aside class="sidebar" id="sidebar">
            <div class="sidebar-head">
              <span>${context.tf(context.locale, 'downloadCenter', 'Download Center')}</span>
              <button class="icon-button mobile-only" data-sidebar-close aria-label="Close navigation">x</button>
            </div>
            <div id="downloadTree" class="doc-nav"></div>
          </aside>
          <main class="content">
            <section class="policy">
              <div class="policy-header">
                <div>
                  <p class="eyebrow">${context.tf(context.locale, 'downloadCenter', 'Download Center')}</p>
                  <h1>${context.tf(context.locale, 'sharedFiles', 'Shared files')}</h1>
                  <p>${context.tf(context.locale, 'sharedFilesText', 'Browse role-based files, inspect descriptions and tags, and download the version that is assigned to you.')}</p>
                </div>
                <dl class="meta-grid">
                  <div><dt>${context.tf(context.locale, 'featureType', 'Feature')}</dt><dd>${context.tf(context.locale, 'fileExplorer', 'File explorer')}</dd></div>
                  <div><dt>${context.tf(context.locale, 'access', 'Access')}</dt><dd>${context.tf(context.locale, 'roleBased', 'Role based')}</dd></div>
                  <div><dt>${context.tf(context.locale, 'management', 'Management')}</dt><dd>${context.user.is_admin ? context.tf(context.locale, 'manageViaAdmin', 'Manageable in admin portal') : context.tf(context.locale, 'readOnly', 'Read only')}</dd></div>
                </dl>
              </div>
              <div class="downloads-layout">
                <div id="downloadExplorerEmpty" class="empty-state">
                  <h1>${context.tf(context.locale, 'loadingFiles', 'Loading files')}</h1>
                  <p>${context.tf(context.locale, 'loadingFilesText', 'The download center is fetching the latest directory tree for you.')}</p>
                </div>
                <div id="downloadFileView" class="panel download-detail-panel" hidden></div>
              </div>
            </section>
          </main>
        </div>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: context.tf(context.locale, 'downloadCenter', 'Download Center'),
      body,
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'downloads.js')]
    });
  }

  function renderDownloadsAdminPage(context) {
    const settings = context.getSettings();
    const body = `
      <div class="app-shell">
        ${context.renderTopbar(context.user, context.locale, '/admin/downloads')}
        <main class="admin-page" data-downloads-admin-page>
          <div class="admin-header">
            <div>
              <h1>${context.escapeHtml(feature.label)}</h1>
              <p class="hint">${context.escapeHtml(feature.description)}</p>
            </div>
            <a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a>
          </div>
          <div id="downloadsAdminError" class="notice admin-error" hidden></div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <section class="admin-grid">
            <div class="panel content-nav-panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'downloadCenter', 'Download Center')}</h2>
                <div class="panel-head-actions">
                  <button class="button" data-new-download type="button">${context.tf(context.locale, 'uploadFile', 'Upload file')}</button>
                </div>
              </div>
              <div id="downloadsTree" class="content-tree"></div>
            </div>
            <div class="panel content-editor-panel download-detail-panel-admin">
              <div class="panel-head">
                <div class="panel-head-actions">
                  <button class="button ghost" id="backToDownloadsListButton" type="button" hidden>${context.tf(context.locale, 'back', 'Back')}</button>
                  <h2 id="downloadEditorTitle">${context.tf(context.locale, 'downloadEditor', 'Download editor')}</h2>
                </div>
                <div class="panel-head-actions">
                  <a class="button ghost" id="openLiveDownloadButton" href="/downloads" hidden>${context.tf(context.locale, 'open', 'Open')} ${context.tf(context.locale, 'downloadCenter', 'Download Center')}</a>
                </div>
              </div>
              <div class="content-editor-body">
                <div id="downloadEditorEmpty" class="empty-state content-empty-state">
                  <h1>${context.tf(context.locale, 'selectDownloadEntry', 'Select a file')}</h1>
                  <p>${context.tf(context.locale, 'selectDownloadEntryText', 'Upload files, assign roles, edit descriptions and update text-based files directly in the browser.')}</p>
                </div>
                <form id="downloadEditorForm" class="modal-form" hidden>
                  <input name="id" type="hidden">
                  <input name="content_base64" type="hidden">
                  <input name="encoding" type="hidden" value="text">
                  <div class="content-meta">
                    <label>${context.tf(context.locale, 'fileName', 'File name')} <input name="name" required></label>
                    <label>${context.tf(context.locale, 'folderPath', 'Folder path')} <input name="relative_dir" placeholder="team/templates"></label>
                    <label>${context.tf(context.locale, 'mimeType', 'MIME type')} <input name="mime_type" placeholder="text/markdown"></label>
                    <label>${context.tf(context.locale, 'rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Admins, Users"></label>
                  </div>
                  <label>${context.tf(context.locale, 'description', 'Description')} <textarea name="description"></textarea></label>
                  <label>${context.tf(context.locale, 'tagsCsv', 'Tags (comma separated)')} <input name="tags" placeholder="template, onboarding"></label>
                  <label>${context.tf(context.locale, 'replaceUpload', 'Replace via upload')} <input name="file_upload" type="file"></label>
                  <label>${context.tf(context.locale, 'textContent', 'Text content')}
                    <textarea name="content_text" class="code-input content-raw-input" spellcheck="false"></textarea>
                  </label>
                  <div class="modal-actions">
                    <button class="button danger" id="deleteDownloadButton" type="button">${context.tf(context.locale, 'delete', 'Delete')}</button>
                    <button class="button primary" type="submit">${context.t(context.locale, 'save')}</button>
                  </div>
                </form>
              </div>
            </div>
          </section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: context.tf(context.locale, 'downloadCenter', 'Download Center'),
      body,
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'admin.js')]
    });
  }

  function sanitizeExplorerSegment(value = '') {
    return String(value || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  }

  function sanitizeExplorerDir(value = '') {
    return String(value || '').replace(/\\/g, '/').split('/').map((part) => sanitizeExplorerSegment(part)).filter(Boolean).join('/');
  }

  function sanitizeFileName(value = '') {
    return sanitizeExplorerSegment(value).replace(/^\.+/, '').slice(0, 180);
  }

  function normalizeTagList(value) {
    const items = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
    return Array.from(new Set(items.map((item) => String(item).trim()).filter(Boolean)));
  }
}
