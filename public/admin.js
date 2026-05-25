(() => {
  let users = [];
  let roles = [];
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
    document.querySelector('#settingsForm')?.addEventListener('submit', saveSettings);
    document.querySelector('input[name="font_scale"]')?.addEventListener('input', (event) => {
      document.querySelector('[data-font-preview]').textContent = `${Math.round(Number(event.target.value) * 100)}%`;
    });
    document.querySelector('input[name="logo_upload"]')?.addEventListener('change', handleLogoUpload);
    document.querySelector('[data-reload-content]')?.addEventListener('click', async () => {
      await fetch('/api/admin/reload', { method: 'POST' });
      location.reload();
    });
    document.querySelector('[data-factory-reset]')?.addEventListener('click', openFactoryResetDialog);
    await refresh();
  }

  async function refresh() {
    try {
      clearAdminError();
      const [userRows, roleRows] = await Promise.all([
        fetchJson('/api/admin/users'),
        fetchJson('/api/admin/roles')
      ]);
      users = Array.isArray(userRows) ? userRows : [];
      roles = Array.isArray(roleRows) ? roleRows : [];
      renderUsers();
      renderRoles();
    } catch (error) {
      renderAdminError(error);
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

  function openUserDialog(user = {}) {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${user.id ? msg('editUser', 'Edit user') : msg('createUser', 'Create user')}</h2>
        <label>${msg('name', 'Name')} <input name="name" required value="${esc(user.name || '')}"></label>
        <label>${msg('email', 'Email')} <input name="email" type="email" required value="${esc(user.email || '')}"></label>
        <label>${msg('password', 'Password')} <input name="password" type="password" placeholder="${user.id ? msg('leaveEmptyUnchanged', 'Leave empty to keep unchanged') : ''}"></label>
        <div class="check-row"><label><input name="is_admin" type="checkbox" ${user.is_admin ? 'checked' : ''}> Admin</label><label><input name="active" type="checkbox" ${user.active !== false ? 'checked' : ''}> ${msg('active', 'Active')}</label></div>
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

  function handleLogoUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 4_000_000) {
      alert(msg('logoTooLarge', 'Please use a logo below 1 MB.'));
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
