(() => {
  let downloadTree = [];
  let downloadDirectories = [];
  let currentDownloadSelection = null;
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  let errorBox = null;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  async function init() {
    errorBox = document.querySelector('#downloadsAdminError');
    document.querySelector('[data-new-download]')?.addEventListener('click', () => openDownloadCreateDialog());
    document.querySelector('#downloadEditorForm')?.addEventListener('submit', saveDownloadContent);
    document.querySelector('#downloadEditorForm input[name="file_upload"]')?.addEventListener('change', handleDownloadUploadSelect);
    document.querySelector('#deleteDownloadButton')?.addEventListener('click', deleteCurrentDownload);
    document.querySelector('#backToDownloadsListButton')?.addEventListener('click', closeDownloadDetail);
    hydrateFromUrl();
    await refresh();
  }

  async function refresh() {
    try {
      clearError();
      const response = await fetchJson('/api/admin/downloads/tree');
      downloadTree = Array.isArray(response?.tree) ? response.tree : [];
      downloadDirectories = Array.isArray(response?.directories) ? response.directories : [];
      renderDownloadTree();
      if (currentDownloadSelection?.id) await loadDownloadFile(currentDownloadSelection.id);
      else closeDownloadDetail(false);
    } catch (error) {
      renderError(error);
    }
  }

  function hydrateFromUrl() {
    const id = new URLSearchParams(location.search).get('file');
    if (id) currentDownloadSelection = { id: Number(id) || id };
  }

  function renderDownloadTree() {
    const target = document.querySelector('#downloadsTree');
    if (!target) return;
    target.innerHTML = downloadTree.length
      ? `<div class="content-tree-list">${downloadTree.map((node) => renderDownloadNode(node)).join('')}</div>`
      : `<div class="notice">${msg('noFiles', 'No files available yet.')}</div>`;

    target.querySelectorAll('[data-open-download]').forEach((button) => button.addEventListener('click', async () => {
      await loadDownloadFile(button.dataset.openDownload);
    }));
  }

  function renderDownloadNode(node) {
    if (node.type === 'file') {
      const active = Number(currentDownloadSelection?.id) === Number(node.id);
      return `
        <button class="content-tree-item ${active ? 'active' : ''}" type="button" data-open-download="${esc(node.id)}">
          <span class="content-tree-kind">FILE</span>
          <span class="content-tree-label">${esc(node.relativePath || node.name)}</span>
        </button>
      `;
    }

    return `
      <section class="content-tree-group">
        <div class="content-tree-item content-tree-category">
          <span class="content-tree-kind">DIR</span>
          <span class="content-tree-label">${esc(node.relativeDir || node.label || 'Folder')}</span>
        </div>
        <div class="content-tree-children">${(node.children || []).map((child) => renderDownloadNode(child)).join('')}</div>
      </section>
    `;
  }

  async function loadDownloadFile(id) {
    try {
      const file = await fetchJson(`/api/admin/downloads/file?id=${encodeURIComponent(id)}`);
      currentDownloadSelection = { id: file.id };
      updateLayout();
      syncUrl();
      renderDownloadTree();
      document.querySelector('#downloadEditorTitle').textContent = `${msg('downloadEditor', 'Download editor')}: ${file.relativePath || file.name}`;
      document.querySelector('#downloadEditorEmpty').hidden = true;
      const form = document.querySelector('#downloadEditorForm');
      const openLiveDownloadButton = document.querySelector('#openLiveDownloadButton');
      form.hidden = false;
      if (openLiveDownloadButton) {
        openLiveDownloadButton.href = `/downloads?file=${encodeURIComponent(file.id)}`;
        openLiveDownloadButton.hidden = false;
      }
      form.elements.id.value = file.id || '';
      form.elements.name.value = file.name || '';
      form.elements.relative_dir.value = file.relativeDir || '';
      form.elements.mime_type.value = file.mimeType || '';
      form.elements.roles.value = Array.isArray(file.roles) ? file.roles.join(', ') : '';
      form.elements.description.value = file.description || '';
      form.elements.tags.value = Array.isArray(file.tags) ? file.tags.join(', ') : '';
      form.elements.encoding.value = file.isText ? 'text' : 'binary';
      form.elements.content_text.value = file.isText ? (file.contentText || '') : '';
      form.elements.content_text.disabled = !file.isText;
      form.elements.file_upload.value = '';
      form.elements.content_base64.value = '';
      document.querySelector('#deleteDownloadButton').hidden = false;
    } catch (error) {
      renderError(error);
    }
  }

  async function saveDownloadContent(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      id: form.elements.id.value || undefined,
      name: form.elements.name.value,
      relative_dir: form.elements.relative_dir.value,
      mime_type: form.elements.mime_type.value,
      roles: parseCsv(form.elements.roles.value),
      description: form.elements.description.value,
      tags: parseCsv(form.elements.tags.value),
      content_text: form.elements.content_text.value,
      content_base64: form.elements.content_base64.value,
      encoding: form.elements.encoding.value
    };
    try {
      const result = await fetchJson('/api/admin/downloads/file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      await refresh();
      if (result?.id) await loadDownloadFile(result.id);
    } catch (error) {
      renderError(error);
    }
  }

  async function deleteCurrentDownload() {
    const id = document.querySelector('#downloadEditorForm')?.elements.id.value;
    if (!id || !confirm(msg('deleteFileConfirm', 'Delete this file?'))) return;
    try {
      await fetchJson(`/api/admin/downloads/file/${id}`, { method: 'DELETE' });
      currentDownloadSelection = null;
      await refresh();
    } catch (error) {
      renderError(error);
    }
  }

  function openDownloadCreateDialog() {
    const directoryOptions = downloadDirectories
      .map((directory) => {
        const value = directory.relativeDir || '';
        const label = directory.relativeDir ? directory.relativeDir : msg('downloadRoot', 'Download root');
        return `<option value="${esc(value)}">${esc(label)}</option>`;
      })
      .join('');

    const dialog = modal(`
      <form class="modal-form">
        <h2>${msg('uploadFile', 'Upload file')}</h2>
        <label>${msg('fileName', 'File name')} <input name="name" placeholder="checklist.md" required></label>
        <label>${msg('folderPath', 'Folder path')} <input name="relative_dir" list="download-directory-list" placeholder="team/templates"></label>
        <datalist id="download-directory-list">${directoryOptions}</datalist>
        <label>${msg('mimeType', 'MIME type')} <input name="mime_type" placeholder="text/markdown"></label>
        <label>${msg('rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Admins, Users"></label>
        <label>${msg('description', 'Description')} <textarea name="description"></textarea></label>
        <label>${msg('tagsCsv', 'Tags (comma separated)')} <input name="tags" placeholder="template, onboarding"></label>
        <label>${msg('replaceUpload', 'Upload file')} <input name="file_upload" type="file"></label>
        <label>${msg('textContent', 'Text content')}
          <textarea name="content_text" class="code-input" spellcheck="false" placeholder="# Optional text content"></textarea>
        </label>
        <input name="content_base64" type="hidden">
        <input name="encoding" type="hidden" value="text">
        <div class="modal-actions">
          <button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button>
          <button class="button primary" type="submit">${msg('create', 'Create')}</button>
        </div>
      </form>
    `);

    const uploadInput = dialog.querySelector('input[name="file_upload"]');
    const base64Input = dialog.querySelector('input[name="content_base64"]');
    const encodingInput = dialog.querySelector('input[name="encoding"]');
    const textArea = dialog.querySelector('textarea[name="content_text"]');
    uploadInput?.addEventListener('change', async () => {
      const file = uploadInput.files?.[0];
      if (!file) {
        base64Input.value = '';
        encodingInput.value = 'text';
        return;
      }
      const buffer = await file.arrayBuffer();
      base64Input.value = arrayBufferToBase64(buffer);
      const isText = file.type.startsWith('text/') || /\.(md|markdown|txt|json|js|css|html|xml|csv|tsv|svg)$/i.test(file.name);
      encodingInput.value = isText ? 'text' : 'binary';
      if (isText) {
        try {
          textArea.value = new TextDecoder().decode(buffer);
        } catch {}
      } else {
        textArea.value = '';
      }
      const nameInput = dialog.querySelector('input[name="name"]');
      const mimeInput = dialog.querySelector('input[name="mime_type"]');
      if (nameInput && !nameInput.value) nameInput.value = file.name;
      if (mimeInput && !mimeInput.value) mimeInput.value = file.type || '';
    });

    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const result = await fetchJson('/api/admin/downloads/file', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: form.get('name'),
            relative_dir: form.get('relative_dir'),
            mime_type: form.get('mime_type'),
            roles: parseCsv(form.get('roles')),
            description: form.get('description'),
            tags: parseCsv(form.get('tags')),
            content_text: form.get('content_text'),
            content_base64: form.get('content_base64'),
            encoding: form.get('encoding')
          })
        });
        dialog.remove();
        await refresh();
        if (result?.id) await loadDownloadFile(result.id);
      } catch (error) {
        renderError(error);
      }
    });
  }

  async function handleDownloadUploadSelect(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    const form = document.querySelector('#downloadEditorForm');
    if (!form) return;
    if (!file) {
      form.elements.content_base64.value = '';
      return;
    }
    const buffer = await file.arrayBuffer();
    form.elements.content_base64.value = arrayBufferToBase64(buffer);
    const isText = file.type.startsWith('text/') || /\.(md|markdown|txt|json|js|css|html|xml|csv|tsv|svg)$/i.test(file.name);
    form.elements.encoding.value = isText ? 'text' : 'binary';
    if (isText) {
      try {
        form.elements.content_text.value = new TextDecoder().decode(buffer);
        form.elements.content_text.disabled = false;
      } catch {}
    } else {
      form.elements.content_text.value = '';
      form.elements.content_text.disabled = true;
    }
  }

  function closeDownloadDetail(updateHistory = true) {
    currentDownloadSelection = null;
    const form = document.querySelector('#downloadEditorForm');
    const empty = document.querySelector('#downloadEditorEmpty');
    const openLiveDownloadButton = document.querySelector('#openLiveDownloadButton');
    if (form) form.hidden = true;
    if (empty) empty.hidden = false;
    if (openLiveDownloadButton) {
      openLiveDownloadButton.hidden = true;
      openLiveDownloadButton.href = '/downloads';
    }
    updateLayout();
    if (updateHistory) syncUrl();
  }

  function updateLayout() {
    const hasSelection = Boolean(currentDownloadSelection?.id);
    document.querySelector('#backToDownloadsListButton')?.toggleAttribute('hidden', !hasSelection);
    const listPanel = document.querySelector('#downloadsTree')?.closest('.content-nav-panel');
    const detailPanel = document.querySelector('.download-detail-panel-admin');
    if (listPanel) {
      listPanel.hidden = hasSelection;
      listPanel.classList.toggle('is-full-width', !hasSelection);
    }
    if (detailPanel) {
      detailPanel.hidden = !hasSelection;
      detailPanel.classList.toggle('is-full-width', hasSelection);
    }
  }

  function syncUrl() {
    const params = new URLSearchParams(location.search);
    if (currentDownloadSelection?.id) params.set('file', currentDownloadSelection.id);
    else params.delete('file');
    history.replaceState({}, '', `${location.pathname}?${params.toString()}`);
  }

  function parseCsv(value) {
    return String(value || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
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

  function renderError(error) {
    if (!errorBox) return;
    errorBox.hidden = false;
    errorBox.innerHTML = `<strong>${msg('unexpectedError', 'An unexpected error occurred.')}</strong><p>${esc(error?.message || String(error))}</p>`;
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.hidden = true;
    errorBox.innerHTML = '';
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      try { throw new Error(JSON.parse(text).error || text); } catch { throw new Error(text); }
    }
    return response.json();
  }

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function readPortalI18n() {
    try { return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}'); } catch { return {}; }
  }
})();
