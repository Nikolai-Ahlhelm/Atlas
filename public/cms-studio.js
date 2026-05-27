(() => {
  let pages = [];
  let currentPage = null;
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  let errorBox = null;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCmsStudio, { once: true });
  } else {
    initCmsStudio();
  }

  async function initCmsStudio() {
    if (!document.querySelector('#cmsPageTree')) return;
    errorBox = document.querySelector('#cmsStudioError');
    document.querySelector('[data-new-cms-page]')?.addEventListener('click', openCreateDialog);
    document.querySelector('#cmsEditorForm')?.addEventListener('submit', savePage);
    document.querySelector('[data-delete-cms-page]')?.addEventListener('click', deletePage);
    hydrateStateFromUrl();
    await refresh();
  }

  async function refresh() {
    try {
      clearError();
      const response = await fetchJson('/api/cms/studio/tree');
      pages = Array.isArray(response?.tree) ? response.tree : [];
      renderTree();
      if (currentPage?.slug) {
        await loadPage(currentPage.slug);
        return;
      }
      const requested = new URLSearchParams(location.search).get('page');
      if (requested) await loadPage(requested);
    } catch (error) {
      renderError(error);
    }
  }

  function renderTree() {
    const target = document.querySelector('#cmsPageTree');
    target.innerHTML = pages.length
      ? `<div class="content-tree-list">${pages.map((page) => `
          <button class="content-tree-item ${currentPage?.slug === page.slug ? 'active' : ''}" type="button" data-open-page="${esc(page.slug)}">
            <span class="content-tree-kind">PAGE</span>
            <span class="content-tree-label">${esc(page.title)}</span>
          </button>
        `).join('')}</div>`
      : `<div class="notice">${msg('noCmsPages', 'No pages yet.')}</div>`;

    target.querySelectorAll('[data-open-page]').forEach((button) => button.addEventListener('click', async () => {
      await loadPage(button.dataset.openPage);
    }));
  }

  async function loadPage(slug) {
    try {
      const page = await fetchJson(`/api/cms/studio/page?slug=${encodeURIComponent(slug)}`);
      currentPage = { slug: page.slug };
      syncUrl();
      renderTree();
      document.querySelector('#cmsEditorEmpty').hidden = true;
      const form = document.querySelector('#cmsEditorForm');
      form.hidden = false;
      document.querySelector('#cmsEditorTitle').textContent = `${msg('cmsEditor', 'CMS editor')}: ${page.meta?.title || page.slug}`;
      form.elements.slug.value = page.slug || '';
      form.elements.display_slug.value = page.slug || '';
      form.elements.relative_path.value = page.relativePath || '';
      form.elements.title.value = page.meta?.title || '';
      form.elements.coverImage.value = page.meta?.coverImage || '';
      form.elements.roles.value = Array.isArray(page.meta?.roles) ? page.meta.roles.join(', ') : '';
      form.elements.description.value = page.meta?.description || '';
      form.elements.excerpt.value = page.meta?.excerpt || '';
      form.elements.markdown.value = page.markdown || '';
    } catch (error) {
      renderError(error);
    }
  }

  async function savePage(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await fetchJson('/api/cms/studio/page', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: form.get('slug'),
          title: form.get('title'),
          coverImage: form.get('coverImage'),
          roles: parseCsv(form.get('roles')),
          description: form.get('description'),
          excerpt: form.get('excerpt'),
          markdown: form.get('markdown')
        })
      });
      await refresh();
      if (result?.slug) await loadPage(result.slug);
    } catch (error) {
      renderError(error);
    }
  }

  async function deletePage() {
    const slug = document.querySelector('#cmsEditorForm')?.elements.slug.value;
    if (!slug || !confirm(msg('deletePageConfirm', 'Delete this page?'))) return;
    try {
      await fetchJson(`/api/cms/studio/page/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      currentPage = null;
      syncUrl();
      document.querySelector('#cmsEditorForm').hidden = true;
      document.querySelector('#cmsEditorEmpty').hidden = false;
      await refresh();
    } catch (error) {
      renderError(error);
    }
  }

  function openCreateDialog() {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${msg('createPage', 'Create page')}</h2>
        <label>${msg('pageSlug', 'Page slug')} <input name="slug" placeholder="about-us" required></label>
        <label>${msg('title', 'Title')} <input name="title" placeholder="About us"></label>
        <label>${msg('coverImageUrl', 'Cover image URL')} <input name="coverImage" placeholder="https://..."></label>
        <label>${msg('description', 'Description')} <textarea name="description"></textarea></label>
        <label>${msg('excerpt', 'Excerpt')} <textarea name="excerpt"></textarea></label>
        <label>${msg('rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Users"></label>
        <label>${msg('rawMarkdown', 'Raw Markdown / HTML')}
          <textarea name="markdown" class="code-input" spellcheck="false" placeholder="# About us"></textarea>
        </label>
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
        const result = await fetchJson('/api/cms/studio/page', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'create',
            slug: form.get('slug'),
            title: form.get('title'),
            coverImage: form.get('coverImage'),
            roles: parseCsv(form.get('roles')),
            description: form.get('description'),
            excerpt: form.get('excerpt'),
            markdown: form.get('markdown')
          })
        });
        dialog.remove();
        await refresh();
        if (result?.slug) await loadPage(result.slug);
      } catch (error) {
        renderError(error);
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

  function hydrateStateFromUrl() {
    const slug = new URLSearchParams(location.search).get('page');
    if (slug) currentPage = { slug };
  }

  function syncUrl() {
    const params = new URLSearchParams(location.search);
    if (currentPage?.slug) params.set('page', currentPage.slug);
    else params.delete('page');
    history.replaceState({}, '', `${location.pathname}?${params.toString()}`);
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

  function parseCsv(value) {
    return String(value || '')
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
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
