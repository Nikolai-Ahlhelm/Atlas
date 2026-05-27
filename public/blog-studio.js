(() => {
  let posts = [];
  let currentPost = null;
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  let errorBox = null;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBlogStudio, { once: true });
  } else {
    initBlogStudio();
  }

  async function initBlogStudio() {
    if (!document.querySelector('#blogPostTree')) return;
    errorBox = document.querySelector('#blogStudioError');
    document.querySelector('[data-new-blog-post]')?.addEventListener('click', openCreateDialog);
    document.querySelector('#blogEditorForm')?.addEventListener('submit', savePost);
    document.querySelector('[data-delete-blog-post]')?.addEventListener('click', deletePost);
    hydrateStateFromUrl();
    await refresh();
  }

  async function refresh() {
    try {
      clearError();
      const response = await fetchJson('/api/blog/studio/tree');
      posts = Array.isArray(response?.tree) ? response.tree : [];
      renderTree();
      if (currentPost?.slug) {
        await loadPost(currentPost.slug);
        return;
      }
      const requested = new URLSearchParams(location.search).get('post');
      if (requested) await loadPost(requested);
    } catch (error) {
      renderError(error);
    }
  }

  function renderTree() {
    const target = document.querySelector('#blogPostTree');
    target.innerHTML = posts.length
      ? `<div class="content-tree-list">${posts.map((post) => `
          <button class="content-tree-item ${currentPost?.slug === post.slug ? 'active' : ''}" type="button" data-open-post="${esc(post.slug)}">
            <span class="content-tree-kind">POST</span>
            <span class="content-tree-label">${esc(post.title)}</span>
          </button>
        `).join('')}</div>`
      : `<div class="notice">${msg('noPostsYet', 'No blog posts yet.')}</div>`;

    target.querySelectorAll('[data-open-post]').forEach((button) => button.addEventListener('click', async () => {
      await loadPost(button.dataset.openPost);
    }));
  }

  async function loadPost(slug) {
    try {
      const post = await fetchJson(`/api/blog/studio/post?slug=${encodeURIComponent(slug)}`);
      currentPost = { slug: post.slug };
      syncUrl();
      renderTree();
      document.querySelector('#blogEditorEmpty').hidden = true;
      const form = document.querySelector('#blogEditorForm');
      form.hidden = false;
      document.querySelector('#blogEditorTitle').textContent = `${msg('blogEditor', 'Blog editor')}: ${post.meta?.title || post.slug}`;
      form.elements.slug.value = post.slug || '';
      form.elements.display_slug.value = post.slug || '';
      form.elements.relative_path.value = post.relativePath || '';
      form.elements.title.value = post.meta?.title || '';
      form.elements.author.value = post.meta?.author || '';
      form.elements.publishedAt.value = post.meta?.publishedAt || '';
      form.elements.coverImage.value = post.meta?.coverImage || '';
      form.elements.roles.value = Array.isArray(post.meta?.roles) ? post.meta.roles.join(', ') : '';
      form.elements.description.value = post.meta?.description || '';
      form.elements.excerpt.value = post.meta?.excerpt || '';
      form.elements.markdown.value = post.markdown || '';
    } catch (error) {
      renderError(error);
    }
  }

  async function savePost(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await fetchJson('/api/blog/studio/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: form.get('slug'),
          title: form.get('title'),
          author: form.get('author'),
          publishedAt: form.get('publishedAt'),
          coverImage: form.get('coverImage'),
          roles: parseCsv(form.get('roles')),
          description: form.get('description'),
          excerpt: form.get('excerpt'),
          markdown: form.get('markdown')
        })
      });
      await refresh();
      if (result?.slug) await loadPost(result.slug);
    } catch (error) {
      renderError(error);
    }
  }

  async function deletePost() {
    const slug = document.querySelector('#blogEditorForm')?.elements.slug.value;
    if (!slug || !confirm(msg('deletePostConfirm', 'Delete this post?'))) return;
    try {
      await fetchJson(`/api/blog/studio/post/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      currentPost = null;
      syncUrl();
      document.querySelector('#blogEditorForm').hidden = true;
      document.querySelector('#blogEditorEmpty').hidden = false;
      await refresh();
    } catch (error) {
      renderError(error);
    }
  }

  function openCreateDialog() {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${msg('createPost', 'Create post')}</h2>
        <label>${msg('postSlug', 'Post slug')} <input name="slug" placeholder="new-release" required></label>
        <label>${msg('title', 'Title')} <input name="title" placeholder="New release"></label>
        <label>${msg('author', 'Author')} <input name="author"></label>
        <label>${msg('publishedAt', 'Published at')} <input name="publishedAt" placeholder="2026-05-27"></label>
        <label>${msg('coverImageUrl', 'Cover image URL')} <input name="coverImage" placeholder="https://..."></label>
        <label>${msg('description', 'Description')} <textarea name="description"></textarea></label>
        <label>${msg('excerpt', 'Excerpt')} <textarea name="excerpt"></textarea></label>
        <label>${msg('rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Users"></label>
        <label>${msg('rawMarkdown', 'Raw Markdown')}
          <textarea name="markdown" class="code-input" spellcheck="false" placeholder="# New release"></textarea>
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
        const result = await fetchJson('/api/blog/studio/post', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'create',
            slug: form.get('slug'),
            title: form.get('title'),
            author: form.get('author'),
            publishedAt: form.get('publishedAt'),
            coverImage: form.get('coverImage'),
            roles: parseCsv(form.get('roles')),
            description: form.get('description'),
            excerpt: form.get('excerpt'),
            markdown: form.get('markdown')
          })
        });
        dialog.remove();
        await refresh();
        if (result?.slug) await loadPost(result.slug);
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
    const slug = new URLSearchParams(location.search).get('post');
    if (slug) currentPost = { slug };
  }

  function syncUrl() {
    const params = new URLSearchParams(location.search);
    if (currentPost?.slug) params.set('post', currentPost.slug);
    else params.delete('post');
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
