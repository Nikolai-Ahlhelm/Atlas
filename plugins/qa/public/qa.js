(() => {
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  const app = document.querySelector('[data-qa-app]');
  const admin = document.querySelector('[data-qa-admin-page]');
  const root = app || admin;
  const state = {
    slug: app?.dataset.qaSlug || '',
    questions: [],
    question: null,
    tags: [],
    can: {},
    q: '',
    tag: '',
    status: '',
    support: { tags: [], questions: [], roles: [], permissions: {}, permissionKeys: [], can: {} },
    adminTab: 'moderation'
  };

  if (root) {
    injectCss(root.dataset.cssHref);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }

  async function init() {
    bind();
    if (admin) await loadAdmin();
    else await loadQa();
  }

  function bind() {
    document.querySelector('#qaSearch')?.addEventListener('input', debounce(async (event) => {
      state.q = event.target.value || '';
      await renderCurrent();
    }, 220));
    document.querySelector('#qaTagFilter')?.addEventListener('change', async (event) => {
      state.tag = event.target.value || '';
      await renderCurrent();
    });
    document.querySelector('#qaStatusFilter')?.addEventListener('change', async (event) => {
      state.status = event.target.value || '';
      await renderCurrent();
    });
    document.querySelector('[data-open-question-dialog]')?.addEventListener('click', openQuestionDialog);
    document.querySelector('[data-close-question-dialog]')?.addEventListener('click', () => document.querySelector('#qaQuestionDialog')?.close());
    document.querySelector('#qaQuestionForm')?.addEventListener('submit', saveQuestion);
    document.querySelectorAll('[data-qa-admin-tab]').forEach((button) => button.addEventListener('click', () => {
      state.adminTab = button.dataset.qaAdminTab || 'moderation';
      renderAdmin();
    }));
  }

  async function loadQa() {
    const response = await fetchJson('/api/qa/questions');
    state.questions = response.items || [];
    state.tags = response.tags || [];
    state.can = response.can || {};
    hydrateTagFilter();
    hydrateDialogTags();
    document.querySelector('[data-open-question-dialog]')?.toggleAttribute('hidden', !state.can.ask);
    await renderCurrent();
  }

  async function renderCurrent() {
    if (state.slug) return loadQuestion(state.slug);
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.tag) params.set('tag', state.tag);
    if (state.status) params.set('status', state.status);
    const response = await fetchJson(`/api/qa/questions?${params.toString()}`);
    state.questions = response.items || [];
    state.tags = response.tags || state.tags;
    state.can = response.can || state.can;
    renderList();
  }

  function renderList() {
    const target = document.querySelector('#qaRoot');
    if (!target) return;
    const totals = state.questions.reduce((acc, question) => {
      acc.answers += Number(question.answerCount || 0);
      if (question.status === 'solved') acc.solved += 1;
      return acc;
    }, { answers: 0, solved: 0 });
    target.innerHTML = `
      <section class="qa-overview-band">
        <div><h2>${msg('questions', 'Questions')}</h2><p>${msg('questionsIntro', 'Find answers, ask focused questions and capture accepted solutions for the team.')}</p></div>
        <dl class="qa-summary-strip"><div><dt>${msg('questions', 'Questions')}</dt><dd>${state.questions.length}</dd></div><div><dt>${msg('answers', 'Answers')}</dt><dd>${totals.answers}</dd></div><div><dt>${msg('solved', 'Solved')}</dt><dd>${totals.solved}</dd></div></dl>
      </section>
      <section class="qa-question-list">${state.questions.length ? state.questions.map(renderQuestionRow).join('') : renderEmpty(msg('noQuestions', 'No questions'), msg('noQuestionsText', 'No questions match this view.'))}</section>
    `;
  }

  function renderQuestionRow(question) {
    return `
      <a class="qa-question-row ${question.status === 'solved' ? 'is-solved' : ''}" href="/qa/question/${encodeURIComponent(question.slug)}">
        <span class="qa-vote-score">${question.score || 0}</span>
        <span class="qa-question-copy">
          <span class="qa-badge-row"><span class="pill">${esc(statusLabel(question.status))}</span>${question.acceptedAnswerId ? `<span class="pill success">${msg('accepted', 'Accepted')}</span>` : ''}</span>
          <strong>${esc(question.title)}</strong>
          <small>${esc(question.author?.name || question.author?.email || msg('unknown', 'Unknown'))} · ${formatDate(question.updatedAt)}</small>
          <span class="qa-tag-list">${question.tags.map(renderTag).join('')}</span>
        </span>
        <span class="qa-answer-count"><strong>${question.answerCount || 0}</strong><small>${msg('answers', 'Answers')}</small></span>
      </a>
    `;
  }

  async function loadQuestion(slug) {
    state.question = await fetchJson(`/api/qa/question?slug=${encodeURIComponent(slug)}`);
    renderQuestionDetail();
  }

  function renderQuestionDetail() {
    const target = document.querySelector('#qaRoot');
    const question = state.question;
    if (!target || !question) return;
    target.innerHTML = `
      <article class="qa-detail">
        <div class="qa-detail-head">
          <div>
            <p class="eyebrow">${esc(statusLabel(question.status))}</p>
            <h2>${esc(question.title)}</h2>
            <div class="qa-meta-line"><span>${msg('askedBy', 'Asked by')} ${esc(question.author?.name || question.author?.email || msg('unknown', 'Unknown'))}</span><span>${formatDate(question.createdAt)}</span></div>
            <div class="qa-tag-list">${question.tags.map(renderTag).join('')}</div>
          </div>
          ${question.can?.moderate ? renderStatusModeration(question) : ''}
        </div>
        <section class="qa-post qa-question-post">
          ${renderVoteControls('question', question.id, question.score, question.myVote)}
          <div class="qa-post-body">${nl2br(question.content)}</div>
        </section>
        <section class="qa-answer-section">
          <div class="qa-section-head"><h3>${msg('answers', 'Answers')} (${question.answers.length})</h3></div>
          <div class="qa-answer-list">${question.answers.length ? question.answers.map(renderAnswer).join('') : `<p class="hint">${msg('noAnswers', 'No answers yet.')}</p>`}</div>
        </section>
        ${question.can?.answer ? renderAnswerForm() : `<div class="notice">${question.status === 'closed' ? msg('questionClosed', 'This question is closed.') : msg('answerPermissionMissing', 'Answer permissions are required.')}</div>`}
      </article>
    `;
    bindQuestionActions();
  }

  function renderAnswer(answer) {
    return `
      <article class="qa-post qa-answer ${answer.accepted ? 'accepted' : ''}" data-answer-id="${answer.id}">
        ${renderVoteControls('answer', answer.id, answer.score, answer.myVote)}
        <div class="qa-post-body">
          <div class="qa-answer-head"><strong>${esc(answer.author?.name || answer.author?.email || msg('unknown', 'Unknown'))}</strong><small>${formatDate(answer.createdAt)}</small>${answer.accepted ? `<span class="pill success">${msg('bestAnswer', 'Best answer')}</span>` : ''}</div>
          <p>${nl2br(answer.content)}</p>
          ${state.question.can?.acceptAnswer && !answer.accepted ? `<button class="button small primary" type="button" data-accept-answer="${answer.id}">${msg('markBestAnswer', 'Mark best answer')}</button>` : ''}
        </div>
      </article>
    `;
  }

  function renderVoteControls(type, id, score, mine) {
    if (!state.question?.can?.vote) return `<div class="qa-votes"><strong>${score || 0}</strong></div>`;
    return `<div class="qa-votes"><button class="${mine === 1 ? 'active' : ''}" type="button" data-vote-${type}="${id}" data-value="1">▲</button><strong>${score || 0}</strong><button class="${mine === -1 ? 'active' : ''}" type="button" data-vote-${type}="${id}" data-value="-1">▼</button></div>`;
  }

  function renderAnswerForm() {
    return `<form id="qaAnswerForm" class="qa-answer-form"><label>${msg('yourAnswer', 'Your answer')}<textarea name="content" required></textarea></label><button class="button primary" type="submit">${msg('postAnswer', 'Post answer')}</button></form>`;
  }

  function renderStatusModeration(question) {
    return `<div class="qa-status-control"><label>${msg('status', 'Status')}<select data-question-status="${question.id}">${['open', 'solved', 'closed'].map((status) => `<option value="${status}" ${question.status === status ? 'selected' : ''}>${esc(statusLabel(status))}</option>`).join('')}</select></label></div>`;
  }

  function bindQuestionActions() {
    document.querySelector('#qaAnswerForm')?.addEventListener('submit', saveAnswer);
    document.querySelectorAll('[data-vote-question]').forEach((button) => button.addEventListener('click', () => voteQuestion(button.dataset.voteQuestion, button.dataset.value)));
    document.querySelectorAll('[data-vote-answer]').forEach((button) => button.addEventListener('click', () => voteAnswer(button.dataset.voteAnswer, button.dataset.value)));
    document.querySelectorAll('[data-accept-answer]').forEach((button) => button.addEventListener('click', () => acceptAnswer(button.dataset.acceptAnswer)));
    document.querySelector('[data-question-status]')?.addEventListener('change', (event) => moderateStatus(event.target.dataset.questionStatus, event.target.value));
  }

  async function saveAnswer(event) {
    event.preventDefault();
    state.question = await fetchJson('/api/qa/answer', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ slug: state.question.slug, content: event.currentTarget.elements.content.value }) });
    renderQuestionDetail();
  }

  async function voteQuestion(questionId, value) {
    state.question = await fetchJson('/api/qa/vote/question', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ question_id: Number(questionId), value: Number(value) }) });
    renderQuestionDetail();
  }

  async function voteAnswer(answerId, value) {
    state.question = await fetchJson('/api/qa/vote/answer', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ answer_id: Number(answerId), value: Number(value) }) });
    renderQuestionDetail();
  }

  async function acceptAnswer(answerId) {
    state.question = await fetchJson('/api/qa/accept-answer', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ answer_id: Number(answerId) }) });
    renderQuestionDetail();
  }

  async function moderateStatus(questionId, status) {
    const response = await fetchJson('/api/admin/qa/question/status', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ question_id: Number(questionId), status }) });
    state.question = response.question;
    renderQuestionDetail();
  }

  function openQuestionDialog() {
    hydrateDialogTags();
    document.querySelector('#qaQuestionForm')?.reset();
    document.querySelector('#qaQuestionDialog')?.showModal();
  }

  async function saveQuestion(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const tags = Array.from(form.elements.tags.selectedOptions).map((option) => Number(option.value));
    const response = await fetchJson('/api/qa/question', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ title: form.elements.title.value, content: form.elements.content.value, tags }) });
    document.querySelector('#qaQuestionDialog')?.close();
    location.href = `/qa/question/${encodeURIComponent(response.question.slug)}`;
  }

  async function loadAdmin() {
    state.support = await fetchJson('/api/admin/qa/support-data');
    renderAdmin();
  }

  function renderAdmin() {
    const allowedTabs = getAllowedAdminTabs();
    if (!allowedTabs.includes(state.adminTab)) state.adminTab = allowedTabs[0] || '';
    document.querySelectorAll('[data-qa-admin-tab]').forEach((button) => {
      const tab = button.dataset.qaAdminTab;
      const isAllowed = allowedTabs.includes(tab);
      button.hidden = !isAllowed;
      button.classList.toggle('active', isAllowed && tab === state.adminTab);
    });
    const target = document.querySelector('#qaAdminRoot');
    if (!target) return;
    if (state.adminTab === 'moderation') target.innerHTML = renderModerationAdmin();
    else if (state.adminTab === 'tags') target.innerHTML = renderTagsAdmin();
    else if (state.adminTab === 'permissions') target.innerHTML = renderPermissionsAdmin();
    else target.innerHTML = renderEmpty(msg('qaPermissionRequired', 'Q&A permissions required.'), msg('qaViewRequired', 'Q&A permissions are required.'));
    bindAdminActions();
  }

  function getAllowedAdminTabs() {
    const can = state.support.can || {};
    const tabs = [];
    if (can.moderate) tabs.push('moderation');
    if (can.manageTags) tabs.push('tags');
    if (can.moderate) tabs.push('permissions');
    return tabs;
  }

  function renderModerationAdmin() {
    return `<section class="panel qa-admin-panel"><div class="panel-head"><h2>${msg('moderation', 'Moderation')}</h2></div><div class="qa-admin-list">${(state.support.questions || []).map((question) => `<article class="qa-admin-row"><div><strong>${esc(question.title)}</strong><small>${esc(question.slug)}</small></div><select data-admin-question-status="${question.id}">${['open', 'solved', 'closed'].map((status) => `<option value="${status}" ${question.status === status ? 'selected' : ''}>${esc(statusLabel(status))}</option>`).join('')}</select><a class="button small ghost" href="/qa/question/${encodeURIComponent(question.slug)}">${msg('open', 'Open')}</a></article>`).join('') || renderEmpty(msg('noQuestions', 'No questions'), msg('noQuestionsText', 'No questions match this view.'))}</div></section>`;
  }

  function renderTagsAdmin() {
    return `
      <section class="panel qa-admin-panel">
        <div class="panel-head"><h2>${msg('tags', 'Tags')}</h2></div>
        <form id="qaTagForm" class="qa-settings-form">
          <input name="id" type="hidden">
          <div class="content-meta"><label>${msg('tagName', 'Tag name')}<input name="name" required></label><label>${msg('tagSlug', 'Tag slug')}<input name="slug"></label><label>${msg('tagColor', 'Tag color')}<input name="color" type="color" value="#4f7cff"></label></div>
          <div class="modal-actions"><button class="button ghost" type="button" data-reset-tag-form>${msg('newTag', 'New tag')}</button><button class="button primary" type="submit">${msg('saveTag', 'Save tag')}</button></div>
        </form>
        <div class="qa-admin-list">${(state.support.tags || []).map((tag) => `<article class="qa-admin-row" data-edit-tag="${tag.id}"><span class="qa-tag" style="--tag-color:${esc(tag.color)}">${esc(tag.name)}</span><span>${esc(tag.slug)}</span><button class="button small danger" type="button" data-delete-tag="${tag.id}">${msg('delete', 'Delete')}</button></article>`).join('') || renderEmpty(msg('noTags', 'No tags'), msg('noTagsText', 'Create tags to make questions easier to filter.'))}</div>
      </section>
    `;
  }

  function renderPermissionsAdmin() {
    return `<section class="panel qa-admin-panel"><div class="panel-head"><div><h2>${msg('permissions', 'Permissions')}</h2><p class="hint">${msg('permissionsAdminHint', 'Assign Q&A capabilities to Atlas roles. Admin users keep full access automatically.')}</p></div><button class="button primary" type="button" data-save-qa-permissions>${msg('savePermissions', 'Save permissions')}</button></div>${state.support.permissionKeys.map((key) => `<section class="permission-card"><div><strong>${esc(key)}</strong><p class="hint">${esc(permissionHint(key))}</p></div><div class="permission-grid compact">${state.support.roles.map((role) => `<label class="check"><input type="checkbox" data-qa-permission="${esc(key)}" value="${esc(role.name)}" ${(state.support.permissions[key] || []).includes(role.name) ? 'checked' : ''}><span>${esc(role.name)}</span></label>`).join('')}</div></section>`).join('')}</section>`;
  }

  function bindAdminActions() {
    document.querySelector('#qaTagForm')?.addEventListener('submit', saveTag);
    document.querySelector('[data-reset-tag-form]')?.addEventListener('click', () => document.querySelector('#qaTagForm')?.reset());
    document.querySelectorAll('[data-edit-tag]').forEach((row) => row.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete-tag]')) return;
      fillTagForm(state.support.tags.find((tag) => tag.id === Number(row.dataset.editTag)));
    }));
    document.querySelectorAll('[data-delete-tag]').forEach((button) => button.addEventListener('click', () => deleteTag(button.dataset.deleteTag)));
    document.querySelectorAll('[data-admin-question-status]').forEach((select) => select.addEventListener('change', () => moderateAdminStatus(select.dataset.adminQuestionStatus, select.value)));
    document.querySelector('[data-save-qa-permissions]')?.addEventListener('click', savePermissions);
  }

  function fillTagForm(tag) {
    const form = document.querySelector('#qaTagForm');
    form.elements.id.value = tag.id;
    form.elements.name.value = tag.name;
    form.elements.slug.value = tag.slug;
    form.elements.color.value = tag.color || '#4f7cff';
  }

  async function saveTag(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await fetchJson('/api/admin/qa/tags', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ id: form.elements.id.value || undefined, name: form.elements.name.value, slug: form.elements.slug.value, color: form.elements.color.value }) });
    await loadAdmin();
  }

  async function deleteTag(id) {
    if (!confirm(msg('deleteConfirm', 'Delete this item?'))) return;
    await fetchJson(`/api/admin/qa/tags/${id}`, { method: 'DELETE' });
    await loadAdmin();
  }

  async function moderateAdminStatus(questionId, status) {
    await fetchJson('/api/admin/qa/question/status', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ question_id: Number(questionId), status }) });
    await loadAdmin();
  }

  async function savePermissions() {
    const permissions = {};
    state.support.permissionKeys.forEach((key) => { permissions[key] = []; });
    document.querySelectorAll('[data-qa-permission]:checked').forEach((input) => permissions[input.dataset.qaPermission].push(input.value));
    const response = await fetchJson('/api/admin/qa/permissions', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ permissions }) });
    state.support.permissions = response.permissions || permissions;
    renderAdmin();
  }

  function hydrateTagFilter() {
    const select = document.querySelector('#qaTagFilter');
    if (select) select.innerHTML = `<option value="">${msg('allTags', 'All tags')}</option>${state.tags.map((tag) => `<option value="${esc(tag.slug)}">${esc(tag.name)}</option>`).join('')}`;
  }

  function hydrateDialogTags() {
    const select = document.querySelector('[data-qa-tag-select]');
    if (select) select.innerHTML = state.tags.map((tag) => `<option value="${tag.id}">${esc(tag.name)}</option>`).join('');
  }

  function renderTag(tag) {
    return `<span class="qa-tag" style="--tag-color:${esc(tag.color)}">${esc(tag.name)}</span>`;
  }

  function statusLabel(status) {
    return ({ open: msg('open', 'Open'), solved: msg('solved', 'Solved'), closed: msg('closed', 'Closed') })[status] || status;
  }

  function permissionHint(key) {
    return ({
      'qa.view': msg('qaViewHint', 'May view questions and answers.'),
      'qa.ask': msg('qaAskHint', 'May ask new questions.'),
      'qa.answer': msg('qaAnswerHint', 'May answer open questions.'),
      'qa.vote': msg('qaVoteHint', 'May vote on questions and answers.'),
      'qa.accept_answer': msg('qaAcceptAnswerHint', 'May accept best answers on own questions.'),
      'qa.moderate': msg('qaModerateHint', 'May moderate status and accept answers.'),
      'qa.manage_tags': msg('qaManageTagsHint', 'May create, edit and delete Q&A tags.')
    })[key] || key;
  }

  function renderEmpty(title, text) {
    return `<div class="empty-state"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
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

  function nl2br(value = '') {
    return esc(value).replace(/\n/g, '<br>');
  }

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function readPortalI18n() {
    try { return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}'); } catch { return {}; }
  }
})();
