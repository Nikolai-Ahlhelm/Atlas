import { join } from 'node:path';

const QA_PERMISSION_KEYS = [
  'qa.view',
  'qa.ask',
  'qa.answer',
  'qa.vote',
  'qa.accept_answer',
  'qa.moderate',
  'qa.manage_tags'
];
const QUESTION_STATUSES = new Set(['open', 'solved', 'closed']);
const VOTE_VALUES = new Set([-1, 1]);

export default function createQaPlugin({ manifest, rootDir }) {
  let db = null;

  const feature = {
    key: manifest.key || 'qa',
    label: manifest.name || 'Q&A',
    href: '/qa',
    description: manifest.description || 'Structured questions and answers with tags, voting, accepted answers and moderation.',
    defaultEnabled: true
  };

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    localesDir: join(rootDir, 'locales'),
    adminPage: { href: '/admin/qa', label: manifest.name || 'Q&A' },
    init(context) {
      db = context.db;
      db.exec(`
        CREATE TABLE IF NOT EXISTS qa_questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL DEFAULT '',
          author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'open',
          accepted_answer_id INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS qa_answers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          question_id INTEGER NOT NULL REFERENCES qa_questions(id) ON DELETE CASCADE,
          author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          content TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS qa_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL DEFAULT '#4f7cff'
        );
        CREATE TABLE IF NOT EXISTS qa_question_tags (
          question_id INTEGER NOT NULL REFERENCES qa_questions(id) ON DELETE CASCADE,
          tag_id INTEGER NOT NULL REFERENCES qa_tags(id) ON DELETE CASCADE,
          PRIMARY KEY (question_id, tag_id)
        );
        CREATE TABLE IF NOT EXISTS qa_question_votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          question_id INTEGER NOT NULL REFERENCES qa_questions(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          value INTEGER NOT NULL,
          UNIQUE(question_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS qa_answer_votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          answer_id INTEGER NOT NULL REFERENCES qa_answers(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          value INTEGER NOT NULL,
          UNIQUE(answer_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS qa_permissions (
          permission_key TEXT NOT NULL,
          role_name TEXT NOT NULL,
          PRIMARY KEY (permission_key, role_name)
        );
        CREATE INDEX IF NOT EXISTS idx_qa_questions_status ON qa_questions(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_qa_answers_question ON qa_answers(question_id, created_at ASC);
      `);
      seedDefaultPermissions();
    },
    resetToFactoryDefaults(context) {
      context.db.exec(`
        DELETE FROM qa_answer_votes;
        DELETE FROM qa_question_votes;
        DELETE FROM qa_question_tags;
        DELETE FROM qa_answers;
        DELETE FROM qa_questions;
        DELETE FROM qa_tags;
        DELETE FROM qa_permissions;
        DELETE FROM sqlite_sequence WHERE name IN ('qa_questions', 'qa_answers', 'qa_tags', 'qa_question_votes', 'qa_answer_votes');
      `);
    },
    seedInitialData(context) {
      if (context.db.prepare('SELECT COUNT(*) AS count FROM qa_questions').get().count) return;
      const adminId = getSeedAdminId(context);
      const tags = [
        ['Policies', 'policies', '#4f7cff'],
        ['Access', 'access', '#16a34a'],
        ['Incidents', 'incidents', '#dc2626']
      ].map(([name, slug, color]) => ({
        name,
        id: context.db.prepare('INSERT OR IGNORE INTO qa_tags (name, slug, color) VALUES (?, ?, ?)').run(name, slug, color).lastInsertRowid
          || context.db.prepare('SELECT id FROM qa_tags WHERE slug = ?').get(slug)?.id
      }));
      const firstSlug = uniqueSlug(context, 'qa_questions', 'How should we report a suspected phishing mail?');
      const firstId = context.db.prepare(`
        INSERT INTO qa_questions (title, slug, content, author_user_id, status, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        'How should we report a suspected phishing mail?',
        firstSlug,
        'We need a consistent route for suspicious emails so triage can happen quickly.',
        adminId,
        'solved'
      ).lastInsertRowid;
      for (const tag of tags.filter((item) => ['Access', 'Incidents'].includes(item.name))) context.db.prepare('INSERT OR IGNORE INTO qa_question_tags (question_id, tag_id) VALUES (?, ?)').run(firstId, tag.id);
      const answerId = context.db.prepare('INSERT INTO qa_answers (question_id, author_user_id, content, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(firstId, adminId, 'Use the Security Incident Report form and attach the mail headers if available. The sample form shows the minimum information we expect.').lastInsertRowid;
      context.db.prepare('UPDATE qa_questions SET accepted_answer_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(answerId, 'solved', firstId);

      const secondId = context.db.prepare(`
        INSERT INTO qa_questions (title, slug, content, author_user_id, status, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        'Where do policy owners maintain review notes?',
        uniqueSlug(context, 'qa_questions', 'Where do policy owners maintain review notes?'),
        'I want to understand whether reviews belong in documentation, tasks or changelogs.',
        adminId,
        'open'
      ).lastInsertRowid;
      const policyTag = tags.find((item) => item.name === 'Policies');
      if (policyTag) context.db.prepare('INSERT OR IGNORE INTO qa_question_tags (question_id, tag_id) VALUES (?, ?)').run(secondId, policyTag.id);
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/qa/support-data' && req.method === 'GET') return requireAny(context, ['qa.moderate', 'qa.manage_tags'], () => sendAdminSupport(context));
      if (url.pathname === '/api/admin/qa/tags' && req.method === 'POST') return requirePermission(context, 'qa.manage_tags', () => saveTag(context));
      if (url.pathname.startsWith('/api/admin/qa/tags/') && req.method === 'DELETE') return requirePermission(context, 'qa.manage_tags', () => deleteTag(context));
      if (url.pathname === '/api/admin/qa/permissions' && req.method === 'POST') return requirePermission(context, 'qa.moderate', () => savePermissions(context));
      if (url.pathname === '/api/admin/qa/question/status' && req.method === 'POST') return requirePermission(context, 'qa.moderate', () => moderateQuestionStatus(context));

      if (url.pathname === '/api/qa/questions' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'qa.view', () => listQuestions(context)));
      if (url.pathname === '/api/qa/question' && req.method === 'GET') return requireEnabled(context, () => requirePermission(context, 'qa.view', () => getQuestionDetail(context)));
      if (url.pathname === '/api/qa/question' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'qa.ask', () => saveQuestion(context)));
      if (url.pathname === '/api/qa/answer' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'qa.answer', () => saveAnswer(context)));
      if (url.pathname === '/api/qa/vote/question' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'qa.vote', () => voteQuestion(context)));
      if (url.pathname === '/api/qa/vote/answer' && req.method === 'POST') return requireEnabled(context, () => requirePermission(context, 'qa.vote', () => voteAnswer(context)));
      if (url.pathname === '/api/qa/accept-answer' && req.method === 'POST') return requireEnabled(context, () => acceptAnswer(context));

      if (url.pathname === '/qa' || url.pathname.startsWith('/qa/question/')) {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'qaFeatureDisabledNotice', 'The Q&A feature is currently disabled.') }));
          return true;
        }
        if (!hasPermission(user, 'qa.view')) {
          context.sendHtml(res, 403, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'qaViewRequired', 'Q&A permissions are required.') }));
          return true;
        }
        context.sendHtml(res, 200, renderQaPage(context));
        return true;
      }
      if (url.pathname === '/admin/qa') return requireAny(context, ['qa.moderate', 'qa.manage_tags'], () => context.sendHtml(res, 200, renderAdminPage(context)));
      return false;
    }
  };

  async function requireEnabled(context, callback) {
    if (!context.isPluginEnabled(feature.key)) {
      context.sendJson(context.res, 404, { error: context.tf(context.locale, 'qaFeatureDisabled', 'The Q&A feature is currently disabled.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requirePermission(context, key, callback) {
    if (!hasPermission(context.user, key)) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'qaPermissionRequired', 'Q&A permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requireAny(context, keys, callback) {
    if (!keys.some((key) => hasPermission(context.user, key))) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'qaPermissionRequired', 'Q&A permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  function renderQaPage(context) {
    const settings = context.getSettings();
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const slug = context.url.pathname.startsWith('/qa/question/') ? decodeURIComponent(context.url.pathname.slice('/qa/question/'.length)) : '';
    const body = `
      <div class="app-shell qa-page" data-qa-app data-qa-slug="${context.escapeAttribute(slug)}" data-css-href="${context.pluginAssetUrl(feature.key, 'qa.css')}">
        ${context.renderTopbar(context.user, context.locale, '/qa')}
        <main class="qa-workspace">
          <section class="qa-header">
            <div><p class="eyebrow">${context.tf(context.locale, 'qa', 'Q&A')}</p><h1>${context.escapeHtml(copy.label)}</h1><p class="hint">${context.escapeHtml(copy.description)}</p></div>
            <div class="row-actions">
              <a class="button ghost" href="/qa">${context.tf(context.locale, 'questionList', 'Questions')}</a>
              <button class="button primary" type="button" data-open-question-dialog hidden>${context.tf(context.locale, 'askQuestion', 'Ask question')}</button>
              ${hasPermission(context.user, 'qa.moderate') || hasPermission(context.user, 'qa.manage_tags') ? `<a class="button ghost" href="/admin/qa">${context.tf(context.locale, 'admin', 'Admin')}</a>` : ''}
            </div>
          </section>
          <section class="qa-toolbar">
            <input id="qaSearch" type="search" placeholder="${context.tf(context.locale, 'searchQuestions', 'Search questions')}">
            <select id="qaTagFilter"><option value="">${context.tf(context.locale, 'allTags', 'All tags')}</option></select>
            <select id="qaStatusFilter"><option value="">${context.tf(context.locale, 'allStatuses', 'All statuses')}</option><option value="open">${context.tf(context.locale, 'open', 'Open')}</option><option value="solved">${context.tf(context.locale, 'solved', 'Solved')}</option><option value="closed">${context.tf(context.locale, 'closed', 'Closed')}</option></select>
          </section>
          <section id="qaRoot" class="qa-root"></section>
        </main>
        ${renderQuestionDialog(context)}
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'qa.js')], pluginKeys: [feature.key] });
  }

  function renderAdminPage(context) {
    const settings = context.getSettings();
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const canModerate = hasPermission(context.user, 'qa.moderate');
    const canManageTags = hasPermission(context.user, 'qa.manage_tags');
    const adminTabs = [
      canModerate ? ['moderation', context.tf(context.locale, 'moderation', 'Moderation')] : null,
      canManageTags ? ['tags', context.tf(context.locale, 'tags', 'Tags')] : null,
      canModerate ? ['permissions', context.tf(context.locale, 'permissions', 'Permissions')] : null
    ].filter(Boolean);
    const activeTab = adminTabs[0]?.[0] || '';
    const body = `
      <div class="app-shell" data-qa-admin-page data-css-href="${context.pluginAssetUrl(feature.key, 'qa.css')}">
        ${context.renderTopbar(context.user, context.locale, '/admin/qa')}
        <main class="admin-page qa-admin-page">
          <div class="admin-header"><div><h1>${context.escapeHtml(copy.label)}</h1><p class="hint">${context.escapeHtml(copy.description)}</p></div><div class="row-actions"><a class="button ghost" href="/qa">${context.tf(context.locale, 'openQa', 'Open Q&A')}</a><a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a></div></div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <nav class="builder-subnav">
            ${adminTabs.map(([key, label]) => `<button class="admin-tab-button ${key === activeTab ? 'active' : ''}" type="button" data-qa-admin-tab="${key}">${label}</button>`).join('')}
          </nav>
          <section id="qaAdminRoot" class="qa-admin-root"></section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'qa.js')], pluginKeys: [feature.key] });
  }

  function renderQuestionDialog(context) {
    return `
      <dialog id="qaQuestionDialog" class="modal-dialog qa-dialog">
        <form id="qaQuestionForm" class="modal-form">
          <div class="qa-dialog-head"><div><p class="eyebrow">${context.tf(context.locale, 'qa', 'Q&A')}</p><h2>${context.tf(context.locale, 'askQuestion', 'Ask question')}</h2></div><button class="button ghost" type="button" data-close-question-dialog>${context.tf(context.locale, 'close', 'Close')}</button></div>
          <label>${context.tf(context.locale, 'title', 'Title')}<input name="title" required></label>
          <label>${context.tf(context.locale, 'content', 'Content')}<textarea name="content" required></textarea></label>
          <label>${context.tf(context.locale, 'tags', 'Tags')}<select name="tags" multiple size="5" data-qa-tag-select></select></label>
          <div class="modal-actions"><button class="button primary" type="submit">${context.tf(context.locale, 'save', 'Save')}</button></div>
        </form>
      </dialog>
    `;
  }

  function sendAdminSupport(context) {
    context.sendJson(context.res, 200, {
      tags: listTags(),
      questions: listAllQuestions(context.user).map((question) => serializeQuestionSummary(question, context.user)),
      roles: context.listRoles(),
      permissions: getPermissionMatrix(),
      permissionKeys: QA_PERMISSION_KEYS,
      can: getCapabilities(context.user)
    });
  }

  function listQuestions(context) {
    const q = String(context.url.searchParams.get('q') || '').trim().toLowerCase();
    const tag = String(context.url.searchParams.get('tag') || '').trim();
    const status = String(context.url.searchParams.get('status') || '').trim();
    let rows = listAllQuestions(context.user);
    if (q) rows = rows.filter((question) => [question.title, question.content].some((value) => String(value || '').toLowerCase().includes(q)));
    if (tag) rows = rows.filter((question) => question.tags.some((item) => item.slug === tag));
    if (QUESTION_STATUSES.has(status)) rows = rows.filter((question) => question.status === status);
    context.sendJson(context.res, 200, { items: rows.map((question) => serializeQuestionSummary(question, context.user)), tags: listTags(), can: getCapabilities(context.user) });
  }

  function getQuestionDetail(context) {
    const question = getQuestionBySlug(context.url.searchParams.get('slug'));
    if (!question) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'questionNotFound', 'Question not found.') });
    context.sendJson(context.res, 200, serializeQuestionDetail(question, context.user));
  }

  async function saveQuestion(context) {
    const payload = await context.readJson(context.req);
    const title = String(payload.title || '').trim();
    const content = String(payload.content || '').trim();
    if (!title) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'questionTitleRequired', 'A question title is required.') });
    if (!content) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'questionContentRequired', 'Question content is required.') });
    const slug = uniqueSlug(context, 'qa_questions', payload.slug || title);
    const tagIds = normalizeIdArray(payload.tags).filter((id) => tagExists(id));
    let questionId = null;
    db.exec('BEGIN');
    try {
      const result = db.prepare('INSERT INTO qa_questions (title, slug, content, author_user_id, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)').run(title, slug, content, context.user.id);
      questionId = result.lastInsertRowid;
      for (const tagId of tagIds) db.prepare('INSERT OR IGNORE INTO qa_question_tags (question_id, tag_id) VALUES (?, ?)').run(questionId, tagId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const saved = serializeQuestionDetail(getQuestionById(questionId), context.user);
    await context.emitPluginEvent('qa.question.created', saved, { source: { plugin: feature.key } });
    context.sendJson(context.res, 200, { ok: true, question: saved });
  }

  async function saveAnswer(context) {
    const payload = await context.readJson(context.req);
    const question = getQuestionBySlug(payload.slug);
    if (!question) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'questionNotFound', 'Question not found.') });
    if (question.status === 'closed' && !hasPermission(context.user, 'qa.moderate')) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'questionClosed', 'This question is closed.') });
    const content = String(payload.content || '').trim();
    if (!content) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'answerContentRequired', 'Answer content is required.') });
    const result = db.prepare('INSERT INTO qa_answers (question_id, author_user_id, content, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(question.id, context.user.id, content);
    db.prepare('UPDATE qa_questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(question.id);
    const saved = serializeQuestionDetail(getQuestionById(question.id), context.user);
    await context.emitPluginEvent('qa.answer.created', { answerId: Number(result.lastInsertRowid), question: saved }, { source: { plugin: feature.key } });
    context.sendJson(context.res, 200, saved);
  }

  async function voteQuestion(context) {
    const payload = await context.readJson(context.req);
    const question = getQuestionById(payload.questionId || payload.question_id);
    if (!question) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'questionNotFound', 'Question not found.') });
    setVote('qa_question_votes', 'question_id', question.id, context.user.id, payload.value);
    context.sendJson(context.res, 200, serializeQuestionDetail(getQuestionById(question.id), context.user));
  }

  async function voteAnswer(context) {
    const payload = await context.readJson(context.req);
    const answer = getAnswerById(payload.answerId || payload.answer_id);
    if (!answer) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'answerNotFound', 'Answer not found.') });
    setVote('qa_answer_votes', 'answer_id', answer.id, context.user.id, payload.value);
    context.sendJson(context.res, 200, serializeQuestionDetail(getQuestionById(answer.questionId), context.user));
  }

  async function acceptAnswer(context) {
    const payload = await context.readJson(context.req);
    const answer = getAnswerById(payload.answerId || payload.answer_id);
    if (!answer) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'answerNotFound', 'Answer not found.') });
    const question = getQuestionById(answer.questionId);
    if (!(hasPermission(context.user, 'qa.moderate') || (question.authorUserId === context.user.id && hasPermission(context.user, 'qa.accept_answer')))) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'acceptAnswerRequired', 'Accept answer permissions required.') });
    db.prepare('UPDATE qa_questions SET accepted_answer_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(answer.id, 'solved', question.id);
    context.sendJson(context.res, 200, serializeQuestionDetail(getQuestionById(question.id), context.user));
  }

  async function moderateQuestionStatus(context) {
    const payload = await context.readJson(context.req);
    const question = getQuestionById(payload.questionId || payload.question_id);
    const status = String(payload.status || '').trim();
    if (!question || !QUESTION_STATUSES.has(status)) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'invalidStatus', 'Invalid status.') });
    db.prepare('UPDATE qa_questions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, question.id);
    context.sendJson(context.res, 200, { ok: true, question: serializeQuestionDetail(getQuestionById(question.id), context.user) });
  }

  async function saveTag(context) {
    const payload = await context.readJson(context.req);
    const id = Number(payload.id || 0);
    const name = String(payload.name || '').trim();
    if (!name) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'tagNameRequired', 'A tag name is required.') });
    const slug = id ? uniqueSlug(context, 'qa_tags', payload.slug || name, id) : uniqueSlug(context, 'qa_tags', payload.slug || name);
    const color = sanitizeColor(payload.color || '#4f7cff');
    if (id) db.prepare('UPDATE qa_tags SET name = ?, slug = ?, color = ? WHERE id = ?').run(name, slug, color, id);
    else db.prepare('INSERT INTO qa_tags (name, slug, color) VALUES (?, ?, ?)').run(name, slug, color);
    context.sendJson(context.res, 200, { ok: true, tags: listTags() });
  }

  function deleteTag(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/admin/qa/tags/'.length)));
    db.prepare('DELETE FROM qa_tags WHERE id = ?').run(id);
    context.sendJson(context.res, 200, { ok: true });
  }

  async function savePermissions(context) {
    const payload = await context.readJson(context.req);
    const permissions = payload.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};
    const validRoles = new Set(context.listRoles().map((role) => role.name));
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM qa_permissions').run();
      for (const key of QA_PERMISSION_KEYS) {
        for (const role of normalizeStringArray(permissions[key]).filter((role) => validRoles.has(role))) {
          db.prepare('INSERT OR IGNORE INTO qa_permissions (permission_key, role_name) VALUES (?, ?)').run(key, role);
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
    if (db.prepare('SELECT COUNT(*) AS count FROM qa_permissions').get().count) return;
    for (const key of QA_PERMISSION_KEYS) db.prepare('INSERT OR IGNORE INTO qa_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Admins');
    for (const key of ['qa.view', 'qa.ask', 'qa.answer', 'qa.vote', 'qa.accept_answer']) db.prepare('INSERT OR IGNORE INTO qa_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Users');
  }

  function getSeedAdminId(context) {
    return context.db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get()?.id || null;
  }

  function hasPermission(user, key) {
    if (user?.is_admin) return true;
    return Boolean(user?.roles?.some((role) => db.prepare('SELECT 1 FROM qa_permissions WHERE permission_key = ? AND role_name = ?').get(key, role)));
  }

  function getPermissionMatrix() {
    const matrix = Object.fromEntries(QA_PERMISSION_KEYS.map((key) => [key, []]));
    for (const row of db.prepare('SELECT permission_key, role_name FROM qa_permissions ORDER BY permission_key, role_name').all()) {
      if (!matrix[row.permission_key]) matrix[row.permission_key] = [];
      matrix[row.permission_key].push(row.role_name);
    }
    return matrix;
  }

  function getCapabilities(user) {
    return Object.fromEntries(QA_PERMISSION_KEYS.map((key) => [key.replace('qa.', '').replace(/_([a-z])/g, (_, char) => char.toUpperCase()), hasPermission(user, key)]));
  }

  function listAllQuestions(user) {
    return db.prepare(`
      SELECT q.*, u.name AS author_name, u.email AS author_email
      FROM qa_questions q
      LEFT JOIN users u ON u.id = q.author_user_id
      ORDER BY q.updated_at DESC, q.id DESC
    `).all().map(normalizeQuestionRow);
  }

  function getQuestionBySlug(slug) {
    const row = db.prepare(`
      SELECT q.*, u.name AS author_name, u.email AS author_email
      FROM qa_questions q
      LEFT JOIN users u ON u.id = q.author_user_id
      WHERE q.slug = ?
    `).get(String(slug || '').trim());
    return row ? normalizeQuestionRow(row) : null;
  }

  function getQuestionById(id) {
    const row = db.prepare(`
      SELECT q.*, u.name AS author_name, u.email AS author_email
      FROM qa_questions q
      LEFT JOIN users u ON u.id = q.author_user_id
      WHERE q.id = ?
    `).get(Number(id || 0));
    return row ? normalizeQuestionRow(row) : null;
  }

  function normalizeQuestionRow(row) {
    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      content: row.content || '',
      authorUserId: row.author_user_id,
      author: row.author_email ? { id: row.author_user_id, name: row.author_name || row.author_email, email: row.author_email } : null,
      status: QUESTION_STATUSES.has(row.status) ? row.status : 'open',
      acceptedAnswerId: row.accepted_answer_id,
      tags: getQuestionTags(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function serializeQuestionSummary(question, user) {
    const answerCount = db.prepare('SELECT COUNT(*) AS count FROM qa_answers WHERE question_id = ?').get(question.id).count;
    return { ...question, content: question.content.slice(0, 260), answerCount, score: voteScore('qa_question_votes', 'question_id', question.id), myVote: myVote('qa_question_votes', 'question_id', question.id, user.id), can: questionCapabilities(question, user) };
  }

  function serializeQuestionDetail(question, user) {
    const answers = db.prepare(`
      SELECT a.*, u.name AS author_name, u.email AS author_email
      FROM qa_answers a
      LEFT JOIN users u ON u.id = a.author_user_id
      WHERE a.question_id = ?
      ORDER BY a.id = ? DESC, a.created_at ASC
    `).all(question.id, question.acceptedAnswerId || 0).map((row) => serializeAnswer(row, user, question));
    return { ...serializeQuestionSummary(question, user), content: question.content, answers, can: questionCapabilities(question, user) };
  }

  function serializeAnswer(row, user, question) {
    return {
      id: row.id,
      questionId: row.question_id,
      authorUserId: row.author_user_id,
      author: row.author_email ? { id: row.author_user_id, name: row.author_name || row.author_email, email: row.author_email } : null,
      content: row.content || '',
      accepted: question.acceptedAnswerId === row.id,
      score: voteScore('qa_answer_votes', 'answer_id', row.id),
      myVote: myVote('qa_answer_votes', 'answer_id', row.id, user.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function questionCapabilities(question, user) {
    return {
      ask: hasPermission(user, 'qa.ask'),
      answer: hasPermission(user, 'qa.answer') && (question.status !== 'closed' || hasPermission(user, 'qa.moderate')),
      vote: hasPermission(user, 'qa.vote'),
      acceptAnswer: hasPermission(user, 'qa.moderate') || (question.authorUserId === user.id && hasPermission(user, 'qa.accept_answer')),
      moderate: hasPermission(user, 'qa.moderate')
    };
  }

  function getAnswerById(id) {
    const row = db.prepare('SELECT id, question_id, author_user_id, content FROM qa_answers WHERE id = ?').get(Number(id || 0));
    return row ? { id: row.id, questionId: row.question_id, authorUserId: row.author_user_id, content: row.content || '' } : null;
  }

  function getQuestionTags(questionId) {
    return db.prepare('SELECT t.* FROM qa_tags t JOIN qa_question_tags qt ON qt.tag_id = t.id WHERE qt.question_id = ? ORDER BY t.name').all(questionId).map(normalizeTagRow);
  }

  function listTags() {
    return db.prepare('SELECT * FROM qa_tags ORDER BY name').all().map(normalizeTagRow);
  }

  function normalizeTagRow(row) {
    return { id: row.id, name: row.name, slug: row.slug, color: sanitizeColor(row.color || '#4f7cff') };
  }

  function tagExists(id) {
    return Boolean(db.prepare('SELECT 1 FROM qa_tags WHERE id = ?').get(id));
  }

  function setVote(table, column, targetId, userId, rawValue) {
    const value = Number(rawValue);
    if (!VOTE_VALUES.has(value)) return;
    const existing = db.prepare(`SELECT id, value FROM ${table} WHERE ${column} = ? AND user_id = ?`).get(targetId, userId);
    if (existing?.value === value) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(existing.id);
    else if (existing) db.prepare(`UPDATE ${table} SET value = ? WHERE id = ?`).run(value, existing.id);
    else db.prepare(`INSERT INTO ${table} (${column}, user_id, value) VALUES (?, ?, ?)`).run(targetId, userId, value);
  }

  function voteScore(table, column, targetId) {
    return Number(db.prepare(`SELECT COALESCE(SUM(value), 0) AS score FROM ${table} WHERE ${column} = ?`).get(targetId).score || 0);
  }

  function myVote(table, column, targetId, userId) {
    return Number(db.prepare(`SELECT value FROM ${table} WHERE ${column} = ? AND user_id = ?`).get(targetId, userId)?.value || 0);
  }

  function uniqueSlug(context, table, source, excludeId = 0) {
    const base = context.slugify(String(source || '').trim()) || 'item';
    let slug = base;
    let index = 2;
    while (db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`).get(slug, excludeId)) slug = `${base}-${index++}`;
    return slug;
  }

  function normalizeIdArray(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
    return Array.from(new Set(source.map(Number).filter((item) => Number.isInteger(item) && item > 0)));
  }

  function normalizeStringArray(value) {
    if (Array.isArray(value)) return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
    return String(value || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  }

  function sanitizeColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#4f7cff';
  }
}
