import { join } from 'node:path';

const TASK_PERMISSION_KEYS = [
  'tasks.view',
  'tasks.create',
  'tasks.edit',
  'tasks.assign',
  'tasks.comment',
  'tasks.manage_boards',
  'tasks.delete'
];
const BOARD_PERMISSION_KEYS = TASK_PERMISSION_KEYS;
const VISIBILITIES = new Set(['private', 'roles', 'public']);
const CARD_STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done', 'archived']);

export default function createTasksPlugin({ manifest, rootDir }) {
  let db = null;
  let helpers = null;

  const feature = {
    key: manifest.key || 'tasks',
    label: manifest.name || 'Tasks',
    href: '/tasks',
    description: manifest.description || 'Boards, Kanban columns and tasks with labels, comments, assignees and board permissions.',
    defaultEnabled: true
  };

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    localesDir: join(rootDir, 'locales'),
    adminPage: { href: '/admin/tasks', label: manifest.name || 'Tasks' },
    init(context) {
      db = context.db;
      helpers = context;
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_boards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          visibility TEXT NOT NULL DEFAULT 'private',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS task_columns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          board_id INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS task_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          board_id INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
          column_id INTEGER NOT NULL REFERENCES task_columns(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          due_date TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'todo',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS task_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_card_id INTEGER NOT NULL REFERENCES task_cards(id) ON DELETE CASCADE,
          author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS task_labels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          board_id INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#4f7cff'
        );
        CREATE TABLE IF NOT EXISTS task_card_labels (
          task_card_id INTEGER NOT NULL REFERENCES task_cards(id) ON DELETE CASCADE,
          label_id INTEGER NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
          PRIMARY KEY (task_card_id, label_id)
        );
        CREATE TABLE IF NOT EXISTS task_permissions (
          permission_key TEXT NOT NULL,
          role_name TEXT NOT NULL,
          PRIMARY KEY (permission_key, role_name)
        );
        CREATE TABLE IF NOT EXISTS task_board_permissions (
          board_id INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
          permission_key TEXT NOT NULL,
          principal_type TEXT NOT NULL,
          principal TEXT NOT NULL,
          PRIMARY KEY (board_id, permission_key, principal_type, principal)
        );
        CREATE INDEX IF NOT EXISTS idx_task_boards_status ON task_boards(status);
        CREATE INDEX IF NOT EXISTS idx_task_columns_board ON task_columns(board_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_task_cards_board ON task_cards(board_id, column_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_task_comments_card ON task_comments(task_card_id, created_at);
      `);
      seedDefaultPermissions();
    },
    resetToFactoryDefaults(context) {
      context.db.exec(`
        DELETE FROM task_card_labels;
        DELETE FROM task_comments;
        DELETE FROM task_cards;
        DELETE FROM task_labels;
        DELETE FROM task_columns;
        DELETE FROM task_board_permissions;
        DELETE FROM task_permissions;
        DELETE FROM task_boards;
        DELETE FROM sqlite_sequence WHERE name IN ('task_boards', 'task_columns', 'task_cards', 'task_comments', 'task_labels');
      `);
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/tasks/support-data' && req.method === 'GET') return requireTasksAdmin(context, () => sendSupportData(context));
      if (url.pathname === '/api/admin/tasks/permissions' && req.method === 'POST') return requireTasksAdmin(context, () => saveGlobalPermissions(context));
      if (url.pathname === '/api/admin/tasks/boards' && req.method === 'GET') return requireTasksAdmin(context, () => sendBoards(context, { admin: true }));

      if (url.pathname === '/api/tasks/boards' && req.method === 'GET') return requireEnabled(context, () => requireGlobal(context, 'tasks.view', () => sendBoards(context)));
      if (url.pathname === '/api/tasks/board' && req.method === 'GET') return requireEnabled(context, () => sendBoardDetail(context));
      if (url.pathname === '/api/tasks/board' && req.method === 'POST') return requireEnabled(context, () => saveBoard(context));
      if (url.pathname.startsWith('/api/tasks/board/') && req.method === 'DELETE') return requireEnabled(context, () => archiveBoard(context));
      if (url.pathname === '/api/tasks/columns' && req.method === 'POST') return requireEnabled(context, () => saveColumns(context));
      if (url.pathname === '/api/tasks/labels' && req.method === 'POST') return requireEnabled(context, () => saveLabel(context));
      if (url.pathname.startsWith('/api/tasks/labels/') && req.method === 'DELETE') return requireEnabled(context, () => deleteLabel(context));
      if (url.pathname === '/api/tasks/cards' && req.method === 'POST') return requireEnabled(context, () => saveCard(context));
      if (url.pathname === '/api/tasks/cards/move' && req.method === 'POST') return requireEnabled(context, () => moveCard(context));
      if (url.pathname.startsWith('/api/tasks/cards/') && req.method === 'DELETE') return requireEnabled(context, () => archiveCard(context));
      if (url.pathname === '/api/tasks/comments' && req.method === 'POST') return requireEnabled(context, () => addComment(context));

      if (url.pathname === '/tasks' || url.pathname.startsWith('/tasks/')) {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'tasksFeatureDisabledNotice', 'The tasks feature is currently disabled.') }));
          return true;
        }
        if (!hasGlobalPermission(user, 'tasks.view')) {
          context.sendHtml(res, 403, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'tasksViewRequired', 'Tasks permissions are required.') }));
          return true;
        }
        context.sendHtml(res, 200, renderTasksPage(context));
        return true;
      }

      if (url.pathname === '/admin/tasks') return requireTasksAdmin(context, () => context.sendHtml(res, 200, renderTasksAdminPage(context)));
      return false;
    }
  };

  async function requireEnabled(context, callback) {
    if (!context.isPluginEnabled(feature.key)) {
      context.sendJson(context.res, 404, { error: context.tf(context.locale, 'tasksFeatureDisabled', 'The tasks feature is currently disabled.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requireGlobal(context, permissionKey, callback) {
    if (!hasGlobalPermission(context.user, permissionKey)) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksPermissionRequired', 'Tasks permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  async function requireTasksAdmin(context, callback) {
    if (!(hasGlobalPermission(context.user, 'tasks.manage_boards') || ownsAnyBoard(context.user))) {
      context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksManageRequired', 'Board management permissions required.') });
      return true;
    }
    await callback();
    return true;
  }

  function renderTasksPage(context) {
    const settings = context.getSettings();
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const requestedId = context.url.searchParams.get('board') || '';
    const body = `
      <div class="app-shell tasks-page" data-tasks-app data-board-id="${context.escapeAttribute(requestedId)}" data-css-href="${context.pluginAssetUrl(feature.key, 'tasks.css')}">
        ${context.renderTopbar(context.user, context.locale, '/tasks')}
        <main class="tasks-workspace">
          <section class="tasks-header">
            <div>
              <p class="eyebrow">${context.tf(context.locale, 'tasks', 'Tasks')}</p>
              <h1>${context.escapeHtml(copy.label)}</h1>
              <p class="hint">${context.escapeHtml(copy.description)}</p>
            </div>
            <div class="row-actions">
              <button class="button primary" type="button" data-new-board hidden>${context.tf(context.locale, 'createBoard', 'Create board')}</button>
              <button class="button ghost" type="button" data-new-card hidden>${context.tf(context.locale, 'createTask', 'Create task')}</button>
              ${hasGlobalPermission(context.user, 'tasks.manage_boards') || ownsAnyBoard(context.user) ? `<a class="button ghost" href="/admin/tasks">${context.tf(context.locale, 'admin', 'Admin')}</a>` : ''}
            </div>
          </section>
          <section id="tasksNotice" class="notice" hidden></section>
          <section id="tasksBoardOverview" class="tasks-board-grid"></section>
          <section id="tasksKanban" class="tasks-kanban-shell" hidden>
            <div class="tasks-board-topline">
              <button class="button ghost" type="button" data-back-to-boards>${context.tf(context.locale, 'boards', 'Boards')}</button>
              <div><h2 id="tasksBoardTitle"></h2><p id="tasksBoardDescription" class="hint"></p></div>
            </div>
            <div id="tasksColumns" class="tasks-columns"></div>
          </section>
        </main>
        ${renderTaskDialog(context)}
        ${renderBoardDialog(context)}
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'tasks.js')], pluginKeys: [feature.key] });
  }

  function renderTasksAdminPage(context) {
    const settings = context.getSettings();
    const copy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell" data-tasks-admin-page data-css-href="${context.pluginAssetUrl(feature.key, 'tasks.css')}">
        ${context.renderTopbar(context.user, context.locale, '/admin/tasks')}
        <main class="admin-page tasks-admin-page">
          <div class="admin-header">
            <div><h1>${context.escapeHtml(copy.label)}</h1><p class="hint">${context.escapeHtml(copy.description)}</p></div>
            <div class="row-actions">
              <button class="button primary" type="button" data-new-board>${context.tf(context.locale, 'createBoard', 'Create board')}</button>
              <a class="button ghost" href="/tasks">${context.tf(context.locale, 'openTasks', 'Open tasks')}</a>
              <a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a>
            </div>
          </div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <section id="tasksNotice" class="notice" hidden></section>
          <section class="tasks-admin-grid">
            <div class="panel">
              <div class="panel-head"><h2>${context.tf(context.locale, 'boards', 'Boards')}</h2></div>
              <div id="tasksAdminBoards" class="tasks-admin-list"></div>
            </div>
            <div class="panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'boardDetails', 'Board details')}</h2>
                <div class="row-actions">
                  <button class="button ghost" type="button" data-edit-board hidden>${context.tf(context.locale, 'edit', 'Edit')}</button>
                  <button class="button danger" type="button" data-archive-board hidden>${context.tf(context.locale, 'archive', 'Archive')}</button>
                </div>
              </div>
              <div id="tasksAdminDetail" class="tasks-admin-detail"></div>
            </div>
            <div class="panel tasks-permissions-panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'permissions', 'Permissions')}</h2>
                <button class="button primary" type="button" data-save-task-permissions>${context.tf(context.locale, 'savePermissions', 'Save permissions')}</button>
              </div>
              <div id="tasksPermissionMatrix"></div>
            </div>
          </section>
        </main>
        ${renderTaskDialog(context)}
        ${renderBoardDialog(context)}
        ${renderLabelDialog(context)}
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: copy.label, body, settings, locale: context.locale, scripts: [context.pluginAssetUrl(feature.key, 'tasks.js')], pluginKeys: [feature.key] });
  }

  function renderTaskDialog(context) {
    return `
      <dialog id="taskEditorDialog" class="modal-dialog tasks-dialog">
        <form id="taskEditorForm" class="modal-form">
          <input name="id" type="hidden">
          <input name="board_id" type="hidden">
          <div class="tasks-dialog-head"><div><p class="eyebrow">${context.tf(context.locale, 'tasks', 'Tasks')}</p><h2 id="taskEditorTitle">${context.tf(context.locale, 'taskDetails', 'Task details')}</h2></div><button class="button ghost" type="button" data-close-task-dialog>${context.tf(context.locale, 'close', 'Close')}</button></div>
          <div class="content-meta">
            <label>${context.tf(context.locale, 'title', 'Title')} <input name="title" required></label>
            <label>${context.tf(context.locale, 'column', 'Column')} <select name="column_id" required></select></label>
            <label>${context.tf(context.locale, 'status', 'Status')} <select name="status">${Array.from(CARD_STATUSES).map((status) => `<option value="${status}">${context.escapeHtml(status)}</option>`).join('')}</select></label>
          </div>
          <label>${context.tf(context.locale, 'description', 'Description')} <textarea name="description"></textarea></label>
          <div class="content-meta">
            <label>${context.tf(context.locale, 'assignee', 'Assignee')} <select name="assigned_user_id"></select></label>
            <label>${context.tf(context.locale, 'dueDate', 'Due date')} <input name="due_date" type="date"></label>
            <label>${context.tf(context.locale, 'tags', 'Tags')} <select name="labels" multiple size="4"></select></label>
          </div>
          <section id="taskComments" class="tasks-comments"></section>
          <div class="modal-actions">
            <button class="button danger" type="button" data-archive-task hidden>${context.tf(context.locale, 'archive', 'Archive')}</button>
            <button class="button primary" type="submit">${context.tf(context.locale, 'save', 'Save')}</button>
          </div>
        </form>
      </dialog>
    `;
  }

  function renderBoardDialog(context) {
    return `
      <dialog id="boardEditorDialog" class="modal-dialog tasks-dialog">
        <form id="boardEditorForm" class="modal-form">
          <input name="id" type="hidden">
          <div class="tasks-dialog-head"><div><p class="eyebrow">${context.tf(context.locale, 'boards', 'Boards')}</p><h2>${context.tf(context.locale, 'boardEditor', 'Board editor')}</h2></div><button class="button ghost" type="button" data-close-board-dialog>${context.tf(context.locale, 'close', 'Close')}</button></div>
          <div class="content-meta">
            <label>${context.tf(context.locale, 'name', 'Name')} <input name="name" required></label>
            <label>${context.tf(context.locale, 'owner', 'Owner')} <select name="owner_user_id"></select></label>
            <label>${context.tf(context.locale, 'visibility', 'Visibility')} <select name="visibility"><option value="private">private</option><option value="roles">roles</option><option value="public">public</option></select></label>
          </div>
          <label>${context.tf(context.locale, 'description', 'Description')} <textarea name="description"></textarea></label>
          <section class="tasks-dialog-section">
            <div class="panel-head compact"><h3>${context.tf(context.locale, 'permissions', 'Permissions')}</h3></div>
            <div id="boardPermissionMatrix" class="tasks-board-permissions"></div>
          </section>
          <div class="modal-actions"><button class="button primary" type="submit">${context.tf(context.locale, 'save', 'Save')}</button></div>
        </form>
      </dialog>
    `;
  }

  function renderLabelDialog(context) {
    return `
      <dialog id="labelEditorDialog" class="modal-dialog tasks-dialog">
        <form id="labelEditorForm" class="modal-form">
          <input name="id" type="hidden">
          <input name="board_id" type="hidden">
          <div class="tasks-dialog-head"><div><p class="eyebrow">${context.tf(context.locale, 'tags', 'Tags')}</p><h2>${context.tf(context.locale, 'tagEditor', 'Tag editor')}</h2></div><button class="button ghost" type="button" data-close-label-dialog>${context.tf(context.locale, 'close', 'Close')}</button></div>
          <div class="content-meta">
            <label>${context.tf(context.locale, 'name', 'Name')} <input name="name" required></label>
            <label>${context.tf(context.locale, 'color', 'Color')} <input name="color" type="color" value="#4f7cff"></label>
          </div>
          <div class="modal-actions"><button class="button danger" type="button" data-delete-label hidden>${context.tf(context.locale, 'delete', 'Delete')}</button><button class="button primary" type="submit">${context.tf(context.locale, 'save', 'Save')}</button></div>
        </form>
      </dialog>
    `;
  }

  function sendSupportData(context) {
    context.sendJson(context.res, 200, {
      roles: context.listRoles(),
      users: context.listUsers().map((item) => context.publicUser(item)),
      permissions: getGlobalPermissionMatrix(),
      permissionKeys: TASK_PERMISSION_KEYS,
      boardPermissionKeys: BOARD_PERMISSION_KEYS
    });
  }

  async function saveGlobalPermissions(context) {
    const payload = await context.readJson(context.req);
    const permissions = payload.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};
    const validRoles = new Set(context.listRoles().map((role) => role.name));
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM task_permissions').run();
      for (const key of TASK_PERMISSION_KEYS) {
        for (const role of normalizeStringArray(permissions[key]).filter((item) => validRoles.has(item))) {
          db.prepare('INSERT OR IGNORE INTO task_permissions (permission_key, role_name) VALUES (?, ?)').run(key, role);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    context.sendJson(context.res, 200, { ok: true, permissions: getGlobalPermissionMatrix() });
  }

  function sendBoards(context, options = {}) {
    const boards = listBoards({ includeArchived: options.admin })
      .filter((board) => options.admin ? canManageBoard(context.user, board) : canSeeBoard(context.user, board))
      .map((board) => serializeBoardSummary(board, context.user));
    context.sendJson(context.res, 200, { boards, can: getUserCapabilities(context.user) });
  }

  function sendBoardDetail(context) {
    const board = getBoardById(context.url.searchParams.get('id'));
    if (!board || board.status === 'archived' || !canSeeBoard(context.user, board)) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'boardNotFound', 'Board not found.') });
    context.sendJson(context.res, 200, serializeBoardDetail(board, context.user));
  }

  async function saveBoard(context) {
    const payload = await context.readJson(context.req);
    const id = Number(payload.id || 0);
    const existing = id ? getBoardById(id) : null;
    if (id && !existing) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'boardNotFound', 'Board not found.') });
    if (!existing && !hasGlobalPermission(context.user, 'tasks.manage_boards') && !hasGlobalPermission(context.user, 'tasks.create')) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksCreateRequired', 'Create permissions required.') });
    if (existing && !canManageBoard(context.user, existing)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksManageRequired', 'Board management permissions required.') });

    const name = String(payload.name || '').trim();
    if (!name) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'boardNameRequired', 'A board name is required.') });
    const description = String(payload.description || '').trim();
    const visibility = VISIBILITIES.has(String(payload.visibility || 'private')) ? String(payload.visibility || 'private') : 'private';
    const ownerUserId = validUserId(payload.ownerUserId ?? payload.owner_user_id) || context.user.id;

    let boardId = id;
    db.exec('BEGIN');
    try {
      if (existing) {
        db.prepare('UPDATE task_boards SET name = ?, description = ?, owner_user_id = ?, visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, description, ownerUserId, visibility, id);
      } else {
        const result = db.prepare('INSERT INTO task_boards (name, description, owner_user_id, visibility, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)').run(name, description, ownerUserId, visibility);
        boardId = result.lastInsertRowid;
        createDefaultColumns(boardId);
      }
      if (payload.permissions && typeof payload.permissions === 'object') saveBoardPermissions(boardId, payload.permissions, context);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    context.sendJson(context.res, 200, { ok: true, board: serializeBoardDetail(getBoardById(boardId), context.user) });
  }

  async function archiveBoard(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/tasks/board/'.length)));
    const board = getBoardById(id);
    if (!board) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'boardNotFound', 'Board not found.') });
    if (!canDeleteBoard(context.user, board)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksDeleteRequired', 'Delete permissions required.') });
    db.prepare('UPDATE task_boards SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('archived', id);
    context.sendJson(context.res, 200, { ok: true });
  }

  async function saveColumns(context) {
    const payload = await context.readJson(context.req);
    const board = getBoardById(payload.boardId ?? payload.board_id);
    if (!board || !canManageBoard(context.user, board)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksManageRequired', 'Board management permissions required.') });
    const columns = Array.isArray(payload.columns) ? payload.columns : [];
    db.exec('BEGIN');
    try {
      for (const [index, column] of columns.entries()) {
        const id = Number(column.id || 0);
        const name = String(column.name || '').trim();
        if (!name) continue;
        if (id) db.prepare('UPDATE task_columns SET name = ?, sort_order = ? WHERE id = ? AND board_id = ?').run(name, index, id, board.id);
        else db.prepare('INSERT INTO task_columns (board_id, name, sort_order) VALUES (?, ?, ?)').run(board.id, name, index);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    context.sendJson(context.res, 200, serializeBoardDetail(getBoardById(board.id), context.user));
  }

  async function saveLabel(context) {
    const payload = await context.readJson(context.req);
    const board = getBoardById(payload.boardId ?? payload.board_id);
    if (!board || !canManageBoard(context.user, board)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksManageRequired', 'Board management permissions required.') });
    const id = Number(payload.id || 0);
    const name = String(payload.name || '').trim();
    const color = sanitizeColor(payload.color || '#4f7cff');
    if (!name) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'labelNameRequired', 'A label name is required.') });
    if (id) db.prepare('UPDATE task_labels SET name = ?, color = ? WHERE id = ? AND board_id = ?').run(name, color, id, board.id);
    else db.prepare('INSERT INTO task_labels (board_id, name, color) VALUES (?, ?, ?)').run(board.id, name, color);
    context.sendJson(context.res, 200, serializeBoardDetail(getBoardById(board.id), context.user));
  }

  async function deleteLabel(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/tasks/labels/'.length)));
    const row = db.prepare('SELECT board_id FROM task_labels WHERE id = ?').get(id);
    const board = row ? getBoardById(row.board_id) : null;
    if (!board || !canManageBoard(context.user, board)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksManageRequired', 'Board management permissions required.') });
    db.prepare('DELETE FROM task_labels WHERE id = ?').run(id);
    context.sendJson(context.res, 200, serializeBoardDetail(getBoardById(board.id), context.user));
  }

  async function saveCard(context) {
    const payload = await context.readJson(context.req);
    const id = Number(payload.id || 0);
    const existing = id ? getCardById(id) : null;
    const board = getBoardById(existing?.boardId || payload.boardId || payload.board_id);
    if (!board) return context.sendJson(context.res, 404, { error: context.tf(context.locale, 'boardNotFound', 'Board not found.') });
    if (existing && !canEditBoard(context.user, board)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksEditRequired', 'Edit permissions required.') });
    if (!existing && !canCreateCard(context.user, board)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksCreateRequired', 'Create permissions required.') });

    const title = String(payload.title || '').trim();
    if (!title) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'taskTitleRequired', 'A task title is required.') });
    const columnId = validColumnId(board.id, payload.columnId ?? payload.column_id);
    if (!columnId) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'columnRequired', 'A column is required.') });
    const assignedUserId = canAssignBoard(context.user, board) ? validUserId(payload.assignedUserId ?? payload.assigned_user_id) : (existing?.assignedUserId || null);
    const dueDate = normalizeDate(payload.dueDate ?? payload.due_date);
    const status = CARD_STATUSES.has(String(payload.status || 'todo')) ? String(payload.status || 'todo') : 'todo';
    const labelIds = normalizeIdArray(payload.labelIds ?? payload.label_ids).filter((labelId) => labelBelongsToBoard(labelId, board.id));

    let savedCardId = id;
    db.exec('BEGIN');
    try {
      let cardId = id;
      if (existing) {
        db.prepare(`
          UPDATE task_cards SET column_id = ?, title = ?, description = ?, assigned_user_id = ?, due_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(columnId, title, String(payload.description || '').trim(), assignedUserId, dueDate, status, id);
      } else {
        const sortOrder = nextCardSortOrder(columnId);
        const result = db.prepare(`
          INSERT INTO task_cards (board_id, column_id, title, description, assigned_user_id, due_date, sort_order, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(board.id, columnId, title, String(payload.description || '').trim(), assignedUserId, dueDate, sortOrder, status);
        cardId = result.lastInsertRowid;
      }
      savedCardId = Number(cardId);
      db.prepare('DELETE FROM task_card_labels WHERE task_card_id = ?').run(cardId);
      for (const labelId of labelIds) db.prepare('INSERT OR IGNORE INTO task_card_labels (task_card_id, label_id) VALUES (?, ?)').run(cardId, labelId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    await context.emitPluginEvent(existing ? 'tasks.card.updated' : 'tasks.card.created', { card: getCardById(savedCardId), boardId: board.id }, { source: { plugin: feature.key } });
    context.sendJson(context.res, 200, serializeBoardDetail(getBoardById(board.id), context.user));
  }

  async function moveCard(context) {
    const payload = await context.readJson(context.req);
    const card = getCardById(payload.cardId ?? payload.card_id);
    const board = card ? getBoardById(card.boardId) : null;
    if (!board || !canEditBoard(context.user, board)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksEditRequired', 'Edit permissions required.') });
    const columnId = validColumnId(board.id, payload.columnId ?? payload.column_id);
    if (!columnId) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'columnRequired', 'A column is required.') });
    const targetIndex = Math.max(0, Number(payload.sortOrder ?? payload.sort_order ?? 0) || 0);
    const status = CARD_STATUSES.has(String(payload.status || card.status)) ? String(payload.status || card.status) : card.status;
    const cards = db.prepare('SELECT id FROM task_cards WHERE board_id = ? AND column_id = ? AND id != ? AND status != ? ORDER BY sort_order, id').all(board.id, columnId, card.id, 'archived').map((item) => item.id);
    cards.splice(Math.min(targetIndex, cards.length), 0, card.id);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE task_cards SET column_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(columnId, status, card.id);
      cards.forEach((cardId, index) => db.prepare('UPDATE task_cards SET sort_order = ? WHERE id = ?').run(index, cardId));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    await context.emitPluginEvent('tasks.card.updated', { card: getCardById(card.id), boardId: board.id }, { source: { plugin: feature.key } });
    context.sendJson(context.res, 200, serializeBoardDetail(getBoardById(board.id), context.user));
  }

  async function archiveCard(context) {
    const id = Number(decodeURIComponent(context.url.pathname.slice('/api/tasks/cards/'.length)));
    const card = getCardById(id);
    const board = card ? getBoardById(card.boardId) : null;
    if (!board || !canDeleteCard(context.user, board)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksDeleteRequired', 'Delete permissions required.') });
    db.prepare('UPDATE task_cards SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('archived', id);
    await context.emitPluginEvent('tasks.card.updated', { card: getCardById(id), boardId: board.id }, { source: { plugin: feature.key } });
    context.sendJson(context.res, 200, serializeBoardDetail(getBoardById(board.id), context.user));
  }

  async function addComment(context) {
    const payload = await context.readJson(context.req);
    const card = getCardById(payload.cardId ?? payload.card_id);
    const board = card ? getBoardById(card.boardId) : null;
    if (!board || !canCommentBoard(context.user, board)) return context.sendJson(context.res, 403, { error: context.tf(context.locale, 'tasksCommentRequired', 'Comment permissions required.') });
    const content = String(payload.content || '').trim();
    if (!content) return context.sendJson(context.res, 400, { error: context.tf(context.locale, 'commentRequired', 'A comment is required.') });
    db.prepare('INSERT INTO task_comments (task_card_id, author_user_id, content) VALUES (?, ?, ?)').run(card.id, context.user.id, content);
    db.prepare('UPDATE task_cards SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(card.id);
    context.sendJson(context.res, 200, serializeBoardDetail(getBoardById(board.id), context.user));
  }

  function seedDefaultPermissions() {
    if (db.prepare('SELECT COUNT(*) AS count FROM task_permissions').get().count) return;
    for (const key of TASK_PERMISSION_KEYS) db.prepare('INSERT OR IGNORE INTO task_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Admins');
    for (const key of ['tasks.view', 'tasks.create', 'tasks.edit', 'tasks.assign', 'tasks.comment']) {
      db.prepare('INSERT OR IGNORE INTO task_permissions (permission_key, role_name) VALUES (?, ?)').run(key, 'Users');
    }
  }

  function createDefaultColumns(boardId) {
    [['To do', 0], ['In progress', 1], ['Done', 2]].forEach(([name, order]) => {
      db.prepare('INSERT INTO task_columns (board_id, name, sort_order) VALUES (?, ?, ?)').run(boardId, name, order);
    });
  }

  function hasGlobalPermission(user, permissionKey) {
    if (user?.is_admin) return true;
    return Boolean(user?.roles?.some((role) => db.prepare('SELECT 1 FROM task_permissions WHERE permission_key = ? AND role_name = ?').get(permissionKey, role)));
  }

  function hasBoardGrant(user, board, permissionKey) {
    if (!user || !board) return false;
    if (board.ownerUserId === user.id && ['tasks.view', 'tasks.edit', 'tasks.assign', 'tasks.comment', 'tasks.create', 'tasks.manage_boards'].includes(permissionKey)) return true;
    if (db.prepare('SELECT 1 FROM task_board_permissions WHERE board_id = ? AND permission_key = ? AND principal_type = ? AND principal = ?').get(board.id, permissionKey, 'user', String(user.id))) return true;
    return Boolean(user.roles?.some((role) => db.prepare('SELECT 1 FROM task_board_permissions WHERE board_id = ? AND permission_key = ? AND principal_type = ? AND principal = ?').get(board.id, permissionKey, 'role', role)));
  }

  function canSeeBoard(user, board) {
    if (!hasGlobalPermission(user, 'tasks.view')) return false;
    if (user?.is_admin || hasGlobalPermission(user, 'tasks.manage_boards')) return true;
    if (board.ownerUserId === user?.id) return true;
    if (board.visibility === 'public') return true;
    return hasBoardGrant(user, board, 'tasks.view') || hasBoardGrant(user, board, 'tasks.edit') || hasBoardGrant(user, board, 'tasks.manage_boards');
  }

  function canManageBoard(user, board) {
    if (user?.is_admin || hasGlobalPermission(user, 'tasks.manage_boards')) return true;
    return hasGlobalPermission(user, 'tasks.edit') && hasBoardGrant(user, board, 'tasks.manage_boards');
  }

  function canCreateCard(user, board) {
    return canManageBoard(user, board) || (hasGlobalPermission(user, 'tasks.create') && hasBoardGrant(user, board, 'tasks.create'));
  }

  function canEditBoard(user, board) {
    return canManageBoard(user, board) || (hasGlobalPermission(user, 'tasks.edit') && hasBoardGrant(user, board, 'tasks.edit'));
  }

  function canAssignBoard(user, board) {
    return canManageBoard(user, board) || (hasGlobalPermission(user, 'tasks.assign') && hasBoardGrant(user, board, 'tasks.assign'));
  }

  function canCommentBoard(user, board) {
    return canManageBoard(user, board) || (hasGlobalPermission(user, 'tasks.comment') && hasBoardGrant(user, board, 'tasks.comment'));
  }

  function canDeleteCard(user, board) {
    return canManageBoard(user, board) || (hasGlobalPermission(user, 'tasks.delete') && hasBoardGrant(user, board, 'tasks.delete'));
  }

  function canDeleteBoard(user, board) {
    return Boolean(user?.is_admin || (hasGlobalPermission(user, 'tasks.delete') && hasBoardGrant(user, board, 'tasks.delete')) || hasGlobalPermission(user, 'tasks.manage_boards'));
  }

  function ownsAnyBoard(user) {
    return Boolean(user?.id && db?.prepare('SELECT 1 FROM task_boards WHERE owner_user_id = ? AND status != ? LIMIT 1').get(user.id, 'archived'));
  }

  function getGlobalPermissionMatrix() {
    const matrix = Object.fromEntries(TASK_PERMISSION_KEYS.map((key) => [key, []]));
    for (const row of db.prepare('SELECT permission_key, role_name FROM task_permissions ORDER BY permission_key, role_name').all()) {
      if (!matrix[row.permission_key]) matrix[row.permission_key] = [];
      matrix[row.permission_key].push(row.role_name);
    }
    return matrix;
  }

  function getUserCapabilities(user, board = null) {
    const global = Object.fromEntries(TASK_PERMISSION_KEYS.map((key) => [capabilityName(key), hasGlobalPermission(user, key)]));
    if (!board) return global;
    return {
      ...global,
      viewBoard: canSeeBoard(user, board),
      createCard: canCreateCard(user, board),
      editBoard: canEditBoard(user, board),
      assign: canAssignBoard(user, board),
      comment: canCommentBoard(user, board),
      manageBoard: canManageBoard(user, board),
      deleteCard: canDeleteCard(user, board),
      deleteBoard: canDeleteBoard(user, board)
    };
  }

  function listBoards({ includeArchived = false } = {}) {
    const rows = includeArchived ? db.prepare('SELECT * FROM task_boards ORDER BY updated_at DESC, id DESC').all() : db.prepare('SELECT * FROM task_boards WHERE status != ? ORDER BY updated_at DESC, id DESC').all('archived');
    return rows.map(normalizeBoardRow);
  }

  function getBoardById(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const row = db.prepare('SELECT * FROM task_boards WHERE id = ?').get(numericId);
    return row ? normalizeBoardRow(row) : null;
  }

  function normalizeBoardRow(row) {
    const owner = row.owner_user_id ? db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(row.owner_user_id) : null;
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      ownerUserId: row.owner_user_id,
      owner: owner ? { id: owner.id, email: owner.email, name: owner.name } : null,
      visibility: VISIBILITIES.has(row.visibility) ? row.visibility : 'private',
      status: row.status || 'active',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function serializeBoardSummary(board, user) {
    const counts = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
        SUM(CASE WHEN due_date IS NOT NULL AND due_date < date('now') AND status != 'done' AND status != 'archived' THEN 1 ELSE 0 END) AS overdue
      FROM task_cards WHERE board_id = ?
    `).get(board.id);
    return { ...board, counts: { total: counts.total || 0, archived: counts.archived || 0, overdue: counts.overdue || 0 }, can: getUserCapabilities(user, board) };
  }

  function serializeBoardDetail(board, user) {
    return {
      ...serializeBoardSummary(board, user),
      permissions: getBoardPermissionMatrix(board.id),
      columns: listColumns(board.id).map((column) => ({ ...column, cards: listCards(board.id, column.id).map(serializeCard) })),
      labels: listLabels(board.id),
      users: helpers.listUsers().map((item) => helpers.publicUser(item)),
      roles: helpers.listRoles()
    };
  }

  function listColumns(boardId) {
    return db.prepare('SELECT id, board_id, name, sort_order FROM task_columns WHERE board_id = ? ORDER BY sort_order, id').all(boardId).map((row) => ({
      id: row.id,
      boardId: row.board_id,
      name: row.name,
      sortOrder: row.sort_order
    }));
  }

  function listLabels(boardId) {
    return db.prepare('SELECT id, board_id, name, color FROM task_labels WHERE board_id = ? ORDER BY name').all(boardId).map((row) => ({
      id: row.id,
      boardId: row.board_id,
      name: row.name,
      color: sanitizeColor(row.color)
    }));
  }

  function listCards(boardId, columnId) {
    return db.prepare(`
      SELECT c.*, u.name AS assignee_name, u.email AS assignee_email
      FROM task_cards c
      LEFT JOIN users u ON u.id = c.assigned_user_id
      WHERE c.board_id = ? AND c.column_id = ? AND c.status != ?
      ORDER BY c.sort_order, c.id
    `).all(boardId, columnId, 'archived');
  }

  function serializeCard(row) {
    const labels = db.prepare(`
      SELECT l.id, l.board_id, l.name, l.color
      FROM task_labels l
      JOIN task_card_labels cl ON cl.label_id = l.id
      WHERE cl.task_card_id = ?
      ORDER BY l.name
    `).all(row.id).map((label) => ({ id: label.id, boardId: label.board_id, name: label.name, color: sanitizeColor(label.color) }));
    const comments = db.prepare(`
      SELECT c.id, c.task_card_id, c.author_user_id, c.content, c.created_at, u.name AS author_name, u.email AS author_email
      FROM task_comments c
      LEFT JOIN users u ON u.id = c.author_user_id
      WHERE c.task_card_id = ?
      ORDER BY c.created_at ASC, c.id ASC
    `).all(row.id).map((comment) => ({
      id: comment.id,
      taskCardId: comment.task_card_id,
      authorUserId: comment.author_user_id,
      author: comment.author_email ? { id: comment.author_user_id, name: comment.author_name || comment.author_email, email: comment.author_email } : null,
      content: comment.content,
      createdAt: comment.created_at
    }));
    return {
      id: row.id,
      boardId: row.board_id,
      columnId: row.column_id,
      title: row.title,
      description: row.description || '',
      assignedUserId: row.assigned_user_id,
      assignee: row.assignee_email ? { id: row.assigned_user_id, name: row.assignee_name || row.assignee_email, email: row.assignee_email } : null,
      dueDate: row.due_date || '',
      sortOrder: row.sort_order,
      status: row.status,
      labels,
      comments,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function getCardById(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const row = db.prepare('SELECT * FROM task_cards WHERE id = ?').get(numericId);
    return row ? {
      id: row.id,
      boardId: row.board_id,
      columnId: row.column_id,
      title: row.title,
      assignedUserId: row.assigned_user_id,
      status: row.status
    } : null;
  }

  function getBoardPermissionMatrix(boardId) {
    const matrix = Object.fromEntries(BOARD_PERMISSION_KEYS.map((key) => [key, { roles: [], users: [] }]));
    const rows = db.prepare('SELECT permission_key, principal_type, principal FROM task_board_permissions WHERE board_id = ? ORDER BY permission_key, principal_type, principal').all(boardId);
    for (const row of rows) {
      if (!matrix[row.permission_key]) matrix[row.permission_key] = { roles: [], users: [] };
      if (row.principal_type === 'role') matrix[row.permission_key].roles.push(row.principal);
      if (row.principal_type === 'user') matrix[row.permission_key].users.push(Number(row.principal));
    }
    return matrix;
  }

  function saveBoardPermissions(boardId, permissions, context) {
    const validRoles = new Set(context.listRoles().map((role) => role.name));
    const validUsers = new Set(context.listUsers().map((user) => String(user.id)));
    db.prepare('DELETE FROM task_board_permissions WHERE board_id = ?').run(boardId);
    for (const key of BOARD_PERMISSION_KEYS) {
      const entry = permissions[key] || {};
      for (const role of normalizeStringArray(entry.roles).filter((item) => validRoles.has(item))) {
        db.prepare('INSERT OR IGNORE INTO task_board_permissions (board_id, permission_key, principal_type, principal) VALUES (?, ?, ?, ?)').run(boardId, key, 'role', role);
      }
      for (const userId of normalizeIdArray(entry.users).filter((item) => validUsers.has(String(item)))) {
        db.prepare('INSERT OR IGNORE INTO task_board_permissions (board_id, permission_key, principal_type, principal) VALUES (?, ?, ?, ?)').run(boardId, key, 'user', String(userId));
      }
    }
  }

  function validColumnId(boardId, value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return null;
    return db.prepare('SELECT id FROM task_columns WHERE id = ? AND board_id = ?').get(id, boardId)?.id || null;
  }

  function validUserId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return null;
    return db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(id)?.id || null;
  }

  function labelBelongsToBoard(labelId, boardId) {
    return Boolean(db.prepare('SELECT 1 FROM task_labels WHERE id = ? AND board_id = ?').get(labelId, boardId));
  }

  function nextCardSortOrder(columnId) {
    return Number(db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM task_cards WHERE column_id = ?').get(columnId).next || 0);
  }

  function normalizeStringArray(value) {
    if (Array.isArray(value)) return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
    return String(value || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  }

  function normalizeIdArray(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
    return Array.from(new Set(source.map(Number).filter((item) => Number.isInteger(item) && item > 0)));
  }

  function normalizeDate(value) {
    const text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  }

  function sanitizeColor(value = '#4f7cff') {
    return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#4f7cff';
  }

  function capabilityName(key) {
    return key.replace('tasks.', '').replace(/_([a-z])/g, (_, char) => char.toUpperCase());
  }
}
