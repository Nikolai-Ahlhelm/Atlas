let users = [];
let roles = [];
const I18N = readPortalI18n().messages || {};
const msg = (key, fallback) => I18N[key] || fallback || key;

initAdmin();

async function initAdmin() {
  await refresh();
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
}

async function refresh() {
  users = await fetchJson('/api/admin/users');
  roles = await fetchJson('/api/admin/roles');
  renderUsers();
  renderRoles();
}

function renderUsers() {
  const target = document.querySelector('#usersTable');
  target.innerHTML = `
    <table>
      <thead><tr><th>${msg('name', 'Name')}</th><th>${msg('email', 'E-Mail')}</th><th>${msg('roles', 'Rollen')}</th><th>${msg('status', 'Status')}</th><th></th></tr></thead>
      <tbody>
        ${users.map((user) => `
          <tr>
            <td>${esc(user.name)}${user.is_admin ? '<span class="tag">Admin</span>' : ''}</td>
            <td>${esc(user.email)}</td>
            <td>${user.roles.map((role) => `<span class="pill" style="--role-color: ${esc(roleColor(role))}">${esc(role)}</span>`).join('')}</td>
            <td>${user.active ? msg('active', 'Aktiv') : msg('blocked', 'Gesperrt')}</td>
            <td class="row-actions">
              <button class="button small" data-edit-user="${user.id}">${msg('edit', 'Bearbeiten')}</button>
              <button class="button small danger" data-delete-user="${user.id}">${msg('delete', 'Loeschen')}</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  target.querySelectorAll('[data-edit-user]').forEach((button) => button.addEventListener('click', () => {
    openUserDialog(users.find((user) => user.id === Number(button.dataset.editUser)));
  }));
  target.querySelectorAll('[data-delete-user]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm(msg('deleteUserConfirm', 'Diesen Nutzer wirklich loeschen?'))) return;
    await fetch(`/api/admin/users/${button.dataset.deleteUser}`, { method: 'DELETE' });
    await refresh();
  }));
}

function renderRoles() {
  const target = document.querySelector('#rolesTable');
  target.innerHTML = `
    <table>
      <thead><tr><th>${msg('role', 'Rolle')}</th><th>${msg('description', 'Beschreibung')}</th><th></th></tr></thead>
      <tbody>
        ${roles.map((role) => `
          <tr>
            <td><span class="pill" style="--role-color: ${esc(role.color || '#5d6b82')}">${esc(role.name)}</span></td>
            <td>${esc(role.description)}</td>
            <td class="row-actions">
              <button class="button small" data-edit-role="${role.id}">${msg('edit', 'Bearbeiten')}</button>
              <button class="button small danger" data-delete-role="${role.id}">${msg('delete', 'Loeschen')}</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  target.querySelectorAll('[data-edit-role]').forEach((button) => button.addEventListener('click', () => {
    openRoleDialog(roles.find((role) => role.id === Number(button.dataset.editRole)));
  }));
  target.querySelectorAll('[data-delete-role]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm(msg('deleteRoleConfirm', 'Diese Rolle wirklich loeschen? Sie wird auch von Nutzern entfernt.'))) return;
    await fetch(`/api/admin/roles/${button.dataset.deleteRole}`, { method: 'DELETE' });
    await refresh();
  }));
}

function openUserDialog(user = {}) {
  const dialog = modal(`
    <form class="modal-form">
      <h2>${user.id ? msg('editUser', 'Nutzer bearbeiten') : msg('createUser', 'Nutzer anlegen')}</h2>
      <label>${msg('name', 'Name')} <input name="name" required value="${esc(user.name || '')}"></label>
      <label>${msg('email', 'E-Mail')} <input name="email" type="email" required value="${esc(user.email || '')}"></label>
      <label>${msg('password', 'Passwort')} <input name="password" type="password" placeholder="${user.id ? msg('leaveEmptyUnchanged', 'Leer lassen, wenn unveraendert') : ''}"></label>
      <div class="check-row"><label><input name="is_admin" type="checkbox" ${user.is_admin ? 'checked' : ''}> Admin</label><label><input name="active" type="checkbox" ${user.active !== false ? 'checked' : ''}> ${msg('active', 'Aktiv')}</label></div>
      <fieldset><legend>${msg('roles', 'Rollen')}</legend>${roles.map((role) => `<label class="check"><input name="roles" type="checkbox" value="${esc(role.name)}" ${(user.roles || []).includes(role.name) ? 'checked' : ''}> ${esc(role.name)}</label>`).join('')}</fieldset>
      <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Abbrechen')}</button><button class="button primary" type="submit">${msg('save', 'Speichern')}</button></div>
    </form>
  `);
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
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
  });
}

function openRoleDialog(role = {}) {
  const dialog = modal(`
    <form class="modal-form">
      <h2>${role.name ? msg('editRole', 'Rolle bearbeiten') : msg('createRole', 'Rolle anlegen')}</h2>
      <label>${msg('name', 'Name')} <input name="name" required value="${esc(role.name || '')}"></label>
      <label>${msg('description', 'Beschreibung')} <textarea name="description">${esc(role.description || '')}</textarea></label>
      <label>${msg('color', 'Farbe')} <input name="color" type="color" value="${esc(role.color || '#5d6b82')}"></label>
      <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Abbrechen')}</button><button class="button primary" type="submit">${msg('save', 'Speichern')}</button></div>
    </form>
  `);
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await fetchJson('/api/admin/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: role.id, name: form.get('name'), description: form.get('description'), color: form.get('color') })
    });
    dialog.remove();
    await refresh();
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  try {
    JSON.parse(payload.menu_links || '[]');
  } catch {
    alert(msg('invalidMenuJson', 'Die Menueleisten-Links sind kein gueltiges JSON.'));
    return;
  }
  await fetchJson('/api/admin/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  location.reload();
}

function handleLogoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 250_000) {
    alert(msg('logoTooLarge', 'Bitte ein Logo unter 250 KB verwenden.'));
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

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(await response.text());
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
