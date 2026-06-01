import { join } from 'node:path';

const FORM_PERMISSION_KEYS = ['manage', 'view', 'evaluate', 'submit'];
const FORM_FIELD_TYPES = new Set(['text', 'textarea', 'email', 'select', 'date', 'number', 'checkbox', 'divider']);
const FORM_SUBMISSION_STATUSES = new Set(['submitted', 'in_review', 'approved', 'rejected']);

export default function createFormsPlugin({ manifest, rootDir }) {
  let db = null;
  let helpers = null;

  const feature = {
    key: manifest.key || 'forms',
    label: manifest.name || 'Forms',
    href: '/forms',
    description: manifest.description || 'Configurable request and workflow forms with per-form access, submissions and evaluation.',
    defaultEnabled: true
  };

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    adminPage: {
      href: '/admin/forms',
      label: manifest.name || 'Forms'
    },
    init(context) {
      db = context.db;
      helpers = context;
      db.exec(`
        CREATE TABLE IF NOT EXISTS forms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          intro_text TEXT NOT NULL DEFAULT '',
          creator_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'active',
          permissions_json TEXT NOT NULL DEFAULT '{}',
          fields_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS form_submissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
          submitter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          submitter_name TEXT NOT NULL DEFAULT '',
          submitter_email TEXT NOT NULL DEFAULT '',
          values_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'submitted',
          notes TEXT NOT NULL DEFAULT '',
          reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
    resetToFactoryDefaults(context) {
      context.db.exec(`
        DELETE FROM form_submissions;
        DELETE FROM forms;
        DELETE FROM sqlite_sequence WHERE name IN ('forms', 'form_submissions');
      `);
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/forms' && req.method === 'GET') {
        context.requireAdmin(user, res, () => context.sendJson(res, 200, getFormAdminTree()));
        return true;
      }
      if (url.pathname === '/api/admin/forms/form' && req.method === 'GET') {
        context.requireAdmin(user, res, () => handleGetAdminForm(context));
        return true;
      }
      if (url.pathname === '/api/admin/forms/form' && req.method === 'POST') {
        context.requireAdmin(user, res, () => handleSaveAdminForm(context));
        return true;
      }
      if (url.pathname.startsWith('/api/admin/forms/form/') && req.method === 'DELETE') {
        context.requireAdmin(user, res, () => handleDeleteAdminForm(context));
        return true;
      }

      if (url.pathname === '/api/forms' && req.method === 'GET') {
        if (!context.isPluginEnabled(feature.key)) return context.sendJson(res, 404, { error: context.tf(locale, 'formsFeatureDisabled', 'This feature is currently disabled.') });
        context.sendJson(res, 200, listFormsForUser(user));
        return true;
      }
      if (url.pathname === '/api/forms/form' && req.method === 'GET') {
        if (!context.isPluginEnabled(feature.key)) return context.sendJson(res, 404, { error: context.tf(locale, 'formsFeatureDisabled', 'This feature is currently disabled.') });
        handleGetPublicForm(context);
        return true;
      }
      if (url.pathname === '/api/forms/form/submit' && req.method === 'POST') {
        if (!context.isPluginEnabled(feature.key)) return context.sendJson(res, 404, { error: context.tf(locale, 'formsFeatureDisabled', 'This feature is currently disabled.') });
        await handleSubmitForm(context);
        return true;
      }
      if (url.pathname === '/api/forms/submissions' && req.method === 'GET') {
        if (!context.isPluginEnabled(feature.key)) return context.sendJson(res, 404, { error: context.tf(locale, 'formsFeatureDisabled', 'This feature is currently disabled.') });
        handleGetFormSubmissions(context);
        return true;
      }
      if (url.pathname === '/api/forms/submissions/review' && req.method === 'POST') {
        if (!context.isPluginEnabled(feature.key)) return context.sendJson(res, 404, { error: context.tf(locale, 'formsFeatureDisabled', 'This feature is currently disabled.') });
        await handleReviewFormSubmission(context);
        return true;
      }

      if (url.pathname === '/forms') {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'formsFeatureDisabledNotice', 'The forms feature is currently disabled.') }));
          return true;
        }
        context.sendHtml(res, 200, renderFormsPage(context));
        return true;
      }

      if (url.pathname === '/admin/forms') {
        context.requireAdmin(user, res, () => {
          context.sendHtml(res, 200, renderFormsAdminPage(context));
        });
        return true;
      }

      return false;
    }
  };

  function renderFormsPage(context) {
    const settings = context.getSettings();
    const featureCopy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell forms-page" data-forms-app>
        ${context.renderTopbar(context.user, context.locale, '/forms')}
        <div class="workspace">
          <aside class="sidebar" id="sidebar">
            <div class="sidebar-head">
              <span>${context.tf(context.locale, 'forms', 'Forms')}</span>
              <button class="icon-button mobile-only" data-sidebar-close aria-label="Close navigation">x</button>
            </div>
            <div id="formsNav" class="doc-nav"></div>
          </aside>
          <main class="content">
            <section class="policy">
              <div class="policy-header">
                <div>
                  <p class="eyebrow">${context.tf(context.locale, 'forms', 'Forms')}</p>
                  <h1>${context.tf(context.locale, 'workflowForms', 'Workflow forms')}</h1>
                  <p>${context.tf(context.locale, 'workflowFormsText', 'Submit structured requests, review incoming submissions and keep access aligned to the right people and groups.')}</p>
                </div>
                <dl class="meta-grid">
                  <div><dt>${context.tf(context.locale, 'featureType', 'Feature')}</dt><dd>${context.tf(context.locale, 'structuredForms', 'Structured forms')}</dd></div>
                  <div><dt>${context.tf(context.locale, 'access', 'Access')}</dt><dd>${context.tf(context.locale, 'perFormAccess', 'Per-form access')}</dd></div>
                  <div><dt>${context.tf(context.locale, 'management', 'Management')}</dt><dd>${context.user.is_admin ? context.tf(context.locale, 'manageViaAdmin', 'Manageable in admin portal') : context.tf(context.locale, 'roleBased', 'Role based')}</dd></div>
                </dl>
              </div>
              <div class="forms-layout">
                <div id="formsEmptyState" class="empty-state">
                  <h1>${context.tf(context.locale, 'loadingForms', 'Loading forms')}</h1>
                  <p>${context.tf(context.locale, 'loadingFormsText', 'Atlas is fetching the forms you can access.')}</p>
                </div>
                <div id="formDetailView" class="panel forms-detail-panel" hidden></div>
              </div>
            </section>
          </main>
        </div>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: featureCopy.label,
      body,
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'forms.js')],
      pluginKeys: [feature.key]
    });
  }

  function renderFormsAdminPage(context) {
    const settings = context.getSettings();
    const featureCopy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell">
        ${context.renderTopbar(context.user, context.locale, '/admin/forms')}
        <main class="admin-page" data-forms-admin-page>
          <div class="admin-header">
            <div>
              <h1>${context.escapeHtml(featureCopy.label)}</h1>
              <p class="hint">${context.escapeHtml(featureCopy.description)}</p>
            </div>
            <a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a>
          </div>
          <div id="formsAdminError" class="notice admin-error" hidden></div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <section class="admin-grid">
            <div class="panel content-nav-panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'forms', 'Forms')}</h2>
                <div class="panel-head-actions">
                  <button class="button" data-new-form type="button">${context.tf(context.locale, 'createForm', 'Create form')}</button>
                </div>
              </div>
              <div id="formsTree" class="content-tree"></div>
            </div>
            <div class="panel content-editor-panel form-detail-panel-admin">
              <div class="panel-head">
                <div class="panel-head-actions">
                  <button class="button ghost" id="backToFormsListButton" type="button" hidden>${context.tf(context.locale, 'back', 'Back')}</button>
                  <h2 id="formEditorTitle">${context.tf(context.locale, 'formEditor', 'Form editor')}</h2>
                </div>
                <div class="panel-head-actions">
                  <a class="button ghost" id="openLiveFormButton" href="/forms" hidden>${context.tf(context.locale, 'open', 'Open')} ${context.tf(context.locale, 'forms', 'Forms')}</a>
                </div>
              </div>
              <div class="content-editor-body">
                <div id="formEditorEmpty" class="empty-state content-empty-state">
                  <h1>${context.tf(context.locale, 'selectForm', 'Select a form')}</h1>
                  <p>${context.tf(context.locale, 'selectFormText', 'Create request and workflow forms, define fields, and configure who may view, submit or evaluate each form.')}</p>
                </div>
                <form id="formEditorForm" class="modal-form" hidden>
                  <input name="id" type="hidden">
                  <div class="content-meta">
                    <label>${context.tf(context.locale, 'formSlug', 'Form slug')} <input name="slug" required placeholder="user-request"></label>
                    <label>${context.tf(context.locale, 'title', 'Title')} <input name="title" required placeholder="User request"></label>
                    <label>${context.tf(context.locale, 'status', 'Status')}
                      <select name="status">
                        <option value="active">${context.tf(context.locale, 'active', 'Active')}</option>
                        <option value="archived">${context.tf(context.locale, 'archived', 'Archived')}</option>
                      </select>
                    </label>
                  </div>
                  <label>${context.tf(context.locale, 'description', 'Description')} <textarea name="description"></textarea></label>
                  <label>${context.tf(context.locale, 'introText', 'Intro text')} <textarea name="intro_text"></textarea></label>
                  <nav class="builder-subnav" aria-label="${context.tf(context.locale, 'formBuilderSections', 'Form builder sections')}">
                    <button class="admin-tab-button active" type="button" data-form-subtab="fields">${context.tf(context.locale, 'fields', 'Fields')}</button>
                    <button class="admin-tab-button" type="button" data-form-subtab="permissions">${context.tf(context.locale, 'permissions', 'Permissions')}</button>
                  </nav>
                  <div class="panel-inline-section" data-form-subpanel="fields">
                    <div class="panel-head compact">
                      <h2>${context.tf(context.locale, 'fields', 'Fields')}</h2>
                      <div class="panel-head-actions">
                        <button class="button" data-add-form-field type="button">${context.tf(context.locale, 'addField', 'Add field')}</button>
                        <button class="button" data-add-divider-field type="button">${context.tf(context.locale, 'addSectionDivider', 'Add section divider')}</button>
                      </div>
                    </div>
                    <div id="formFieldsEditor" class="form-fields-editor"></div>
                  </div>
                  <div id="formPermissionsEditor" class="form-permissions-editor" data-form-subpanel="permissions" hidden></div>
                  <div class="modal-actions">
                    <button class="button danger" id="deleteFormButton" type="button">${context.tf(context.locale, 'delete', 'Delete')}</button>
                    <button class="button primary" type="submit">${context.t(context.locale, 'save')}</button>
                  </div>
                </form>
              </div>
            </div>
          </section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: featureCopy.label,
      body,
      admin: false,
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'admin.js')],
      pluginKeys: [feature.key]
    });
  }

  function normalizeEmailList(values) {
    const list = Array.isArray(values) ? values : [values];
    return Array.from(new Set(list.flatMap((value) => String(value || '').split(/[,\n]/)).map((item) => item.trim().toLowerCase()).filter(Boolean)));
  }

  function normalizeFormPermissionEntry(value) {
    return {
      roles: helpers.normalizeRoleList(value?.roles || []),
      users: normalizeEmailList(value?.users || [])
    };
  }

  function normalizeFormPermissions(value) {
    const source = value && typeof value === 'object' ? value : {};
    const normalized = {};
    for (const key of FORM_PERMISSION_KEYS) normalized[key] = normalizeFormPermissionEntry(source[key]);
    return normalized;
  }

  function normalizeFormFieldKey(value, fallback = 'field') {
    const base = helpers.slugify(String(value || '').trim()) || helpers.slugify(fallback) || 'field';
    return base.replace(/-/g, '_');
  }

  function normalizeFormFieldVisibility(value) {
    const fieldKey = normalizeFormFieldKey(value?.fieldKey || value?.field_key || '', '');
    if (!fieldKey) return null;
    const mode = String(value?.mode || '').trim() === 'equals' ? 'equals' : 'filled';
    const expectedValue = mode === 'equals' ? String(value?.expectedValue ?? value?.expected_value ?? '').trim() : '';
    return { fieldKey, mode, expectedValue };
  }

  function normalizeFormFields(value) {
    const list = Array.isArray(value) ? value : [];
    const usedKeys = new Set();
    const normalized = [];
    for (const [index, field] of list.entries()) {
      const label = String(field?.label || '').trim();
      const type = FORM_FIELD_TYPES.has(String(field?.type || '').trim()) ? String(field.type).trim() : 'text';
      let key = type === 'divider'
        ? normalizeFormFieldKey(field?.key || label || `divider_${index + 1}`, `divider_${index + 1}`)
        : normalizeFormFieldKey(field?.key || label || `field_${index + 1}`, `field_${index + 1}`);
      while (usedKeys.has(key)) key = `${key}_${index + 1}`;
      usedKeys.add(key);
      normalized.push({
        key,
        label: label || (type === 'divider' ? 'Section' : helpers.titleFromSlug(key.replace(/_/g, '-'))),
        type,
        required: type === 'divider' ? false : Boolean(field?.required),
        placeholder: String(field?.placeholder || '').trim(),
        helpText: String(field?.helpText || '').trim(),
        options: type === 'select' ? normalizeTagList(field?.options || []) : [],
        visibility: normalizeFormFieldVisibility(field?.visibility)
      });
    }
    return normalized.map((field) => ({
      ...field,
      visibility: field.visibility && usedKeys.has(field.visibility.fieldKey) ? field.visibility : null
    }));
  }

  function normalizeTagList(values) {
    const list = Array.isArray(values) ? values : [values];
    return Array.from(new Set(list.flatMap((value) => String(value || '').split(/[,\n]/)).map((item) => item.trim()).filter(Boolean)));
  }

  function normalizeFormStatus(value) {
    return String(value || '').trim().toLowerCase() === 'archived' ? 'archived' : 'active';
  }

  function getFormRowBySlug(slug) {
    const value = String(slug || '').trim();
    if (!value) return null;
    return db.prepare(`
      SELECT f.*, u.name AS creator_name, u.email AS creator_email
      FROM forms f
      LEFT JOIN users u ON u.id = f.creator_user_id
      WHERE f.slug = ?
    `).get(value);
  }

  function getFormRowById(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    return db.prepare(`
      SELECT f.*, u.name AS creator_name, u.email AS creator_email
      FROM forms f
      LEFT JOIN users u ON u.id = f.creator_user_id
      WHERE f.id = ?
    `).get(numericId);
  }

  function normalizeFormRecord(row) {
    const permissions = normalizeFormPermissions(helpers.parseJsonObject(row.permissions_json, {}));
    const fields = normalizeFormFields(helpers.parseJsonObject(row.fields_json, []));
    const creator = row.creator_email ? { id: row.creator_user_id || null, name: row.creator_name || row.creator_email, email: row.creator_email } : null;
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description || '',
      introText: row.intro_text || '',
      status: normalizeFormStatus(row.status),
      permissions,
      fields,
      creator,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function listFormsAdmin() {
    return db.prepare(`
      SELECT f.*, u.name AS creator_name, u.email AS creator_email
      FROM forms f
      LEFT JOIN users u ON u.id = f.creator_user_id
      ORDER BY f.title, f.slug
    `).all().map(normalizeFormRecord);
  }

  function getFormBySlug(slug) {
    const row = getFormRowBySlug(slug);
    return row ? normalizeFormRecord(row) : null;
  }

  function getFormById(id) {
    const row = getFormRowById(id);
    return row ? normalizeFormRecord(row) : null;
  }

  function getSubmissionCountByFormId() {
    const rows = db.prepare('SELECT form_id, COUNT(*) AS count FROM form_submissions GROUP BY form_id').all();
    return new Map(rows.map((row) => [row.form_id, row.count]));
  }

  function canMatchFormPermission(user, scope) {
    if (!user) return false;
    if (user.is_admin) return true;
    if (Array.isArray(scope?.users) && scope.users.includes(String(user.email || '').toLowerCase())) return true;
    return Array.isArray(scope?.roles) && scope.roles.some((role) => user.roles.includes(role));
  }

  function isFormCreator(user, form) {
    return Boolean(user?.id && form?.creator?.id && Number(user.id) === Number(form.creator.id));
  }

  function canManageForm(user, form) {
    return Boolean(user?.is_admin || isFormCreator(user, form) || canMatchFormPermission(user, form.permissions.manage));
  }

  function canEvaluateForm(user, form) {
    return Boolean(canManageForm(user, form) || canMatchFormPermission(user, form.permissions.evaluate));
  }

  function canSubmitForm(user, form) {
    return Boolean(canManageForm(user, form) || canMatchFormPermission(user, form.permissions.submit));
  }

  function canViewForm(user, form) {
    return Boolean(canManageForm(user, form) || canEvaluateForm(user, form) || canSubmitForm(user, form) || canMatchFormPermission(user, form.permissions.view));
  }

  function listFormsForUser(user) {
    const submissionCounts = getSubmissionCountByFormId();
    return listFormsAdmin()
      .filter((form) => form.status === 'active')
      .map((form) => ({
        ...form,
        actions: {
          canManage: canManageForm(user, form),
          canView: canViewForm(user, form),
          canEvaluate: canEvaluateForm(user, form),
          canSubmit: canSubmitForm(user, form)
        },
        submissionCount: submissionCounts.get(form.id) || 0
      }))
      .filter((form) => form.actions.canView);
  }

  function getFormAdminTree() {
    const submissionCounts = getSubmissionCountByFormId();
    return {
      tree: listFormsAdmin().map((form) => ({
        id: form.id,
        slug: form.slug,
        title: form.title,
        status: form.status,
        submissionCount: submissionCounts.get(form.id) || 0,
        updatedAt: form.updatedAt
      }))
    };
  }

  function handleGetAdminForm(context) {
    const form = context.url.searchParams.get('slug') ? getFormBySlug(context.url.searchParams.get('slug')) : getFormById(context.url.searchParams.get('id'));
    if (!form) return context.sendJson(context.res, 404, { error: 'Form not found.' });
    context.sendJson(context.res, 200, form);
  }

  async function handleSaveAdminForm(context) {
    const payload = await context.readJson(context.req);
    const id = payload.id ? Number(payload.id) : null;
    const title = String(payload.title || '').trim();
    const slug = helpers.slugify(String(payload.slug || '').trim() || title);
    const description = String(payload.description || '').trim();
    const introText = String(payload.introText || payload.intro_text || '').trim();
    const status = normalizeFormStatus(payload.status);
    const permissions = normalizeFormPermissions(payload.permissions);
    const fields = normalizeFormFields(payload.fields);
    if (!title) return context.sendJson(context.res, 400, { error: 'A form title is required.' });
    if (!slug) return context.sendJson(context.res, 400, { error: 'A form slug is required.' });
    if (!fields.length) return context.sendJson(context.res, 400, { error: 'Please add at least one form field.' });
    const existingBySlug = getFormBySlug(slug);
    if (existingBySlug && (!id || existingBySlug.id !== id)) return context.sendJson(context.res, 400, { error: 'This slug is already in use.' });

    if (!id) {
      const result = db.prepare(`
        INSERT INTO forms (slug, title, description, intro_text, creator_user_id, status, permissions_json, fields_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(slug, title, description, introText, context.user.id, status, JSON.stringify(permissions), JSON.stringify(fields));
      return context.sendJson(context.res, 200, { ok: true, id: result.lastInsertRowid, slug });
    }

    const current = getFormById(id);
    if (!current) return context.sendJson(context.res, 404, { error: 'Form not found.' });
    db.prepare(`
      UPDATE forms
      SET slug = ?, title = ?, description = ?, intro_text = ?, status = ?, permissions_json = ?, fields_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(slug, title, description, introText, status, JSON.stringify(permissions), JSON.stringify(fields), id);
    context.sendJson(context.res, 200, { ok: true, id, slug });
  }

  function handleDeleteAdminForm(context) {
    const id = Number(context.url.pathname.split('/').pop());
    const current = getFormById(id);
    if (!current) return context.sendJson(context.res, 404, { error: 'Form not found.' });
    db.prepare('DELETE FROM forms WHERE id = ?').run(id);
    context.sendJson(context.res, 200, { ok: true });
  }

  function isFormFieldVisible(field, values) {
    if (!field?.visibility?.fieldKey) return true;
    if (!(field.visibility.fieldKey in values)) return true;
    const dependency = values[field.visibility.fieldKey];
    if (field.visibility.mode === 'equals') return String(dependency ?? '').trim() === String(field.visibility.expectedValue || '');
    if (typeof dependency === 'boolean') return dependency === true;
    return String(dependency ?? '').trim() !== '';
  }

  function validateSubmissionValue(field, rawValue) {
    if (field.type === 'divider') return '';
    if (field.type === 'checkbox') return Boolean(rawValue);
    const value = String(rawValue ?? '').trim();
    if (field.required && !value) throw new Error(`Please fill "${field.label}".`);
    if (!value) return '';
    if (field.type === 'select' && field.options.length && !field.options.includes(value)) throw new Error(`Please choose a valid option for "${field.label}".`);
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`Please enter a valid email for "${field.label}".`);
    if (field.type === 'number' && Number.isNaN(Number(value))) throw new Error(`Please enter a number for "${field.label}".`);
    return value;
  }

  function normalizeSubmissionValues(form, values) {
    const source = values && typeof values === 'object' ? values : {};
    const normalized = {};
    for (const field of form.fields) {
      const rawValue = source[field.key];
      if (!isFormFieldVisible(field, { ...source, ...normalized })) {
        normalized[field.key] = field.type === 'checkbox' ? false : '';
        continue;
      }
      normalized[field.key] = validateSubmissionValue(field, rawValue);
    }
    return normalized;
  }

  function normalizeSubmissionStatus(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return FORM_SUBMISSION_STATUSES.has(normalized) ? normalized : 'submitted';
  }

  function normalizeFormSubmissionRecord(row, form) {
    const values = helpers.parseJsonObject(row.values_json, {});
    return {
      id: row.id,
      formId: row.form_id,
      formSlug: form.slug,
      submitter: { id: row.submitter_user_id || null, name: row.submitter_name || row.submitter_email, email: row.submitter_email },
      status: normalizeSubmissionStatus(row.status),
      notes: row.notes || '',
      values: form.fields.filter((field) => field.type !== 'divider').map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        value: values[field.key] ?? (field.type === 'checkbox' ? false : ''),
        visibility: field.visibility || null
      })),
      reviewedBy: row.reviewer_email ? { id: row.reviewed_by_user_id || null, name: row.reviewer_name || row.reviewer_email, email: row.reviewer_email } : null,
      reviewedAt: row.reviewed_at || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function listFormSubmissions(form, user) {
    const rows = db.prepare(`
      SELECT s.*, reviewer.name AS reviewer_name, reviewer.email AS reviewer_email
      FROM form_submissions s
      LEFT JOIN users reviewer ON reviewer.id = s.reviewed_by_user_id
      WHERE s.form_id = ?
      ORDER BY s.created_at DESC, s.id DESC
    `).all(form.id);
    return rows.filter((row) => canEvaluateForm(user, form) || Number(row.submitter_user_id) === Number(user.id)).map((row) => normalizeFormSubmissionRecord(row, form));
  }

  function handleGetPublicForm(context) {
    const form = getFormBySlug(context.url.searchParams.get('slug'));
    if (!form || form.status !== 'active') return context.sendJson(context.res, 404, { error: 'Form not found.' });
    if (!canViewForm(context.user, form)) return context.sendJson(context.res, 403, { error: 'You do not have access to this form.' });
    context.sendJson(context.res, 200, {
      ...form,
      actions: {
        canManage: canManageForm(context.user, form),
        canView: canViewForm(context.user, form),
        canEvaluate: canEvaluateForm(context.user, form),
        canSubmit: canSubmitForm(context.user, form)
      }
    });
  }

  async function handleSubmitForm(context) {
    const payload = await context.readJson(context.req);
    const form = getFormBySlug(payload.slug);
    if (!form || form.status !== 'active') return context.sendJson(context.res, 404, { error: 'Form not found.' });
    if (!canSubmitForm(context.user, form)) return context.sendJson(context.res, 403, { error: 'You do not have permission to submit this form.' });
    const values = normalizeSubmissionValues(form, payload.values);
    const result = db.prepare(`
      INSERT INTO form_submissions (form_id, submitter_user_id, submitter_name, submitter_email, values_json, status, updated_at)
      VALUES (?, ?, ?, ?, ?, 'submitted', CURRENT_TIMESTAMP)
    `).run(form.id, context.user.id, context.user.name, context.user.email, JSON.stringify(values));
    context.sendJson(context.res, 200, { ok: true, submissionId: result.lastInsertRowid });
  }

  function handleGetFormSubmissions(context) {
    const form = getFormBySlug(context.url.searchParams.get('slug'));
    if (!form || form.status !== 'active') return context.sendJson(context.res, 404, { error: 'Form not found.' });
    if (!canViewForm(context.user, form)) return context.sendJson(context.res, 403, { error: 'You do not have access to this form.' });
    context.sendJson(context.res, 200, {
      form: { id: form.id, slug: form.slug, title: form.title },
      canEvaluate: canEvaluateForm(context.user, form),
      submissions: listFormSubmissions(form, context.user)
    });
  }

  async function handleReviewFormSubmission(context) {
    const payload = await context.readJson(context.req);
    const submissionId = Number(payload.submissionId);
    if (!Number.isInteger(submissionId) || submissionId <= 0) return context.sendJson(context.res, 400, { error: 'Submission not found.' });
    const row = db.prepare('SELECT form_id FROM form_submissions WHERE id = ?').get(submissionId);
    if (!row) return context.sendJson(context.res, 404, { error: 'Submission not found.' });
    const form = getFormById(row.form_id);
    if (!form) return context.sendJson(context.res, 404, { error: 'Form not found.' });
    if (!canEvaluateForm(context.user, form)) return context.sendJson(context.res, 403, { error: 'You do not have permission to review this submission.' });
    const status = normalizeSubmissionStatus(payload.status);
    const notes = String(payload.notes || '').trim();
    db.prepare(`
      UPDATE form_submissions
      SET status = ?, notes = ?, reviewed_by_user_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, notes, context.user.id, submissionId);
    context.sendJson(context.res, 200, { ok: true });
  }
}
