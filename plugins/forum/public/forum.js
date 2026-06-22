(() => {
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  const app = document.querySelector('[data-forum-app]');
  const admin = document.querySelector('[data-forum-admin-page]');
  const rootNode = app || admin;
  const state = {
    mode: app?.dataset.forumMode || 'home',
    slug: app?.dataset.forumSlug || '',
    categories: [],
    tags: [],
    threads: [],
    thread: null,
    can: {},
    q: '',
    tag: '',
    status: '',
    support: { roles: [], categories: [], tags: [], permissions: {}, permissionKeys: [] },
    reports: [],
    adminTab: 'categories'
  };

  if (rootNode) {
    injectCss(rootNode.dataset.cssHref);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }

  async function init() {
    bindShell();
    if (admin) await loadAdmin();
    else await loadForum();
  }

  function bindShell() {
    document.querySelector('#forumSearch')?.addEventListener('input', debounce(async (event) => {
      state.q = event.target.value || '';
      await renderCurrentForum();
    }, 220));
    document.querySelector('#forumTagFilter')?.addEventListener('change', async (event) => {
      state.tag = event.target.value || '';
      await renderCurrentForum();
    });
    document.querySelector('#forumStatusFilter')?.addEventListener('change', async (event) => {
      state.status = event.target.value || '';
      await renderCurrentForum();
    });
    document.querySelector('[data-new-thread]')?.addEventListener('click', () => openThreadDialog());
    document.querySelector('[data-close-forum-dialog]')?.addEventListener('click', () => document.querySelector('#forumThreadDialog')?.close());
    document.querySelector('#forumThreadForm')?.addEventListener('submit', saveThread);
    document.querySelector('[data-close-edit-dialog]')?.addEventListener('click', () => document.querySelector('#forumEditDialog')?.close());
    document.querySelector('#forumEditForm')?.addEventListener('submit', savePostEdit);
    document.querySelectorAll('[data-forum-admin-tab]').forEach((button) => button.addEventListener('click', () => {
      state.adminTab = button.dataset.forumAdminTab || 'categories';
      renderAdmin();
    }));
  }

  async function loadForum() {
    const categories = await fetchJson('/api/forum/categories');
    state.categories = categories.items || [];
    state.tags = categories.tags || [];
    state.can = categories.can || {};
    hydrateTagFilter();
    hydrateDialogOptions();
    document.querySelector('[data-new-thread]')?.toggleAttribute('hidden', !state.can.createthread);
    await renderCurrentForum();
  }

  async function renderCurrentForum() {
    if (state.mode === 'thread') return loadThread(state.slug);
    if (state.mode === 'category') return loadCategory(state.slug);
    return loadHome();
  }

  async function loadHome() {
    const threads = await fetchJson(`/api/forum/threads?${threadQuery('').toString()}`);
    state.threads = threads.items || [];
    state.can = threads.can || state.can;
    renderHome();
  }

  function renderHome() {
    const root = document.querySelector('#forumRoot');
    const totals = state.categories.reduce((acc, category) => {
      acc.threads += Number(category.threadCount || 0);
      acc.posts += Number(category.postCount || 0);
      return acc;
    }, { threads: 0, posts: 0 });
    const pinned = state.threads.filter((thread) => thread.isPinned).slice(0, 4);
    const latest = state.threads.slice(0, 24);
    root.innerHTML = `
      <section class="forum-home-grid">
        <aside class="forum-category-rail" aria-label="${msg('categories', 'Categories')}">
          <div class="forum-rail-head">
            <div>
              <p class="eyebrow">${msg('discussionSpaces', 'Discussion spaces')}</p>
              <h2>${msg('categories', 'Categories')}</h2>
            </div>
            <span class="forum-total-pill">${state.categories.length}</span>
          </div>
          <div class="forum-category-stack">
            ${state.categories.length ? state.categories.map(renderCategoryRailItem).join('') : renderEmpty(msg('noCategories', 'No categories'), msg('noCategoriesText', 'No forum categories are available yet.'))}
          </div>
        </aside>
        <section class="forum-activity">
          <div class="forum-overview-band">
            <div>
              <p class="eyebrow">${msg('forum', 'Forum')}</p>
              <h2>${msg('latestDiscussions', 'Latest discussions')}</h2>
              <p>${msg('latestDiscussionsText', 'Scan active topics, jump into the right category and follow solved or locked discussions at a glance.')}</p>
            </div>
            <dl class="forum-summary-strip">
              <div><dt>${msg('categories', 'Categories')}</dt><dd>${state.categories.length}</dd></div>
              <div><dt>${msg('threads', 'Threads')}</dt><dd>${totals.threads}</dd></div>
              <div><dt>${msg('posts', 'Posts')}</dt><dd>${totals.posts}</dd></div>
            </dl>
          </div>
          ${pinned.length ? `<section class="forum-pinned-strip"><h3>${msg('pinnedThreads', 'Pinned threads')}</h3><div>${pinned.map(renderPinnedThread).join('')}</div></section>` : ''}
          <section class="forum-thread-list modern">
            ${latest.length ? latest.map(renderThreadRow).join('') : renderEmpty(msg('noThreads', 'No threads'), msg('noThreadsText', 'No threads match this view.'))}
          </section>
        </section>
      </section>
    `;
  }

  function renderCategoryRailItem(category) {
    return `
      <a class="forum-category-rail-item" href="/forum/category/${encodeURIComponent(category.slug)}">
        <span class="forum-category-dot ${category.isPrivate ? 'private' : ''}"></span>
        <span>
          <strong>${esc(category.name)}</strong>
          <small>${esc(category.description || msg('noCategoryDescription', 'No description has been added yet.'))}</small>
        </span>
        <span class="forum-category-count">${category.threadCount || 0}</span>
      </a>
    `;
  }

  function renderPinnedThread(thread) {
    return `
      <a class="forum-pinned-card" href="/forum/thread/${encodeURIComponent(thread.slug)}">
        <span class="forum-thread-status pinned">${msg('pinned', 'Pinned')}</span>
        <strong>${esc(thread.title)}</strong>
        <small>${esc(thread.category.name)} · ${formatRelative(thread.lastActivityAt || thread.updatedAt)}</small>
      </a>
    `;
  }

  async function loadCategory(slug) {
    const [detail, threads] = await Promise.all([
      fetchJson(`/api/forum/category?slug=${encodeURIComponent(slug)}`),
      fetchJson(`/api/forum/threads?${threadQuery(slug).toString()}`)
    ]);
    state.threads = threads.items || [];
    state.can = threads.can || state.can;
    const root = document.querySelector('#forumRoot');
    root.innerHTML = `
      <section class="forum-section-head forum-category-head">
        <div>
          <p class="eyebrow">${detail.category.isPrivate ? msg('private', 'Private') : msg('category', 'Category')}</p>
          <h2>${esc(detail.category.name)}</h2>
          <p>${esc(detail.category.description || msg('noCategoryDescription', 'No description has been added yet.'))}</p>
        </div>
        <dl class="forum-summary-strip compact">
          <div><dt>${msg('threads', 'Threads')}</dt><dd>${detail.category.threadCount || state.threads.length}</dd></div>
          <div><dt>${msg('posts', 'Posts')}</dt><dd>${detail.category.postCount || 0}</dd></div>
        </dl>
      </section>
      <section class="forum-thread-list modern">
        ${state.threads.length ? state.threads.map(renderThreadRow).join('') : renderEmpty(msg('noThreads', 'No threads'), msg('noThreadsText', 'No threads match this view.'))}
      </section>
    `;
  }

  function threadQuery(categorySlug = '') {
    const params = new URLSearchParams();
    if (categorySlug) params.set('category', categorySlug);
    if (state.q) params.set('q', state.q);
    if (state.tag) params.set('tag', state.tag);
    if (state.status) params.set('status', state.status);
    return params;
  }

  function renderThreadRow(thread) {
    const lastAuthor = thread.lastPost?.author || thread.author;
    return `
      <a class="forum-thread-row modern ${thread.hasUnread ? 'unread' : ''}" href="/forum/thread/${encodeURIComponent(thread.slug)}">
        ${renderAvatar(thread.author, 'forum-thread-avatar')}
        <span class="forum-thread-copy">
          <span class="forum-thread-topline">
            ${renderThreadStatus(thread)}
            <strong>${esc(thread.title)}</strong>
          </span>
          <span class="forum-thread-excerpt">${esc(thread.excerpt || thread.lastPost?.excerpt || '')}</span>
          <span class="forum-thread-meta-line">
            <span>${esc(thread.category.name)}</span>
            <span>${esc(authorDisplayName(thread.author))}</span>
            <span>${formatRelative(thread.createdAt)}</span>
          </span>
          <span class="forum-tag-list">${(thread.tags || []).map(renderTag).join('')}</span>
        </span>
        <span class="forum-thread-activity">
          ${renderAvatar(lastAuthor, 'forum-mini-avatar')}
          <span><strong>${esc(authorDisplayName(lastAuthor))}</strong><small>${formatRelative(thread.lastActivityAt || thread.updatedAt)}</small></span>
        </span>
        <span class="forum-thread-metrics">
          <span><strong>${thread.replyCount || 0}</strong><small>${msg('replies', 'Replies')}</small></span>
          <span><strong>${thread.viewCount || 0}</strong><small>${msg('views', 'views')}</small></span>
        </span>
      </a>
    `;
  }

  function renderThreadStatus(thread) {
    const badges = [];
    if (thread.hasUnread) badges.push(`<span class="forum-thread-status unread">${msg('newActivity', 'New')}</span>`);
    if (thread.isPinned) badges.push(`<span class="forum-thread-status pinned">${msg('pinned', 'Pinned')}</span>`);
    if (thread.isSolved) badges.push(`<span class="forum-thread-status solved">${msg('solved', 'Solved')}</span>`);
    if (thread.isLocked) badges.push(`<span class="forum-thread-status locked">${msg('locked', 'Locked')}</span>`);
    return badges.join('');
  }

  async function loadThread(slug) {
    state.thread = await fetchJson(`/api/forum/thread?slug=${encodeURIComponent(slug)}`);
    const root = document.querySelector('#forumRoot');
    root.innerHTML = `
      <section class="forum-thread-detail modern">
        <header class="forum-thread-hero">
          <div>
            <p class="eyebrow">${esc(state.thread.category.name)}</p>
            <h2>${esc(state.thread.title)}</h2>
            <div class="forum-thread-meta-line">
              <span>${msg('startedBy', 'Started by')} ${esc(authorDisplayName(state.thread.author))}</span>
              <span>${formatDate(state.thread.createdAt)}</span>
              <span>${state.thread.viewCount || 0} ${msg('views', 'views')}</span>
            </div>
            <div class="forum-tag-list">${state.thread.tags.map(renderTag).join('') || badge(msg('untagged', 'Untagged'))}</div>
          </div>
          <div class="forum-thread-controls">${renderThreadControls(state.thread)}</div>
        </header>
        <div class="forum-post-timeline">${state.thread.posts.map(renderPost).join('')}</div>
        ${state.thread.can.reply ? renderReplyForm() : `<div class="notice">${msg('threadLockedNotice', 'This thread is locked for replies.')}</div>`}
      </section>
    `;
    bindThreadActions();
  }

  function renderThreadControls(thread) {
    if (!thread.can?.moderate) return '';
    return `
      <button class="button small ghost" type="button" data-mod-field="isPinned" data-mod-value="${thread.isPinned ? '0' : '1'}">${thread.isPinned ? msg('unpin', 'Unpin') : msg('pin', 'Pin')}</button>
      <button class="button small ghost" type="button" data-mod-field="isLocked" data-mod-value="${thread.isLocked ? '0' : '1'}">${thread.isLocked ? msg('unlock', 'Unlock') : msg('lock', 'Lock')}</button>
      <button class="button small ghost" type="button" data-mod-field="isSolved" data-mod-value="${thread.isSolved ? '0' : '1'}">${thread.isSolved ? msg('unsolve', 'Unsolve') : msg('solve', 'Solve')}</button>
    `;
  }

  function renderPost(post) {
    const solution = state.thread.solutionPostId === post.id;
    const original = String(post.id).startsWith('thread-');
    return `
      <article class="forum-post modern ${solution ? 'solution' : ''} ${original ? 'original' : ''}" data-post-id="${esc(post.id)}">
        <aside class="forum-post-author">
          ${renderForumAuthor(post.author, post.createdAt)}
        </aside>
        <div class="forum-post-body">
          <div class="forum-post-meta">
            <span>${original ? msg('originalPost', 'Original post') : formatDate(post.createdAt)}</span>
            ${solution ? `<span class="forum-thread-status solved">${msg('solution', 'Solution')}</span>` : ''}
          </div>
          <div class="forum-post-content">${post.isDeleted ? `<em>${msg('deletedPost', 'This post was deleted.')}</em>` : nl2br(post.content)}</div>
          ${typeof post.id === 'number' ? `
            <div class="forum-post-actions">
              ${renderReactions(post)}
              ${post.canEdit ? `<button class="button small ghost" type="button" data-edit-post="${post.id}">${msg('edit', 'Edit')}</button>` : ''}
              ${post.canDelete ? `<button class="button small danger" type="button" data-delete-post="${post.id}">${msg('delete', 'Delete')}</button>` : ''}
              ${state.thread.can.markSolution ? `<button class="button small ghost" type="button" data-solution-post="${post.id}">${msg('markSolution', 'Mark solution')}</button>` : ''}
              <button class="button small ghost" type="button" data-report-post="${post.id}">${msg('report', 'Report')}</button>
            </div>
          ` : ''}
        </div>
      </article>
    `;
  }

  function renderReactions(post) {
    return `<span class="forum-reactions">${(post.reactions || []).map((reaction) => `<button class="reaction-button ${reaction.mine ? 'active' : ''}" type="button" data-react-post="${post.id}" data-react-type="${reaction.type}"><span>${reactionIcon(reaction.type)}</span>${reaction.count}</button>`).join('')}</span>`;
  }

  function renderForumAuthor(author = {}, createdAt = '') {
    const profile = author.profile || null;
    const name = authorDisplayName(author);
    const title = [profile?.jobTitle, profile?.department].filter(Boolean).join(' · ');
    const badges = [...(author.roles || []).slice(0, 1), ...(profile?.skills || []).slice(0, 2).map((skill) => skill.name)];
    return `
      <div class="forum-author-card">
        ${renderAvatar(author, 'forum-author-avatar')}
        <span class="forum-author-copy">
          <strong>${profile?.href ? `<a href="${esc(profile.href)}">${esc(name)}</a>` : esc(name)}</strong>
          <small>${esc(title || formatDate(createdAt))}</small>
          <span class="forum-author-badges">${badges.map((item) => `<span class="pill">${esc(item)}</span>`).join('')}</span>
        </span>
      </div>
    `;
  }

  function renderAvatar(author = {}, className = 'forum-author-avatar') {
    const profile = author.profile || null;
    const name = authorDisplayName(author);
    return `<span class="${className}">${profile?.avatarUrl ? `<img src="${esc(profile.avatarUrl)}" alt="">` : esc(initials(name))}</span>`;
  }

  function authorDisplayName(author = {}) {
    return author.profile?.displayName || author.name || 'Unknown';
  }

  function renderReplyForm() {
    return `
      <form id="forumReplyForm" class="forum-reply-form modern">
        <label>
          <span>${msg('yourReply', 'Your reply')}</span>
          <textarea name="content" required placeholder="${msg('writeReply', 'Write a reply')}"></textarea>
        </label>
        <div class="forum-composer-actions">
          <span class="hint">${msg('replyComposerHint', 'Keep it clear and constructive.')}</span>
          <button class="button primary" type="submit">${msg('reply', 'Reply')}</button>
        </div>
      </form>
    `;
  }

  function bindThreadActions() {
    document.querySelector('#forumReplyForm')?.addEventListener('submit', reply);
    document.querySelectorAll('[data-react-post]').forEach((button) => button.addEventListener('click', () => react(button.dataset.reactPost, button.dataset.reactType)));
    document.querySelectorAll('[data-edit-post]').forEach((button) => button.addEventListener('click', () => openEdit(button.dataset.editPost)));
    document.querySelectorAll('[data-delete-post]').forEach((button) => button.addEventListener('click', () => deletePost(button.dataset.deletePost)));
    document.querySelectorAll('[data-report-post]').forEach((button) => button.addEventListener('click', () => reportPost(button.dataset.reportPost)));
    document.querySelectorAll('[data-solution-post]').forEach((button) => button.addEventListener('click', () => markSolution(button.dataset.solutionPost)));
    document.querySelectorAll('[data-mod-field]').forEach((button) => button.addEventListener('click', () => moderate(button.dataset.modField, button.dataset.modValue === '1')));
  }

  async function reply(event) {
    event.preventDefault();
    await fetchJson('/api/forum/post', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ threadSlug: state.thread.slug, content: event.currentTarget.elements.content.value }) });
    await loadThread(state.thread.slug);
  }

  async function react(postId, type) {
    await fetchJson('/api/forum/reaction', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ postId: Number(postId), type }) });
    await loadThread(state.thread.slug);
  }

  function openEdit(postId) {
    const post = state.thread.posts.find((item) => String(item.id) === String(postId));
    const dialog = document.querySelector('#forumEditDialog');
    const form = document.querySelector('#forumEditForm');
    form.elements.post_id.value = post.id;
    form.elements.content.value = post.content || '';
    dialog.showModal();
  }

  async function savePostEdit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await fetchJson('/api/forum/post/edit', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ post_id: Number(form.elements.post_id.value), content: form.elements.content.value }) });
    document.querySelector('#forumEditDialog')?.close();
    await loadThread(state.thread.slug);
  }

  async function deletePost(postId) {
    if (!confirm(msg('deletePostConfirm', 'Delete this post?'))) return;
    await fetchJson(`/api/forum/post/${postId}`, { method: 'DELETE' });
    await loadThread(state.thread.slug);
  }

  async function reportPost(postId) {
    const reason = prompt(msg('reportReason', 'Why are you reporting this post?'));
    if (!reason) return;
    await fetchJson('/api/forum/report', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ postId: Number(postId), reason }) });
    alert(msg('reportSaved', 'Report saved.'));
  }

  async function markSolution(postId) {
    await fetchJson('/api/forum/thread/solution', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ slug: state.thread.slug, postId: Number(postId) }) });
    await loadThread(state.thread.slug);
  }

  async function moderate(field, value) {
    await fetchJson('/api/forum/thread/moderate', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ slug: state.thread.slug, [field]: value }) });
    await loadThread(state.thread.slug);
  }

  function openThreadDialog() {
    hydrateDialogOptions();
    const form = document.querySelector('#forumThreadForm');
    form?.reset();
    if (state.mode === 'category') {
      const category = state.categories.find((item) => item.slug === state.slug);
      if (category) form.elements.category_id.value = category.id;
    }
    document.querySelector('#forumThreadDialog')?.showModal();
  }

  async function saveThread(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const tags = Array.from(form.elements.tags.selectedOptions).map((option) => Number(option.value));
    const response = await fetchJson('/api/forum/thread', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({
      category_id: Number(form.elements.category_id.value),
      title: form.elements.title.value,
      slug: form.elements.slug.value,
      content: form.elements.content.value,
      tags
    }) });
    document.querySelector('#forumThreadDialog')?.close();
    location.href = `/forum/thread/${encodeURIComponent(response.thread.slug)}`;
  }

  async function loadAdmin() {
    state.support = await fetchJson('/api/admin/forum/support-data');
    state.reports = (await fetchJson('/api/admin/forum/reports').catch(() => ({ items: [] }))).items || [];
    renderAdmin();
  }

  function renderAdmin() {
    document.querySelectorAll('[data-forum-admin-tab]').forEach((button) => button.classList.toggle('active', button.dataset.forumAdminTab === state.adminTab));
    const root = document.querySelector('#forumAdminRoot');
    if (state.adminTab === 'categories') root.innerHTML = renderCategoryAdmin();
    if (state.adminTab === 'tags') root.innerHTML = renderTagAdmin();
    if (state.adminTab === 'reports') root.innerHTML = renderReportsAdmin();
    if (state.adminTab === 'permissions') root.innerHTML = renderPermissionsAdmin();
    bindAdminActions();
  }

  function renderCategoryAdmin() {
    return `
      <section class="forum-admin-split">
        <form id="forumCategoryForm" class="forum-settings-form modern">
          <input name="id" type="hidden">
          <div>
            <p class="eyebrow">${msg('categories', 'Categories')}</p>
            <h2>${msg('saveCategory', 'Save category')}</h2>
            <p class="hint">${msg('categoriesAdminHint', 'Define spaces for discussions, control ordering and restrict private categories to selected roles.')}</p>
          </div>
          <div class="forum-form-grid">
            <label>${msg('categoryName', 'Category name')}<input name="name" required placeholder="${msg('categoryNamePlaceholder', 'Community updates')}"></label>
            <label>${msg('categorySlug', 'Category slug')}<input name="slug" placeholder="community-updates"></label>
            <label>${msg('sortOrder', 'Sort order')}<input name="sort_order" type="number" placeholder="0"></label>
          </div>
          <label>${msg('categoryDescription', 'Category description')}<textarea name="description" placeholder="${msg('categoryDescriptionPlaceholder', 'News, questions and coordination for the community.')}"></textarea></label>
          <div class="forum-visibility-editor">
            <label class="check"><input name="is_private" type="checkbox"><span>${msg('privateCategorySetting', 'Private category')}</span></label>
            <p class="hint">${msg('privateCategoryHint', 'Private categories are visible only to admins, moderators, participating users or the roles selected below.')}</p>
          </div>
          <label>${msg('visibleRoles', 'Visible roles')}<select name="roles" multiple size="5">${state.support.roles.map((role) => `<option value="${esc(role.name)}">${esc(role.name)}</option>`).join('')}</select></label>
          <div class="forum-form-actions"><button class="button ghost" type="button" data-reset-category-form>${msg('newCategory', 'New category')}</button><button class="button primary" type="submit">${msg('saveCategory', 'Save category')}</button></div>
        </form>
        <section class="forum-admin-list modern">
          ${(state.support.categories || []).map((category) => `<article class="forum-admin-row modern" data-edit-category="${category.id}"><div><strong>${esc(category.name)}</strong><span>${esc(category.slug)} · ${category.threadCount || 0} ${msg('threads', 'Threads')}</span><p class="hint">${esc(category.description || msg('noCategoryDescription', 'No description has been added yet.'))}</p></div><span class="pill">${category.isPrivate ? msg('private', 'Private') : msg('public', 'Public')}</span><button class="button small danger" type="button" data-delete-category="${category.id}">${msg('delete', 'Delete')}</button></article>`).join('') || renderEmpty(msg('noCategories', 'No categories'), msg('noCategoriesText', 'No forum categories are available yet.'))}
        </section>
      </section>
    `;
  }

  function renderTagAdmin() {
    return `
      <section class="forum-admin-split">
        <form id="forumTagForm" class="forum-settings-form modern">
          <input name="id" type="hidden">
          <div>
            <p class="eyebrow">${msg('tags', 'Tags')}</p>
            <h2>${msg('saveTag', 'Save tag')}</h2>
            <p class="hint">${msg('tagsAdminHint', 'Create reusable labels that help users filter and scan discussions.')}</p>
          </div>
          <div class="forum-form-grid">
            <label>${msg('tagName', 'Tag name')}<input name="name" placeholder="${msg('tagNamePlaceholder', 'Question')}" required></label>
            <label>${msg('tagSlug', 'Tag slug')}<input name="slug" placeholder="question"></label>
            <label>${msg('tagColor', 'Tag color')}<input name="color" type="color" value="#5d6b82"></label>
          </div>
          <div class="forum-form-actions"><button class="button ghost" type="button" data-reset-tag-form>${msg('newTag', 'New tag')}</button><button class="button primary" type="submit">${msg('saveTag', 'Save tag')}</button></div>
        </form>
        <section class="forum-admin-list modern">${(state.support.tags || []).map((tag) => `<article class="forum-admin-row modern" data-edit-tag="${tag.id}"><span class="forum-tag" style="--tag-color:${esc(tag.color)}">${esc(tag.name)}</span><span>${esc(tag.slug)}</span><button class="button small danger" type="button" data-delete-tag="${tag.id}">${msg('delete', 'Delete')}</button></article>`).join('') || renderEmpty(msg('noTags', 'No tags'), msg('noTagsText', 'Create tags to make threads easier to filter.'))}</section>
      </section>
    `;
  }

  function renderReportsAdmin() {
    return `
      <section class="forum-admin-list modern reports">
        ${state.reports.length ? state.reports.map((report) => `
          <article class="forum-report-row modern">
            <div>
              <span class="pill">${esc(report.status)}</span>
              <strong>${esc(report.thread.title)}</strong>
              <p>${esc(report.reason)}</p>
              <p class="hint">${msg('reportedContent', 'Reported content')}: ${esc(report.content).slice(0, 220)}</p>
            </div>
            <div class="forum-report-meta">
              <span>${msg('reporter', 'Reporter')}: ${esc(report.reporterName || '-')}</span>
              <span>${msg('author', 'Author')}: ${esc(report.authorName || '-')}</span>
            </div>
            <button class="button small primary" type="button" data-resolve-report="${report.id}">${msg('resolve', 'Resolve')}</button>
          </article>
        `).join('') : renderEmpty(msg('noReports', 'No reports'), msg('noReportsText', 'There are no reports yet.'))}
      </section>
    `;
  }

  function renderPermissionsAdmin() {
    return `
      <section class="forum-permissions-board">
        <div class="panel-head">
          <div><h2>${msg('permissions', 'Permissions')}</h2><p class="hint">${msg('permissionsAdminHint', 'Assign forum capabilities to Atlas roles. Admin users keep full access automatically.')}</p></div>
          <button class="button primary" type="button" data-save-forum-permissions>${msg('savePermissions', 'Save permissions')}</button>
        </div>
        ${state.support.permissionKeys.map((key) => `<section class="permission-card"><div><strong>${esc(key)}</strong><p class="hint">${esc(permissionHint(key))}</p></div><div class="permission-grid compact">${state.support.roles.map((role) => `<label class="check"><input type="checkbox" data-forum-permission="${esc(key)}" value="${esc(role.name)}" ${(state.support.permissions[key] || []).includes(role.name) ? 'checked' : ''}><span>${esc(role.name)}</span></label>`).join('')}</div></section>`).join('')}
      </section>
    `;
  }

  function bindAdminActions() {
    document.querySelector('#forumCategoryForm')?.addEventListener('submit', saveCategory);
    document.querySelector('#forumTagForm')?.addEventListener('submit', saveTag);
    document.querySelectorAll('[data-edit-category]').forEach((button) => button.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete-category]')) return;
      fillCategoryForm(state.support.categories.find((item) => item.id === Number(button.dataset.editCategory)));
    }));
    document.querySelectorAll('[data-edit-tag]').forEach((button) => button.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete-tag]')) return;
      fillTagForm(state.support.tags.find((item) => item.id === Number(button.dataset.editTag)));
    }));
    document.querySelectorAll('[data-delete-category]').forEach((button) => button.addEventListener('click', () => deleteAdminItem(`/api/admin/forum/categories/${button.dataset.deleteCategory}`)));
    document.querySelectorAll('[data-delete-tag]').forEach((button) => button.addEventListener('click', () => deleteAdminItem(`/api/admin/forum/tags/${button.dataset.deleteTag}`)));
    document.querySelectorAll('[data-resolve-report]').forEach((button) => button.addEventListener('click', () => resolveReport(button.dataset.resolveReport)));
    document.querySelector('[data-reset-category-form]')?.addEventListener('click', () => {
      document.querySelector('#forumCategoryForm')?.reset();
      document.querySelector('#forumCategoryForm input[name="id"]').value = '';
    });
    document.querySelector('[data-reset-tag-form]')?.addEventListener('click', () => {
      document.querySelector('#forumTagForm')?.reset();
      document.querySelector('#forumTagForm input[name="id"]').value = '';
    });
    document.querySelector('[data-save-forum-permissions]')?.addEventListener('click', savePermissions);
  }

  function fillCategoryForm(category) {
    const form = document.querySelector('#forumCategoryForm');
    form.elements.id.value = category.id;
    form.elements.name.value = category.name;
    form.elements.slug.value = category.slug;
    form.elements.sort_order.value = category.sortOrder || 0;
    form.elements.description.value = category.description || '';
    form.elements.is_private.checked = category.isPrivate;
    Array.from(form.elements.roles.options).forEach((option) => { option.selected = (category.roles || []).includes(option.value); });
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function fillTagForm(tag) {
    const form = document.querySelector('#forumTagForm');
    form.elements.id.value = tag.id;
    form.elements.name.value = tag.name;
    form.elements.slug.value = tag.slug;
    form.elements.color.value = tag.color || '#5d6b82';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function saveCategory(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await fetchJson('/api/admin/forum/categories', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({
      id: form.elements.id.value || undefined,
      name: form.elements.name.value,
      slug: form.elements.slug.value,
      description: form.elements.description.value,
      sort_order: form.elements.sort_order.value,
      is_private: form.elements.is_private.checked,
      roles: Array.from(form.elements.roles.selectedOptions).map((option) => option.value)
    }) });
    await loadAdmin();
  }

  async function saveTag(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await fetchJson('/api/admin/forum/tags', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ id: form.elements.id.value || undefined, name: form.elements.name.value, slug: form.elements.slug.value, color: form.elements.color.value }) });
    await loadAdmin();
  }

  async function deleteAdminItem(url) {
    if (!confirm(msg('deleteConfirm', 'Delete this item?'))) return;
    await fetchJson(url, { method: 'DELETE' });
    await loadAdmin();
  }

  async function resolveReport(id) {
    await fetchJson('/api/admin/forum/reports/resolve', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ id: Number(id), status: 'resolved' }) });
    await loadAdmin();
  }

  async function savePermissions() {
    const permissions = {};
    state.support.permissionKeys.forEach((key) => { permissions[key] = []; });
    document.querySelectorAll('[data-forum-permission]:checked').forEach((input) => permissions[input.dataset.forumPermission].push(input.value));
    const response = await fetchJson('/api/admin/forum/permissions', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ permissions }) });
    state.support.permissions = response.permissions || permissions;
    renderAdmin();
  }

  function hydrateTagFilter() {
    const select = document.querySelector('#forumTagFilter');
    if (select) select.innerHTML = `<option value="">${msg('allTags', 'All tags')}</option>${state.tags.map((tag) => `<option value="${esc(tag.slug)}">${esc(tag.name)}</option>`).join('')}`;
  }

  function hydrateDialogOptions() {
    const categorySelect = document.querySelector('[data-forum-category-select]');
    if (categorySelect) categorySelect.innerHTML = state.categories.map((category) => `<option value="${category.id}">${esc(category.name)}</option>`).join('');
    const tagSelect = document.querySelector('[data-forum-tag-select]');
    if (tagSelect) tagSelect.innerHTML = state.tags.map((tag) => `<option value="${tag.id}">${esc(tag.name)}</option>`).join('');
  }

  function renderTag(tag) {
    return `<span class="forum-tag" style="--tag-color:${esc(tag.color)}">${esc(tag.name)}</span>`;
  }

  function badge(text) {
    return `<span class="pill">${esc(text)}</span>`;
  }

  function renderEmpty(title, text) {
    return `<div class="empty-state"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
  }

  function permissionHint(key) {
    return ({
      'forum.view': msg('forumViewHint', 'May view public and permitted private forum categories.'),
      'forum.create_thread': msg('forumCreateThreadHint', 'May start new threads in visible categories.'),
      'forum.reply': msg('forumReplyHint', 'May reply to unlocked visible threads.'),
      'forum.edit_own_post': msg('forumEditOwnPostHint', 'May edit their own replies.'),
      'forum.delete_own_post': msg('forumDeleteOwnPostHint', 'May soft-delete their own replies.'),
      'forum.moderate': msg('forumModerateHint', 'May pin, lock, solve threads and remove posts.'),
      'forum.manage_categories': msg('forumManageCategoriesHint', 'May create, edit and delete forum categories.'),
      'forum.manage_tags': msg('forumManageTagsHint', 'May create, edit and delete thread tags.'),
      'forum.mark_solution': msg('forumMarkSolutionHint', 'May mark solutions on own threads.'),
      'forum.view_reports': msg('forumViewReportsHint', 'May view reported posts in the admin area.')
    })[key] || key;
  }

  function reactionIcon(type) {
    return ({ like: '+1', helpful: '?', insightful: '!', celebrate: '*' })[type] || type;
  }

  function initials(value = '') {
    return String(value || '?').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  }

  function injectCss(href) {
    if (!href || Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((link) => link.href === new URL(href, location.href).href)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
  }

  function jsonHeaders() {
    return { 'content-type': 'application/json' };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new Error(data?.error || text || response.statusText);
    return data;
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function formatDate(value) {
    return value ? new Date(value).toLocaleString() : '';
  }

  function formatRelative(value) {
    if (!value) return '-';
    const diff = Date.now() - new Date(value).getTime();
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return msg('justNow', 'Just now');
    if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m`;
    if (diff < day) return `${Math.floor(diff / hour)}h`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function nl2br(value = '') {
    return esc(value).replace(/\n/g, '<br>');
  }

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
})();
