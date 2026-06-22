(() => {
  const I18N = readPortalI18n().messages || {};
  const msg = (key, fallback) => I18N[key] || fallback || key;
  const app = document.querySelector('[data-directory-app]');
  const admin = document.querySelector('[data-directory-admin-page]');
  const state = {
    mode: app?.dataset.directoryMode || 'list',
    userId: app?.dataset.directoryUserId || '',
    profiles: [],
    filters: { skills: [], departments: [], roles: [] },
    support: { profiles: [], fields: [], skills: [], roles: [], permissions: {}, permissionKeys: [] },
    can: {},
    q: '',
    skill: '',
    department: '',
    role: '',
    adminTab: 'profiles'
  };

  if (app || admin) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }

  async function init() {
    bind();
    if (admin) await loadAdmin();
    else await loadApp();
  }

  function bind() {
    document.querySelector('#directorySearch')?.addEventListener('input', debounce(async (event) => { state.q = event.target.value || ''; await loadProfiles(); }, 220));
    document.querySelector('#directorySkillFilter')?.addEventListener('change', async (event) => { state.skill = event.target.value || ''; await loadProfiles(); });
    document.querySelector('#directoryDepartmentFilter')?.addEventListener('change', async (event) => { state.department = event.target.value || ''; await loadProfiles(); });
    document.querySelector('#directoryRoleFilter')?.addEventListener('change', async (event) => { state.role = event.target.value || ''; await loadProfiles(); });
    document.querySelectorAll('[data-directory-admin-tab]').forEach((button) => button.addEventListener('click', () => {
      state.adminTab = button.dataset.directoryAdminTab || 'profiles';
      renderAdmin();
    }));
  }

  async function loadApp() {
    if (state.mode === 'me') return loadMe();
    if (state.mode === 'profile') return loadProfile(state.userId);
    await loadProfiles();
  }

  async function loadProfiles() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.skill) params.set('skill', state.skill);
    if (state.department) params.set('department', state.department);
    if (state.role) params.set('role', state.role);
    const response = await fetchJson(`/api/directory/profiles?${params.toString()}`);
    state.profiles = response.items || [];
    state.filters = response.filters || state.filters;
    state.can = response.can || {};
    hydrateFilters();
    renderDirectoryList();
  }

  async function loadProfile(userId) {
    const profile = await fetchJson(`/api/directory/profile?user_id=${encodeURIComponent(userId)}`);
    document.querySelector('[data-directory-toolbar]')?.setAttribute('hidden', 'hidden');
    document.querySelector('#directoryRoot').innerHTML = renderProfileDetail(profile);
  }

  async function loadMe() {
    const [profile, support] = await Promise.all([fetchJson('/api/directory/me'), fetchJson('/api/directory/support-data')]);
    state.support = support;
    document.querySelector('[data-directory-toolbar]')?.setAttribute('hidden', 'hidden');
    document.querySelector('#directoryRoot').innerHTML = renderProfileEditor(profile, false);
    bindProfileForm();
  }

  function hydrateFilters() {
    setOptions('#directorySkillFilter', state.filters.skills || [], 'id', 'name', msg('allSkills', 'All skills'), state.skill);
    setSimpleOptions('#directoryDepartmentFilter', state.filters.departments || [], msg('allDepartments', 'All departments'), state.department);
    setSimpleOptions('#directoryRoleFilter', state.filters.roles || [], msg('allRoles', 'All roles'), state.role);
  }

  function renderDirectoryList() {
    const root = document.querySelector('#directoryRoot');
    root.innerHTML = `
      <section class="directory-overview-band">
        <div><h2>${msg('members', 'Members')}</h2><p>${msg('membersText', 'Find people by role, team, location, skills or profile details.')}</p></div>
        <dl class="directory-summary-strip"><div><dt>${msg('profiles', 'Profiles')}</dt><dd>${state.profiles.length}</dd></div><div><dt>${msg('skills', 'Skills')}</dt><dd>${state.filters.skills?.length || 0}</dd></div></dl>
      </section>
      <section class="directory-profile-grid">
        ${state.profiles.length ? state.profiles.map(renderProfileCard).join('') : renderEmpty(msg('noProfiles', 'No profiles'), msg('noProfilesText', 'No matching profiles were found.'))}
      </section>
    `;
  }

  function renderProfileCard(profile) {
    return `
      <article class="directory-profile-card">
        <div class="directory-profile-main">
          ${renderAvatar(profile)}
          <div>
            <h2><a href="/directory/profile/${profile.userId}">${esc(profile.displayName)}</a></h2>
            <p>${esc([profile.jobTitle, profile.department].filter(Boolean).join(' · ') || profile.location || msg('member', 'Member'))}</p>
          </div>
        </div>
        ${profile.bio ? `<p>${esc(profile.bio)}</p>` : ''}
        <div class="directory-pill-row">${profile.roles.map((role) => `<span class="pill">${esc(role)}</span>`).join('')}${profile.skills.slice(0, 4).map((skill) => `<span class="directory-skill-pill">${esc(skill.name)}</span>`).join('')}</div>
      </article>
    `;
  }

  function renderProfileDetail(profile) {
    return `
      <section class="directory-profile-detail">
        <div class="directory-profile-hero">
          ${renderAvatar(profile)}
          <div>
            <p class="eyebrow">${esc(profile.department || msg('profile', 'Profile'))}</p>
            <h2>${esc(profile.displayName)}</h2>
            <p>${esc([profile.jobTitle, profile.location].filter(Boolean).join(' · '))}</p>
          </div>
        </div>
        ${profile.bio ? `<p class="directory-bio">${esc(profile.bio)}</p>` : ''}
        <div class="directory-pill-row">${profile.roles.map((role) => `<span class="pill">${esc(role)}</span>`).join('')}${profile.skills.map((skill) => `<span class="directory-skill-pill">${esc(skill.name)}</span>`).join('')}</div>
        <dl class="directory-field-list">
          ${profile.fields.filter((field) => field.value).map((field) => `<div><dt>${esc(field.name)}</dt><dd>${formatFieldValue(field)}</dd></div>`).join('') || `<div><dt>${msg('details', 'Details')}</dt><dd>${msg('noPublicFields', 'No additional visible fields yet.')}</dd></div>`}
        </dl>
      </section>
    `;
  }

  function renderProfileEditor(profile, adminMode) {
    const support = state.support;
    const selectedSkills = new Set((profile.skills || []).map((skill) => skill.id));
    return `
      <form id="directoryProfileForm" class="directory-settings-form">
        <input name="user_id" type="hidden" value="${profile.userId}">
        <section class="directory-editor-section">
          <h2>${adminMode ? msg('editProfile', 'Edit profile') : msg('editMyProfile', 'Edit my profile')}</h2>
          <div class="directory-form-grid">
            <label>${msg('displayName', 'Display name')}<span class="hint">${msg('displayNameHint', 'Shown in the directory and forum posts.')}</span><input name="display_name" value="${esc(profile.displayName)}" required></label>
            <label>${msg('jobTitle', 'Job title')}<span class="hint">${msg('jobTitleHint', 'Used as the compact role line on profile cards.')}</span><input name="job_title" value="${esc(profile.jobTitle || '')}"></label>
            <label>${msg('department', 'Department / team')}<span class="hint">${msg('departmentHint', 'Helps users filter by team or group.')}</span><input name="department" value="${esc(profile.department || '')}"></label>
            <label>${msg('location', 'Location')}<span class="hint">${msg('locationHint', 'Office, region or community timezone.')}</span><input name="location" value="${esc(profile.location || '')}"></label>
            <label>${msg('avatarUrl', 'Avatar URL')}<span class="hint">${msg('avatarUrlHint', 'HTTPS image URL or safe data image.')}</span><input name="avatar_url" value="${esc(profile.avatarUrl || '')}"></label>
            <label>${msg('profileVisibility', 'Profile visibility')}<span class="hint">${msg('profileVisibilityHint', 'Controls the overall profile listing visibility.')}</span><select name="visibility">${visibilityOptions(profile.visibility)}</select></label>
          </div>
          <label>${msg('bio', 'Bio')}<span class="hint">${msg('bioHint', 'Short introduction for colleagues or community members.')}</span><textarea name="bio">${esc(profile.bio || '')}</textarea></label>
          <label>${msg('skills', 'Skills / interests')}<span class="hint">${msg('skillsHint', 'Choose skills or interests that should appear as badges.')}</span><select name="skills" multiple size="6">${support.skills.map((skill) => `<option value="${skill.id}" ${selectedSkills.has(skill.id) ? 'selected' : ''}>${esc(skill.name)}</option>`).join('')}</select></label>
        </section>
        <section class="directory-editor-section">
          <h2>${msg('customFields', 'Custom fields')}</h2>
          <div class="directory-field-editor-list">${(support.fields || []).map((field) => renderFieldEditor(field, profile)).join('') || `<div class="notice">${msg('noCustomFields', 'No custom profile fields are configured yet.')}</div>`}</div>
        </section>
        <div class="directory-form-actions"><button class="button primary" type="submit">${msg('saveProfile', 'Save profile')}</button></div>
      </form>
    `;
  }

  function renderFieldEditor(field, profile) {
    const existing = (profile.fields || []).find((item) => item.fieldId === field.id) || { value: '', visibility: field.visibilityDefault };
    return `<section class="directory-field-editor"><label>${esc(field.name)}<span class="hint">${esc(field.fieldType)} · ${msg('defaultVisibility', 'Default visibility')}: ${esc(field.visibilityDefault)}</span>${field.fieldType === 'textarea' ? `<textarea name="field_${field.id}">${esc(existing.value || '')}</textarea>` : `<input name="field_${field.id}" value="${esc(existing.value || '')}" type="${inputType(field.fieldType)}">`}</label><label>${msg('fieldVisibility', 'Field visibility')}<select name="field_visibility_${field.id}">${visibilityOptions(existing.visibility)}</select></label></section>`;
  }

  function bindProfileForm() {
    document.querySelector('#directoryProfileForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = readProfileForm(event.currentTarget);
      const endpoint = admin ? '/api/admin/directory/profile' : '/api/directory/me';
      await fetchJson(endpoint, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(payload) });
      alert(msg('profileSaved', 'Profile saved.'));
      if (!admin) await loadMe();
      else await loadAdmin();
    });
  }

  function readProfileForm(form) {
    const fieldValues = {};
    (state.support.fields || []).forEach((field) => {
      fieldValues[field.id] = { value: form.elements[`field_${field.id}`]?.value || '', visibility: form.elements[`field_visibility_${field.id}`]?.value || field.visibilityDefault };
    });
    return {
      user_id: Number(form.elements.user_id?.value || 0) || undefined,
      display_name: form.elements.display_name.value,
      bio: form.elements.bio.value,
      avatar_url: form.elements.avatar_url.value,
      location: form.elements.location.value,
      job_title: form.elements.job_title.value,
      department: form.elements.department.value,
      visibility: form.elements.visibility.value,
      skills: Array.from(form.elements.skills.selectedOptions).map((option) => Number(option.value)),
      fieldValues
    };
  }

  async function loadAdmin() {
    state.support = await fetchJson('/api/admin/directory/support-data');
    renderAdmin();
  }

  function renderAdmin() {
    document.querySelectorAll('[data-directory-admin-tab]').forEach((button) => button.classList.toggle('active', button.dataset.directoryAdminTab === state.adminTab));
    const root = document.querySelector('#directoryAdminRoot');
    if (state.adminTab === 'profiles') root.innerHTML = renderProfilesAdmin();
    if (state.adminTab === 'fields') root.innerHTML = renderFieldsAdmin();
    if (state.adminTab === 'skills') root.innerHTML = renderSkillsAdmin();
    if (state.adminTab === 'permissions') root.innerHTML = renderPermissionsAdmin();
    bindAdminActions();
  }

  function renderProfilesAdmin() {
    const selected = state.support.profiles[0];
    return `<section class="panel directory-admin-panel"><div class="directory-admin-head"><div><h2>${msg('profiles', 'Profiles')}</h2><p class="hint">${msg('profilesAdminHint', 'Select a user and maintain their public directory information.')}</p></div></div><div class="directory-admin-layout"><div class="directory-admin-list">${state.support.profiles.map((profile) => `<button class="directory-admin-row" type="button" data-load-profile="${profile.userId}">${renderAvatar(profile)}<span><strong>${esc(profile.displayName)}</strong><small>${esc(profile.jobTitle || profile.department || profile.user.email)}</small></span></button>`).join('')}</div><div id="directoryAdminProfileEditor">${selected ? renderProfileEditor(selected, true) : renderEmpty(msg('noProfiles', 'No profiles'), msg('noProfilesText', 'No profiles are available.'))}</div></div></section>`;
  }

  function renderFieldsAdmin() {
    return `<section class="panel directory-admin-panel"><div class="directory-admin-head"><div><h2>${msg('fields', 'Fields')}</h2><p class="hint">${msg('fieldsAdminHint', 'Configure additional profile attributes and their default visibility.')}</p></div></div><form id="directoryFieldForm" class="directory-settings-form compact"><input name="id" type="hidden"><div class="directory-form-grid"><label>${msg('fieldName', 'Field name')}<span class="hint">${msg('fieldNameHint', 'Label shown on profile forms and detail pages.')}</span><input name="name" required></label><label>${msg('fieldType', 'Field type')}<span class="hint">${msg('fieldTypeHint', 'Controls the input used for this profile attribute.')}</span><select name="field_type">${['text', 'textarea', 'url', 'email', 'phone', 'select', 'multi_select'].map((type) => `<option value="${type}">${type}</option>`).join('')}</select></label><label>${msg('sortOrder', 'Sort order')}<span class="hint">${msg('sortOrderHint', 'Lower numbers appear first.')}</span><input name="sort_order" type="number" value="0"></label><label>${msg('visibilityDefault', 'Default visibility')}<span class="hint">${msg('visibilityDefaultHint', 'Users can override it per field value.')}</span><select name="visibility_default">${visibilityOptions('members')}</select></label><label class="check directory-check"><input name="is_required" type="checkbox"><span>${msg('requiredField', 'Required field')}</span></label></div><div class="directory-form-actions"><button class="button ghost" type="button" data-reset-field>${msg('newField', 'New field')}</button><button class="button primary" type="submit">${msg('saveField', 'Save field')}</button></div></form><div class="directory-admin-list">${state.support.fields.map((field) => `<article class="directory-admin-row" data-edit-field="${field.id}"><span><strong>${esc(field.name)}</strong><small>${esc(field.fieldType)} · ${esc(field.visibilityDefault)}</small></span><button class="button small danger" type="button" data-delete-field="${field.id}">${msg('delete', 'Delete')}</button></article>`).join('') || renderEmpty(msg('noCustomFields', 'No custom fields'), msg('noCustomFieldsText', 'Create fields to collect profile-specific information.'))}</div></section>`;
  }

  function renderSkillsAdmin() {
    return `<section class="panel directory-admin-panel"><div class="directory-admin-head"><div><h2>${msg('skills', 'Skills')}</h2><p class="hint">${msg('skillsAdminHint', 'Manage reusable skills, interests and badges for profiles and forum cards.')}</p></div></div><form id="directorySkillForm" class="directory-settings-form compact"><input name="id" type="hidden"><label>${msg('skillName', 'Skill name')}<span class="hint">${msg('skillNameHint', 'Appears as a badge on profiles and forum posts.')}</span><input name="name" required></label><div class="directory-form-actions"><button class="button ghost" type="button" data-reset-skill>${msg('newSkill', 'New skill')}</button><button class="button primary" type="submit">${msg('saveSkill', 'Save skill')}</button></div></form><div class="directory-admin-list">${state.support.skills.map((skill) => `<article class="directory-admin-row" data-edit-skill="${skill.id}"><span class="directory-skill-pill">${esc(skill.name)}</span><button class="button small danger" type="button" data-delete-skill="${skill.id}">${msg('delete', 'Delete')}</button></article>`).join('') || renderEmpty(msg('noSkills', 'No skills'), msg('noSkillsText', 'Create skills to enrich profile cards.'))}</div></section>`;
  }

  function renderPermissionsAdmin() {
    return `<section class="panel directory-admin-panel"><div class="panel-head"><div><h2>${msg('permissions', 'Permissions')}</h2><p class="hint">${msg('permissionsAdminHint', 'Assign directory capabilities to Atlas roles. Admin users keep full access automatically.')}</p></div><button class="button primary" type="button" data-save-directory-permissions>${msg('savePermissions', 'Save permissions')}</button></div>${state.support.permissionKeys.map((key) => `<section class="permission-card"><div><strong>${esc(key)}</strong><p class="hint">${esc(permissionHint(key))}</p></div><div class="permission-grid compact">${state.support.roles.map((role) => `<label class="check"><input type="checkbox" data-directory-permission="${esc(key)}" value="${esc(role.name)}" ${(state.support.permissions[key] || []).includes(role.name) ? 'checked' : ''}><span>${esc(role.name)}</span></label>`).join('')}</div></section>`).join('')}</section>`;
  }

  function bindAdminActions() {
    document.querySelectorAll('[data-load-profile]').forEach((button) => button.addEventListener('click', () => {
      const profile = state.support.profiles.find((item) => item.userId === Number(button.dataset.loadProfile));
      document.querySelector('#directoryAdminProfileEditor').innerHTML = renderProfileEditor(profile, true);
      bindProfileForm();
    }));
    bindProfileForm();
    document.querySelector('#directoryFieldForm')?.addEventListener('submit', saveField);
    document.querySelector('#directorySkillForm')?.addEventListener('submit', saveSkill);
    document.querySelectorAll('[data-edit-field]').forEach((row) => row.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete-field]')) return;
      fillFieldForm(state.support.fields.find((field) => field.id === Number(row.dataset.editField)));
    }));
    document.querySelectorAll('[data-edit-skill]').forEach((row) => row.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete-skill]')) return;
      fillSkillForm(state.support.skills.find((skill) => skill.id === Number(row.dataset.editSkill)));
    }));
    document.querySelectorAll('[data-delete-field]').forEach((button) => button.addEventListener('click', () => deleteAdminItem(`/api/admin/directory/fields/${button.dataset.deleteField}`)));
    document.querySelectorAll('[data-delete-skill]').forEach((button) => button.addEventListener('click', () => deleteAdminItem(`/api/admin/directory/skills/${button.dataset.deleteSkill}`)));
    document.querySelector('[data-save-directory-permissions]')?.addEventListener('click', savePermissions);
    document.querySelector('[data-reset-field]')?.addEventListener('click', () => document.querySelector('#directoryFieldForm')?.reset());
    document.querySelector('[data-reset-skill]')?.addEventListener('click', () => document.querySelector('#directorySkillForm')?.reset());
  }

  function fillFieldForm(field) {
    const form = document.querySelector('#directoryFieldForm');
    form.elements.id.value = field.id;
    form.elements.name.value = field.name;
    form.elements.field_type.value = field.fieldType;
    form.elements.sort_order.value = field.sortOrder || 0;
    form.elements.visibility_default.value = field.visibilityDefault || 'members';
    form.elements.is_required.checked = Boolean(field.isRequired);
  }

  function fillSkillForm(skill) {
    const form = document.querySelector('#directorySkillForm');
    form.elements.id.value = skill.id;
    form.elements.name.value = skill.name;
  }

  async function saveField(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await fetchJson('/api/admin/directory/fields', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ id: form.elements.id.value || undefined, name: form.elements.name.value, field_type: form.elements.field_type.value, sort_order: form.elements.sort_order.value, visibility_default: form.elements.visibility_default.value, is_required: form.elements.is_required.checked }) });
    await loadAdmin();
  }

  async function saveSkill(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await fetchJson('/api/admin/directory/skills', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ id: form.elements.id.value || undefined, name: form.elements.name.value }) });
    await loadAdmin();
  }

  async function deleteAdminItem(url) {
    if (!confirm(msg('deleteConfirm', 'Delete this item?'))) return;
    await fetchJson(url, { method: 'DELETE' });
    await loadAdmin();
  }

  async function savePermissions() {
    const permissions = {};
    state.support.permissionKeys.forEach((key) => { permissions[key] = []; });
    document.querySelectorAll('[data-directory-permission]:checked').forEach((input) => permissions[input.dataset.directoryPermission].push(input.value));
    await fetchJson('/api/admin/directory/permissions', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ permissions }) });
    await loadAdmin();
  }

  function setOptions(selector, items, valueKey, labelKey, emptyLabel, selected = '') {
    const select = document.querySelector(selector);
    if (select) select.innerHTML = `<option value="">${esc(emptyLabel)}</option>${items.map((item) => `<option value="${esc(item[valueKey])}" ${String(item[valueKey]) === String(selected) ? 'selected' : ''}>${esc(item[labelKey])}</option>`).join('')}`;
  }

  function setSimpleOptions(selector, items, emptyLabel, selected = '') {
    const select = document.querySelector(selector);
    if (select) select.innerHTML = `<option value="">${esc(emptyLabel)}</option>${items.map((item) => `<option value="${esc(item)}" ${String(item) === String(selected) ? 'selected' : ''}>${esc(item)}</option>`).join('')}`;
  }

  function renderAvatar(profile) {
    const initials = (profile.displayName || profile.user?.name || '?').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
    return `<span class="directory-avatar">${profile.avatarUrl ? `<img src="${esc(profile.avatarUrl)}" alt="">` : esc(initials)}</span>`;
  }

  function visibilityOptions(selected = 'members') {
    return ['public', 'members', 'private'].map((value) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${esc(msg(`visibility_${value}`, value))}</option>`).join('');
  }

  function inputType(type) {
    return ({ url: 'url', email: 'email', phone: 'tel' })[type] || 'text';
  }

  function formatFieldValue(field) {
    if (field.fieldType === 'url') return `<a href="${esc(field.value)}" target="_blank" rel="noreferrer">${esc(field.value)}</a>`;
    if (field.fieldType === 'email') return `<a href="mailto:${esc(field.value)}">${esc(field.value)}</a>`;
    if (field.fieldType === 'phone') return `<a href="tel:${esc(field.value)}">${esc(field.value)}</a>`;
    return esc(field.value);
  }

  function permissionHint(key) {
    return ({
      'directory.view': msg('directoryViewHint', 'May browse visible profiles and member fields.'),
      'directory.view_private_fields': msg('directoryViewPrivateHint', 'May view fields marked private.'),
      'directory.edit_own': msg('directoryEditOwnHint', 'May edit their own profile.'),
      'directory.manage_profiles': msg('directoryManageProfilesHint', 'May edit all user profiles.'),
      'directory.manage_fields': msg('directoryManageFieldsHint', 'May manage custom fields, skills and permissions.')
    })[key] || key;
  }

  function renderEmpty(title, text) {
    return `<div class="empty-state"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
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

  function esc(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
})();
