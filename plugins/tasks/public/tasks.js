(() => {
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  const publicRoot = document.querySelector('[data-tasks-app]');
  const adminRoot = document.querySelector('[data-tasks-admin-page]');
  const root = publicRoot || adminRoot;

  const state = {
    me: null,
    boards: [],
    board: null,
    selectedBoardId: Number(publicRoot?.dataset.boardId || 0) || 0,
    support: { roles: [], users: [], permissions: {}, permissionKeys: [], boardPermissionKeys: [] },
    can: {},
    draggedCardId: null
  };

  if (root) {
    injectCss(root.dataset.cssHref);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }

  async function init() {
    bindShell();
    await refreshMe();
    await refreshSupport();
    await refreshBoards();
    if (state.selectedBoardId) await openBoard(state.selectedBoardId);
  }

  function bindShell() {
    document.querySelectorAll('[data-new-board]').forEach((button) => button.addEventListener('click', () => openBoardDialog()));
    document.querySelectorAll('[data-new-card]').forEach((button) => button.addEventListener('click', () => openTaskDialog()));
    document.querySelector('[data-back-to-boards]')?.addEventListener('click', closeBoard);
    document.querySelector('[data-edit-board]')?.addEventListener('click', () => openBoardDialog(state.board));
    document.querySelector('[data-archive-board]')?.addEventListener('click', archiveBoard);
    document.querySelector('[data-save-task-permissions]')?.addEventListener('click', saveGlobalPermissions);
    document.querySelector('[data-close-task-dialog]')?.addEventListener('click', () => document.querySelector('#taskEditorDialog')?.close());
    document.querySelector('[data-close-board-dialog]')?.addEventListener('click', () => document.querySelector('#boardEditorDialog')?.close());
    document.querySelector('[data-close-label-dialog]')?.addEventListener('click', () => document.querySelector('#labelEditorDialog')?.close());
    document.querySelector('#taskEditorForm')?.addEventListener('submit', saveTask);
    document.querySelector('#boardEditorForm')?.addEventListener('submit', saveBoard);
    document.querySelector('#labelEditorForm')?.addEventListener('submit', saveLabel);
    document.querySelector('[data-delete-label]')?.addEventListener('click', deleteLabel);
    document.querySelector('[data-archive-task]')?.addEventListener('click', archiveTask);
  }

  async function refreshMe() {
    try { state.me = await fetchJson('/api/me'); } catch { state.me = null; }
  }

  async function refreshSupport() {
    try {
      const support = await fetchJson('/api/admin/tasks/support-data');
      state.support = {
        roles: Array.isArray(support.roles) ? support.roles : [],
        users: Array.isArray(support.users) ? support.users : [],
        permissions: support.permissions || {},
        permissionKeys: Array.isArray(support.permissionKeys) ? support.permissionKeys : [],
        boardPermissionKeys: Array.isArray(support.boardPermissionKeys) ? support.boardPermissionKeys : []
      };
      renderGlobalPermissions();
    } catch {
      state.support = { roles: [], users: state.me ? [state.me] : [], permissions: {}, permissionKeys: [], boardPermissionKeys: [] };
    }
  }

  async function refreshBoards() {
    const response = await fetchJson(adminRoot ? '/api/admin/tasks/boards' : '/api/tasks/boards');
    state.boards = Array.isArray(response.boards) ? response.boards : [];
    state.can = response.can || {};
    renderBoardOverview();
    renderAdminBoards();
  }

  function renderBoardOverview() {
    const target = document.querySelector('#tasksBoardOverview');
    if (!target) return;
    document.querySelectorAll('[data-new-board]').forEach((button) => {
      if (publicRoot) button.hidden = !(state.can.create || state.can.manageBoards);
    });
    target.hidden = Boolean(state.board);
    target.innerHTML = state.boards.length ? state.boards.map((board) => `
      <button class="tasks-board-card" type="button" data-open-board="${board.id}">
        <span class="pill">${esc(board.visibility)}</span>
        <strong>${esc(board.name)}</strong>
        <span>${esc(board.description || msg('noDescription', 'No description'))}</span>
        <dl>
          <div><dt>${msg('tasks', 'Tasks')}</dt><dd>${board.counts?.total || 0}</dd></div>
          <div><dt>${msg('overdue', 'Overdue')}</dt><dd>${board.counts?.overdue || 0}</dd></div>
        </dl>
      </button>
    `).join('') : `<div class="empty-state"><h1>${msg('noBoards', 'No boards')}</h1><p>${msg('noBoardsText', 'No task boards are available for you yet.')}</p></div>`;
    target.querySelectorAll('[data-open-board]').forEach((button) => button.addEventListener('click', () => openBoard(Number(button.dataset.openBoard))));
  }

  function renderAdminBoards() {
    const target = document.querySelector('#tasksAdminBoards');
    if (!target) return;
    target.innerHTML = state.boards.length ? state.boards.map((board) => `
      <button class="tasks-admin-row ${state.board?.id === board.id ? 'active' : ''}" type="button" data-admin-board="${board.id}">
        <span><strong>${esc(board.name)}</strong><small>${esc(board.owner?.name || board.visibility)}</small></span>
        <span class="pill">${esc(board.status)}</span>
      </button>
    `).join('') : `<div class="empty-state"><h1>${msg('noBoards', 'No boards')}</h1><p>${msg('noBoardsText', 'No task boards are available yet.')}</p></div>`;
    target.querySelectorAll('[data-admin-board]').forEach((button) => button.addEventListener('click', () => openBoard(Number(button.dataset.adminBoard))));
  }

  async function openBoard(id) {
    try {
      state.selectedBoardId = Number(id);
      state.board = await fetchJson(`/api/tasks/board?id=${encodeURIComponent(id)}`);
      if (state.board?.users) state.support.users = state.board.users;
      if (state.board?.roles) state.support.roles = state.board.roles;
      renderBoardOverview();
      renderAdminBoards();
      renderKanban();
      renderAdminDetail();
      clearNotice();
      if (publicRoot) history.replaceState(null, '', `/tasks?board=${encodeURIComponent(id)}`);
    } catch (error) {
      showNotice(error.message || msg('boardNotFound', 'Board not found.'));
    }
  }

  function closeBoard() {
    state.board = null;
    state.selectedBoardId = 0;
    renderBoardOverview();
    document.querySelector('#tasksKanban')?.setAttribute('hidden', '');
    if (publicRoot) history.replaceState(null, '', '/tasks');
  }

  function renderKanban() {
    const board = state.board;
    const shell = document.querySelector('#tasksKanban');
    const columnsTarget = document.querySelector('#tasksColumns');
    if (!shell || !columnsTarget || !board) return;
    shell.hidden = false;
    document.querySelector('#tasksBoardTitle').textContent = board.name;
    document.querySelector('#tasksBoardDescription').textContent = board.description || '';
    document.querySelector('[data-new-card]')?.toggleAttribute('hidden', !board.can?.createCard);
    columnsTarget.innerHTML = board.columns.map((column) => `
      <section class="tasks-column" data-column-drop="${column.id}">
        <div class="tasks-column-head"><h3>${esc(column.name)}</h3><span class="pill">${column.cards.length}</span></div>
        <div class="tasks-card-list" data-card-list="${column.id}">
          ${column.cards.map(renderCard).join('')}
        </div>
      </section>
    `).join('');
    columnsTarget.querySelectorAll('[data-card-id]').forEach((card) => {
      card.addEventListener('click', () => openTaskDialog(findCard(Number(card.dataset.cardId))));
      card.addEventListener('dragstart', onCardDragStart);
      card.addEventListener('dragend', onCardDragEnd);
    });
    columnsTarget.querySelectorAll('[data-card-list]').forEach((list) => {
      list.addEventListener('dragover', (event) => { event.preventDefault(); list.classList.add('is-drop-target'); });
      list.addEventListener('dragleave', () => list.classList.remove('is-drop-target'));
      list.addEventListener('drop', onCardDrop);
    });
  }

  function renderCard(card) {
    const overdue = card.dueDate && card.dueDate < new Date().toISOString().slice(0, 10) && card.status !== 'done';
    const assignee = card.assignee?.name || card.assignee?.email || msg('unassigned', 'Unassigned');
    const dueLabel = card.dueDate || msg('noDueDate', 'No due date');
    const commentCount = Array.isArray(card.comments) ? card.comments.length : 0;
    return `
      <article class="tasks-card ${overdue ? 'is-overdue' : ''}" draggable="${state.board?.can?.editBoard ? 'true' : 'false'}" data-card-id="${card.id}">
        <div class="tasks-card-kicker"><span>#${card.id}</span><span>${esc(statusLabel(card.status))}</span></div>
        <strong class="tasks-card-title">${esc(card.title)}</strong>
        ${card.description ? `<p>${esc(card.description)}</p>` : ''}
        <div class="tasks-label-row">${card.labels.map((label) => `<span class="tasks-label" style="--label-color:${esc(label.color)}">${esc(label.name)}</span>`).join('')}</div>
        <div class="tasks-card-facts">
          <span class="tasks-card-fact"><b>${msg('assigneeShort', 'Assignee')}</b>${esc(assignee)}</span>
          <span class="tasks-card-fact ${overdue ? 'danger' : ''}"><b>${msg('dueShort', 'Due')}</b>${esc(dueLabel)}</span>
          <span class="tasks-card-fact"><b>${msg('commentsShort', 'Comments')}</b>${commentCount}</span>
        </div>
      </article>
    `;
  }

  function renderAdminDetail() {
    const target = document.querySelector('#tasksAdminDetail');
    if (!target) return;
    const board = state.board;
    document.querySelector('[data-edit-board]')?.toggleAttribute('hidden', !board?.can?.manageBoard);
    document.querySelector('[data-archive-board]')?.toggleAttribute('hidden', !board?.can?.deleteBoard);
    if (!board) {
      target.innerHTML = `<div class="empty-state"><h1>${msg('selectBoard', 'Select a board')}</h1><p>${msg('selectBoardText', 'Choose a board to manage columns, labels and access.')}</p></div>`;
      return;
    }
    renderGlobalPermissions();
    target.innerHTML = `
      <article class="tasks-admin-summary">
        <h2>${esc(board.name)}</h2>
        <p class="hint">${esc(board.description || '')}</p>
        <dl class="tasks-summary-strip">
          <div><dt>${msg('visibility', 'Visibility')}</dt><dd>${esc(board.visibility)}</dd></div>
          <div><dt>${msg('owner', 'Owner')}</dt><dd>${esc(board.owner?.name || '')}</dd></div>
          <div><dt>${msg('tasks', 'Tasks')}</dt><dd>${board.counts?.total || 0}</dd></div>
        </dl>
      </article>
      <section class="tasks-admin-section">
        <div class="panel-head compact"><h3>${msg('columns', 'Columns')}</h3><button class="button ghost" type="button" data-add-column>${msg('addColumn', 'Add column')}</button></div>
        <div id="tasksColumnEditor">${board.columns.map((column) => `<label>${msg('column', 'Column')}<input data-column-name="${column.id}" value="${esc(column.name)}"></label>`).join('')}</div>
        <button class="button primary" type="button" data-save-columns>${msg('saveColumns', 'Save columns')}</button>
      </section>
      <section class="tasks-admin-section">
        <div class="panel-head compact"><h3>${msg('tags', 'Tags')}</h3><button class="button ghost" type="button" data-add-label>${msg('addTag', 'Add tag')}</button></div>
        <div class="tasks-label-admin-list">${board.labels.map((label) => `<button class="tasks-label-admin" type="button" data-edit-label="${label.id}"><span style="background:${esc(label.color)}"></span><strong>${esc(label.name)}</strong><small>${esc(label.color)}</small></button>`).join('') || `<p class="hint">${msg('noTags', 'No tags yet.')}</p>`}</div>
      </section>
    `;
    target.querySelector('[data-add-column]')?.addEventListener('click', addColumnInput);
    target.querySelector('[data-save-columns]')?.addEventListener('click', saveColumns);
    target.querySelector('[data-add-label]')?.addEventListener('click', () => openLabelDialog());
    target.querySelectorAll('[data-edit-label]').forEach((button) => button.addEventListener('click', () => openLabelDialog(state.board.labels.find((label) => label.id === Number(button.dataset.editLabel)))));
  }

  function openTaskDialog(card = null) {
    if (!state.board) return;
    const dialog = document.querySelector('#taskEditorDialog');
    const form = document.querySelector('#taskEditorForm');
    if (!dialog || !form) return;
    form.reset();
    form.elements.id.value = card?.id || '';
    form.elements.board_id.value = state.board.id;
    form.elements.title.value = card?.title || '';
    form.elements.description.value = card?.description || '';
    form.elements.due_date.value = card?.dueDate || '';
    form.elements.status.value = card?.status || 'todo';
    hydrateTaskSelects(form, card);
    renderComments(card);
    document.querySelector('[data-archive-task]')?.toggleAttribute('hidden', !card?.id || !state.board.can?.deleteCard);
    dialog.showModal();
  }

  function hydrateTaskSelects(form, card) {
    form.elements.column_id.innerHTML = state.board.columns.map((column) => `<option value="${column.id}" ${card?.columnId === column.id ? 'selected' : ''}>${esc(column.name)}</option>`).join('');
    form.elements.assigned_user_id.innerHTML = `<option value="">${msg('unassigned', 'Unassigned')}</option>${(state.board.users || state.support.users).map((user) => `<option value="${user.id}" ${card?.assignedUserId === user.id ? 'selected' : ''}>${esc(user.name || user.email)}</option>`).join('')}`;
    form.elements.labels.innerHTML = state.board.labels.map((label) => `<option value="${label.id}" ${(card?.labels || []).some((item) => item.id === label.id) ? 'selected' : ''}>${esc(label.name)}</option>`).join('');
    form.elements.labels.closest('label')?.classList.add('tasks-tag-select-label');
  }

  function renderComments(card) {
    const target = document.querySelector('#taskComments');
    if (!target) return;
    if (!card?.id) {
      target.innerHTML = '';
      return;
    }
    target.innerHTML = `
      <div class="panel-head compact"><h3>${msg('comments', 'Comments')}</h3></div>
      <div class="tasks-comment-list">${(card.comments || []).map((comment) => `<article><strong>${esc(comment.author?.name || comment.author?.email || '')}</strong><p>${esc(comment.content)}</p><small>${esc(formatDate(comment.createdAt))}</small></article>`).join('') || `<p class="hint">${msg('noComments', 'No comments yet.')}</p>`}</div>
      ${state.board.can?.comment ? `<div id="taskCommentEditor" class="tasks-comment-form"><textarea name="content" placeholder="${esc(msg('writeComment', 'Write a comment'))}"></textarea><button class="button ghost" type="button" data-add-task-comment>${msg('comment', 'Comment')}</button></div>` : ''}
    `;
    target.querySelector('[data-add-task-comment]')?.addEventListener('click', () => addComment(card.id));
    target.querySelector('#taskCommentEditor textarea')?.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') addComment(card.id);
    });
  }

  async function saveTask(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const labelIds = Array.from(form.elements.labels.selectedOptions).map((option) => Number(option.value));
    const response = await fetchJson('/api/tasks/cards', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: form.elements.id.value ? Number(form.elements.id.value) : undefined,
        board_id: Number(form.elements.board_id.value),
        column_id: Number(form.elements.column_id.value),
        title: form.elements.title.value,
        description: form.elements.description.value,
        assigned_user_id: form.elements.assigned_user_id.value ? Number(form.elements.assigned_user_id.value) : null,
        due_date: form.elements.due_date.value,
        status: form.elements.status.value,
        label_ids: labelIds
      })
    });
    state.board = response;
    renderKanban();
    renderAdminDetail();
    document.querySelector('#taskEditorDialog')?.close();
  }

  async function archiveTask() {
    const id = Number(document.querySelector('#taskEditorForm')?.elements.id.value || 0);
    if (!id || !confirm(msg('archiveTaskConfirm', 'Archive this task?'))) return;
    state.board = await fetchJson(`/api/tasks/cards/${id}`, { method: 'DELETE' });
    renderKanban();
    renderAdminDetail();
    document.querySelector('#taskEditorDialog')?.close();
  }

  async function addComment(cardId) {
    const editor = document.querySelector('#taskCommentEditor');
    const textarea = editor?.querySelector('textarea[name="content"]');
    const content = textarea?.value.trim() || '';
    if (!content) return;
    state.board = await fetchJson('/api/tasks/comments', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ card_id: cardId, content }) });
    const card = findCard(cardId);
    renderKanban();
    renderComments(card);
  }

  function openBoardDialog(board = null) {
    const dialog = document.querySelector('#boardEditorDialog');
    const form = document.querySelector('#boardEditorForm');
    if (!dialog || !form) return;
    form.reset();
    const users = state.support.users.length ? state.support.users : (state.me ? [state.me] : []);
    form.elements.owner_user_id.innerHTML = users.map((user) => `<option value="${user.id}" ${board?.ownerUserId === user.id || (!board && state.me?.id === user.id) ? 'selected' : ''}>${esc(user.name || user.email)}</option>`).join('');
    form.elements.id.value = board?.id || '';
    form.elements.name.value = board?.name || '';
    form.elements.description.value = board?.description || '';
    form.elements.visibility.value = board?.visibility || 'public';
    renderBoardPermissionEditor(board?.permissions || defaultBoardPermissions());
    dialog.showModal();
  }

  function renderBoardPermissionEditor(permissions) {
    const target = document.querySelector('#boardPermissionMatrix');
    if (!target) return;
    const keys = state.support.boardPermissionKeys.length ? state.support.boardPermissionKeys : ['tasks.view', 'tasks.create', 'tasks.edit', 'tasks.assign', 'tasks.comment', 'tasks.manage_boards', 'tasks.delete'];
    target.innerHTML = keys.map((key) => `
      <section class="permission-card">
        <div><strong>${esc(key)}</strong><p class="hint">${esc(permissionHint(key))}</p></div>
        <div class="permission-grid">
          <fieldset><legend>${msg('roles', 'Roles')}</legend>${state.support.roles.map((role) => `<label class="check"><input type="checkbox" data-board-permission="${esc(key)}" data-scope="role" value="${esc(role.name)}" ${(permissions[key]?.roles || []).includes(role.name) ? 'checked' : ''}> <span>${esc(role.name)}</span></label>`).join('')}</fieldset>
          <fieldset><legend>${msg('users', 'Users')}</legend>${state.support.users.map((user) => `<label class="check"><input type="checkbox" data-board-permission="${esc(key)}" data-scope="user" value="${user.id}" ${(permissions[key]?.users || []).includes(user.id) ? 'checked' : ''}> <span>${esc(user.name || user.email)}</span></label>`).join('')}</fieldset>
        </div>
      </section>
    `).join('');
  }

  function readBoardPermissions() {
    const keys = state.support.boardPermissionKeys.length ? state.support.boardPermissionKeys : ['tasks.view', 'tasks.create', 'tasks.edit', 'tasks.assign', 'tasks.comment', 'tasks.manage_boards', 'tasks.delete'];
    const permissions = {};
    keys.forEach((key) => {
      permissions[key] = {
        roles: Array.from(document.querySelectorAll(`[data-board-permission="${key}"][data-scope="role"]:checked`)).map((input) => input.value),
        users: Array.from(document.querySelectorAll(`[data-board-permission="${key}"][data-scope="user"]:checked`)).map((input) => Number(input.value))
      };
    });
    return permissions;
  }

  async function saveBoard(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const response = await fetchJson('/api/tasks/board', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: form.elements.id.value ? Number(form.elements.id.value) : undefined,
        name: form.elements.name.value,
        description: form.elements.description.value,
        owner_user_id: Number(form.elements.owner_user_id.value || state.me?.id || 0),
        visibility: form.elements.visibility.value,
        permissions: readBoardPermissions()
      })
    });
    state.board = response.board;
    document.querySelector('#boardEditorDialog')?.close();
    await refreshBoards();
    await openBoard(state.board.id);
  }

  async function archiveBoard() {
    if (!state.board || !confirm(msg('archiveBoardConfirm', 'Archive this board?'))) return;
    await fetchJson(`/api/tasks/board/${state.board.id}`, { method: 'DELETE' });
    state.board = null;
    await refreshBoards();
    renderAdminDetail();
  }

  function addColumnInput() {
    const target = document.querySelector('#tasksColumnEditor');
    if (!target) return;
    const wrapper = document.createElement('label');
    wrapper.innerHTML = `${msg('column', 'Column')}<input data-column-name="" value="">`;
    target.append(wrapper);
  }

  async function saveColumns() {
    const columns = Array.from(document.querySelectorAll('[data-column-name]')).map((input) => ({ id: input.dataset.columnName ? Number(input.dataset.columnName) : undefined, name: input.value }));
    state.board = await fetchJson('/api/tasks/columns', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ board_id: state.board.id, columns }) });
    renderKanban();
    renderAdminDetail();
  }

  function openLabelDialog(label = null) {
    const dialog = document.querySelector('#labelEditorDialog');
    const form = document.querySelector('#labelEditorForm');
    if (!dialog || !form || !state.board) return;
    form.reset();
    form.elements.id.value = label?.id || '';
    form.elements.board_id.value = state.board.id;
    form.elements.name.value = label?.name || '';
    form.elements.color.value = label?.color || '#4f7cff';
    document.querySelector('[data-delete-label]')?.toggleAttribute('hidden', !label?.id);
    dialog.showModal();
  }

  async function saveLabel(event) {
    event.preventDefault();
    const form = event.currentTarget;
    state.board = await fetchJson('/api/tasks/labels', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ id: form.elements.id.value ? Number(form.elements.id.value) : undefined, board_id: Number(form.elements.board_id.value), name: form.elements.name.value, color: form.elements.color.value })
    });
    renderKanban();
    renderAdminDetail();
    document.querySelector('#labelEditorDialog')?.close();
  }

  async function deleteLabel() {
    const id = Number(document.querySelector('#labelEditorForm')?.elements.id.value || 0);
    if (!id || !confirm(msg('deleteTagConfirm', 'Delete this tag? It will be removed from assigned tasks.'))) return;
    state.board = await fetchJson(`/api/tasks/labels/${id}`, { method: 'DELETE' });
    renderKanban();
    renderAdminDetail();
    document.querySelector('#labelEditorDialog')?.close();
  }

  function renderGlobalPermissions() {
    const target = document.querySelector('#tasksPermissionMatrix');
    if (!target) return;
    target.innerHTML = state.support.permissionKeys.map((key) => `
      <section class="permission-card">
        <div><strong>${esc(key)}</strong><p class="hint">${esc(permissionHint(key))}</p></div>
        <div class="permission-grid compact">${state.support.roles.map((role) => `<label class="check"><input type="checkbox" data-task-permission="${esc(key)}" value="${esc(role.name)}" ${(state.support.permissions[key] || []).includes(role.name) ? 'checked' : ''}> <span>${esc(role.name)}</span></label>`).join('')}</div>
      </section>
    `).join('');
  }

  async function saveGlobalPermissions() {
    const permissions = {};
    state.support.permissionKeys.forEach((key) => { permissions[key] = []; });
    document.querySelectorAll('[data-task-permission]:checked').forEach((input) => permissions[input.dataset.taskPermission].push(input.value));
    const response = await fetchJson('/api/admin/tasks/permissions', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ permissions }) });
    state.support.permissions = response.permissions || permissions;
    renderGlobalPermissions();
    showNotice(msg('permissionsSaved', 'Permissions saved.'));
  }

  function onCardDragStart(event) {
    if (!state.board?.can?.editBoard) return event.preventDefault();
    state.draggedCardId = Number(event.currentTarget.dataset.cardId);
    event.currentTarget.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(state.draggedCardId));
  }

  function onCardDragEnd(event) {
    state.draggedCardId = null;
    event.currentTarget.classList.remove('is-dragging');
    document.querySelectorAll('.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
  }

  async function onCardDrop(event) {
    event.preventDefault();
    const list = event.currentTarget;
    list.classList.remove('is-drop-target');
    const cardId = state.draggedCardId || Number(event.dataTransfer.getData('text/plain'));
    const columnId = Number(list.dataset.cardList);
    if (!cardId || !columnId) return;
    const sortOrder = list.querySelectorAll('[data-card-id]').length;
    state.board = await fetchJson('/api/tasks/cards/move', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ card_id: cardId, column_id: columnId, sort_order: sortOrder, status: statusForColumn(columnId) }) });
    renderKanban();
    renderAdminDetail();
  }

  function statusForColumn(columnId) {
    const name = state.board?.columns.find((column) => column.id === columnId)?.name.toLowerCase() || '';
    if (name.includes('done') || name.includes('fertig')) return 'done';
    if (name.includes('progress') || name.includes('arbeit')) return 'in_progress';
    return 'todo';
  }

  function findCard(id) {
    return state.board?.columns.flatMap((column) => column.cards).find((card) => card.id === id) || null;
  }

  function defaultBoardPermissions() {
    const userRole = state.support.roles.some((role) => role.name === 'Users') ? ['Users'] : [];
    return Object.fromEntries(['tasks.view', 'tasks.create', 'tasks.edit', 'tasks.assign', 'tasks.comment', 'tasks.manage_boards', 'tasks.delete'].map((key) => [key, {
      roles: ['tasks.view', 'tasks.create', 'tasks.edit', 'tasks.assign', 'tasks.comment'].includes(key) ? userRole : [],
      users: []
    }]));
  }

  function permissionHint(key) {
    return ({
      'tasks.view': msg('tasksViewHint', 'May see boards granted by board access.'),
      'tasks.create': msg('tasksCreateHint', 'May create boards or cards where granted.'),
      'tasks.edit': msg('tasksEditHint', 'May edit cards and move tasks where granted.'),
      'tasks.assign': msg('tasksAssignHint', 'May assign tasks to users.'),
      'tasks.comment': msg('tasksCommentHint', 'May add task comments.'),
      'tasks.manage_boards': msg('tasksManageBoardsHint', 'May manage board settings, columns, labels and access.'),
      'tasks.delete': msg('tasksDeleteHint', 'May archive boards and tasks.')
    })[key] || key;
  }

  function statusLabel(status) {
    return ({
      todo: msg('todo', 'To do'),
      in_progress: msg('inProgress', 'In progress'),
      blocked: msg('blocked', 'Blocked'),
      done: msg('done', 'Done'),
      archived: msg('archived', 'Archived')
    })[status] || status;
  }

  function showNotice(message) {
    const target = document.querySelector('#tasksNotice');
    if (!target) return;
    target.hidden = false;
    target.textContent = message;
  }

  function clearNotice() {
    const target = document.querySelector('#tasksNotice');
    if (!target) return;
    target.hidden = true;
    target.textContent = '';
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function injectCss(href) {
    if (!href || Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((link) => link.href === new URL(href, location.href).href)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new Error(data?.error || text || response.statusText);
    return data;
  }

  function jsonHeaders() {
    return { 'content-type': 'application/json' };
  }

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function readPortalI18n() {
    try { return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}'); } catch { return {}; }
  }
})();
