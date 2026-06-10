import { join } from 'node:path';

const FORUM_PERMISSION_KEYS = [
  'forum.view',
  'forum.create_thread',
  'forum.reply',
  'forum.edit_own_post',
  'forum.delete_own_post',
  'forum.moderate',
  'forum.manage_categories',
  'forum.manage_tags',
  'forum.mark_solution',
  'forum.view_reports'
];
const REACTION_TYPES = new Set(['like', 'helpful', 'insightful', 'celebrate']);
const REPORT_STATUSES = new Set(['open', 'resolved', 'dismissed']);

export default function createForumPlugin({ manifest, rootDir }) {
  let db = null;

  const feature = {
    key: manifest.key || 'forum',
    label: manifest.name || 'Forum',
    href: '/forum',
    description: manifest.description || 'Structured community discussions with categories, threads, replies, tags, reactions and moderation.',
    defaultEnabled: true
  };

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    localesDir: join(rootDir, 'locales'),
    adminPage: { href: '/admin/forum', label: manifest.name || 'Forum' },
    init(context) {
      db = context.db;
      db.exec(`
        CREATE TABLE IF NOT EXISTS forum_categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_private INTEGER NOT NULL DEFAULT 0,
          roles_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS forum_threads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id INTEGER NOT NULL REFERENCES forum_categories(id) ON DELETE CASCADE,
          author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL DEFAULT '',
          is_pinned INTEGER NOT NULL DEFAULT 0,
          is_locked INTEGER NOT NULL DEFAULT 0,
          is_solved INTEGER NOT NULL DEFAULT 0,
          solution_post_id INTEGER,
          view_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS forum_posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
          author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          content TEXT NOT NULL DEFAULT '',
          parent_post_id INTEGER REFERENCES forum_posts(id) ON DELETE SET NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS forum_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL DEFAULT '#5d6b82'
        );
        CREATE TABLE IF NOT EXISTS forum_thread_tags (
          thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
          tag_id INTEGER NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
          PRIMARY KEY (thread_id, tag_id)
        );
        CREATE TABLE IF NOT EXISTS forum_reactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(post_id, user_id, type)
        );
        CREATE TABLE IF NOT EXISTS forum_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
          reporter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reason TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at TEXT
        );
        CREATE TABLE IF NOT EXISTS forum_permissions (
          permission_key TEXT NOT NULL,
          role_name TEXT NOT NULL,
          PRIMARY KEY (permission_key, role_name)
        );
        CREATE INDEX IF NOT EXISTS idx_forum_threads_category ON forum_threads(category_id, is_pinned DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_forum_posts_thread ON forum_posts(thread_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_forum_reports_status ON forum_reports(status, created_at DESC);
      `);
      seedDefaultPermissions();
    },
    resetToFactoryDefaults(context) {
      context.db.exec(`
        DELETE FROM forum_reports;
        DELETE FROM forum_reactions;
        DELETE FROM forum_thread_tags;
        DELETE FROM forum_posts;
        DELETE FROM forum_threads;
        DELETE FROM forum_tags;
        DELETE FROM forum_categories;
        DELETE FROM forum_permissions;
        DELETE FROM sqlite_sequence WHERE name IN ('forum_categories', 'forum_threads', 'forum_posts', 'forum_tags', 'forum_reactions', 'forum_reports');
      `);
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/forum/support-data' && req.method === 'GET') {
        return requireAny(context, ['forum.manage_categories', 'forum.manage_tags', 'forum.view_reports', 'forum.moderate'], () => context.sendJson(res, 200, getSupportData(context)));
      }
      if (url.pathname === '/api/admin/forum/categories' && req.method === 'POST') return requirePermission(context, 'forum.manage_categories', () => saveCategory(context));
      if (url.pathname.startsWith('/api/admin/forum/categories/') && req.method === 'DELETE') return requirePermission(context, 'forum.manage_categories', () => deleteCategory(context));
      if (url.pathname === '/api/admin/forum/tags' && req.method === 'POST') return requirePermission(context, 'forum.manage_tags', () => saveTag(context));
      if (url.pathname.startsWith('/api/admin/forum/tags/') && req.method === 'DELETE') return requirePermission(context, 'forum.manage_tags', () => deleteTag(context));
      if (url.pathname === '/api/admin/forum/reports' && req.method === 'GET') return requirePermission(context, 'forum.view_reports', () => listReports(context));
      if (url.pathname === '/api/admin/forum/reports/resolve' && req.method === 'POST') return requirePermission(context, 'forum.moderate', () => resolveReport(context));
      if (url.pathname === '/api/admin/forum/permissions' && req.method === 'POST') return requirePermission(context, 'forum.moderate', () => savePermissions(context));

      if (url.pathname === '/api/forum/categories' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'forum.view', () => listCategories(context)));
      if (url.pathname === '/api/forum/category' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'forum.view', () => getCategoryDetail(context)));
      if (url.pathname === '/api/forum/threads' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'forum.view', () => listThreads(context)));
      if (url.pathname === '/api/forum/thread' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'forum.view', () => getThreadDetail(context)));
      if (url.pathname === '/api/forum/thread' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'forum.create_thread', () => createThread(context)));
      if (url.pathname === '/api/forum/post' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'forum.reply', () => createPost(context)));
      if (url.pathname === '/api/forum/post/edit' && req.method === 'POST') return requireEnabled(context, () => editPost(context));
      if (url.pathname.startsWith('/api/forum/post/') && req.method === 'DELETE') return requireEnabled(context, () => deletePost(context));
      if (url.pathname === '/api/forum/reaction' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'forum.view', () => toggleReaction(context)));
      if (url.pathname === '/api/forum/report' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'forum.view', () => reportPost(context)));
      if (url.pathname === '/api/forum/thread/moderate' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'forum.moderate', () => moderateThread(context)));
      if (url.pathname === '/api/forum/thread/solution' && req.method === 'POST') return requireEnabled(context, () => markSolution(context));

      if (url.pathname === '/forum' || url.pathname.startsWith('/forum/')) {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'forumFeatureDisabledNotice', 'The forum feature is currently disabled.') }));
          return true;
        }
        if (!hasPermission(user, 'forum.view')) {
          context.sendHtml(res, 403, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'forumViewRequired', 'Forum permissions are required.') }));
          return true;
        }
        context.sendHtml(res, 200, renderForumPage(context));
        return true;
      }
      if (url.pathname === '/admin/forum') {
        return requireAny(context, ['forum.manage_categories', 'forum.manage_tags', 'forum.view_reports', 'forum.moderate'], () => context.sendHtml(res, 200, renderAdminPage(context)));
      }
      return false;
    }
  };

  async function requireEnabled(context, callback) {
    if (!context.isPluginEnabled(feature.key)) {
      context.sendJson(context.res, 404, { error: context.tf(context.locale, 'forumFeatureDisabled', 'The forum feature is currently disabled.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requirePermission(context, permissionKey, callback) {
    if (!hasPermission(context.user, permissionKey)) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'forumPermissionRequired', 'Forum permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requireAny(context, keys, callback) {
    if (!keys.some((key) => hasPermission(context.user, key))) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'forumPermissionRequired', 'Forum permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  function renderForumPage(context) {
    const settings = context.getSettings();
    const mode = context.url.pathname.startsWith('/forum/category/') ? 'category' : context.url.pathname.startsWith('/forum/thread/') ? 'thread' : 'home';
    const slug = mode === 'category' ? decodeURIComponent(context.url.pathname.slice('/forum/category/'.length)) : mode === 'thread' ? decodeURIComponent(context.url.pathname.slice('/forum/thread/'.length)) : '';
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell forum-page" data-forum-app data-forum-mode="${context.escapeAttribute(mode)}" data-forum-slug="${context.escapeAttribute(slug)}">
        ${context.renderTopbar(context.user, context.locale, '/forum')}
        <main class="forum-workspace">
          <section class="forum-header">
            <div>
              <p class="eyebrow">${context.tf(context.locale, 'forum', 'Forum')}</p>
              <h1>${context.escapeHtml(copy.label)}</h1>
              <p class="hint">${context.escapeHtml(copy.description)}</p>
            </div>
            <div class="row-actions">
              <a class="button ghost" href="/forum">${context.tf(context.locale, 'forumHome', 'Forum home')}</a>
              <button class="button primary" type="button" data-new-thread hidden>${context.tf(context.locale, 'createThread', 'Create thread')}</button>
              ${hasPermission(context.user, 'forum.moderate') ? `<a class="button ghost" href="/admin/forum">${context.tf(context.locale, 'admin', 'Admin')}</a>` : ''}
            </div>
          </section>
          <section class="forum-toolbar">
            <input id="forumSearch" type="search" placeholder="${context.tf(context.locale, 'searchForum', 'Search forum')}">
            <select id="forumTagFilter"><option value="">${context.tf(context.locale, 'allTags', 'All tags')}</option></select>
            <select id="forumStatusFilter">
              <option value="">${context.tf(context.locale, 'allThreads', 'All threads')}</option>
              <option value="solved">${context.tf(context.locale, 'solved', 'Solved')}</option>
              <option value="open">${context.tf(context.locale, 'open', 'Open')}</option>
              <option value="locked">${context.tf(context.locale, 'locked', 'Locked')}</option>
            </select>
          </section>
          <section id="forumRoot" class="forum-root"></section>
        </main>
        ${renderThreadDialog(context)}
        ${renderEditDialog(context)}
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'forum.js')], pluginKeys: [feature.key] });
  }

  function renderAdminPage(context) {
    const settings = context.getSettings();
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell" data-forum-admin-page>
        ${context.renderTopbar(context.user, context.locale, '/admin/forum')}
        <main class="admin-page forum-admin-page">
          <div class="admin-header">
            <div><h1>${context.escapeHtml(copy.label)}</h1><p class="hint">${context.escapeHtml(copy.description)}</p></div>
            <div class="row-actions"><a class="button ghost" href="/forum">${context.tf(context.locale, 'openForum', 'Open forum')}</a><a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a></div>
          </div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <nav class="builder-subnav">
            <button class="admin-tab-button active" type="button" data-forum-admin-tab="categories">${context.tf(context.locale, 'categories', 'Categories')}</button>
            <button class="admin-tab-button" type="button" data-forum-admin-tab="tags">${context.tf(context.locale, 'tags', 'Tags')}</button>
            <button class="admin-tab-button" type="button" data-forum-admin-tab="reports">${context.tf(context.locale, 'reports', 'Reports')}</button>
            <button class="admin-tab-button" type="button" data-forum-admin-tab="permissions">${context.tf(context.locale, 'permissions', 'Permissions')}</button>
          </nav>
          <section id="forumAdminRoot" class="forum-admin-root"></section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'forum.js')], pluginKeys: [feature.key] });
  }

  function renderThreadDialog(context) {
    return `
      <dialog id="forumThreadDialog" class="modal-dialog forum-dialog">
        <form id="forumThreadForm" class="modal-form">
          <input name="id" type="hidden">
          <h2>${context.tf(context.locale, 'createThread', 'Create thread')}</h2>
          <label>${context.tf(context.locale, 'category', 'Category')}<select name="category_id" required data-forum-category-select></select></label>
          <label>${context.tf(context.locale, 'title', 'Title')}<input name="title" required></label>
          <label>${context.tf(context.locale, 'slug', 'Slug')}<input name="slug" placeholder="welcome-thread"></label>
          <label>${context.tf(context.locale, 'content', 'Content')}<textarea name="content" required></textarea></label>
          <label>${context.tf(context.locale, 'tags', 'Tags')}<select name="tags" multiple size="4" data-forum-tag-select></select></label>
          <div class="modal-actions"><button class="button ghost" type="button" data-close-forum-dialog>${context.tf(context.locale, 'cancel', 'Cancel')}</button><button class="button primary" type="submit">${context.tf(context.locale, 'save', 'Save')}</button></div>
        </form>
      </dialog>
    `;
  }

  function renderEditDialog(context) {
    return `
      <dialog id="forumEditDialog" class="modal-dialog forum-dialog">
        <form id="forumEditForm" class="modal-form">
          <input name="post_id" type="hidden">
          <h2>${context.tf(context.locale, 'editPost', 'Edit post')}</h2>
          <label>${context.tf(context.locale, 'content', 'Content')}<textarea name="content" required></textarea></label>
          <div class="modal-actions"><button class="button ghost" type="button" data-close-edit-dialog>${context.tf(context.locale, 'cancel', 'Cancel')}</button><button class="button primary" type="submit">${context.tf(context.locale, 'save', 'Save')}</button></div>
        </form>
      </dialog>
    `;
  }

  function getSupportData(context) {
    return {
      categories: getAllCategories().map((category) => serializeCategory(category, context.user, { includePrivate: true })),
      tags: listAllTags(),
      roles: context.listRoles(),
      permissions: getPermissionMatrix(),
      permissionKeys: FORUM_PERMISSION_KEYS,
      can: getCapabilities(context.user)
    };
  }

  function listCategories(context) {
    const categories = getAllCategories().filter((category) => canSeeCategory(context.user, category));
    context.sendJson(context.res, 200, { items: categories.map((category) => serializeCategory(category, context.user)), tags: listAllTags(), can: getCapabilities(context.user) });
  }

  function getCategoryDetail(context) {
    const category = getCategoryBySlug(context.url.searchParams.get('slug'));
    if (!category || !canSeeCategory(context.user, category)) return context.sendJson(context.res, 404, { error: 'Category not found.' });
    context.sendJson(context.res, 200, { category: serializeCategory(category, context.user), tags: listAllTags(), can: getCapabilities(context.user) });
  }

  function listThreads(context) {
    const categorySlug = String(context.url.searchParams.get('category') || '').trim();
    const q = String(context.url.searchParams.get('q') || '').trim().toLowerCase();
    const tag = String(context.url.searchParams.get('tag') || '').trim();
    const status = String(context.url.searchParams.get('status') || '').trim();
    let rows = db.prepare(`
      SELECT ft.*, fc.slug AS category_slug, fc.name AS category_name, fc.is_private, fc.roles_json, u.name AS author_name, u.email AS author_email
      FROM forum_threads ft
      JOIN forum_categories fc ON fc.id = ft.category_id
      LEFT JOIN users u ON u.id = ft.author_user_id
      ORDER BY ft.is_pinned DESC, ft.updated_at DESC
    `).all();
    rows = rows.map(normalizeThreadRow).filter((thread) => canSeeCategory(context.user, thread.category));
    if (categorySlug) rows = rows.filter((thread) => thread.category.slug === categorySlug);
    if (q) rows = rows.filter((thread) => `${thread.title} ${thread.content}`.toLowerCase().includes(q));
    if (tag) rows = rows.filter((thread) => thread.tags.some((item) => item.slug === tag));
    if (status === 'solved') rows = rows.filter((thread) => thread.isSolved);
    if (status === 'open') rows = rows.filter((thread) => !thread.isLocked);
    if (status === 'locked') rows = rows.filter((thread) => thread.isLocked);
    context.sendJson(context.res, 200, { items: rows.map((thread) => serializeThreadSummary(thread, context.user)), can: getCapabilities(context.user) });
  }

  function getThreadDetail(context) {
    const thread = getThreadBySlug(context.url.searchParams.get('slug'));
    if (!thread || !canSeeCategory(context.user, thread.category)) return context.sendJson(context.res, 404, { error: 'Thread not found.' });
    db.prepare('UPDATE forum_threads SET view_count = view_count + 1 WHERE id = ?').run(thread.id);
    context.sendJson(context.res, 200, serializeThreadDetail(getThreadById(thread.id), context.user));
  }

  async function createThread(context) {
    const payload = await context.readJson(context.req);
    const category = getCategoryById(payload.categoryId || payload.category_id);
    if (!category || !canSeeCategory(context.user, category)) return context.sendJson(context.res, 404, { error: 'Category not found.' });
    const title = String(payload.title || '').trim();
    const content = String(payload.content || '').trim();
    if (!title || !content) return context.sendJson(context.res, 400, { error: 'Title and content are required.' });
    const slug = uniqueSlug(context, 'forum_threads', payload.slug || title);
    const tagIds = normalizeIdArray(payload.tags);
    db.exec('BEGIN');
    try {
      const result = db.prepare('INSERT INTO forum_threads (category_id, author_user_id, title, slug, content, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(category.id, context.user.id, title, slug, content);
      for (const tagId of tagIds) db.prepare('INSERT OR IGNORE INTO forum_thread_tags (thread_id, tag_id) VALUES (?, ?)').run(result.lastInsertRowid, tagId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    context.sendJson(context.res, 200, { ok: true, thread: serializeThreadDetail(getThreadBySlug(slug), context.user) });
  }

  async function createPost(context) {
    const payload = await context.readJson(context.req);
    const thread = getThreadBySlug(payload.threadSlug || payload.thread_slug);
    if (!thread || !canSeeCategory(context.user, thread.category)) return context.sendJson(context.res, 404, { error: 'Thread not found.' });
    if (thread.isLocked && !hasPermission(context.user, 'forum.moderate')) return context.sendJson(context.res, 403, { error: 'Thread is locked.' });
    const content = String(payload.content || '').trim();
    if (!content) return context.sendJson(context.res, 400, { error: 'Content is required.' });
    db.prepare('INSERT INTO forum_posts (thread_id, author_user_id, content, parent_post_id, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)').run(thread.id, context.user.id, content, Number(payload.parentPostId || payload.parent_post_id || 0) || null);
    db.prepare('UPDATE forum_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(thread.id);
    context.sendJson(context.res, 200, { ok: true, thread: serializeThreadDetail(getThreadById(thread.id), context.user) });
  }

  async function editPost(context) {
    const payload = await context.readJson(context.req);
    const post = getPostById(payload.postId || payload.post_id);
    if (!post) return context.sendJson(context.res, 404, { error: 'Post not found.' });
    const thread = getThreadById(post.threadId);
    if (!thread || !canSeeCategory(context.user, thread.category)) return context.sendJson(context.res, 404, { error: 'Post not found.' });
    if (!canEditPost(context.user, post)) return context.sendJson(context.res, 403, { error: 'Edit permissions required.' });
    const content = String(payload.content || '').trim();
    if (!content) return context.sendJson(context.res, 400, { error: 'Content is required.' });
    db.prepare('UPDATE forum_posts SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, post.id);
    context.sendJson(context.res, 200, { ok: true, thread: serializeThreadDetail(getThreadById(thread.id), context.user) });
  }

  function deletePost(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/forum/post/'.length)));
    const post = getPostById(id);
    if (!post) return context.sendJson(context.res, 404, { error: 'Post not found.' });
    const thread = getThreadById(post.threadId);
    if (!thread || !canSeeCategory(context.user, thread.category)) return context.sendJson(context.res, 404, { error: 'Post not found.' });
    if (!canDeletePost(context.user, post)) return context.sendJson(context.res, 403, { error: 'Delete permissions required.' });
    db.prepare('UPDATE forum_posts SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    context.sendJson(context.res, 200, { ok: true });
  }

  async function toggleReaction(context) {
    const payload = await context.readJson(context.req);
    const post = getPostById(payload.postId || payload.post_id);
    const type = String(payload.type || '').trim();
    if (!post || !REACTION_TYPES.has(type)) return context.sendJson(context.res, 400, { error: 'Invalid reaction.' });
    const thread = getThreadById(post.threadId);
    if (!thread || !canSeeCategory(context.user, thread.category)) return context.sendJson(context.res, 404, { error: 'Post not found.' });
    const existing = db.prepare('SELECT id FROM forum_reactions WHERE post_id = ? AND user_id = ? AND type = ?').get(post.id, context.user.id, type);
    if (existing) db.prepare('DELETE FROM forum_reactions WHERE id = ?').run(existing.id);
    else db.prepare('INSERT INTO forum_reactions (post_id, user_id, type) VALUES (?, ?, ?)').run(post.id, context.user.id, type);
    context.sendJson(context.res, 200, { ok: true, reactions: getReactions(post.id, context.user.id) });
  }

  async function reportPost(context) {
    const payload = await context.readJson(context.req);
    const post = getPostById(payload.postId || payload.post_id);
    if (!post) return context.sendJson(context.res, 404, { error: 'Post not found.' });
    const thread = getThreadById(post.threadId);
    if (!thread || !canSeeCategory(context.user, thread.category)) return context.sendJson(context.res, 404, { error: 'Post not found.' });
    const reason = String(payload.reason || '').trim();
    if (!reason) return context.sendJson(context.res, 400, { error: 'Reason is required.' });
    db.prepare('INSERT INTO forum_reports (post_id, reporter_user_id, reason) VALUES (?, ?, ?)').run(post.id, context.user.id, reason);
    context.sendJson(context.res, 200, { ok: true });
  }

  async function moderateThread(context) {
    const payload = await context.readJson(context.req);
    const thread = getThreadBySlug(payload.slug);
    if (!thread) return context.sendJson(context.res, 404, { error: 'Thread not found.' });
    const fields = [];
    const values = [];
    for (const [key, column] of [['isPinned', 'is_pinned'], ['isLocked', 'is_locked'], ['isSolved', 'is_solved']]) {
      if (payload[key] !== undefined) {
        fields.push(`${column} = ?`);
        values.push(payload[key] ? 1 : 0);
      }
    }
    if (!fields.length) return context.sendJson(context.res, 400, { error: 'No moderation changes provided.' });
    values.push(thread.id);
    db.prepare(`UPDATE forum_threads SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
    context.sendJson(context.res, 200, { ok: true, thread: serializeThreadDetail(getThreadById(thread.id), context.user) });
  }

  async function markSolution(context) {
    const payload = await context.readJson(context.req);
    const thread = getThreadBySlug(payload.slug);
    if (!thread) return context.sendJson(context.res, 404, { error: 'Thread not found.' });
    if (!(hasPermission(context.user, 'forum.moderate') || (thread.authorUserId === context.user.id && hasPermission(context.user, 'forum.mark_solution')))) return context.sendJson(context.res, 403, { error: 'Solution permissions required.' });
    const postId = Number(payload.postId || payload.post_id || 0) || null;
    if (postId && !getPostById(postId)) return context.sendJson(context.res, 404, { error: 'Post not found.' });
    db.prepare('UPDATE forum_threads SET is_solved = ?, solution_post_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(postId ? 1 : 0, postId, thread.id);
    context.sendJson(context.res, 200, { ok: true, thread: serializeThreadDetail(getThreadById(thread.id), context.user) });
  }

  async function saveCategory(context) {
    const payload = await context.readJson(context.req);
    const id = Number(payload.id || 0);
    const name = String(payload.name || '').trim();
    if (!name) return context.sendJson(context.res, 400, { error: 'Name is required.' });
    const slug = id ? uniqueSlug(context, 'forum_categories', payload.slug || name, id) : uniqueSlug(context, 'forum_categories', payload.slug || name);
    const data = [name, slug, String(payload.description || '').trim(), Number(payload.sortOrder ?? payload.sort_order ?? 0) || 0, payload.isPrivate || payload.is_private ? 1 : 0, JSON.stringify(normalizeStringArray(payload.roles))];
    if (id) db.prepare('UPDATE forum_categories SET name = ?, slug = ?, description = ?, sort_order = ?, is_private = ?, roles_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(...data, id);
    else db.prepare('INSERT INTO forum_categories (name, slug, description, sort_order, is_private, roles_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(...data);
    context.sendJson(context.res, 200, { ok: true, categories: getAllCategories().map((category) => serializeCategory(category, context.user, { includePrivate: true })) });
  }

  function deleteCategory(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/admin/forum/categories/'.length)));
    db.prepare('DELETE FROM forum_categories WHERE id = ?').run(id);
    context.sendJson(context.res, 200, { ok: true });
  }

  async function saveTag(context) {
    const payload = await context.readJson(context.req);
    const id = Number(payload.id || 0);
    const name = String(payload.name || '').trim();
    if (!name) return context.sendJson(context.res, 400, { error: 'Name is required.' });
    const slug = id ? uniqueSlug(context, 'forum_tags', payload.slug || name, id) : uniqueSlug(context, 'forum_tags', payload.slug || name);
    const color = /^#[0-9a-f]{6}$/i.test(String(payload.color || '')) ? payload.color : '#5d6b82';
    if (id) db.prepare('UPDATE forum_tags SET name = ?, slug = ?, color = ? WHERE id = ?').run(name, slug, color, id);
    else db.prepare('INSERT INTO forum_tags (name, slug, color) VALUES (?, ?, ?)').run(name, slug, color);
    context.sendJson(context.res, 200, { ok: true, tags: listAllTags() });
  }

  function deleteTag(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/admin/forum/tags/'.length)));
    db.prepare('DELETE FROM forum_tags WHERE id = ?').run(id);
    context.sendJson(context.res, 200, { ok: true });
  }

  function listReports(context) {
    const rows = db.prepare(`
      SELECT fr.*, fp.content, ft.slug AS thread_slug, ft.title AS thread_title, ru.name AS reporter_name, au.name AS author_name
      FROM forum_reports fr
      JOIN forum_posts fp ON fp.id = fr.post_id
      JOIN forum_threads ft ON ft.id = fp.thread_id
      LEFT JOIN users ru ON ru.id = fr.reporter_user_id
      LEFT JOIN users au ON au.id = fp.author_user_id
      ORDER BY fr.status = 'open' DESC, fr.created_at DESC
    `).all();
    context.sendJson(context.res, 200, { items: rows.map((row) => ({
      id: row.id,
      postId: row.post_id,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      content: row.content,
      thread: { slug: row.thread_slug, title: row.thread_title },
      reporterName: row.reporter_name || '',
      authorName: row.author_name || ''
    })) });
  }

  async function resolveReport(context) {
    const payload = await context.readJson(context.req);
    const status = REPORT_STATUSES.has(String(payload.status || 'resolved')) ? String(payload.status || 'resolved') : 'resolved';
    db.prepare('UPDATE forum_reports SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, Number(payload.id || 0));
    context.sendJson(context.res, 200, { ok: true });
  }

  async function savePermissions(context) {
    const payload = await context.readJson(context.req);
    const permissions = payload.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};
    const validRoles = new Set(context.listRoles().map((role) => role.name));
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM forum_permissions').run();
      for (const key of FORUM_PERMISSION_KEYS) {
        for (const role of normalizeStringArray(permissions[key]).filter((item) => validRoles.has(item))) {
          db.prepare('INSERT OR IGNORE INTO forum_permissions (permission_key, role_name) VALUES (?, ?)').run(key, role);
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
    if (db.prepare('SELECT COUNT(*) AS count FROM forum_permissions').get().count) return;
    for (const key of FORUM_PERMISSION_KEYS) db.prepare('INSERT OR IGNORE INTO forum_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Admins');
    for (const key of ['forum.view', 'forum.create_thread', 'forum.reply', 'forum.edit_own_post', 'forum.delete_own_post', 'forum.mark_solution']) {
      db.prepare('INSERT OR IGNORE INTO forum_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Users');
    }
  }

  function hasPermission(user, key) {
    if (user?.is_admin) return true;
    return Boolean(user?.roles?.some((role) => db.prepare('SELECT 1 FROM forum_permissions WHERE permission_key = ? AND role_name = ?').get(key, role)));
  }

  function getPermissionMatrix() {
    const matrix = Object.fromEntries(FORUM_PERMISSION_KEYS.map((key) => [key, []]));
    for (const row of db.prepare('SELECT permission_key, role_name FROM forum_permissions ORDER BY permission_key, role_name').all()) {
      if (!matrix[row.permission_key]) matrix[row.permission_key] = [];
      matrix[row.permission_key].push(row.role_name);
    }
    return matrix;
  }

  function getCapabilities(user) {
    return Object.fromEntries(FORUM_PERMISSION_KEYS.map((key) => [key.replace('forum.', '').replace(/_/g, ''), hasPermission(user, key)]));
  }

  function getAllCategories() {
    return db.prepare('SELECT * FROM forum_categories ORDER BY sort_order, name').all().map(normalizeCategoryRow);
  }

  function getCategoryBySlug(slug) {
    const row = db.prepare('SELECT * FROM forum_categories WHERE slug = ?').get(String(slug || '').trim());
    return row ? normalizeCategoryRow(row) : null;
  }

  function getCategoryById(id) {
    const row = db.prepare('SELECT * FROM forum_categories WHERE id = ?').get(Number(id || 0));
    return row ? normalizeCategoryRow(row) : null;
  }

  function canSeeCategory(user, category) {
    if (user?.is_admin || hasPermission(user, 'forum.moderate')) return true;
    if (!hasPermission(user, 'forum.view')) return false;
    if (!category.isPrivate) return true;
    return category.roles.some((role) => user?.roles?.includes(role)) || userParticipatesInCategory(user?.id, category.id);
  }

  function userParticipatesInCategory(userId, categoryId) {
    if (!userId) return false;
    return Boolean(db.prepare(`
      SELECT 1 FROM forum_threads ft
      LEFT JOIN forum_posts fp ON fp.thread_id = ft.id
      WHERE ft.category_id = ? AND (ft.author_user_id = ? OR fp.author_user_id = ?)
      LIMIT 1
    `).get(categoryId, userId, userId));
  }

  function serializeCategory(category, user, options = {}) {
    const stats = db.prepare(`
      SELECT COUNT(DISTINCT ft.id) AS threads, COUNT(fp.id) AS posts, MAX(COALESCE(fp.updated_at, ft.updated_at)) AS latest
      FROM forum_threads ft LEFT JOIN forum_posts fp ON fp.thread_id = ft.id
      WHERE ft.category_id = ?
    `).get(category.id);
    return {
      ...category,
      roles: options.includePrivate ? category.roles : undefined,
      threadCount: stats.threads || 0,
      postCount: stats.posts || 0,
      latestActivity: stats.latest || category.updatedAt,
      canCreateThread: hasPermission(user, 'forum.create_thread') && canSeeCategory(user, category)
    };
  }

  function normalizeCategoryRow(row) {
    return { id: row.id, name: row.name, slug: row.slug, description: row.description || '', sortOrder: row.sort_order || 0, isPrivate: Boolean(row.is_private), roles: parseJsonArray(row.roles_json), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  function getThreadBySlug(slug) {
    const row = db.prepare(`
      SELECT ft.*, fc.slug AS category_slug, fc.name AS category_name, fc.is_private, fc.roles_json, u.name AS author_name, u.email AS author_email
      FROM forum_threads ft
      JOIN forum_categories fc ON fc.id = ft.category_id
      LEFT JOIN users u ON u.id = ft.author_user_id
      WHERE ft.slug = ?
    `).get(String(slug || '').trim());
    return row ? normalizeThreadRow(row) : null;
  }

  function getThreadById(id) {
    const row = db.prepare(`
      SELECT ft.*, fc.slug AS category_slug, fc.name AS category_name, fc.is_private, fc.roles_json, u.name AS author_name, u.email AS author_email
      FROM forum_threads ft
      JOIN forum_categories fc ON fc.id = ft.category_id
      LEFT JOIN users u ON u.id = ft.author_user_id
      WHERE ft.id = ?
    `).get(Number(id || 0));
    return row ? normalizeThreadRow(row) : null;
  }

  function normalizeThreadRow(row) {
    const author = buildForumAuthor(row.author_user_id, row.author_name || row.author_email || 'Unknown');
    return {
      id: row.id,
      categoryId: row.category_id,
      authorUserId: row.author_user_id,
      title: row.title,
      slug: row.slug,
      content: row.content || '',
      isPinned: Boolean(row.is_pinned),
      isLocked: Boolean(row.is_locked),
      isSolved: Boolean(row.is_solved),
      solutionPostId: row.solution_post_id,
      viewCount: row.view_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      category: { id: row.category_id, slug: row.category_slug, name: row.category_name, isPrivate: Boolean(row.is_private), roles: parseJsonArray(row.roles_json) },
      author,
      tags: getThreadTags(row.id)
    };
  }

  function serializeThreadSummary(thread, user) {
    const replyCount = db.prepare('SELECT COUNT(*) AS count FROM forum_posts WHERE thread_id = ? AND is_deleted = 0').get(thread.id).count;
    return { ...thread, content: '', replyCount, canModerate: hasPermission(user, 'forum.moderate') };
  }

  function serializeThreadDetail(thread, user) {
    const posts = db.prepare(`
      SELECT fp.*, u.name, u.email FROM forum_posts fp
      LEFT JOIN users u ON u.id = fp.author_user_id
      WHERE fp.thread_id = ? ORDER BY fp.created_at ASC
    `).all(thread.id).map((row) => normalizePostRow(row, user));
    const originalPost = {
      id: `thread-${thread.id}`,
      threadId: thread.id,
      authorUserId: thread.authorUserId,
      content: thread.content,
      isDeleted: false,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      author: thread.author,
      reactions: [],
      canEdit: false,
      canDelete: false
    };
    return {
      ...thread,
      posts: [originalPost, ...posts],
      can: {
        reply: hasPermission(user, 'forum.reply') && (!thread.isLocked || hasPermission(user, 'forum.moderate')),
        moderate: hasPermission(user, 'forum.moderate'),
        markSolution: hasPermission(user, 'forum.moderate') || (thread.authorUserId === user.id && hasPermission(user, 'forum.mark_solution'))
      }
    };
  }

  function getPostById(id) {
    const row = db.prepare('SELECT * FROM forum_posts WHERE id = ?').get(Number(id || 0));
    return row ? { id: row.id, threadId: row.thread_id, authorUserId: row.author_user_id, content: row.content || '', parentPostId: row.parent_post_id, isDeleted: Boolean(row.is_deleted), createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  function normalizePostRow(row, user) {
    return {
      id: row.id,
      threadId: row.thread_id,
      authorUserId: row.author_user_id,
      content: row.is_deleted ? '' : row.content,
      parentPostId: row.parent_post_id,
      isDeleted: Boolean(row.is_deleted),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      author: buildForumAuthor(row.author_user_id, row.name || row.email || 'Unknown'),
      reactions: getReactions(row.id, user.id),
      canEdit: canEditPost(user, { authorUserId: row.author_user_id, isDeleted: Boolean(row.is_deleted) }),
      canDelete: canDeletePost(user, { authorUserId: row.author_user_id, isDeleted: Boolean(row.is_deleted) })
    };
  }

  function canEditPost(user, post) {
    return !post.isDeleted && (hasPermission(user, 'forum.moderate') || (post.authorUserId === user.id && hasPermission(user, 'forum.edit_own_post')));
  }

  function canDeletePost(user, post) {
    return !post.isDeleted && (hasPermission(user, 'forum.moderate') || (post.authorUserId === user.id && hasPermission(user, 'forum.delete_own_post')));
  }

  function getThreadTags(threadId) {
    return db.prepare('SELECT ft.* FROM forum_tags ft JOIN forum_thread_tags ftt ON ftt.tag_id = ft.id WHERE ftt.thread_id = ? ORDER BY ft.name').all(threadId).map(normalizeTagRow);
  }

  function listAllTags() {
    return db.prepare('SELECT * FROM forum_tags ORDER BY name').all().map(normalizeTagRow);
  }

  function normalizeTagRow(row) {
    return { id: row.id, name: row.name, slug: row.slug, color: row.color || '#5d6b82' };
  }

  function getReactions(postId, userId) {
    const rows = db.prepare('SELECT type, user_id FROM forum_reactions WHERE post_id = ?').all(postId);
    return Array.from(REACTION_TYPES).map((type) => ({ type, count: rows.filter((row) => row.type === type).length, mine: rows.some((row) => row.type === type && row.user_id === userId) }));
  }

  function buildForumAuthor(userId, fallbackName) {
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(Number(userId || 0));
    const roles = db.prepare('SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? ORDER BY r.name').all(Number(userId || 0)).map((row) => row.name);
    const profile = getForumDirectoryProfile(userId);
    return {
      id: userId,
      name: profile?.displayName || user?.name || fallbackName,
      roles,
      profile
    };
  }

  function getForumDirectoryProfile(userId) {
    if (!tableExists('directory_profiles')) return null;
    const row = db.prepare(`
      SELECT id, user_id, display_name, avatar_url, job_title, department, location
      FROM directory_profiles WHERE user_id = ?
    `).get(Number(userId || 0));
    if (!row) return null;
    const skills = tableExists('directory_skills') ? db.prepare(`
      SELECT ds.id, ds.name FROM directory_skills ds
      JOIN directory_profile_skills dps ON dps.skill_id = ds.id
      WHERE dps.profile_id = ? ORDER BY ds.name LIMIT 3
    `).all(row.id) : [];
    return {
      userId: row.user_id,
      displayName: row.display_name || '',
      avatarUrl: row.avatar_url || '',
      jobTitle: row.job_title || '',
      department: row.department || '',
      location: row.location || '',
      skills,
      href: `/directory/profile/${row.user_id}`
    };
  }

  function tableExists(name) {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  function uniqueSlug(context, table, source, excludeId = 0) {
    const base = context.slugify(String(source || '').trim()) || 'item';
    let slug = base;
    let i = 2;
    while (db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`).get(slug, excludeId)) slug = `${base}-${i++}`;
    return slug;
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

  function normalizeIdArray(value) {
    return Array.from(new Set((Array.isArray(value) ? value : []).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)));
  }
}
