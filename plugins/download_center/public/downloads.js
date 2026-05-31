(() => {
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDownloadsApp, { once: true });
  } else {
    initDownloadsApp();
  }

  async function initDownloadsApp() {
    const shell = document.querySelector('[data-downloads-app]');
    if (!shell) return;

    const treeTarget = document.querySelector('#downloadTree');
    const emptyState = document.querySelector('#downloadExplorerEmpty');
    const detailTarget = document.querySelector('#downloadFileView');
    let activeFileId = new URLSearchParams(location.search).get('file');

    try {
      const response = await fetch('/api/downloads/tree');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load files.');
      const tree = Array.isArray(data.tree) ? data.tree : [];
      treeTarget.innerHTML = tree.length
        ? renderDownloadExplorer(tree, activeFileId)
        : `<div class="notice">${msg('noFiles', 'No files available for your roles yet.')}</div>`;

      const firstFileId = activeFileId || findFirstDownloadId(tree);
      if (firstFileId) {
        activeFileId = firstFileId;
        syncDownloadUrl(activeFileId);
        treeTarget.innerHTML = renderDownloadExplorer(tree, activeFileId);
        bindDownloadLinks(tree, detailTarget, emptyState);
        await loadDownloadDetail(activeFileId, detailTarget, emptyState);
      } else {
        emptyState.hidden = false;
        detailTarget.hidden = true;
      }
    } catch (error) {
      emptyState.innerHTML = `<h1>${msg('unexpectedError', 'An unexpected error occurred.')}</h1><p>${escapeHtml(error.message || String(error))}</p>`;
    }
  }

  function bindDownloadLinks(tree, detailTarget, emptyState) {
    const treeTarget = document.querySelector('#downloadTree');
    treeTarget.querySelectorAll('[data-download-file]').forEach((button) => button.addEventListener('click', async () => {
      const nextFileId = button.dataset.downloadFile;
      syncDownloadUrl(nextFileId);
      treeTarget.innerHTML = renderDownloadExplorer(tree, nextFileId);
      bindDownloadLinks(tree, detailTarget, emptyState);
      await loadDownloadDetail(nextFileId, detailTarget, emptyState);
    }));
  }

  function renderDownloadExplorer(nodes, activeFileId) {
    return nodes.map((node) => {
      if (node.type === 'file') {
        return `<button class="nav-link ${String(node.id) === String(activeFileId) ? 'active' : ''}" type="button" data-download-file="${escapeHtml(node.id)}">${escapeHtml(node.name)}</button>`;
      }
      return `
        <section class="nav-group active-group">
          <div class="nav-group-title">
            <span class="nav-category-label">${escapeHtml(node.label || node.relativeDir || 'Folder')}</span>
          </div>
          <div class="nav-group-items">${renderDownloadExplorer(node.children || [], activeFileId)}</div>
        </section>
      `;
    }).join('');
  }

  function findFirstDownloadId(nodes) {
    for (const node of nodes) {
      if (node.type === 'file') return node.id;
      const nested = findFirstDownloadId(node.children || []);
      if (nested) return nested;
    }
    return '';
  }

  async function loadDownloadDetail(id, detailTarget, emptyState) {
    const isAdmin = document.querySelector('[data-downloads-app]')?.dataset.isAdmin === 'true';
    const response = await fetch(`/api/downloads/file?id=${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load file details.');
    emptyState.hidden = true;
    detailTarget.hidden = false;
    detailTarget.innerHTML = `
      <div class="panel-head">
        <h2>${escapeHtml(data.name)}</h2>
        <a class="button primary" href="${escapeHtml(data.downloadHref)}">${msg('download', 'Download')}</a>
      </div>
      <div class="content-editor-body">
        <div class="content-meta">
          <label>${msg('folderPath', 'Folder path')}<input value="${escapeHtml(data.relativeDir || '/')}" readonly></label>
          <label>${msg('mimeType', 'MIME type')}<input value="${escapeHtml(data.mimeType || '')}" readonly></label>
          <label>${msg('tags', 'Tags')}<input value="${escapeHtml((data.tags || []).join(', '))}" readonly></label>
          <label>${msg('roles', 'Roles')}<input value="${escapeHtml((data.roles || []).join(', ') || msg('all', 'All'))}" readonly></label>
        </div>
        <label>${msg('description', 'Description')}<textarea readonly>${escapeHtml(data.description || '')}</textarea></label>
        ${data.isText ? `<label>${msg('textContent', 'Text content')}<textarea class="code-input content-raw-input" readonly>${escapeHtml(data.contentText || '')}</textarea></label>` : `<div class="notice">${msg('binaryPreviewHint', 'This file is binary and can be downloaded directly.')}</div>`}
        <div class="modal-actions">
          <span class="hint">${msg('updated', 'Updated')}: ${escapeHtml(data.updatedAt || '-')}</span>
          ${isAdmin ? `<a class="button ghost" href="/admin/downloads?file=${encodeURIComponent(data.id)}">${msg('manageInAdmin', 'Manage in admin')}</a>` : ''}
        </div>
      </div>
    `;
  }

  function syncDownloadUrl(fileId) {
    const url = new URL(location.href);
    if (fileId) url.searchParams.set('file', fileId);
    else url.searchParams.delete('file');
    history.replaceState({}, '', url);
  }

  function escapeHtml(value = '') {
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
