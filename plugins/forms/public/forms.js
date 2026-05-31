(() => {
  let forms = [];
  let currentForm = null;
  let currentSubmissions = [];
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initForms, { once: true });
  } else {
    initForms();
  }

  async function initForms() {
    try {
      const response = await fetchJson('/api/forms');
      forms = Array.isArray(response) ? response : [];
      renderFormsNav();
      const requested = new URLSearchParams(location.search).get('form');
      const initial = forms.find((form) => form.slug === requested) || forms[0];
      if (initial) await loadForm(initial.slug);
      else renderEmpty(msg('noForms', 'No forms are available for you yet.'), msg('noFormsText', 'Ask an administrator to grant access to a form or to activate the forms plugin.'));
    } catch (error) {
      renderEmpty(msg('unexpectedError', 'An unexpected error occurred.'), error.message || '');
    }
  }

  function renderFormsNav() {
    const target = document.querySelector('#formsNav');
    if (!target) return;
    target.innerHTML = forms.length
      ? forms.map((form) => `
        <button class="content-tree-item ${currentForm?.slug === form.slug ? 'active' : ''}" type="button" data-open-form="${esc(form.slug)}">
          <span class="content-tree-kind">${form.actions?.canEvaluate ? 'REV' : 'FORM'}</span>
          <span class="content-tree-label">${esc(form.title)}</span>
        </button>
      `).join('')
      : `<div class="notice">${msg('noForms', 'No forms are available for you yet.')}</div>`;

    target.querySelectorAll('[data-open-form]').forEach((button) => button.addEventListener('click', async () => {
      await loadForm(button.dataset.openForm);
    }));
  }

  async function loadForm(slug) {
    currentForm = await fetchJson(`/api/forms/form?slug=${encodeURIComponent(slug)}`);
    renderFormsNav();
    syncUrl(slug);
    renderForm();
    await loadSubmissions();
  }

  async function loadSubmissions() {
    if (!currentForm) return;
    const response = await fetchJson(`/api/forms/submissions?slug=${encodeURIComponent(currentForm.slug)}`);
    currentSubmissions = Array.isArray(response.submissions) ? response.submissions : [];
    renderSubmissionSection(Boolean(response.canEvaluate));
  }

  function renderForm() {
    const empty = document.querySelector('#formsEmptyState');
    const detail = document.querySelector('#formDetailView');
    if (!empty || !detail || !currentForm) return;
    empty.hidden = true;
    detail.hidden = false;
    detail.innerHTML = `
      <div class="form-detail-shell">
        <div class="panel-head">
          <div>
            <h2>${esc(currentForm.title)}</h2>
            <p class="hint">${esc(currentForm.description || '')}</p>
          </div>
          <span class="pill">${currentForm.actions?.canEvaluate ? msg('evaluate', 'Evaluate') : msg('submit', 'Submit')}</span>
        </div>
        <div class="forms-detail-body">
          <section class="forms-hero-copy">
            <p>${esc(currentForm.introText || '')}</p>
          </section>
          ${currentForm.actions?.canSubmit ? renderFormSubmitCard(currentForm) : ''}
          <section id="formSubmissionsSection" class="forms-submissions-section"></section>
        </div>
      </div>
    `;

    const dynamicForm = detail.querySelector('#dynamicForm');
    dynamicForm?.addEventListener('submit', submitCurrentForm);
    dynamicForm?.addEventListener('input', syncConditionalFields);
    dynamicForm?.addEventListener('change', syncConditionalFields);
    syncConditionalFields();
  }

  function renderFormSubmitCard(form) {
    return `
      <section class="forms-submit-card">
        <h3>${msg('submitForm', 'Submit form')}</h3>
        <form id="dynamicForm" class="modal-form">
          ${form.fields.map((field) => renderField(field)).join('')}
          <div class="modal-actions">
            <button class="button primary" type="submit">${msg('submit', 'Submit')}</button>
          </div>
        </form>
      </section>
    `;
  }

  function renderField(field) {
    const visibility = field.visibility ? ` data-visible-when="${esc(JSON.stringify(field.visibility))}"` : '';
    if (field.type === 'divider') {
      return `<section class="form-section-divider"${visibility}><hr><span>${esc(field.label || msg('section', 'Section'))}</span></section>`;
    }
    const required = field.required ? 'required' : '';
    const hint = field.helpText ? `<span class="hint">${esc(field.helpText)}</span>` : '';
    if (field.type === 'textarea') return `<label data-form-field="${esc(field.key)}"${visibility}>${esc(field.label)}${hint}<textarea name="${esc(field.key)}" placeholder="${esc(field.placeholder || '')}" ${required}></textarea></label>`;
    if (field.type === 'select') {
      return `<label data-form-field="${esc(field.key)}"${visibility}>${esc(field.label)}${hint}<select name="${esc(field.key)}" ${required}><option value="">${esc(msg('pleaseChoose', 'Please choose'))}</option>${(field.options || []).map((option) => `<option value="${esc(option)}">${esc(option)}</option>`).join('')}</select></label>`;
    }
    if (field.type === 'checkbox') {
      return `<label class="check" data-form-field="${esc(field.key)}"${visibility}><input name="${esc(field.key)}" type="checkbox"><span>${esc(field.label)}</span></label>`;
    }
    const type = ['email', 'date', 'number'].includes(field.type) ? field.type : 'text';
    return `<label data-form-field="${esc(field.key)}"${visibility}>${esc(field.label)}${hint}<input name="${esc(field.key)}" type="${type}" placeholder="${esc(field.placeholder || '')}" ${required}></label>`;
  }

  async function submitCurrentForm(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const values = {};
    currentForm.fields.forEach((field) => {
      if (field.type === 'divider') return;
      values[field.key] = field.type === 'checkbox' ? formData.get(field.key) === 'on' : formData.get(field.key);
    });
    try {
      await fetchJson('/api/forms/form/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: currentForm.slug, values })
      });
      event.currentTarget.reset();
      await loadSubmissions();
      alert(msg('formSubmitSuccess', 'Your submission has been saved.'));
    } catch (error) {
      alert(error.message || msg('unexpectedError', 'An unexpected error occurred.'));
    }
  }

  function syncConditionalFields() {
    const form = document.querySelector('#dynamicForm');
    if (!form || !currentForm) return;
    const values = {};
    currentForm.fields.forEach((field) => {
      if (field.type === 'divider') return;
      const control = form.elements[field.key];
      if (!control) return;
      values[field.key] = control.type === 'checkbox' ? control.checked : control.value;
    });
    form.querySelectorAll('[data-visible-when]').forEach((node) => {
      const rule = safeJson(node.dataset.visibleWhen);
      const visible = evaluateVisibility(rule, values);
      node.hidden = !visible;
      node.querySelectorAll('input, textarea, select').forEach((control) => { control.disabled = !visible; });
    });
  }

  function evaluateVisibility(rule, values) {
    if (!rule?.fieldKey) return true;
    if (!(rule.fieldKey in values)) return true;
    const dependency = values[rule.fieldKey];
    if (rule.mode === 'equals') return String(dependency ?? '').trim() === String(rule.expectedValue || '');
    if (typeof dependency === 'boolean') return dependency === true;
    return String(dependency ?? '').trim() !== '';
  }

  function safeJson(value) {
    try { return JSON.parse(value || ''); } catch { return null; }
  }

  function renderSubmissionSection(canEvaluate) {
    const target = document.querySelector('#formSubmissionsSection');
    if (!target || !currentForm) return;
    if (!currentSubmissions.length) {
      target.innerHTML = `<section class="forms-submit-card"><h3>${canEvaluate ? msg('submissions', 'Submissions') : msg('mySubmissions', 'My submissions')}</h3><p class="hint">${msg('noSubmissions', 'No submissions yet.')}</p></section>`;
      return;
    }

    target.innerHTML = `
      <section class="forms-submit-card">
        <h3>${canEvaluate ? msg('submissions', 'Submissions') : msg('mySubmissions', 'My submissions')}</h3>
        <div class="forms-submission-list">
          ${currentSubmissions.map((submission) => `
            <article class="forms-submission-card">
              <div class="forms-submission-head">
                <div>
                  <strong>${esc(submission.submitter?.name || submission.submitter?.email || msg('submission', 'Submission'))}</strong>
                  <p class="hint">${esc(formatDate(submission.createdAt))}</p>
                </div>
                <span class="pill">${esc(submission.status)}</span>
              </div>
              <dl class="forms-submission-values">
                ${submission.values.map((item) => `<div><dt>${esc(item.label)}</dt><dd>${esc(formatValue(item.value))}</dd></div>`).join('')}
              </dl>
              ${canEvaluate ? renderReviewForm(submission) : ''}
            </article>
          `).join('')}
        </div>
      </section>
    `;

    target.querySelectorAll('[data-review-submission]').forEach((form) => form.addEventListener('submit', submitReview));
  }

  function renderReviewForm(submission) {
    return `<form class="forms-review-form" data-review-submission="${submission.id}"><input type="hidden" name="submission_id" value="${submission.id}"><label>${msg('status', 'Status')}<select name="status">${['submitted', 'in_review', 'approved', 'rejected'].map((status) => `<option value="${status}" ${submission.status === status ? 'selected' : ''}>${esc(status)}</option>`).join('')}</select></label><label>${msg('notes', 'Notes')}<textarea name="notes">${esc(submission.notes || '')}</textarea></label><div class="modal-actions"><button class="button primary" type="submit">${msg('saveReview', 'Save review')}</button></div></form>`;
  }

  async function submitReview(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await fetchJson('/api/forms/submissions/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ submissionId: Number(form.get('submission_id')), status: form.get('status'), notes: form.get('notes') })
      });
      await loadSubmissions();
    } catch (error) {
      alert(error.message || msg('unexpectedError', 'An unexpected error occurred.'));
    }
  }

  function renderEmpty(title, text) {
    const empty = document.querySelector('#formsEmptyState');
    const detail = document.querySelector('#formDetailView');
    if (detail) detail.hidden = true;
    if (empty) {
      empty.hidden = false;
      empty.innerHTML = `<h1>${esc(title)}</h1><p>${esc(text)}</p>`;
    }
  }

  function syncUrl(slug) {
    const params = new URLSearchParams(location.search);
    params.set('form', slug);
    history.replaceState({}, '', `${location.pathname}?${params.toString()}`);
  }

  function formatValue(value) {
    if (typeof value === 'boolean') return value ? msg('yes', 'Yes') : msg('no', 'No');
    return String(value || '');
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
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
