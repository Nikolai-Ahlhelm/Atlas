(() => {
  let users = [];
  let roles = [];
  let contentTree = [];
  let contentDirectories = [];
  let currentContentSelection = null;
  let activeAdminTab = 'content';
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  let adminErrorBox = null;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdmin, { once: true });
  } else {
    initAdmin();
  }

  async function initAdmin() {
    adminErrorBox = document.querySelector('#adminError');
    window.addEventListener('error', (event) => {
      if (event?.error) renderAdminError(event.error);
    });
    window.addEventListener('unhandledrejection', (event) => {
      renderAdminError(event?.reason || new Error(msg('unexpectedError', 'An unexpected error occurred.')));
    });
    document.querySelector('[data-new-user]')?.addEventListener('click', () => openUserDialog());
    document.querySelector('[data-new-role]')?.addEventListener('click', () => openRoleDialog());
    document.querySelector('[data-new-page]')?.addEventListener('click', () => openPageCreateDialog());
    document.querySelector('[data-new-category]')?.addEventListener('click', () => openCategoryCreateDialog());
    document.querySelectorAll('[data-admin-tab]').forEach((button) => {
      button.addEventListener('click', () => setActiveTab(button.dataset.adminTab || 'content'));
    });
    document.querySelector('#settingsForm')?.addEventListener('submit', saveSettings);
    document.querySelector('#pageEditorForm')?.addEventListener('submit', savePageContent);
    document.querySelector('#categoryEditorForm')?.addEventListener('submit', saveCategoryContent);
    document.querySelector('input[name="font_scale"]')?.addEventListener('input', (event) => {
      document.querySelector('[data-font-preview]').textContent = `${Math.round(Number(event.target.value) * 100)}%`;
    });
    document.querySelectorAll('input[name="light_ui_opacity"], input[name="dark_ui_opacity"]').forEach((input) => {
      input.addEventListener('input', (event) => {
        const mode = event.target.name.startsWith('light') ? 'light' : 'dark';
        const target = document.querySelector(`[data-ui-opacity-preview="${mode}"]`);
        if (target) target.textContent = `${Math.round(Number(event.target.value) * 100)}%`;
      });
    });
    document.querySelector('input[name="entra_enabled"]')?.addEventListener('change', syncSwitchLabels);
    document.querySelector('input[name="logo_upload"]')?.addEventListener('change', handleLogoUpload);
    document.querySelector('[data-reload-content]')?.addEventListener('click', async () => {
      await fetch('/api/admin/reload', { method: 'POST' });
      location.reload();
    });
    document.querySelector('[data-factory-reset]')?.addEventListener('click', openFactoryResetDialog);
    syncSwitchLabels();
    hydrateAdminStateFromUrl();
    renderAdminTabs();
    await refresh();
  }

  async function refresh() {
    try {
      clearAdminError();
      const [userRows, roleRows, contentResponse] = await Promise.all([
        fetchJson('/api/admin/users'),
        fetchJson('/api/admin/roles'),
        fetchJson('/api/admin/content/tree')
      ]);
      users = Array.isArray(userRows) ? userRows : [];
      roles = Array.isArray(roleRows) ? roleRows : [];
      contentTree = Array.isArray(contentResponse?.tree) ? contentResponse.tree : [];
      contentDirectories = Array.isArray(contentResponse?.directories) ? contentResponse.directories : [];
      renderUsers();
      renderRoles();
      renderContentTree();
      renderAdminTabs();
      await restoreContentSelection();
    } catch (error) {
      renderAdminError(error);
    }
  }

  async function restoreContentSelection() {
    if (!currentContentSelection) {
      const params = new URLSearchParams(location.search);
      const page = params.get('page');
      const dir = params.get('dir');
      if (page) {
        await loadPage(page);
        return;
      }
      if (dir !== null) {
        await loadCategory(dir);
      }
      return;
    }
    if (currentContentSelection.type === 'page') {
      await loadPage(currentContentSelection.slug);
      return;
    }
    if (currentContentSelection.type === 'category') {
      await loadCategory(currentContentSelection.relativeDir);
    }
  }

  function renderUsers() {
    const target = document.querySelector('#usersTable');
    target.innerHTML = `
      <table>
        <thead><tr><th>${msg('name', 'Name')}</th><th>${msg('email', 'Email')}</th><th>${msg('roles', 'Roles')}</th><th>${msg('status', 'Status')}</th><th></th></tr></thead>
        <tbody>
          ${users.map((user) => `
            <tr>
              <td>${esc(user.name)}${user.is_admin ? '<span class="tag">Admin</span>' : ''}</td>
              <td>${esc(user.email)}</td>
              <td>${user.roles.map((role) => `<span class="pill" style="--role-color: ${esc(roleColor(role))}">${esc(role)}</span>`).join('')}</td>
              <td>${user.active ? msg('active', 'Active') : msg('blocked', 'Blocked')}</td>
              <td class="row-actions">
                <button class="button small" data-edit-user="${user.id}">${msg('edit', 'Edit')}</button>
                <button class="button small danger" data-delete-user="${user.id}">${msg('delete', 'Delete')}</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;

    target.querySelectorAll('[data-edit-user]').forEach((button) => button.addEventListener('click', () => {
      openUserDialog(users.find((user) => user.id === Number(button.dataset.editUser)));
    }));
    target.querySelectorAll('[data-delete-user]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm(msg('deleteUserConfirm', 'Delete this user?'))) return;
      try {
        await fetchJson(`/api/admin/users/${button.dataset.deleteUser}`, { method: 'DELETE' });
        await refresh();
      } catch (error) {
        showError(error);
      }
    }));
  }

  function renderRoles() {
    const target = document.querySelector('#rolesTable');
    target.innerHTML = `
      <table>
        <thead><tr><th>${msg('role', 'Role')}</th><th>${msg('description', 'Description')}</th><th></th></tr></thead>
        <tbody>
          ${roles.map((role) => `
            <tr>
              <td><span class="pill" style="--role-color: ${esc(role.color || '#5d6b82')}">${esc(role.name)}</span></td>
              <td>${esc(role.description)}</td>
              <td class="row-actions">
                <button class="button small" data-edit-role="${role.id}">${msg('edit', 'Edit')}</button>
                <button class="button small danger" data-delete-role="${role.id}">${msg('delete', 'Delete')}</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;

    target.querySelectorAll('[data-edit-role]').forEach((button) => button.addEventListener('click', () => {
      openRoleDialog(roles.find((role) => role.id === Number(button.dataset.editRole)));
    }));
    target.querySelectorAll('[data-delete-role]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm(msg('deleteRoleConfirm', 'Delete this role? It will also be removed from users.'))) return;
      try {
        await fetchJson(`/api/admin/roles/${button.dataset.deleteRole}`, { method: 'DELETE' });
        await refresh();
      } catch (error) {
        showError(error);
      }
    }));
  }

  function renderContentTree() {
    const target = document.querySelector('#contentTree');
    if (!target) return;
    target.innerHTML = contentTree.length
      ? `<div class="content-tree-list">${contentTree.map((node) => renderTreeNode(node)).join('')}</div>`
      : `<div class="notice">${msg('noContent', 'No content available yet.')}</div>`;

    target.querySelectorAll('[data-open-page]').forEach((button) => button.addEventListener('click', async () => {
      await loadPage(button.dataset.openPage);
    }));
    target.querySelectorAll('[data-open-category]').forEach((button) => button.addEventListener('click', async () => {
      await loadCategory(button.dataset.openCategory || '');
    }));
  }

  function renderTreeNode(node) {
    if (node.type === 'page') {
      const active = currentContentSelection?.type === 'page' && currentContentSelection.slug === node.slug;
      return `
        <button class="content-tree-item ${active ? 'active' : ''}" type="button" data-open-page="${esc(node.slug)}">
          <span class="content-tree-kind">MD</span>
          <span class="content-tree-label">${esc(node.title || node.slug)}</span>
        </button>
      `;
    }

    const active = currentContentSelection?.type === 'category' && currentContentSelection.relativeDir === node.relativeDir;
    return `
      <section class="content-tree-group ${active ? 'active' : ''}">
        <button class="content-tree-item content-tree-category ${active ? 'active' : ''}" type="button" data-open-category="${esc(node.relativeDir || '')}">
          <span class="content-tree-kind">DIR</span>
          <span class="content-tree-label">${esc(node.label || 'Category')}</span>
        </button>
        <div class="content-tree-children">${(node.children || []).map((child) => renderTreeNode(child)).join('')}</div>
      </section>
    `;
  }

  async function loadPage(slug) {
    try {
      const page = await fetchJson(`/api/admin/content/page?slug=${encodeURIComponent(slug)}`);
      setActiveTab('content');
      currentContentSelection = { type: 'page', slug: page.slug };
      syncAdminUrl();
      renderContentTree();
      document.querySelector('#contentEditorTitle').textContent = `${msg('rawMarkdown', 'Raw Markdown')}: ${page.title || page.slug}`;
      document.querySelector('#contentEditorEmpty').hidden = true;
      document.querySelector('#categoryEditorForm').hidden = true;
      const form = document.querySelector('#pageEditorForm');
      form.hidden = false;
      form.elements.slug.value = page.slug || '';
      form.elements.extra_meta.value = JSON.stringify(page.extraMeta || {});
      form.elements.display_slug.value = page.slug || '';
      form.elements.relative_path.value = page.relativePath || '';
      form.elements.title.value = page.meta?.title || '';
      form.elements.description.value = page.meta?.description || '';
      form.elements.owner.value = page.meta?.owner || '';
      form.elements.version.value = page.meta?.version || '';
      form.elements.reviewDate.value = page.meta?.reviewDate || '';
      form.elements.position.value = Number.isFinite(Number(page.meta?.position)) ? Number(page.meta.position) : 999;
      form.elements.roles.value = Array.isArray(page.meta?.roles) ? page.meta.roles.join(', ') : '';
      form.elements.markdown.value = page.markdown || '';
    } catch (error) {
      showError(error);
    }
  }

  async function loadCategory(relativeDir) {
    try {
      const category = await fetchJson(`/api/admin/content/category?dir=${encodeURIComponent(relativeDir || '')}`);
      setActiveTab('content');
      currentContentSelection = { type: 'category', relativeDir: category.relativeDir || '' };
      syncAdminUrl();
      renderContentTree();
      document.querySelector('#contentEditorTitle').textContent = `${msg('category', 'Category')}: ${category.label || category.relativeDir || 'Documentation root'}`;
      document.querySelector('#contentEditorEmpty').hidden = true;
      document.querySelector('#pageEditorForm').hidden = true;
      const form = document.querySelector('#categoryEditorForm');
      form.hidden = false;
      form.elements.relative_dir.value = category.relativeDir || '';
      form.elements.display_dir.value = category.relativeDir || '/';
      form.elements.config_path.value = category.configPath || '';
      form.elements.label.value = category.label || '';
      form.elements.position.value = Number.isFinite(Number(category.position)) ? Number(category.position) : 999;
      form.elements.roles.value = (category.roles || []).join(', ');
    } catch (error) {
      showError(error);
    }
  }

  function openUserDialog(user = {}) {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${user.id ? msg('editUser', 'Edit user') : msg('createUser', 'Create user')}</h2>
      <label>${msg('name', 'Name')} <input name="name" required value="${esc(user.name || '')}"></label>
      <label>${msg('email', 'Email')} <input name="email" type="email" required value="${esc(user.email || '')}"></label>
      <label>${msg('password', 'Password')} <input name="password" type="password" placeholder="${user.id ? msg('leaveEmptyUnchanged', 'Leave empty to keep unchanged') : ''}"></label>
      <div class="switch-row">
        <label class="switch-card">
          <span>Admin</span>
          <span class="switch">
            <input name="is_admin" type="checkbox" ${user.is_admin ? 'checked' : ''}>
            <span class="switch-track"></span>
          </span>
        </label>
        <label class="switch-card">
          <span>${msg('active', 'Active')}</span>
          <span class="switch">
            <input name="active" type="checkbox" ${user.active !== false ? 'checked' : ''}>
            <span class="switch-track"></span>
          </span>
        </label>
      </div>
      <fieldset><legend>${msg('roles', 'Roles')}</legend>${roles.map((role) => `<label class="check"><input name="roles" type="checkbox" value="${esc(role.name)}" ${(user.roles || []).includes(role.name) ? 'checked' : ''}> ${esc(role.name)}</label>`).join('')}</fieldset>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('save', 'Save')}</button></div>
      </form>
    `);
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        await fetchJson('/api/admin/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: user.id,
            name: form.get('name'),
            email: form.get('email'),
            password: form.get('password'),
            is_admin: form.get('is_admin') === 'on',
            active: form.get('active') === 'on',
            roles: form.getAll('roles')
          })
        });
        dialog.remove();
        await refresh();
      } catch (error) {
        showError(error);
      }
    });
  }

  function openRoleDialog(role = {}) {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${role.name ? msg('editRole', 'Edit role') : msg('createRole', 'Create role')}</h2>
        <label>${msg('name', 'Name')} <input name="name" required value="${esc(role.name || '')}"></label>
        <label>${msg('description', 'Description')} <textarea name="description">${esc(role.description || '')}</textarea></label>
        <label>${msg('color', 'Color')} <input name="color" type="color" value="${esc(role.color || '#5d6b82')}"></label>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('save', 'Save')}</button></div>
      </form>
    `);
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        await fetchJson('/api/admin/roles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: role.id, name: form.get('name'), description: form.get('description'), color: form.get('color') })
        });
        dialog.remove();
        await refresh();
      } catch (error) {
        showError(error);
      }
    });
  }

  function openFactoryResetDialog() {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${msg('factoryResetConfirmTitle', 'Reset Atlas?')}</h2>
        <p class="hint">${msg('factoryResetConfirmBody', 'This will erase the current SQLite data and immediately restore the default Atlas setup.')}</p>
        <label>${msg('factoryResetConfirmStep', 'Type RESET ATLAS to continue.')}
          <input name="confirmation" placeholder="${msg('factoryResetPlaceholder', 'RESET ATLAS')}" required>
        </label>
        <div class="modal-actions">
          <button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button>
          <button class="button danger" type="submit">${msg('factoryResetButton', 'Reset to factory settings')}</button>
        </div>
      </form>
    `);

    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        await fetchJson('/api/admin/reset', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmation: form.get('confirmation') })
        });
        alert(msg('factoryResetSuccess', 'Atlas has been reset. Please sign in again.'));
        location.href = '/login';
      } catch (error) {
        showError(error);
      }
    });
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    payload.entra_enabled = form.get('entra_enabled') === 'true' ? 'true' : 'false';
    try {
      JSON.parse(payload.menu_links || '[]');
    } catch {
      alert(msg('invalidMenuJson', 'The menu links are not valid JSON.'));
      return;
    }
    try {
      await fetchJson('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      location.reload();
    } catch (error) {
      showError(error);
    }
  }

  async function savePageContent(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await fetchJson('/api/admin/content/page', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: form.get('slug'),
          extraMeta: form.get('extra_meta'),
          title: form.get('title'),
          description: form.get('description'),
          owner: form.get('owner'),
          version: form.get('version'),
          reviewDate: form.get('reviewDate'),
          position: Number(form.get('position') || 999),
          roles: parseRoles(form.get('roles')),
          markdown: form.get('markdown')
        })
      });
      await refresh();
      await loadPage(String(form.get('slug') || ''));
    } catch (error) {
      showError(error);
    }
  }

  async function saveCategoryContent(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await fetchJson('/api/admin/content/category', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          relative_dir: form.get('relative_dir'),
          label: form.get('label'),
          position: Number(form.get('position') || 999),
          roles: parseRoles(form.get('roles'))
        })
      });
      await refresh();
      await loadCategory(String(form.get('relative_dir') || ''));
    } catch (error) {
      showError(error);
    }
  }

  function openPageCreateDialog() {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${msg('createPage', 'Create page')}</h2>
        <label>${msg('parentCategory', 'Parent category')}
          <select name="parent_dir">${renderDirectoryOptions()}</select>
        </label>
        <label>${msg('pageSlug', 'Page slug')} <input name="slug" placeholder="new-page"></label>
        <label>${msg('title', 'Title')} <input name="title" placeholder="New page"></label>
        <label class="check"><input name="as_index" type="checkbox"> ${msg('createAsIndex', 'Create as category landing page (index.md)')}</label>
        <label>${msg('rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Admins, Users"></label>
        <label>${msg('rawMarkdown', 'Raw Markdown')}
          <textarea name="raw" class="code-input" spellcheck="false" placeholder="Optional. Leave empty to generate a starter template."></textarea>
        </label>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('create', 'Create')}</button></div>
      </form>
    `);

    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const result = await fetchJson('/api/admin/content/page', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'create',
            parentDir: form.get('parent_dir'),
            slug: form.get('slug'),
            title: form.get('title'),
            asIndex: form.get('as_index') === 'on',
            description: '',
            owner: '',
            version: '',
            reviewDate: '',
            position: 999,
            roles: parseRoles(form.get('roles')),
            markdown: form.get('raw')
          })
        });
        dialog.remove();
        await refresh();
        if (result?.slug) await loadPage(result.slug);
      } catch (error) {
        showError(error);
      }
    });
  }

  function openCategoryCreateDialog() {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${msg('createCategory', 'Create category')}</h2>
        <label>${msg('parentCategory', 'Parent category')}
          <select name="parent_dir">${renderDirectoryOptions()}</select>
        </label>
        <label>${msg('categorySlug', 'Category slug')} <input name="slug" placeholder="new-category" required></label>
        <label>${msg('label', 'Label')} <input name="label" placeholder="New category"></label>
        <label>${msg('position', 'Position')} <input name="position" type="number" step="1" value="999"></label>
        <label>${msg('rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Admins, Users"></label>
        <label class="check"><input name="create_index" type="checkbox" checked> ${msg('createIndexPage', 'Create a landing page for this category')}</label>
        <label>${msg('title', 'Title')} <input name="index_title" placeholder="Category overview"></label>
        <label>${msg('rawMarkdown', 'Raw Markdown')}
          <textarea name="raw" class="code-input" spellcheck="false" placeholder="Optional start content for the index page."></textarea>
        </label>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('create', 'Create')}</button></div>
      </form>
    `);

    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const result = await fetchJson('/api/admin/content/category', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'create',
            parentDir: form.get('parent_dir'),
            slug: form.get('slug'),
            label: form.get('label'),
            position: Number(form.get('position') || 999),
            roles: parseRoles(form.get('roles')),
            createIndex: form.get('create_index') === 'on',
            indexTitle: form.get('index_title'),
            raw: form.get('raw')
          })
        });
        dialog.remove();
        await refresh();
        if (result?.relativeDir !== undefined) await loadCategory(result.relativeDir);
      } catch (error) {
        showError(error);
      }
    });
  }

  function renderDirectoryOptions() {
    return contentDirectories
      .map((directory) => {
        const value = directory.relativeDir || '';
        const label = directory.relativeDir ? directory.relativeDir : msg('documentationRoot', 'Documentation root');
        return `<option value="${esc(value)}">${esc(label)}</option>`;
      })
      .join('');
  }

  function hydrateAdminStateFromUrl() {
    const params = new URLSearchParams(location.search);
    activeAdminTab = normalizeAdminTab(params.get('tab'));
    const page = params.get('page');
    const dir = params.get('dir');
    if (page) {
      currentContentSelection = { type: 'page', slug: page };
    } else if (dir !== null && dir !== '') {
      currentContentSelection = { type: 'category', relativeDir: dir };
    } else if (dir === '') {
      currentContentSelection = { type: 'category', relativeDir: '' };
    }
  }

  function normalizeAdminTab(value) {
    return ['content', 'access', 'instance'].includes(value) ? value : 'content';
  }

  function setActiveTab(tab) {
    activeAdminTab = normalizeAdminTab(tab);
    renderAdminTabs();
    syncAdminUrl();
  }

  function renderAdminTabs() {
    document.querySelectorAll('[data-admin-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.adminTab === activeAdminTab);
    });
    document.querySelectorAll('[data-admin-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.adminPanel !== activeAdminTab;
    });
  }

  function syncAdminUrl() {
    const params = new URLSearchParams(location.search);
    params.set('tab', activeAdminTab);
    params.delete('page');
    params.delete('dir');
    if (currentContentSelection?.type === 'page') {
      params.set('page', currentContentSelection.slug);
    }
    if (currentContentSelection?.type === 'category') {
      params.set('dir', currentContentSelection.relativeDir || '');
    }
    const next = `${location.pathname}?${params.toString()}`;
    history.replaceState({}, '', next);
  }

  function handleLogoUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 4_000_000) {
      alert(msg('logoTooLarge', 'Please use a logo below 4 MB.'));
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      document.querySelector('input[name="logo_image"]').value = reader.result;
    });
    reader.readAsDataURL(file);
  }

  function modal(html) {
    const wrapper = document.createElement('div');
    wrapper.className = 'modal-backdrop';
    wrapper.innerHTML = `<div class="modal">${html}</div>`;
    wrapper.addEventListener('click', (event) => {
      if (event.target === wrapper || event.target.closest('[data-close]')) wrapper.remove();
    });
    document.body.append(wrapper);
    return wrapper;
  }

  function renderAdminError(error) {
    const message = esc(error?.message || msg('unexpectedError', 'An unexpected error occurred.'));
    const markup = `<div class="notice"><strong>${msg('unexpectedError', 'An unexpected error occurred.')}</strong><p>${message}</p></div>`;
    const usersTable = document.querySelector('#usersTable');
    const rolesTable = document.querySelector('#rolesTable');
    if (adminErrorBox) {
      adminErrorBox.hidden = false;
      adminErrorBox.innerHTML = `<strong>${msg('unexpectedError', 'An unexpected error occurred.')}</strong><p>${message}</p>`;
    }
    if (usersTable) usersTable.innerHTML = markup;
    if (rolesTable) rolesTable.innerHTML = markup;
  }

  function showError(error) {
    renderAdminError(error);
  }

  function clearAdminError() {
    if (!adminErrorBox) return;
    adminErrorBox.hidden = true;
    adminErrorBox.innerHTML = '';
  }

  function parseRoles(value) {
    return String(value || '')
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function syncSwitchLabels() {
    document.querySelectorAll('.switch input').forEach((input) => {
      const card = input.closest('.switch-field, .switch-card');
      const label = card?.querySelector('.switch-label');
      if (!label) return;
      label.textContent = input.checked ? msg('enabled', 'Enabled') : msg('disabled', 'Disabled');
    });
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      try {
        throw new Error(JSON.parse(text).error || text);
      } catch {
        throw new Error(text);
      }
    }
    return response.json();
  }

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function roleColor(name) {
    return roles.find((role) => role.name === name)?.color || '#5d6b82';
  }

  function readPortalI18n() {
    try {
      return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}');
    } catch {
      return {};
    }
  }
})();
