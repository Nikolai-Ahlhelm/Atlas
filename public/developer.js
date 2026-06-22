(() => {
  const root = document.querySelector('[data-developer-page]');
  if (!root) return;

  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  const adminMode = root.dataset.adminMode === 'true';
  const state = { keys: [], scopes: [], users: [], permissions: {} };

  document.querySelector('[data-create-api-key]')?.addEventListener('click', () => openCreateDialog());
  document.querySelector('[data-refresh-api-keys]')?.addEventListener('click', () => refresh());
  refresh();

  async function refresh() {
    try {
      clearError();
      const data = await fetchJson(adminMode ? '/api/admin/developer/api-keys' : '/api/developer/api-keys');
      state.keys = Array.isArray(data.keys) ? data.keys : [];
      state.scopes = Array.isArray(data.scopes) ? data.scopes : [];
      state.users = Array.isArray(data.users) ? data.users : [];
      state.permissions = data.permissions || {};
      renderKeys();
      renderScopes();
    } catch (error) {
      showError(error);
    }
  }

  function renderKeys() {
    const target = document.querySelector('#apiKeysTable');
    if (!target) return;
    if (!state.keys.length) {
      target.innerHTML = `<div class="empty-state compact"><h1>${msg('noApiKeys', 'No API keys yet')}</h1><p>${msg('noApiKeysText', 'Create a key to connect an external integration.')}</p></div>`;
      return;
    }
    target.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>${msg('name', 'Name')}</th>
            <th>${msg('prefix', 'Prefix')}</th>
            ${adminMode ? `<th>${msg('owner', 'Owner')}</th>` : ''}
            <th>${msg('scopes', 'Scopes')}</th>
            <th>${msg('expiresAt', 'Expires at')}</th>
            <th>${msg('lastUsedAt', 'Last used')}</th>
            <th>${msg('status', 'Status')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${state.keys.map((key) => `
            <tr>
              <td><strong>${esc(key.name)}</strong><small>${esc(formatDate(key.createdAt))}</small></td>
              <td><code>${esc(key.prefix)}</code></td>
              ${adminMode ? `<td>${esc(key.ownerName || key.ownerEmail || '-')}<small>${esc(key.ownerEmail || '')}</small></td>` : ''}
              <td><div class="developer-pill-row">${(key.scopes || []).map((scope) => `<span class="pill">${esc(scope)}</span>`).join('')}</div></td>
              <td>${key.expiresAt ? esc(formatDate(key.expiresAt)) : '<span class="muted">Never</span>'}</td>
              <td>${key.lastUsedAt ? esc(formatDate(key.lastUsedAt)) : '<span class="muted">Never</span>'}<small>${Number(key.usageCount || 0)} requests</small></td>
              <td><span class="plugin-status ${key.isRevoked ? 'disabled' : 'enabled'}">${key.isRevoked ? msg('revoked', 'Revoked') : msg('active', 'Active')}</span></td>
              <td class="row-actions">${key.isRevoked ? '' : `<button class="button small danger" type="button" data-revoke-api-key="${key.id}">${msg('revoke', 'Revoke')}</button>`}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    target.querySelectorAll('[data-revoke-api-key]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!confirm(msg('revokeApiKeyConfirm', 'Revoke this API key? Existing integrations using it will stop working.'))) return;
        try {
          const base = adminMode ? '/api/admin/developer/api-keys' : '/api/developer/api-keys';
          await fetchJson(`${base}/${button.dataset.revokeApiKey}/revoke`, { method: 'POST' });
          await refresh();
        } catch (error) {
          showError(error);
        }
      });
    });
  }

  function renderScopes() {
    const target = document.querySelector('#apiScopesList');
    if (!target) return;
    target.innerHTML = state.scopes.map((scope) => `
      <article class="developer-scope-card">
        <code>${esc(scope.key)}</code>
        <p>${esc(scope.description || '')}</p>
      </article>
    `).join('');
  }

  function openCreateDialog() {
    const dialog = modal(`
      <form class="modal-form developer-key-form">
        <h2>${msg('createApiKey', 'Create API key')}</h2>
        <label>${msg('name', 'Name')}<input name="name" required placeholder="CI deploy, CRM sync"></label>
        ${adminMode && state.users.length ? `
          <label>${msg('owner', 'Owner')}
            <select name="ownerUserId">
              ${state.users.map((user) => `<option value="${user.id}">${esc(user.name || user.email)} (${esc(user.email)})</option>`).join('')}
            </select>
          </label>
        ` : ''}
        <label>${msg('expiresAt', 'Expires at')}<input name="expiresAt" type="datetime-local"></label>
        <fieldset>
          <legend>${msg('scopes', 'Scopes')}</legend>
          <div class="developer-scope-picker">
            ${state.scopes.map((scope) => `
              <label class="check">
                <input type="checkbox" name="scopes" value="${esc(scope.key)}">
                <span><strong>${esc(scope.key)}</strong><small>${esc(scope.description || '')}</small></span>
              </label>
            `).join('')}
          </div>
        </fieldset>
        <div class="modal-actions">
          <button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button>
          <button class="button primary" type="submit">${msg('create', 'Create')}</button>
        </div>
      </form>
    `);
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const response = await fetchJson('/api/developer/api-keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: form.get('name'),
            ownerUserId: form.get('ownerUserId'),
            expiresAt: form.get('expiresAt'),
            scopes: form.getAll('scopes')
          })
        });
        dialog.remove();
        await refresh();
        showCreatedKey(response.plainKey);
      } catch (error) {
        showError(error);
      }
    });
  }

  function showCreatedKey(plainKey) {
    const dialog = modal(`
      <div class="modal-form">
        <h2>${msg('apiKeyCreated', 'API key created')}</h2>
        <p class="hint">${msg('apiKeyCreatedHint', 'Copy this key now. Atlas will not show it again.')}</p>
        <pre class="developer-key-once"><code>${esc(plainKey || '')}</code></pre>
        <div class="modal-actions">
          <button class="button" type="button" data-copy-created-key>${msg('copy', 'Copy')}</button>
          <button class="button primary" type="button" data-close>${msg('close', 'Close')}</button>
        </div>
      </div>
    `);
    dialog.querySelector('[data-copy-created-key]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(plainKey || '');
        window.DisplayPopupMsg?.(msg('copied', 'Copied'));
      } catch {
        window.DisplayPopupMsg?.(msg('copyFailed', 'Copy failed'), { tone: 'error' });
      }
    });
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

  function showError(error) {
    const target = document.querySelector('#developerError');
    if (!target) return alert(error?.message || String(error));
    target.hidden = false;
    target.innerHTML = `<strong>${msg('unexpectedError', 'An unexpected error occurred.')}</strong><p>${esc(error?.message || String(error))}</p>`;
  }

  function clearError() {
    const target = document.querySelector('#developerError');
    if (!target) return;
    target.hidden = true;
    target.innerHTML = '';
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function readPortalI18n() {
    try {
      return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}');
    } catch {
      return {};
    }
  }
})();
