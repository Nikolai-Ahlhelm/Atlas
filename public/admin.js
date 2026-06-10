(() => {
  let users = [];
  let roles = [];
  let plugins = [];
  let formsTree = [];
  let navigationState = { topbar: [] };
  let navigationCatalog = { plugins: [], docs: [], cmsPages: [], roles: [] };
  let selectedNavigationNodeId = null;
  let draggedNavigationNodeId = null;
  let currentFormSelection = null;
  let formDraftFields = [];
  let expandedFormFieldKeys = new Set();
  let draggedFieldIndex = null;
  let activeFormSubtab = 'fields';
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
    document.querySelector('[data-new-form]')?.addEventListener('click', () => openFormCreateDialog());
    document.querySelectorAll('[data-admin-tab]').forEach((button) => {
      button.addEventListener('click', () => setActiveTab(button.dataset.adminTab || 'content'));
    });
    document.querySelector('#settingsForm')?.addEventListener('submit', saveSettings);
    document.querySelector('#formEditorForm')?.addEventListener('submit', saveFormContent);
    document.querySelector('#deleteFormButton')?.addEventListener('click', deleteCurrentForm);
    document.querySelector('[data-add-form-field]')?.addEventListener('click', () => openFieldDialog());
    document.querySelector('[data-add-divider-field]')?.addEventListener('click', () => openFieldDialog({ type: 'divider' }));
    document.querySelector('#backToFormsListButton')?.addEventListener('click', closeFormDetail);
    document.querySelectorAll('[data-form-subtab]').forEach((button) => {
      button.addEventListener('click', () => setActiveFormSubtab(button.dataset.formSubtab || 'fields'));
    });
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
      const [userRows, roleRows, pluginRows, navigationResponse] = await Promise.all([
        fetchJson('/api/admin/users'),
        fetchJson('/api/admin/roles'),
        fetchJson('/api/admin/plugins'),
        fetchJson('/api/admin/navigation')
      ]);
      const formsFeature = Array.isArray(pluginRows) ? pluginRows.find((plugin) => plugin.key === 'forms') : null;
      const formsResponse = formsFeature ? await fetchJson('/api/admin/forms') : null;
      users = Array.isArray(userRows) ? userRows : [];
      roles = Array.isArray(roleRows) ? roleRows : [];
      plugins = Array.isArray(pluginRows) ? pluginRows : [];
      formsTree = Array.isArray(formsResponse?.tree) ? formsResponse.tree : [];
      navigationState = normalizeNavigationState(navigationResponse?.navigation);
      navigationCatalog = {
        plugins: Array.isArray(navigationResponse?.plugins) ? navigationResponse.plugins : [],
        docs: Array.isArray(navigationResponse?.docs) ? navigationResponse.docs : [],
        cmsPages: Array.isArray(navigationResponse?.cmsPages) ? navigationResponse.cmsPages : [],
        roles: Array.isArray(navigationResponse?.roles) ? navigationResponse.roles : []
      };
      renderPlugins();
      renderUsers();
      renderRoles();
      renderFormsTree();
      renderNavigationEditor();
      renderAdminTabs();
      await restoreFormSelection();
    } catch (error) {
      renderAdminError(error);
    }
  }

  async function restoreFormSelection() {
    if (!currentFormSelection) {
      const params = new URLSearchParams(location.search);
      const formSlug = params.get('form');
      if (formSlug) await loadForm(formSlug);
      else closeFormDetail();
      return;
    }
    await loadForm(currentFormSelection.slug);
  }

  function renderPlugins() {
    const target = document.querySelector('#pluginsPanel');
    if (!target) return;
    const sortedPlugins = [...plugins].sort((a, b) => Number(b.enabled) - Number(a.enabled) || String(a.label).localeCompare(String(b.label)));
    target.innerHTML = sortedPlugins.map((plugin) => `
      <article class="plugin-card">
        <div class="plugin-card-head">
          <div>
            <div class="plugin-card-title-row">
              <h3>${esc(plugin.label)}</h3>
              <span class="plugin-status ${plugin.enabled ? 'enabled' : 'disabled'}">${plugin.enabled ? msg('enabled', 'Enabled') : msg('disabled', 'Disabled')}</span>
            </div>
            <p>${esc(plugin.description)}</p>
          </div>
          <label class="switch">
            <input type="checkbox" data-plugin-toggle="${esc(plugin.key)}" ${plugin.enabled ? 'checked' : ''}>
            <span class="switch-track"></span>
            <span class="switch-label">${msg('active', 'Active')}</span>
          </label>
        </div>
        <div class="plugin-card-actions">
          <a class="button small ghost" href="${esc(plugin.href)}">${msg('open', 'Open')}</a>
          ${plugin.adminHref ? `<a class="button small" href="${esc(plugin.adminHref)}">${msg('manage', 'Manage')}</a>` : ''}
        </div>
      </article>
    `).join('');

    target.querySelectorAll('[data-plugin-toggle]').forEach((input) => input.addEventListener('change', async () => {
      try {
        const response = await fetchJson('/api/admin/plugins', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: input.dataset.pluginToggle, enabled: input.checked })
        });
        plugins = Array.isArray(response.plugins) ? response.plugins : plugins;
        renderPlugins();
        showToast(msg('pluginSettingsSaved', 'Plugin settings saved.'));
      } catch (error) {
        showError(error);
      }
    }));
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

  function renderFormsTree() {
    const target = document.querySelector('#formsTree');
    if (!target) return;
    target.innerHTML = formsTree.length
      ? `<div class="content-tree-list">${formsTree.map((form) => renderFormNode(form)).join('')}</div>`
      : `<div class="notice">${msg('noForms', 'No forms available yet.')}</div>`;

    target.querySelectorAll('[data-open-form]').forEach((button) => button.addEventListener('click', async () => {
      await loadForm(button.dataset.openForm);
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

  function renderFormNode(form) {
    const active = currentFormSelection?.slug === form.slug;
    return `
      <button class="content-tree-item ${active ? 'active' : ''}" type="button" data-open-form="${esc(form.slug)}">
        <span class="content-tree-kind">${form.status === 'archived' ? 'ARC' : 'FORM'}</span>
        <span class="content-tree-label">${esc(form.title || form.slug)}</span>
      </button>
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

  async function loadForm(slug) {
    try {
      const form = await fetchJson(`/api/admin/forms/form?slug=${encodeURIComponent(slug)}`);
      setActiveTab('forms');
      currentFormSelection = { slug: form.slug };
      formDraftFields = Array.isArray(form.fields) ? structuredClone(form.fields) : [];
      syncAdminUrl();
      renderFormsTree();
      updateFormsAdminLayout();
      document.querySelector('#formEditorTitle').textContent = `${msg('formEditor', 'Form editor')}: ${form.title || form.slug}`;
      document.querySelector('#formEditorEmpty').hidden = true;
      const editorForm = document.querySelector('#formEditorForm');
      editorForm.hidden = false;
      editorForm.elements.id.value = form.id || '';
      editorForm.elements.slug.value = form.slug || '';
      editorForm.elements.title.value = form.title || '';
      editorForm.elements.status.value = form.status || 'active';
      editorForm.elements.description.value = form.description || '';
      editorForm.elements.intro_text.value = form.introText || '';
      renderPermissionMatrix(form.permissions || {});
      renderFormFieldRows();
      setActiveFormSubtab(activeFormSubtab);
      document.querySelector('#deleteFormButton').hidden = false;
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
        showToast(msg('userSaved', 'User saved.'));
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
        showToast(msg('roleSaved', 'Role saved.'));
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
      await fetchJson('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      window.DisplayPopupMsgAfterReload?.(msg('settingsSaved', 'Settings saved.'));
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
      showToast(msg('pageSaved', 'Page saved.'));
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
      showToast(msg('categorySaved', 'Category saved.'));
    } catch (error) {
      showError(error);
    }
  }

  async function saveFormContent(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      id: form.elements.id.value || undefined,
      slug: form.elements.slug.value,
      title: form.elements.title.value,
      status: form.elements.status.value,
      description: form.elements.description.value,
      introText: form.elements.intro_text.value,
      permissions: readPermissionMatrix(),
      fields: readFormFields()
    };
    try {
      const result = await fetchJson('/api/admin/forms/form', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      await refresh();
      if (result?.slug) await loadForm(result.slug);
      showToast(msg('formSaved', 'Form saved.'));
    } catch (error) {
      showError(error);
    }
  }

  async function deleteCurrentForm() {
    const id = document.querySelector('#formEditorForm')?.elements.id.value;
    if (!id || !confirm(msg('deleteFormConfirm', 'Delete this form and all submissions?'))) return;
    try {
      await fetchJson(`/api/admin/forms/form/${id}`, { method: 'DELETE' });
      currentFormSelection = null;
      document.querySelector('#formEditorForm').hidden = true;
      document.querySelector('#formEditorEmpty').hidden = false;
      await refresh();
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
        showToast(msg('pageCreated', 'Page created.'));
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
        showToast(msg('categoryCreated', 'Category created.'));
      } catch (error) {
        showError(error);
      }
    });
  }

  function openFormCreateDialog() {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${msg('createForm', 'Create form')}</h2>
        <label>${msg('title', 'Title')} <input name="title" placeholder="User request" required></label>
        <label>${msg('formSlug', 'Form slug')} <input name="slug" placeholder="user-request"></label>
        <label>${msg('description', 'Description')} <textarea name="description" placeholder="Collect access, account or workflow requests."></textarea></label>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('create', 'Create')}</button></div>
      </form>
    `);

    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const result = await fetchJson('/api/admin/forms/form', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: form.get('title'),
            slug: form.get('slug'),
            description: form.get('description'),
            introText: 'Please complete the required information before submitting.',
            status: 'active',
            permissions: {
              manage: { roles: ['Admins'], users: [] },
              view: { roles: [], users: [] },
              evaluate: { roles: ['Admins'], users: [] },
              submit: { roles: ['Users'], users: [] }
            },
            fields: [
              { key: 'request_title', label: 'Request title', type: 'text', required: true, placeholder: '', helpText: '', options: [] },
              { key: 'details', label: 'Details', type: 'textarea', required: true, placeholder: '', helpText: '', options: [] }
            ]
          })
        });
        dialog.remove();
        await refresh();
        if (result?.slug) await loadForm(result.slug);
        showToast(msg('formCreated', 'Form created.'));
      } catch (error) {
        showError(error);
      }
    });
  }

  function renderPermissionMatrix(permissions = {}) {
    const target = document.querySelector('#formPermissionsEditor');
    if (!target) return;
    const entries = [
      ['manage', msg('manage', 'Manage')],
      ['view', msg('view', 'View')],
      ['evaluate', msg('evaluate', 'Evaluate')],
      ['submit', msg('submit', 'Submit')]
    ];
    target.innerHTML = entries.map(([key, label]) => `
      <section class="permission-card" data-permission-key="${esc(key)}">
        <div>
          <strong>${esc(label)}</strong>
          <p class="hint">${permissionHint(key)}</p>
        </div>
        <div class="permission-grid">
          <fieldset>
            <legend>${msg('groups', 'Groups')}</legend>
            ${roles.map((role) => `
              <label class="check">
                <input type="checkbox" data-permission-scope="role" data-permission-key="${esc(key)}" value="${esc(role.name)}" ${(permissions[key]?.roles || []).includes(role.name) ? 'checked' : ''}>
                ${esc(role.name)}
              </label>
            `).join('')}
          </fieldset>
          <fieldset>
            <legend>${msg('people', 'People')}</legend>
            ${users.map((user) => `
              <label class="check">
                <input type="checkbox" data-permission-scope="user" data-permission-key="${esc(key)}" value="${esc(user.email)}" ${(permissions[key]?.users || []).includes(user.email) ? 'checked' : ''}>
                ${esc(user.name || user.email)}
              </label>
            `).join('')}
          </fieldset>
        </div>
      </section>
    `).join('');
  }

  function permissionHint(key) {
    const hints = {
      manage: msg('manageFormHint', 'Can edit structure, access and status. The creator always keeps access.'),
      view: msg('viewFormHint', 'Can open the form without necessarily submitting or reviewing it.'),
      evaluate: msg('evaluateFormHint', 'Can inspect submissions and record review notes or decisions.'),
      submit: msg('submitFormHint', 'Can fill in and submit this form.')
    };
    return hints[key] || '';
  }

  function readPermissionMatrix() {
    const permissions = {};
    ['manage', 'view', 'evaluate', 'submit'].forEach((key) => {
      permissions[key] = {
        roles: Array.from(document.querySelectorAll(`input[data-permission-scope="role"][data-permission-key="${key}"]:checked`)).map((input) => input.value),
        users: Array.from(document.querySelectorAll(`input[data-permission-scope="user"][data-permission-key="${key}"]:checked`)).map((input) => input.value)
      };
    });
    return permissions;
  }

  function renderFormFieldRows() {
    const target = document.querySelector('#formFieldsEditor');
    if (!target) return;
    target.innerHTML = formDraftFields.length
      ? formDraftFields.map((field, index) => renderFieldCard(field, index)).join('')
      : `<div class="notice">${msg('noFieldsYet', 'No fields yet. Add the first field to start building this form.')}</div>`;

    target.querySelectorAll('[data-edit-form-field]').forEach((button) => button.addEventListener('click', () => {
      openFieldDialog(formDraftFields[Number(button.dataset.editFormField)], Number(button.dataset.editFormField));
    }));
    target.querySelectorAll('[data-remove-form-field]').forEach((button) => button.addEventListener('click', () => {
      removeField(Number(button.dataset.removeFormField));
    }));
    target.querySelectorAll('[data-toggle-field-details]').forEach((button) => button.addEventListener('click', () => {
      toggleFieldDetails(Number(button.dataset.toggleFieldDetails));
    }));
    target.querySelectorAll('[data-form-field-card]').forEach((card) => {
      card.addEventListener('dragstart', handleFieldDragStart);
      card.addEventListener('dragover', handleFieldDragOver);
      card.addEventListener('drop', handleFieldDrop);
      card.addEventListener('dragend', handleFieldDragEnd);
    });
  }

  function renderFieldCard(field, index) {
    const expanded = expandedFormFieldKeys.has(field.key);
    const visibility = describeVisibility(field.visibility);
    const options = field.type === 'select' ? (field.options || []).join(', ') : '';
    return `
      <section class="form-field-row ${field.type === 'divider' ? 'is-divider' : ''} ${expanded ? 'is-expanded' : ''}" draggable="true" data-form-field-card="${index}">
        <div class="form-field-row-head">
          <div class="form-field-row-title">
            <button class="icon-button field-disclosure" type="button" data-toggle-field-details="${index}" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? '▾' : '▸'}</button>
            <div>
              <strong>${esc(field.label || field.key)}</strong>
              <p class="hint">${esc(field.type === 'divider' ? msg('sectionDivider', 'Section divider') : field.type)}</p>
            </div>
          </div>
          <div class="row-actions">
            <button class="button small" type="button" data-edit-form-field="${index}">${msg('edit', 'Edit')}</button>
            <button class="button small danger" type="button" data-remove-form-field="${index}">${msg('delete', 'Delete')}</button>
          </div>
        </div>
        <div class="form-field-summary">
          <span class="pill">${esc(field.type)}</span>
          <span class="pill">${esc(field.key)}</span>
          ${field.required ? `<span class="pill">${msg('required', 'Required')}</span>` : ''}
        </div>
        <div class="form-field-details" ${expanded ? '' : 'hidden'}>
          ${options ? `<p class="hint"><strong>${msg('options', 'Options')}:</strong> ${esc(options)}</p>` : ''}
          ${visibility ? `<p class="hint"><strong>${msg('visibilityRule', 'Visibility rule')}:</strong> ${esc(visibility)}</p>` : ''}
          ${field.helpText ? `<p class="hint">${esc(field.helpText)}</p>` : ''}
          ${!options && !visibility && !field.helpText ? `<p class="hint">${msg('noAdditionalDetails', 'No additional details for this field.')}</p>` : ''}
        </div>
      </section>
    `;
  }

  function readFormFields() {
    return formDraftFields.slice();
  }

  function openFieldDialog(field = null, index = null) {
    const editMode = Number.isInteger(index);
    const dependencies = formDraftFields
      .filter((item, itemIndex) => item.type !== 'divider' && itemIndex !== index)
      .map((item) => item.key);
    const dialog = modal(`
      <form class="modal-form">
        <h2>${editMode ? msg('editField', 'Edit field') : msg('addField', 'Add field')}</h2>
        <div class="content-meta">
          <label>${msg('type', 'Type')}
            <select name="type">
              ${['text', 'textarea', 'email', 'select', 'date', 'number', 'checkbox', 'divider'].map((type) => `<option value="${type}" ${field?.type === type ? 'selected' : ''}>${esc(type)}</option>`).join('')}
            </select>
          </label>
          <label>${msg('label', 'Label')} <input name="label" value="${esc(field?.label || '')}" required></label>
          <label>${msg('key', 'Key')} <input name="key" value="${esc(field?.key || '')}" placeholder="request_title"></label>
          <label>${msg('placeholder', 'Placeholder')} <input name="placeholder" value="${esc(field?.placeholder || '')}"></label>
        </div>
        <label>${msg('helpText', 'Help text')} <input name="helpText" value="${esc(field?.helpText || '')}"></label>
        <label>${msg('optionsCsv', 'Options (comma separated)')} <input name="options" value="${esc((field?.options || []).join(', '))}" placeholder="Option A, Option B"></label>
        <label class="check"><input name="required" type="checkbox" ${field?.required ? 'checked' : ''}> ${msg('required', 'Required')}</label>
        <div class="panel-inline-section">
          <div class="panel-head compact"><h2>${msg('visibilityRule', 'Visibility rule')}</h2></div>
          <label>${msg('dependsOnField', 'Depends on field')}
            <select name="visibility_field">
              <option value="">${esc(msg('alwaysVisible', 'Always visible'))}</option>
              ${dependencies.map((key) => `<option value="${esc(key)}" ${field?.visibility?.fieldKey === key ? 'selected' : ''}>${esc(key)}</option>`).join('')}
            </select>
          </label>
          <div class="content-meta">
            <label>${msg('conditionType', 'Condition')}
              <select name="visibility_mode">
                <option value="filled" ${field?.visibility?.mode !== 'equals' ? 'selected' : ''}>${esc(msg('isFilled', 'Is filled / enabled'))}</option>
                <option value="equals" ${field?.visibility?.mode === 'equals' ? 'selected' : ''}>${esc(msg('equalsValue', 'Equals value'))}</option>
              </select>
            </label>
            <label>${msg('expectedValue', 'Expected value')} <input name="visibility_value" value="${esc(field?.visibility?.expectedValue || '')}" placeholder="Ja"></label>
          </div>
        </div>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('save', 'Save')}</button></div>
      </form>
    `);
    const typeSelect = dialog.querySelector('select[name="type"]');
    const syncFieldDialog = () => {
      const type = typeSelect.value;
      const optionsLabel = dialog.querySelector('input[name="options"]').closest('label');
      const requiredLabel = dialog.querySelector('input[name="required"]').closest('label');
      const visibilityPanel = dialog.querySelector('.panel-inline-section');
      optionsLabel.hidden = type !== 'select';
      requiredLabel.hidden = type === 'divider';
      dialog.querySelector('input[name="placeholder"]').closest('label').hidden = type === 'divider';
      dialog.querySelector('input[name="helpText"]').closest('label').hidden = type === 'divider';
      visibilityPanel.hidden = type === 'divider';
    };
    typeSelect.addEventListener('change', syncFieldDialog);
    syncFieldDialog();
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const type = String(form.get('type') || 'text');
      const nextField = {
        key: form.get('key'),
        label: form.get('label'),
        type,
        placeholder: form.get('placeholder'),
        helpText: form.get('helpText'),
        options: parseCsv(form.get('options')),
        required: form.get('required') === 'on'
      };
      const visibilityField = String(form.get('visibility_field') || '').trim();
      if (visibilityField && type !== 'divider') {
        nextField.visibility = {
          fieldKey: visibilityField,
          mode: form.get('visibility_mode'),
          expectedValue: form.get('visibility_value')
        };
      }
      if (editMode) formDraftFields[index] = nextField;
      else formDraftFields.push(nextField);
      renderFormFieldRows();
      dialog.remove();
    });
  }

  function moveField(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= formDraftFields.length) return;
    const [field] = formDraftFields.splice(index, 1);
    formDraftFields.splice(nextIndex, 0, field);
    renderFormFieldRows();
  }

  function removeField(index) {
    const removed = formDraftFields[index];
    if (removed?.key) expandedFormFieldKeys.delete(removed.key);
    formDraftFields.splice(index, 1);
    renderFormFieldRows();
  }

  function toggleFieldDetails(index) {
    const field = formDraftFields[index];
    if (!field?.key) return;
    if (expandedFormFieldKeys.has(field.key)) expandedFormFieldKeys.delete(field.key);
    else expandedFormFieldKeys.add(field.key);
    renderFormFieldRows();
  }

  function handleFieldDragStart(event) {
    draggedFieldIndex = Number(event.currentTarget.dataset.formFieldCard);
    event.currentTarget.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(draggedFieldIndex));
  }

  function handleFieldDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('is-drop-target');
  }

  function handleFieldDrop(event) {
    event.preventDefault();
    const targetIndex = Number(event.currentTarget.dataset.formFieldCard);
    const sourceIndex = Number.isInteger(draggedFieldIndex) ? draggedFieldIndex : Number(event.dataTransfer.getData('text/plain'));
    event.currentTarget.classList.remove('is-drop-target');
    if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex) || sourceIndex === targetIndex) return;
    const [field] = formDraftFields.splice(sourceIndex, 1);
    formDraftFields.splice(targetIndex, 0, field);
    draggedFieldIndex = null;
    renderFormFieldRows();
  }

  function handleFieldDragEnd(event) {
    draggedFieldIndex = null;
    document.querySelectorAll('[data-form-field-card]').forEach((card) => {
      card.classList.remove('is-dragging', 'is-drop-target');
    });
    event.currentTarget.classList.remove('is-dragging');
  }

  function describeVisibility(visibility) {
    if (!visibility?.fieldKey) return '';
    if (visibility.mode === 'equals') return `${visibility.fieldKey} = ${visibility.expectedValue || ''}`;
    return `${visibility.fieldKey} ${msg('mustBeFilled', 'must be filled')}`;
  }

  function closeFormDetail() {
    currentFormSelection = null;
    formDraftFields = [];
    expandedFormFieldKeys = new Set();
    const editor = document.querySelector('#formEditorForm');
    const empty = document.querySelector('#formEditorEmpty');
    if (editor) editor.hidden = true;
    if (empty) empty.hidden = false;
    updateFormsAdminLayout();
    syncAdminUrl();
  }

  function updateFormsAdminLayout() {
    const listPanel = document.querySelector('#formsTree')?.closest('[data-admin-panel="forms"]');
    const detailPanel = document.querySelector('.form-detail-panel-admin[data-admin-panel="forms"]');
    const backButton = document.querySelector('#backToFormsListButton');
    const hasSelection = Boolean(currentFormSelection?.slug);
    const formsTabActive = activeAdminTab === 'forms';
    if (listPanel) listPanel.hidden = !formsTabActive || hasSelection;
    if (detailPanel) detailPanel.classList.toggle('is-full-width', hasSelection);
    if (backButton) backButton.hidden = !hasSelection;
  }

  function normalizeNavigationState(value) {
    return {
      topbar: normalizeNavigationNodes(value?.topbar),
      overflowLabel: String(value?.overflowLabel || msg('more', 'More')).trim() || msg('more', 'More'),
      maxVisibleItems: normalizeNavigationMaxVisibleItems(value?.maxVisibleItems)
    };
  }

  function normalizeNavigationMaxVisibleItems(value) {
    const count = Number(value);
    if (!Number.isFinite(count)) return 5;
    return Math.min(12, Math.max(1, Math.round(count)));
  }

  function normalizeNavigationNodes(nodes) {
    return Array.isArray(nodes) ? nodes.map((node) => normalizeNavigationNode(node)).filter(Boolean) : [];
  }

  function normalizeNavigationNode(node) {
    if (!node || typeof node !== 'object') return null;
    const children = normalizeNavigationNodes(node.children);
    const target = normalizeNavigationTarget(node.target);
    const label = String(node.label || '').trim();
    if (!label && !target && !children.length) return null;
    return {
      id: String(node.id || createNavigationId()),
      label: label || defaultLabelForTarget(target),
      roles: Array.isArray(node.roles) ? node.roles.map(String).map((role) => role.trim()).filter(Boolean) : [],
      target,
      children
    };
  }

  function normalizeNavigationTarget(target) {
    const type = String(target?.type || '').trim();
    if (type === 'custom') {
      const href = String(target?.href || '').trim();
      return href ? { type, href } : null;
    }
    if (type === 'plugin') {
      const pluginKey = String(target?.pluginKey || '').trim();
      return pluginKey ? { type, pluginKey } : null;
    }
    if (type === 'doc' || type === 'cms') {
      const slug = String(target?.slug || '').trim();
      return slug ? { type, slug } : null;
    }
    if (type === 'home') return { type };
    return null;
  }

  function createNavigationId() {
    return `nav_${Math.random().toString(36).slice(2, 10)}`;
  }

  function renderNavigationEditor() {
    const target = document.querySelector('#navigationPanel');
    if (!target) return;
    const tree = navigationState.topbar || [];
    let selected = findNavigationNode(tree, selectedNavigationNodeId)?.node || null;
    if (!selected && tree[0]) {
      selectedNavigationNodeId = tree[0].id;
      selected = tree[0];
    }
    target.innerHTML = `
      <div class="navigation-editor">
        <section class="navigation-overflow-settings">
          <div>
            <strong>${msg('responsiveNavigation', 'Responsive navigation')}</strong>
            <p>${msg('responsiveNavigationText', 'When the topbar gets crowded, Atlas groups remaining items under an automatic overflow menu.')}</p>
          </div>
          <label>${msg('overflowLabel', 'Overflow label')}
            <input name="overflowLabel" value="${esc(navigationState.overflowLabel || msg('more', 'More'))}" data-nav-overflow-label>
          </label>
          <label>${msg('visibleItemsBeforeOverflow', 'Visible items before overflow')}
            <input name="maxVisibleItems" type="number" min="1" max="12" value="${esc(navigationState.maxVisibleItems || 5)}" data-nav-max-visible>
          </label>
        </section>
        <div class="navigation-editor-layout">
          <section class="panel-inline-section">
            <div class="navigation-toolbar">
              <div class="panel-head-actions">
                <button class="button" type="button" data-add-nav-node="group">${msg('addGroup', '+ Group')}</button>
                <button class="button" type="button" data-add-nav-node="custom">${msg('addLink', '+ Link')}</button>
                <button class="button" type="button" data-add-nav-node="plugin">${msg('addPluginLink', '+ Plugin')}</button>
                <button class="button" type="button" data-add-nav-node="doc">${msg('addDocLink', '+ Doc')}</button>
                <button class="button" type="button" data-add-nav-node="cms">${msg('addPageLink', '+ Page')}</button>
              </div>
              <button class="button primary" type="button" data-save-navigation>${msg('saveNavigation', 'Save navigation')}</button>
            </div>
            <div class="navigation-tree">${renderNavigationList(tree, null)}</div>
          </section>
          <section class="panel-inline-section">
            ${renderNavigationInspector(selected)}
          </section>
        </div>
      </div>
    `;

    target.querySelectorAll('[data-add-nav-node]').forEach((button) => button.addEventListener('click', () => {
      addNavigationNode(button.dataset.addNavNode || 'group');
    }));
    target.querySelector('[data-save-navigation]')?.addEventListener('click', saveNavigation);
    target.querySelector('[data-nav-overflow-label]')?.addEventListener('input', (event) => {
      navigationState = { ...navigationState, overflowLabel: event.target.value.trim() || msg('more', 'More') };
    });
    target.querySelector('[data-nav-max-visible]')?.addEventListener('input', (event) => {
      navigationState = { ...navigationState, maxVisibleItems: normalizeNavigationMaxVisibleItems(event.target.value) };
    });
    target.querySelectorAll('[data-nav-select]').forEach((button) => button.addEventListener('click', () => {
      selectedNavigationNodeId = button.dataset.navSelect;
      renderNavigationEditor();
    }));
    target.querySelectorAll('[data-nav-delete]').forEach((button) => button.addEventListener('click', () => {
      deleteNavigationNode(button.dataset.navDelete);
    }));
    target.querySelectorAll('[data-nav-add-child]').forEach((button) => button.addEventListener('click', () => {
      addNavigationNode('group', button.dataset.navAddChild);
    }));
    target.querySelectorAll('[data-nav-drop-zone]').forEach((zone) => {
      zone.addEventListener('dragover', handleNavigationZoneDragOver);
      zone.addEventListener('dragleave', handleNavigationDragLeave);
      zone.addEventListener('drop', handleNavigationZoneDrop);
    });
    target.querySelectorAll('[data-nav-row]').forEach((row) => {
      row.addEventListener('dragstart', handleNavigationDragStart);
      row.addEventListener('dragend', handleNavigationDragEnd);
      row.addEventListener('dragover', handleNavigationRowDragOver);
      row.addEventListener('dragleave', handleNavigationDragLeave);
      row.addEventListener('drop', handleNavigationRowDrop);
    });

    const form = target.querySelector('#navigationInspectorForm');
    if (form) {
      form.addEventListener('change', handleNavigationInspectorChange);
    }
  }

  function renderNavigationList(nodes, parentId) {
    const list = Array.isArray(nodes) ? nodes : [];
    const body = list.map((node, index) => `
      ${renderNavigationDropZone(parentId, index)}
      ${renderNavigationNode(node)}
    `).join('');
    return `${body}${renderNavigationDropZone(parentId, list.length)}`;
  }

  function renderNavigationNode(node) {
    const selected = node.id === selectedNavigationNodeId;
    return `
      <div class="navigation-node">
        <div class="navigation-node-row ${selected ? 'active' : ''}" draggable="true" data-nav-row="${esc(node.id)}">
          <button class="navigation-node-main" type="button" data-nav-select="${esc(node.id)}">
            <span class="navigation-node-handle">⋮⋮</span>
            <span class="navigation-node-copy">
              <strong>${esc(node.label || defaultLabelForTarget(node.target) || msg('untitled', 'Untitled'))}</strong>
              <span>${esc(describeNavigationNode(node))}</span>
            </span>
          </button>
          <div class="row-actions">
            <button class="icon-button" type="button" data-nav-add-child="${esc(node.id)}" aria-label="${esc(msg('addChild', 'Add child'))}">+</button>
            <button class="icon-button" type="button" data-nav-delete="${esc(node.id)}" aria-label="${esc(msg('delete', 'Delete'))}">×</button>
          </div>
        </div>
        ${node.children?.length ? `<div class="navigation-node-children">${renderNavigationList(node.children, node.id)}</div>` : ''}
      </div>
    `;
  }

  function renderNavigationDropZone(parentId, index) {
    return `<div class="navigation-drop-zone" data-nav-drop-zone data-parent-id="${esc(parentId || '')}" data-drop-index="${index}"></div>`;
  }

  function renderNavigationInspector(node) {
    if (!node) {
      return `
        <div class="empty-state content-empty-state">
          <h1>${msg('selectNavigationNode', 'Select a navigation item')}</h1>
          <p>${msg('selectNavigationNodeText', 'Pick an item on the left to rename it, change the target or adjust visibility.')}</p>
        </div>
      `;
    }
    const targetType = navigationTargetType(node);
    return `
      <form id="navigationInspectorForm" class="modal-form">
        <input type="hidden" name="id" value="${esc(node.id)}">
        <label>${msg('label', 'Label')} <input name="label" value="${esc(node.label || '')}" required></label>
        <label>${msg('visibleForRoles', 'Visible for roles')} <input name="roles" value="${esc((node.roles || []).join(', '))}" placeholder="Admins, Users"></label>
        <label>${msg('targetType', 'Target type')}
          <select name="target_type">
            <option value="group" ${targetType === 'group' ? 'selected' : ''}>${esc(msg('groupOnly', 'Group only'))}</option>
            <option value="home" ${targetType === 'home' ? 'selected' : ''}>${esc(msg('documentationHome', 'Documentation home'))}</option>
            <option value="custom" ${targetType === 'custom' ? 'selected' : ''}>${esc(msg('customUrl', 'Custom URL'))}</option>
            <option value="plugin" ${targetType === 'plugin' ? 'selected' : ''}>${esc(msg('pluginPage', 'Plugin page'))}</option>
            <option value="doc" ${targetType === 'doc' ? 'selected' : ''}>${esc(msg('documentationPage', 'Documentation page'))}</option>
            <option value="cms" ${targetType === 'cms' ? 'selected' : ''}>${esc(msg('cmsPage', 'CMS page'))}</option>
          </select>
        </label>
        ${targetType === 'custom' ? `<label>${msg('url', 'URL')} <input name="target_href" value="${esc(node.target?.href || '')}" placeholder="/blog"></label>` : ''}
        ${targetType === 'plugin' ? `<label>${msg('pluginPage', 'Plugin page')} <select name="target_plugin">${renderNavigationPluginOptions(node.target?.pluginKey)}</select></label>` : ''}
        ${targetType === 'doc' ? `<label>${msg('documentationPage', 'Documentation page')} <select name="target_doc">${renderNavigationDocOptions(node.target?.slug)}</select></label>` : ''}
        ${targetType === 'cms' ? `<label>${msg('cmsPage', 'CMS page')} <select name="target_cms">${renderNavigationCmsOptions(node.target?.slug)}</select></label>` : ''}
      </form>
    `;
  }

  function renderNavigationPluginOptions(selectedKey) {
    return navigationCatalog.plugins.map((plugin) => `<option value="${esc(plugin.key)}" ${plugin.key === selectedKey ? 'selected' : ''}>${esc(plugin.label)}${plugin.enabled ? '' : ` (${esc(msg('disabled', 'Disabled'))})`}</option>`).join('');
  }

  function renderNavigationDocOptions(selectedSlug) {
    return navigationCatalog.docs.map((doc) => `<option value="${esc(doc.slug)}" ${doc.slug === selectedSlug ? 'selected' : ''}>${esc(doc.title)}</option>`).join('');
  }

  function renderNavigationCmsOptions(selectedSlug) {
    return navigationCatalog.cmsPages.map((page) => `<option value="${esc(page.slug)}" ${page.slug === selectedSlug ? 'selected' : ''}>${esc(page.title)}</option>`).join('');
  }

  function navigationTargetType(node) {
    return node?.target?.type || 'group';
  }

  function describeNavigationNode(node) {
    const type = navigationTargetType(node);
    if (type === 'group') return msg('group', 'Group');
    if (type === 'home') return msg('documentationHome', 'Documentation home');
    if (type === 'custom') return node.target?.href || msg('customUrl', 'Custom URL');
    if (type === 'plugin') return navigationCatalog.plugins.find((plugin) => plugin.key === node.target?.pluginKey)?.label || msg('pluginPage', 'Plugin page');
    if (type === 'doc') return navigationCatalog.docs.find((doc) => doc.slug === node.target?.slug)?.title || msg('documentationPage', 'Documentation page');
    if (type === 'cms') return navigationCatalog.cmsPages.find((page) => page.slug === node.target?.slug)?.title || msg('cmsPage', 'CMS page');
    return '';
  }

  function defaultLabelForTarget(target) {
    if (!target) return '';
    if (target.type === 'home') return msg('home', 'Home');
    if (target.type === 'custom') return target.href || msg('newLink', 'New link');
    if (target.type === 'plugin') return navigationCatalog.plugins.find((plugin) => plugin.key === target.pluginKey)?.label || msg('pluginPage', 'Plugin page');
    if (target.type === 'doc') return navigationCatalog.docs.find((doc) => doc.slug === target.slug)?.title || msg('documentationPage', 'Documentation page');
    if (target.type === 'cms') return navigationCatalog.cmsPages.find((page) => page.slug === target.slug)?.title || msg('cmsPage', 'CMS page');
    return '';
  }

  function createDefaultNavigationNode(kind) {
    if (kind === 'home') return { id: createNavigationId(), label: msg('home', 'Home'), roles: [], target: { type: 'home' }, children: [] };
    if (kind === 'plugin') {
      const plugin = navigationCatalog.plugins[0];
      return { id: createNavigationId(), label: plugin?.label || msg('pluginPage', 'Plugin page'), roles: [], target: plugin ? { type: 'plugin', pluginKey: plugin.key } : null, children: [] };
    }
    if (kind === 'doc') {
      const doc = navigationCatalog.docs[0];
      return { id: createNavigationId(), label: doc?.title || msg('documentationPage', 'Documentation page'), roles: [], target: doc ? { type: 'doc', slug: doc.slug } : null, children: [] };
    }
    if (kind === 'cms') {
      const page = navigationCatalog.cmsPages[0];
      return { id: createNavigationId(), label: page?.title || msg('cmsPage', 'CMS page'), roles: [], target: page ? { type: 'cms', slug: page.slug } : null, children: [] };
    }
    if (kind === 'custom') return { id: createNavigationId(), label: msg('newLink', 'New link'), roles: [], target: { type: 'custom', href: '/' }, children: [] };
    return { id: createNavigationId(), label: msg('newGroup', 'New group'), roles: [], target: null, children: [] };
  }

  function addNavigationNode(kind, parentId = null) {
    const nextNode = createDefaultNavigationNode(kind);
    mutateActiveNavigationTree((tree) => {
      if (!parentId) {
        tree.push(nextNode);
        return;
      }
      const parent = findNavigationNode(tree, parentId)?.node;
      if (!parent) {
        tree.push(nextNode);
        return;
      }
      parent.children = Array.isArray(parent.children) ? parent.children : [];
      parent.children.push(nextNode);
    });
    selectedNavigationNodeId = nextNode.id;
    renderNavigationEditor();
  }

  function deleteNavigationNode(nodeId) {
    mutateActiveNavigationTree((tree) => {
      removeNavigationNode(tree, nodeId);
    });
    if (selectedNavigationNodeId === nodeId) selectedNavigationNodeId = null;
    renderNavigationEditor();
  }

  function handleNavigationInspectorChange(event) {
    const form = event.currentTarget;
    const id = form.elements.id.value;
    mutateActiveNavigationTree((tree) => {
      const record = findNavigationNode(tree, id);
      if (!record?.node) return;
      record.node.label = form.elements.label.value.trim();
      record.node.roles = parseRoles(form.elements.roles.value);
      const targetType = form.elements.target_type.value;
      if (targetType === 'group') record.node.target = null;
      else if (targetType === 'home') record.node.target = { type: 'home' };
      else if (targetType === 'custom') record.node.target = { type: 'custom', href: form.elements.target_href.value.trim() || '/' };
      else if (targetType === 'plugin') record.node.target = { type: 'plugin', pluginKey: form.elements.target_plugin.value };
      else if (targetType === 'doc') record.node.target = { type: 'doc', slug: form.elements.target_doc.value };
      else if (targetType === 'cms') record.node.target = { type: 'cms', slug: form.elements.target_cms.value };
      if (!record.node.label) record.node.label = defaultLabelForTarget(record.node.target) || msg('newGroup', 'New group');
    });
    renderNavigationEditor();
  }

  async function saveNavigation() {
    try {
      const response = await fetchJson('/api/admin/navigation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ navigation: navigationState })
      });
      navigationState = normalizeNavigationState(response?.navigation || navigationState);
      renderNavigationEditor();
      showToast(msg('navigationSaved', 'Navigation saved.'), 'success');
    } catch (error) {
      showError(error);
    }
  }

  function mutateActiveNavigationTree(mutator) {
    const nextTree = cloneValue(navigationState.topbar || []);
    mutator(nextTree);
    navigationState = { ...navigationState, topbar: nextTree };
  }

  function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function findNavigationNode(nodes, id, parentId = null) {
    for (let index = 0; index < (nodes || []).length; index += 1) {
      const node = nodes[index];
      if (node.id === id) return { node, index, siblings: nodes, parentId };
      const child = findNavigationNode(node.children || [], id, node.id);
      if (child) return child;
    }
    return null;
  }

  function removeNavigationNode(nodes, id) {
    for (let index = 0; index < (nodes || []).length; index += 1) {
      if (nodes[index].id === id) return nodes.splice(index, 1)[0];
      const child = removeNavigationNode(nodes[index].children || [], id);
      if (child) return child;
    }
    return null;
  }

  function handleNavigationDragStart(event) {
    draggedNavigationNodeId = event.currentTarget.dataset.navRow;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedNavigationNodeId);
    event.currentTarget.classList.add('is-dragging');
  }

  function handleNavigationDragEnd(event) {
    draggedNavigationNodeId = null;
    clearNavigationDropTargets();
    event.currentTarget.classList.remove('is-dragging');
  }

  function handleNavigationZoneDragOver(event) {
    event.preventDefault();
    if (!draggedNavigationNodeId) return;
    clearNavigationDropTargets();
    event.currentTarget.classList.add('is-drop-target', 'is-insert-target');
  }

  function handleNavigationZoneDrop(event) {
    event.preventDefault();
    const parentId = event.currentTarget.dataset.parentId || null;
    const index = Number(event.currentTarget.dataset.dropIndex || 0);
    clearNavigationDropTargets();
    moveNavigationNode(parentId, index);
  }

  function handleNavigationRowDragOver(event) {
    event.preventDefault();
    if (!draggedNavigationNodeId) return;
    const targetId = event.currentTarget.dataset.navRow;
    const source = findNavigationNode(navigationState.topbar || [], draggedNavigationNodeId)?.node;
    if (!source || source.id === targetId || isNavigationDescendant(source, targetId)) return;
    clearNavigationDropTargets();
    event.currentTarget.classList.add('is-drop-target', 'is-child-drop-target');
  }

  function handleNavigationRowDrop(event) {
    event.preventDefault();
    const targetId = event.currentTarget.dataset.navRow;
    clearNavigationDropTargets();
    moveNavigationNode(targetId, null, { asChild: true });
  }

  function handleNavigationDragLeave(event) {
    const nextTarget = event.relatedTarget;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    event.currentTarget.classList.remove('is-drop-target', 'is-insert-target', 'is-child-drop-target');
  }

  function clearNavigationDropTargets() {
    document.querySelectorAll('.navigation-node-row, .navigation-drop-zone').forEach((element) => {
      element.classList.remove('is-drop-target', 'is-insert-target', 'is-child-drop-target');
    });
  }

  function moveNavigationNode(targetParentId, index, options = {}) {
    const sourceId = draggedNavigationNodeId;
    if (!sourceId) return;
    mutateActiveNavigationTree((tree) => {
      const sourceRecord = findNavigationNode(tree, sourceId);
      if (!sourceRecord?.node) return;
      if (targetParentId && (sourceRecord.node.id === targetParentId || isNavigationDescendant(sourceRecord.node, targetParentId))) return;
      const node = removeNavigationNode(tree, sourceId);
      if (!node) return;
      if (options.asChild && targetParentId) {
        const parent = findNavigationNode(tree, targetParentId)?.node;
        if (!parent) {
          tree.push(node);
          return;
        }
        parent.children = Array.isArray(parent.children) ? parent.children : [];
        parent.children.push(node);
        return;
      }
      if (!targetParentId) {
        const nextIndex = sourceRecord.siblings === tree && sourceRecord.index < index ? index - 1 : index;
        tree.splice(Math.max(0, nextIndex), 0, node);
        return;
      }
      const parent = findNavigationNode(tree, targetParentId)?.node;
      if (!parent) {
        const nextIndex = sourceRecord.siblings === tree && sourceRecord.index < index ? index - 1 : index;
        tree.splice(Math.max(0, nextIndex), 0, node);
        return;
      }
      parent.children = Array.isArray(parent.children) ? parent.children : [];
      const nextIndex = sourceRecord.siblings === parent.children && sourceRecord.index < index ? index - 1 : index;
      parent.children.splice(Math.max(0, nextIndex), 0, node);
    });
    draggedNavigationNodeId = null;
    renderNavigationEditor();
  }

  function isNavigationDescendant(node, targetId) {
    if (!node || !targetId) return false;
    return (node.children || []).some((child) => child.id === targetId || isNavigationDescendant(child, targetId));
  }

  function setActiveFormSubtab(tab) {
    activeFormSubtab = ['fields', 'permissions'].includes(tab) ? tab : 'fields';
    document.querySelectorAll('[data-form-subtab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.formSubtab === activeFormSubtab);
    });
    document.querySelectorAll('[data-form-subpanel]').forEach((panel) => {
      panel.hidden = panel.dataset.formSubpanel !== activeFormSubtab;
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
    const form = params.get('form');
    if (form) currentFormSelection = { slug: form };
  }

  function normalizeAdminTab(value) {
    return ['plugins', 'forms', 'content', 'navigation', 'access', 'instance'].includes(value) ? value : 'content';
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
    if (activeAdminTab === 'forms') updateFormsAdminLayout();
  }

  function syncAdminUrl() {
    const params = new URLSearchParams(location.search);
    params.set('tab', activeAdminTab);
    params.delete('form');
    if (currentFormSelection?.slug) {
      params.set('form', currentFormSelection.slug);
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

  function showToast(message, tone = 'success') {
    if (typeof window.DisplayPopupMsg === 'function') {
      window.DisplayPopupMsg(message, { tone });
    }
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

  function parseCsv(value) {
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
