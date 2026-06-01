(() => {
  let tree = [];
  let directories = [];
  let currentSelection = null;
  let errorBox = null;
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  async function init() {
    errorBox = document.querySelector('#documentationAdminError');
    document.querySelector('[data-new-page]')?.addEventListener('click', openPageCreateDialog);
    document.querySelector('[data-new-category]')?.addEventListener('click', openCategoryCreateDialog);
    document.querySelector('#documentationPageEditorForm')?.addEventListener('submit', savePageContent);
    document.querySelector('#documentationCategoryEditorForm')?.addEventListener('submit', saveCategoryContent);
    document.querySelector('#backToDocumentationListButton')?.addEventListener('click', closeDetail);
    document.querySelector('#reloadDocumentationButton')?.addEventListener('click', reloadDocumentation);
    hydrateFromUrl();
    await refresh();
  }

  async function refresh() {
    try {
      clearError();
      const response = await fetchJson('/api/admin/documentation/tree');
      tree = Array.isArray(response?.tree) ? response.tree : [];
      directories = Array.isArray(response?.directories) ? response.directories : [];
      renderTree();
      await restoreSelection();
    } catch (error) {
      showError(error);
    }
  }

  async function reloadDocumentation() {
    try {
      await fetchJson('/api/admin/documentation/reload', { method: 'POST' });
      await refresh();
    } catch (error) {
      showError(error);
    }
  }

  async function restoreSelection() {
    if (!currentSelection) return;
    if (currentSelection.type === 'page') return loadPage(currentSelection.slug, false);
    if (currentSelection.type === 'category') return loadCategory(currentSelection.relativeDir, false);
  }

  function renderTree() {
    const target = document.querySelector('#documentationTree');
    if (!target) return;
    target.innerHTML = tree.length
      ? `<div class="content-tree-list">${tree.map((node) => renderTreeNode(node)).join('')}</div>`
      : `<div class="empty-state"><h1>${esc(msg('noContent', 'No content available yet.'))}</h1><p>${esc(msg('documentationEmptyStateText', 'Create a page or category to get started.'))}</p></div>`;

    target.querySelectorAll('[data-open-page]').forEach((button) => {
      button.addEventListener('click', () => loadPage(button.dataset.openPage));
    });
    target.querySelectorAll('[data-open-category]').forEach((button) => {
      button.addEventListener('click', () => loadCategory(button.dataset.openCategory || ''));
    });
  }

  function renderTreeNode(node) {
    if (node.type === 'page') {
      const active = currentSelection?.type === 'page' && currentSelection.slug === node.slug;
      return `
        <button class="content-tree-item ${active ? 'active' : ''}" type="button" data-open-page="${esc(node.slug)}">
          <span class="content-tree-kind">P</span>
          <span class="content-tree-label">${esc(node.title)}</span>
        </button>
      `;
    }

    const active = currentSelection?.type === 'category' && currentSelection.relativeDir === node.relativeDir;
    return `
      <div class="content-tree-group">
        <button class="content-tree-item content-tree-category ${active ? 'active' : ''}" type="button" data-open-category="${esc(node.relativeDir || '')}">
          <span class="content-tree-kind">C</span>
          <span class="content-tree-label">${esc(node.label)}</span>
        </button>
        <div class="content-tree-children">${(node.children || []).map((child) => renderTreeNode(child)).join('')}</div>
      </div>
    `;
  }

  async function loadPage(slug, pushState = true) {
    try {
      const page = await fetchJson(`/api/admin/documentation/page?slug=${encodeURIComponent(slug)}`);
      currentSelection = { type: 'page', slug: page.slug };
      renderTree();
      fillPageEditor(page);
      if (pushState) syncUrl();
    } catch (error) {
      showError(error);
    }
  }

  async function loadCategory(relativeDir, pushState = true) {
    try {
      const category = await fetchJson(`/api/admin/documentation/category?dir=${encodeURIComponent(relativeDir || '')}`);
      currentSelection = { type: 'category', relativeDir: category.relativeDir || '' };
      renderTree();
      fillCategoryEditor(category);
      if (pushState) syncUrl();
    } catch (error) {
      showError(error);
    }
  }

  function fillPageEditor(page) {
    const form = document.querySelector('#documentationPageEditorForm');
    const categoryForm = document.querySelector('#documentationCategoryEditorForm');
    const empty = document.querySelector('#documentationEditorEmpty');
    if (!form) return;
    form.hidden = false;
    if (categoryForm) categoryForm.hidden = true;
    if (empty) empty.hidden = true;
    form.elements.slug.value = page.slug || '';
    form.elements.extra_meta.value = JSON.stringify(page.extraMeta || {});
    form.elements.display_slug.value = page.slug || '';
    form.elements.relative_path.value = page.relativePath || '';
    form.elements.title.value = page.meta?.title || page.title || '';
    form.elements.description.value = page.meta?.description || '';
    form.elements.owner.value = page.meta?.owner || '';
    form.elements.version.value = page.meta?.version || '';
    form.elements.reviewDate.value = page.meta?.reviewDate || '';
    form.elements.position.value = page.meta?.position ?? 999;
    form.elements.roles.value = (page.meta?.roles || []).join(', ');
    form.elements.markdown.value = page.markdown || '';
    document.querySelector('#documentationEditorTitle').textContent = page.title || page.slug || msg('page', 'Page');
    const openButton = document.querySelector('#openLiveDocumentationButton');
    if (openButton) {
      openButton.hidden = false;
      openButton.href = page.slug === '__home' ? '/' : `/policy/${encodeURIComponent(page.slug)}`;
    }
    updateLayout();
  }

  function fillCategoryEditor(category) {
    const pageForm = document.querySelector('#documentationPageEditorForm');
    const form = document.querySelector('#documentationCategoryEditorForm');
    const empty = document.querySelector('#documentationEditorEmpty');
    if (!form) return;
    form.hidden = false;
    if (pageForm) pageForm.hidden = true;
    if (empty) empty.hidden = true;
    form.elements.relative_dir.value = category.relativeDir || '';
    form.elements.display_dir.value = category.relativeDir || msg('documentationRoot', 'Documentation root');
    form.elements.config_path.value = category.configPath || '';
    form.elements.label.value = category.label || '';
    form.elements.position.value = category.position ?? 999;
    form.elements.roles.value = (category.roles || []).join(', ');
    document.querySelector('#documentationEditorTitle').textContent = category.label || category.relativeDir || msg('category', 'Category');
    const openButton = document.querySelector('#openLiveDocumentationButton');
    if (openButton) {
      openButton.hidden = !category.relativeDir;
      openButton.href = category.relativeDir ? `/policy/${encodeURIComponent(category.relativeDir)}` : '/';
    }
    updateLayout();
  }

  async function savePageContent(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await fetchJson('/api/admin/documentation/page', {
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
      await fetchJson('/api/admin/documentation/category', {
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
        <label>${msg('title', 'Title')} <input name="title" placeholder="${esc(msg('createPageTitlePlaceholder', 'New page'))}"></label>
        <label class="check"><input name="as_index" type="checkbox"> ${msg('createAsIndex', 'Create as category landing page (index.md)')}</label>
        <label>${msg('rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Admins, Users"></label>
        <label>${msg('rawMarkdown', 'Raw Markdown')}
          <textarea name="raw" class="code-input" spellcheck="false" placeholder="${esc(msg('documentationRawPlaceholder', 'Optional. Leave empty to generate a starter template.'))}"></textarea>
        </label>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('create', 'Create')}</button></div>
      </form>
    `);

    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const result = await fetchJson('/api/admin/documentation/page', {
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
        <label>${msg('label', 'Label')} <input name="label" placeholder="${esc(msg('createCategoryTitlePlaceholder', 'New category'))}"></label>
        <label>${msg('position', 'Position')} <input name="position" type="number" step="1" value="999"></label>
        <label>${msg('rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Admins, Users"></label>
        <label class="check"><input name="create_index" type="checkbox" checked> ${msg('createIndexPage', 'Create a landing page for this category')}</label>
        <label>${msg('title', 'Title')} <input name="index_title" placeholder="${esc(msg('categoryIndexTitlePlaceholder', 'Category overview'))}"></label>
        <label>${msg('rawMarkdown', 'Raw Markdown')}
          <textarea name="raw" class="code-input" spellcheck="false" placeholder="${esc(msg('documentationIndexRawPlaceholder', 'Optional start content for the index page.'))}"></textarea>
        </label>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('create', 'Create')}</button></div>
      </form>
    `);

    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const result = await fetchJson('/api/admin/documentation/category', {
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
    return directories
      .map((directory) => {
        const value = directory.relativeDir || '';
        const label = directory.relativeDir ? directory.relativeDir : msg('documentationRoot', 'Documentation root');
        return `<option value="${esc(value)}">${esc(label)}</option>`;
      })
      .join('');
  }

  function hydrateFromUrl() {
    const params = new URLSearchParams(location.search);
    const page = params.get('page');
    const dir = params.get('dir');
    if (page) currentSelection = { type: 'page', slug: page };
    else if (dir !== null) currentSelection = { type: 'category', relativeDir: dir };
  }

  function syncUrl() {
    const params = new URLSearchParams();
    if (currentSelection?.type === 'page') params.set('page', currentSelection.slug);
    if (currentSelection?.type === 'category') params.set('dir', currentSelection.relativeDir || '');
    const query = params.toString();
    history.replaceState({}, '', query ? `${location.pathname}?${query}` : location.pathname);
  }

  function closeDetail() {
    currentSelection = null;
    document.querySelector('#documentationPageEditorForm').hidden = true;
    document.querySelector('#documentationCategoryEditorForm').hidden = true;
    document.querySelector('#documentationEditorEmpty').hidden = false;
    document.querySelector('#documentationEditorTitle').textContent = msg('contentEditor', 'Editor');
    const openButton = document.querySelector('#openLiveDocumentationButton');
    if (openButton) openButton.hidden = true;
    updateLayout();
    syncUrl();
    renderTree();
  }

  function updateLayout() {
    const listPanel = document.querySelector('#documentationTree')?.closest('.content-nav-panel');
    const detailPanel = document.querySelector('.documentation-detail-panel-admin');
    const backButton = document.querySelector('#backToDocumentationListButton');
    const hasSelection = Boolean(currentSelection);
    if (listPanel) listPanel.hidden = hasSelection;
    if (detailPanel) detailPanel.classList.toggle('is-full-width', hasSelection);
    if (backButton) backButton.hidden = !hasSelection;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
    return data;
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

  function parseRoles(value) {
    return String(value || '')
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function showError(error) {
    if (!errorBox) return;
    errorBox.hidden = false;
    errorBox.innerHTML = `<strong>${msg('unexpectedError', 'An unexpected error occurred.')}</strong><p>${esc(error?.message || msg('unexpectedError', 'An unexpected error occurred.'))}</p>`;
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function readPortalI18n() {
    try {
      return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}');
    } catch {
      return {};
    }
  }
})();
