(() => {
  let users = [];
  let roles = [];
  let formsTree = [];
  let currentFormSelection = null;
  let formDraftFields = [];
  let expandedFormFieldKeys = new Set();
  let draggedFieldIndex = null;
  let activeFormSubtab = 'fields';
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  let errorBox = null;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  async function init() {
    errorBox = document.querySelector('#formsAdminError');
    document.querySelector('[data-new-form]')?.addEventListener('click', () => openFormCreateDialog());
    document.querySelector('#formEditorForm')?.addEventListener('submit', saveFormContent);
    document.querySelector('#deleteFormButton')?.addEventListener('click', deleteCurrentForm);
    document.querySelector('[data-add-form-field]')?.addEventListener('click', () => openFieldDialog());
    document.querySelector('[data-add-divider-field]')?.addEventListener('click', () => openFieldDialog({ type: 'divider' }));
    document.querySelector('#backToFormsListButton')?.addEventListener('click', closeFormDetail);
    document.querySelectorAll('[data-form-subtab]').forEach((button) => button.addEventListener('click', () => setActiveFormSubtab(button.dataset.formSubtab || 'fields')));
    hydrateFromUrl();
    await refresh();
  }

  async function refresh() {
    try {
      const [userRows, roleRows, formsResponse] = await Promise.all([
        fetchJson('/api/admin/users'),
        fetchJson('/api/admin/roles'),
        fetchJson('/api/admin/forms')
      ]);
      users = Array.isArray(userRows) ? userRows : [];
      roles = Array.isArray(roleRows) ? roleRows : [];
      formsTree = Array.isArray(formsResponse?.tree) ? formsResponse.tree : [];
      renderFormsTree();
      if (currentFormSelection?.slug) await loadForm(currentFormSelection.slug);
      else closeFormDetail(false);
      clearError();
    } catch (error) {
      renderError(error);
    }
  }

  function hydrateFromUrl() {
    const slug = new URLSearchParams(location.search).get('form');
    if (slug) currentFormSelection = { slug };
  }

  function renderFormsTree() {
    const target = document.querySelector('#formsTree');
    if (!target) return;
    target.innerHTML = formsTree.length
      ? `<div class="content-tree-list">${formsTree.map((form) => `
        <button class="content-tree-item ${currentFormSelection?.slug === form.slug ? 'active' : ''}" type="button" data-open-form="${esc(form.slug)}">
          <span class="content-tree-kind">${form.status === 'archived' ? 'ARC' : 'FORM'}</span>
          <span class="content-tree-label">${esc(form.title)}</span>
        </button>
      `).join('')}</div>`
      : `<div class="notice">${msg('noForms', 'No forms available yet.')}</div>`;
    target.querySelectorAll('[data-open-form]').forEach((button) => button.addEventListener('click', async () => loadForm(button.dataset.openForm)));
  }

  async function loadForm(slug) {
    const form = await fetchJson(`/api/admin/forms/form?slug=${encodeURIComponent(slug)}`);
    currentFormSelection = { slug: form.slug };
    formDraftFields = Array.isArray(form.fields) ? structuredClone(form.fields) : [];
    updateLayout();
    renderFormsTree();
    document.querySelector('#formEditorTitle').textContent = `${msg('formEditor', 'Form editor')}: ${form.title || form.slug}`;
    const openLiveFormButton = document.querySelector('#openLiveFormButton');
    if (openLiveFormButton) {
      openLiveFormButton.href = `/forms?form=${encodeURIComponent(form.slug)}`;
      openLiveFormButton.hidden = false;
    }
    document.querySelector('#formEditorEmpty').hidden = true;
    const editorForm = document.querySelector('#formEditorForm');
    editorForm.hidden = false;
    editorForm.elements.id.value = form.id || '';
    editorForm.elements.slug.value = form.slug || '';
    editorForm.elements.title.value = form.title || '';
    editorForm.elements.status.value = form.status || 'active';
    editorForm.elements.description.value = form.description || '';
    editorForm.elements.intro_text.value = form.introText || '';
    renderPermissionMatrix(form.permissions || {});
    renderFormFieldRows();
    setActiveFormSubtab(activeFormSubtab);
    syncUrl();
  }

  function renderPermissionMatrix(permissions = {}) {
    const target = document.querySelector('#formPermissionsEditor');
    if (!target) return;
    const entries = [['manage', 'Manage'], ['view', 'View'], ['evaluate', 'Evaluate'], ['submit', 'Submit']];
    target.innerHTML = entries.map(([key, label]) => `
      <section class="permission-card">
        <div><strong>${esc(label)}</strong><p class="hint">${esc(permissionHint(key))}</p></div>
        <div class="permission-grid">
          <fieldset><legend>${msg('groups', 'Groups')}</legend>${roles.map((role) => `<label class="check"><input type="checkbox" data-permission-scope="role" data-permission-key="${esc(key)}" value="${esc(role.name)}" ${(permissions[key]?.roles || []).includes(role.name) ? 'checked' : ''}> ${esc(role.name)}</label>`).join('')}</fieldset>
          <fieldset><legend>${msg('people', 'People')}</legend>${users.map((user) => `<label class="check"><input type="checkbox" data-permission-scope="user" data-permission-key="${esc(key)}" value="${esc(user.email)}" ${(permissions[key]?.users || []).includes(user.email) ? 'checked' : ''}> ${esc(user.name || user.email)}</label>`).join('')}</fieldset>
        </div>
      </section>
    `).join('');
  }

  function permissionHint(key) {
    return {
      manage: 'Can edit structure, access and status.',
      view: 'Can open the form.',
      evaluate: 'Can inspect submissions and record decisions.',
      submit: 'Can fill in and submit this form.'
    }[key] || '';
  }

  function readPermissionMatrix() {
    const permissions = {};
    ['manage', 'view', 'evaluate', 'submit'].forEach((key) => {
      permissions[key] = {
        roles: Array.from(document.querySelectorAll(`input[data-permission-scope="role"][data-permission-key="${key}"]:checked`)).map((input) => input.value),
        users: Array.from(document.querySelectorAll(`input[data-permission-scope="user"][data-permission-key="${key}"]:checked`)).map((input) => input.value)
      };
    });
    return permissions;
  }

  function renderFormFieldRows() {
    const target = document.querySelector('#formFieldsEditor');
    if (!target) return;
    target.innerHTML = formDraftFields.length
      ? formDraftFields.map((field, index) => renderFieldCard(field, index)).join('')
      : `<div class="notice">${msg('noFieldsYet', 'No fields yet. Add the first field to start building this form.')}</div>`;
    target.querySelectorAll('[data-edit-form-field]').forEach((button) => button.addEventListener('click', () => openFieldDialog(formDraftFields[Number(button.dataset.editFormField)], Number(button.dataset.editFormField))));
    target.querySelectorAll('[data-remove-form-field]').forEach((button) => button.addEventListener('click', () => removeField(Number(button.dataset.removeFormField))));
    target.querySelectorAll('[data-toggle-field-details]').forEach((button) => button.addEventListener('click', () => toggleFieldDetails(Number(button.dataset.toggleFieldDetails))));
    target.querySelectorAll('[data-form-field-card]').forEach((card) => {
      card.addEventListener('dragstart', handleFieldDragStart);
      card.addEventListener('dragover', handleFieldDragOver);
      card.addEventListener('drop', handleFieldDrop);
      card.addEventListener('dragend', handleFieldDragEnd);
    });
  }

  function renderFieldCard(field, index) {
    const expanded = expandedFormFieldKeys.has(field.key);
    const visibility = describeVisibility(field.visibility);
    const options = field.type === 'select' ? (field.options || []).join(', ') : '';
    return `
      <section class="form-field-row ${field.type === 'divider' ? 'is-divider' : ''} ${expanded ? 'is-expanded' : ''}" draggable="true" data-form-field-card="${index}">
        <div class="form-field-row-head">
          <div class="form-field-row-title">
            <button class="icon-button field-disclosure" type="button" data-toggle-field-details="${index}" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? '▾' : '▸'}</button>
            <div><strong>${esc(field.label || field.key)}</strong><p class="hint">${esc(field.type === 'divider' ? msg('sectionDivider', 'Section divider') : field.type)}</p></div>
          </div>
          <div class="row-actions">
            <button class="button small" type="button" data-edit-form-field="${index}">${msg('edit', 'Edit')}</button>
            <button class="button small danger" type="button" data-remove-form-field="${index}">${msg('delete', 'Delete')}</button>
          </div>
        </div>
        <div class="form-field-summary">
          <span class="pill">${esc(field.type)}</span>
          <span class="pill">${esc(field.key)}</span>
          ${field.required ? `<span class="pill">${msg('required', 'Required')}</span>` : ''}
        </div>
        <div class="form-field-details" ${expanded ? '' : 'hidden'}>
          ${options ? `<p class="hint"><strong>${msg('options', 'Options')}:</strong> ${esc(options)}</p>` : ''}
          ${visibility ? `<p class="hint"><strong>${msg('visibilityRule', 'Visibility rule')}:</strong> ${esc(visibility)}</p>` : ''}
          ${field.helpText ? `<p class="hint">${esc(field.helpText)}</p>` : ''}
          ${!options && !visibility && !field.helpText ? `<p class="hint">${msg('noAdditionalDetails', 'No additional details for this field.')}</p>` : ''}
        </div>
      </section>
    `;
  }

  function openFieldDialog(field = null, index = null) {
    const editMode = Number.isInteger(index);
    const dependencies = formDraftFields.filter((item, itemIndex) => item.type !== 'divider' && itemIndex !== index).map((item) => item.key);
    const dialog = modal(`
      <form class="modal-form">
        <h2>${editMode ? msg('editField', 'Edit field') : msg('addField', 'Add field')}</h2>
        <div class="content-meta">
          <label>${msg('type', 'Type')}<select name="type">${['text', 'textarea', 'email', 'select', 'date', 'number', 'checkbox', 'divider'].map((type) => `<option value="${type}" ${field?.type === type ? 'selected' : ''}>${esc(type)}</option>`).join('')}</select></label>
          <label>${msg('label', 'Label')} <input name="label" value="${esc(field?.label || '')}" required></label>
          <label>${msg('key', 'Key')} <input name="key" value="${esc(field?.key || '')}" placeholder="request_title"></label>
          <label>${msg('placeholder', 'Placeholder')} <input name="placeholder" value="${esc(field?.placeholder || '')}"></label>
        </div>
        <label>${msg('helpText', 'Help text')} <input name="helpText" value="${esc(field?.helpText || '')}"></label>
        <label>${msg('optionsCsv', 'Options (comma separated)')} <input name="options" value="${esc((field?.options || []).join(', '))}" placeholder="Option A, Option B"></label>
        <label class="check"><input name="required" type="checkbox" ${field?.required ? 'checked' : ''}> ${msg('required', 'Required')}</label>
        <div class="panel-inline-section">
          <div class="panel-head compact"><h2>${msg('visibilityRule', 'Visibility rule')}</h2></div>
          <label>${msg('dependsOnField', 'Depends on field')}<select name="visibility_field"><option value="">${esc(msg('alwaysVisible', 'Always visible'))}</option>${dependencies.map((key) => `<option value="${esc(key)}" ${field?.visibility?.fieldKey === key ? 'selected' : ''}>${esc(key)}</option>`).join('')}</select></label>
          <div class="content-meta">
            <label>${msg('conditionType', 'Condition')}<select name="visibility_mode"><option value="filled" ${field?.visibility?.mode !== 'equals' ? 'selected' : ''}>${esc(msg('isFilled', 'Is filled / enabled'))}</option><option value="equals" ${field?.visibility?.mode === 'equals' ? 'selected' : ''}>${esc(msg('equalsValue', 'Equals value'))}</option></select></label>
            <label>${msg('expectedValue', 'Expected value')} <input name="visibility_value" value="${esc(field?.visibility?.expectedValue || '')}" placeholder="Ja"></label>
          </div>
        </div>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('save', 'Save')}</button></div>
      </form>
    `);
    const typeSelect = dialog.querySelector('select[name="type"]');
    const syncDialog = () => {
      const type = typeSelect.value;
      dialog.querySelector('input[name="options"]').closest('label').hidden = type !== 'select';
      dialog.querySelector('input[name="required"]').closest('label').hidden = type === 'divider';
      dialog.querySelector('input[name="placeholder"]').closest('label').hidden = type === 'divider';
      dialog.querySelector('input[name="helpText"]').closest('label').hidden = type === 'divider';
      dialog.querySelector('.panel-inline-section').hidden = type === 'divider';
    };
    typeSelect.addEventListener('change', syncDialog);
    syncDialog();
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const type = String(form.get('type') || 'text');
      const nextField = { key: form.get('key'), label: form.get('label'), type, placeholder: form.get('placeholder'), helpText: form.get('helpText'), options: parseCsv(form.get('options')), required: form.get('required') === 'on' };
      const visibilityField = String(form.get('visibility_field') || '').trim();
      if (visibilityField && type !== 'divider') nextField.visibility = { fieldKey: visibilityField, mode: form.get('visibility_mode'), expectedValue: form.get('visibility_value') };
      if (editMode) formDraftFields[index] = nextField;
      else formDraftFields.push(nextField);
      renderFormFieldRows();
      dialog.remove();
    });
  }

  function describeVisibility(visibility) {
    if (!visibility?.fieldKey) return '';
    if (visibility.mode === 'equals') return `${visibility.fieldKey} = ${visibility.expectedValue || ''}`;
    return `${visibility.fieldKey} ${msg('mustBeFilled', 'must be filled')}`;
  }

  async function saveFormContent(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      id: form.elements.id.value || undefined,
      slug: form.elements.slug.value,
      title: form.elements.title.value,
      status: form.elements.status.value,
      description: form.elements.description.value,
      introText: form.elements.intro_text.value,
      permissions: readPermissionMatrix(),
      fields: formDraftFields.slice()
    };
    try {
      const result = await fetchJson('/api/admin/forms/form', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      await refresh();
      if (result?.slug) await loadForm(result.slug);
    } catch (error) {
      renderError(error);
    }
  }

  async function deleteCurrentForm() {
    const id = document.querySelector('#formEditorForm')?.elements.id.value;
    if (!id || !confirm(msg('deleteFormConfirm', 'Delete this form and all submissions?'))) return;
    try {
      await fetchJson(`/api/admin/forms/form/${id}`, { method: 'DELETE' });
      currentFormSelection = null;
      await refresh();
    } catch (error) {
      renderError(error);
    }
  }

  function openFormCreateDialog() {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${msg('createForm', 'Create form')}</h2>
        <label>${msg('title', 'Title')} <input name="title" placeholder="User request" required></label>
        <label>${msg('formSlug', 'Form slug')} <input name="slug" placeholder="user-request"></label>
        <label>${msg('description', 'Description')} <textarea name="description" placeholder="Collect access, account or workflow requests."></textarea></label>
        <div class="modal-actions"><button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button><button class="button primary" type="submit">${msg('create', 'Create')}</button></div>
      </form>
    `);
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const result = await fetchJson('/api/admin/forms/form', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: form.get('title'),
            slug: form.get('slug'),
            description: form.get('description'),
            introText: 'Please complete the required information before submitting.',
            status: 'active',
            permissions: { manage: { roles: ['Admins'], users: [] }, view: { roles: [], users: [] }, evaluate: { roles: ['Admins'], users: [] }, submit: { roles: ['Users'], users: [] } },
            fields: [
              { key: 'request_title', label: 'Request title', type: 'text', required: true, placeholder: '', helpText: '', options: [] },
              { key: 'details', label: 'Details', type: 'textarea', required: true, placeholder: '', helpText: '', options: [] }
            ]
          })
        });
        dialog.remove();
        await refresh();
        if (result?.slug) await loadForm(result.slug);
      } catch (error) {
        renderError(error);
      }
    });
  }

  function moveField(sourceIndex, targetIndex) {
    if (targetIndex < 0 || targetIndex >= formDraftFields.length || sourceIndex === targetIndex) return;
    const [field] = formDraftFields.splice(sourceIndex, 1);
    formDraftFields.splice(targetIndex, 0, field);
    renderFormFieldRows();
  }

  function removeField(index) {
    const removed = formDraftFields[index];
    if (removed?.key) expandedFormFieldKeys.delete(removed.key);
    formDraftFields.splice(index, 1);
    renderFormFieldRows();
  }

  function toggleFieldDetails(index) {
    const field = formDraftFields[index];
    if (!field?.key) return;
    if (expandedFormFieldKeys.has(field.key)) expandedFormFieldKeys.delete(field.key);
    else expandedFormFieldKeys.add(field.key);
    renderFormFieldRows();
  }

  function handleFieldDragStart(event) {
    draggedFieldIndex = Number(event.currentTarget.dataset.formFieldCard);
    event.currentTarget.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(draggedFieldIndex));
  }

  function handleFieldDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('is-drop-target');
  }

  function handleFieldDrop(event) {
    event.preventDefault();
    const targetIndex = Number(event.currentTarget.dataset.formFieldCard);
    const sourceIndex = Number.isInteger(draggedFieldIndex) ? draggedFieldIndex : Number(event.dataTransfer.getData('text/plain'));
    event.currentTarget.classList.remove('is-drop-target');
    if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) return;
    moveField(sourceIndex, targetIndex);
    draggedFieldIndex = null;
  }

  function handleFieldDragEnd(event) {
    draggedFieldIndex = null;
    document.querySelectorAll('[data-form-field-card]').forEach((card) => card.classList.remove('is-dragging', 'is-drop-target'));
    event.currentTarget.classList.remove('is-dragging');
  }

  function closeFormDetail(updateHistory = true) {
    currentFormSelection = null;
    formDraftFields = [];
    expandedFormFieldKeys = new Set();
    const editor = document.querySelector('#formEditorForm');
    const empty = document.querySelector('#formEditorEmpty');
    const openLiveFormButton = document.querySelector('#openLiveFormButton');
    if (editor) editor.hidden = true;
    if (empty) empty.hidden = false;
    if (openLiveFormButton) {
      openLiveFormButton.hidden = true;
      openLiveFormButton.href = '/forms';
    }
    updateLayout();
    if (updateHistory) syncUrl();
  }

  function updateLayout() {
    const hasSelection = Boolean(currentFormSelection?.slug);
    document.querySelector('#backToFormsListButton')?.toggleAttribute('hidden', !hasSelection);
    const listPanel = document.querySelector('#formsTree')?.closest('.content-nav-panel');
    const detailPanel = document.querySelector('.form-detail-panel-admin');
    if (listPanel) {
      listPanel.hidden = hasSelection;
      listPanel.classList.toggle('is-full-width', !hasSelection);
    }
    if (detailPanel) {
      detailPanel.hidden = !hasSelection;
      detailPanel.classList.toggle('is-full-width', hasSelection);
    }
  }

  function setActiveFormSubtab(tab) {
    activeFormSubtab = ['fields', 'permissions'].includes(tab) ? tab : 'fields';
    document.querySelectorAll('[data-form-subtab]').forEach((button) => button.classList.toggle('active', button.dataset.formSubtab === activeFormSubtab));
    document.querySelectorAll('[data-form-subpanel]').forEach((panel) => { panel.hidden = panel.dataset.formSubpanel !== activeFormSubtab; });
  }

  function syncUrl() {
    const params = new URLSearchParams(location.search);
    if (currentFormSelection?.slug) params.set('form', currentFormSelection.slug);
    else params.delete('form');
    history.replaceState({}, '', `${location.pathname}?${params.toString()}`);
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

  function parseCsv(value) {
    return String(value || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
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
