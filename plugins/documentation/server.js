import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

export default function createDocumentationPlugin({ manifest, rootDir }) {
  const feature = {
    key: manifest.key || 'documentation',
    label: manifest.name || 'Documentation',
    href: '/',
    description: manifest.description || 'Markdown-based knowledge base with categories, permissions and web editing.',
    defaultEnabled: true
  };

  let helpers = null;
  let catalog = emptyCatalog();

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    adminPage: {
      href: '/admin/documentation',
      label: manifest.name || 'Documentation'
    },
    init(context) {
      helpers = context;
      catalog = loadCatalog();
    },
    seedInitialData(context) {
      helpers = context;
      catalog = loadCatalog();
      if (catalog.policies.length) return;
      const gettingStartedDir = resolveDocsDirectory('getting-started');
      if (!existsSync(gettingStartedDir)) mkdirSync(gettingStartedDir, { recursive: true });
      writeCategoryMeta('getting-started', { label: 'Getting Started', position: 1, roles: [] });
      const pages = [
        {
          path: 'getting-started/index.md',
          meta: { title: 'Getting Started with Atlas', description: 'Demo documentation for the initial workspace.', owner: 'Atlas Team', version: '1.0', reviewDate: '2026-12-31', roles: [], position: 1 },
          markdown: '# Getting Started with Atlas\n\nThis sample documentation page shows how policies and guidance appear in the documentation plugin.\n\n## Explore the workspace\n\nUse the seeded tasks, forms, Q&A and changelog entries to understand how plugin data connects.'
        },
        {
          path: 'getting-started/security-baseline.md',
          meta: { title: 'Security Baseline', description: 'A short example policy page for demos.', owner: 'Security Team', version: '1.0', reviewDate: '2026-12-31', roles: [], position: 2 },
          markdown: '# Security Baseline\n\nReport suspicious activity quickly, keep access role-based, and document review outcomes where the team can find them.\n'
        }
      ];
      for (const page of pages) {
        const filePath = resolveDocsPath(page.path);
        if (existsSync(filePath)) continue;
        writeFileSync(filePath, context.ensureTrailingNewline(serializeEditablePage({ meta: page.meta, markdown: page.markdown })), 'utf8');
      }
      catalog = loadCatalog();
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if (url.pathname === '/api/admin/documentation/tree' && req.method === 'GET') {
        context.requireAdmin(user, res, () => context.sendJson(res, 200, getEditableContentTree()));
        return true;
      }
      if (url.pathname === '/api/admin/documentation/page' && req.method === 'GET') {
        context.requireAdmin(user, res, () => handleGetEditablePage(context));
        return true;
      }
      if (url.pathname === '/api/admin/documentation/page' && req.method === 'POST') {
        context.requireAdmin(user, res, async () => handleSaveEditablePage(context));
        return true;
      }
      if (url.pathname === '/api/admin/documentation/category' && req.method === 'GET') {
        context.requireAdmin(user, res, () => handleGetEditableCategory(context));
        return true;
      }
      if (url.pathname === '/api/admin/documentation/category' && req.method === 'POST') {
        context.requireAdmin(user, res, async () => handleSaveEditableCategory(context));
        return true;
      }
      if (url.pathname === '/api/admin/documentation/reload' && req.method === 'POST') {
        context.requireAdmin(user, res, () => {
          catalog = loadCatalog();
          context.sendJson(res, 200, { ok: true, policies: catalog.policies.length });
        });
        return true;
      }

      if (url.pathname === '/admin/documentation') {
        context.requireAdmin(user, res, () => context.sendHtml(res, 200, renderDocumentationAdminPage(context)));
        return true;
      }

      if (url.pathname === '/') {
        if (!context.isPluginEnabled(feature.key)) return false;
        context.sendHtml(res, 200, renderDocumentationApp(context, { activeSlug: null }));
        return true;
      }
      if (url.pathname.startsWith('/policy/')) {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'documentationFeatureDisabled', 'The documentation feature is currently disabled.') }));
          return true;
        }
        const slug = decodeURIComponent(url.pathname.slice('/policy/'.length));
        const policy = catalog.bySlug.get(slug);
        if (!policy) {
          context.sendHtml(res, 404, renderDocumentationApp(context, { activeSlug: null, notice: context.t(locale, 'notFoundPolicy') }));
          return true;
        }
        if (!canReadPolicy(user, policy)) {
          context.sendHtml(res, 403, renderDocumentationApp(context, { activeSlug: null, notice: context.t(locale, 'noPermission') }));
          return true;
        }
        context.sendHtml(res, 200, renderDocumentationApp(context, { activeSlug: slug, policy }));
        return true;
      }

      return false;
    }
  };

  function docsDir() {
    return join(helpers.ROOT, 'content', 'docs');
  }

  function homePath() {
    return join(helpers.ROOT, 'content', 'home.md');
  }

  function legacyPolicyDir() {
    return join(helpers.ROOT, 'content', 'policies');
  }

  function emptyCatalog() {
    return { policies: [], bySlug: new Map(), sidebar: [], home: null };
  }

  function loadCatalog() {
    const mainDocsDir = docsDir();
    const mainHomePath = homePath();
    helpers.logInfo(`Loading documentation catalog from ${mainDocsDir}`);
    const home = existsSync(mainHomePath) ? createPolicy(mainHomePath, '__home', []) : null;
    if (existsSync(mainDocsDir)) {
      const policies = [];
      const sidebar = scanDocsDirectory(mainDocsDir, '', [], policies).items;
      const bySlug = new Map(policies.map((policy) => [policy.slug, policy]));
      if (home) bySlug.set(home.slug, home);
      helpers.logInfo(`Documentation catalog loaded: ${policies.length} documents, ${sidebar.length} top-level sidebar entries`);
      return { policies, bySlug, sidebar, home };
    }

    const fallbackDir = legacyPolicyDir();
    const policies = existsSync(fallbackDir)
      ? readdirSync(fallbackDir)
        .filter((file) => file.endsWith('.md'))
        .map((file) => createPolicy(join(fallbackDir, file), file.replace(/\.md$/, ''), []))
        .sort((a, b) => a.title.localeCompare(b.title, 'de'))
      : [];
    const sidebarPath = join(helpers.ROOT, 'content', 'sidebar.json');
    const sidebar = existsSync(sidebarPath)
      ? JSON.parse(readFileSync(sidebarPath, 'utf8'))
      : policies.map((policy) => policy.slug);
    const bySlug = new Map(policies.map((policy) => [policy.slug, policy]));
    if (home) bySlug.set(home.slug, home);
    return { policies, bySlug, sidebar, home };
  }

  function scanDocsDirectory(dir, relativeDir, inheritedRoles, policies) {
    const categoryPath = join(dir, 'category.json');
    const category = existsSync(categoryPath) ? JSON.parse(readFileSync(categoryPath, 'utf8')) : {};
    const categoryRoles = Array.isArray(category.roles) ? category.roles : inheritedRoles;
    const entries = readdirSync(dir)
      .filter((entry) => !entry.startsWith('.') && entry !== 'category.json')
      .map((entry) => {
        const fullPath = join(dir, entry);
        return { entry, fullPath, isDirectory: statSync(fullPath).isDirectory() };
      })
      .sort((a, b) => {
        if (a.entry === 'index.md') return -1;
        if (b.entry === 'index.md') return 1;
        const positionDiff = getEntryPosition(a) - getEntryPosition(b);
        if (positionDiff !== 0) return positionDiff;
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.entry.localeCompare(b.entry, 'de');
      });

    const items = [];
    let categorySlug = '';

    for (const item of entries) {
      if (item.isDirectory) {
        const childRelative = relativeDir ? `${relativeDir}/${item.entry}` : item.entry;
        const child = scanDocsDirectory(item.fullPath, childRelative, categoryRoles, policies);
        if (child.items.length || child.categoryItem.slug) items.push(child.categoryItem);
        continue;
      }

      if (!item.entry.endsWith('.md')) continue;
      const basename = item.entry.replace(/\.md$/, '');
      const slug = basename === 'index' ? relativeDir : (relativeDir ? `${relativeDir}/${basename}` : basename);
      if (!slug) continue;
      const policy = createPolicy(item.fullPath, slug, categoryRoles);
      policies.push(policy);
      if (basename === 'index') categorySlug = slug;
      else items.push(slug);
    }

    const fallbackLabel = relativeDir ? helpers.titleFromSlug(relativeDir.split('/').pop()) : 'Documentation';
    return {
      items,
      categoryItem: {
        type: 'category',
        label: category.label || fallbackLabel,
        slug: categorySlug,
        roles: categoryRoles,
        items
      }
    };
  }

  function createPolicy(filePath, slug, inheritedRoles) {
    const raw = readFileSync(filePath, 'utf8');
    const { meta, markdown } = helpers.parseFrontmatter(raw);
    const rendered = helpers.markdownToHtml(markdown, slug);
    const roles = Array.isArray(meta.roles) ? meta.roles : inheritedRoles;
    return {
      slug,
      file: filePath,
      title: meta.title || helpers.titleFromSlug(slug.split('/').pop()),
      description: meta.description || '',
      roles,
      owner: meta.owner || '',
      version: meta.version || '',
      reviewDate: meta.reviewDate || '',
      html: rendered.html,
      headings: rendered.headings
    };
  }

  function getEntryPosition(item) {
    try {
      if (item.isDirectory) {
        const categoryPath = join(item.fullPath, 'category.json');
        if (!existsSync(categoryPath)) return 999;
        const category = JSON.parse(readFileSync(categoryPath, 'utf8'));
        return Number(category.position ?? category.sidebar_position ?? 999);
      }
      if (!item.entry.endsWith('.md')) return 999;
      const { meta } = helpers.parseFrontmatter(readFileSync(item.fullPath, 'utf8'));
      return Number(meta.position ?? meta.sidebar_position ?? 999);
    } catch {
      return 999;
    }
  }

  function renderDocumentationApp(context, { activeSlug, policy = null, notice = '' } = {}) {
    const settings = context.getSettings();
    const readable = catalog.policies.filter((item) => canReadPolicy(context.user, item));
    const current = policy || catalog.home || readable[0];
    const active = activeSlug || (policy ? policy.slug : '__home');
    const currentHref = policy ? `/policy/${encodeURIComponent(policy.slug)}` : '/';
    const body = `
      <div class="app-shell">
        ${context.renderTopbar(context.user, context.locale, currentHref)}
        <div class="workspace">
          <aside class="sidebar" id="sidebar">
            <div class="sidebar-head">
              <span>${context.escapeHtml(settings.sidebar_title)}</span>
              <button class="icon-button mobile-only" data-sidebar-close aria-label="Close navigation">x</button>
            </div>
            <nav class="doc-nav">${renderSidebar(catalog.sidebar, context.user, active)}</nav>
          </aside>
          <main class="content">
            ${notice ? `<div class="notice">${context.escapeHtml(notice)}</div>` : ''}
            ${current ? renderPolicy(context, current) : renderEmptyState(context)}
          </main>
        </div>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: current?.title || settings.app_name, body, settings, locale: context.locale, pluginKeys: [feature.key] });
  }

  function renderDocumentationAdminPage(context) {
    const settings = context.getSettings();
    const featureCopy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell">
        ${context.renderTopbar(context.user, context.locale, '/admin/documentation')}
        <main class="admin-page" data-documentation-admin-page>
          <div class="admin-header">
            <div>
              <h1>${context.escapeHtml(featureCopy.label)}</h1>
              <p class="hint">${context.escapeHtml(featureCopy.description)}</p>
            </div>
            <div class="panel-head-actions">
              <button class="button" id="reloadDocumentationButton" type="button">${context.t(context.locale, 'reloadMarkdown')}</button>
              <a class="button ghost" href="/admin">${context.tf(context.locale, 'admin', 'Admin')}</a>
            </div>
          </div>
          <div id="documentationAdminError" class="notice admin-error" hidden></div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <section class="admin-grid">
            <div class="panel content-nav-panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'documentation', 'Documentation')}</h2>
                <div class="panel-head-actions">
                  <button class="button" data-new-category type="button">${context.tf(context.locale, 'createCategory', 'Create category')}</button>
                  <button class="button" data-new-page type="button">${context.tf(context.locale, 'createPage', 'Create page')}</button>
                </div>
              </div>
              <div id="documentationTree" class="content-tree"></div>
            </div>
            <div class="panel content-editor-panel documentation-detail-panel-admin">
              <div class="panel-head">
                <div class="panel-head-actions">
                  <button class="button ghost" id="backToDocumentationListButton" type="button" hidden>${context.tf(context.locale, 'back', 'Back')}</button>
                  <h2 id="documentationEditorTitle">${context.tf(context.locale, 'contentEditor', 'Editor')}</h2>
                </div>
                <div class="panel-head-actions">
                  <a class="button ghost" id="openLiveDocumentationButton" href="/" hidden>${context.tf(context.locale, 'open', 'Open')} ${context.tf(context.locale, 'documentation', 'Documentation')}</a>
                </div>
              </div>
              <div class="content-editor-body">
                <div id="documentationEditorEmpty" class="empty-state content-empty-state">
                  <h1>${context.tf(context.locale, 'selectContentEntry', 'Select a page or category')}</h1>
                  <p>${context.tf(context.locale, 'selectContentEntryText', 'Admins can edit raw Markdown here and create new content without opening a file editor.')}</p>
                </div>
                <form id="documentationPageEditorForm" class="modal-form" hidden>
                  <input name="slug" type="hidden">
                  <input name="extra_meta" type="hidden">
                  <div class="content-meta">
                    <label>${context.tf(context.locale, 'pageSlug', 'Page slug')} <input name="display_slug" readonly></label>
                    <label>${context.tf(context.locale, 'filePath', 'File path')} <input name="relative_path" readonly></label>
                  </div>
                  <div class="content-meta">
                    <label>${context.tf(context.locale, 'title', 'Title')} <input name="title"></label>
                    <label>${context.tf(context.locale, 'description', 'Description')} <input name="description"></label>
                    <label>${context.tf(context.locale, 'owner', 'Owner')} <input name="owner"></label>
                    <label>${context.tf(context.locale, 'version', 'Version')} <input name="version"></label>
                    <label>${context.tf(context.locale, 'review', 'Review date')} <input name="reviewDate" placeholder="2026-12-31"></label>
                    <label>${context.tf(context.locale, 'position', 'Position')} <input name="position" type="number" step="1" value="999"></label>
                    <label>${context.tf(context.locale, 'rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Admins, Users"></label>
                  </div>
                  <label>${context.tf(context.locale, 'rawMarkdown', 'Raw Markdown')}
                    <textarea name="markdown" class="code-input content-raw-input" spellcheck="false"></textarea>
                  </label>
                  <div class="modal-actions">
                    <button class="button primary" type="submit">${context.t(context.locale, 'save')}</button>
                  </div>
                </form>
                <form id="documentationCategoryEditorForm" class="modal-form" hidden>
                  <input name="relative_dir" type="hidden">
                  <div class="content-meta">
                    <label>${context.tf(context.locale, 'categoryPath', 'Category path')} <input name="display_dir" readonly></label>
                    <label>${context.tf(context.locale, 'categoryConfigPath', 'Config file')} <input name="config_path" readonly></label>
                  </div>
                  <label>${context.tf(context.locale, 'label', 'Label')} <input name="label" required></label>
                  <label>${context.tf(context.locale, 'position', 'Position')} <input name="position" type="number" step="1" value="999"></label>
                  <label>${context.tf(context.locale, 'rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Admins, Users"></label>
                  <div class="modal-actions">
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
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'admin.js')],
      pluginKeys: [feature.key]
    });
  }

  function renderSidebar(items, user, activeSlug) {
    return items.map((item) => {
      if (typeof item === 'string') {
        const policy = catalog.bySlug.get(item);
        if (!policy || !canReadPolicy(user, policy)) return '';
        return `<a class="nav-link ${activeSlug === policy.slug ? 'active' : ''}" href="/policy/${encodeURIComponent(policy.slug)}">${helpers.escapeHtml(policy.title)}</a>`;
      }
      const categoryPolicy = item.slug ? catalog.bySlug.get(item.slug) : null;
      const canSeeCategory = !categoryPolicy || canReadPolicy(user, categoryPolicy);
      const children = renderSidebar(item.items || [], user, activeSlug);
      if (!canSeeCategory && !children.trim()) return '';
      const isActive = categoryPolicy && activeSlug === categoryPolicy.slug;
      const containsActive = sidebarContainsActive(item.items || [], activeSlug);
      const title = categoryPolicy && canSeeCategory
        ? `<a class="nav-category-link ${isActive ? 'active' : ''}" href="/policy/${encodeURIComponent(categoryPolicy.slug)}">${helpers.escapeHtml(item.label || categoryPolicy.title)}</a>`
        : `<span class="nav-category-label">${helpers.escapeHtml(item.label || 'Category')}</span>`;
      return `
        <section class="nav-group ${containsActive || isActive ? 'active-group' : ''}">
          <div class="nav-group-title">
            ${title}
            <button class="nav-caret" data-toggle-section type="button" aria-label="Collapse category"></button>
          </div>
          <div class="nav-group-items">${children}</div>
        </section>
      `;
    }).join('');
  }

  function renderPolicy(context, policy) {
    const breadcrumbs = findBreadcrumbs(catalog.sidebar, policy.slug);
    const editLinks = context.user?.is_admin ? renderPolicyAdminActions(context, policy) : '';
    return `
      <article class="policy">
        ${renderBreadcrumbs(breadcrumbs, policy)}
        <div class="policy-header">
          <div>
            ${editLinks}
            <h1>${helpers.escapeHtml(policy.title)}</h1>
            <p>${helpers.escapeHtml(policy.description)}</p>
          </div>
          <dl class="meta-grid">
            <div><dt>${context.t(context.locale, 'version')}</dt><dd>${helpers.escapeHtml(policy.version || '-')}</dd></div>
            <div><dt>${context.t(context.locale, 'review')}</dt><dd>${helpers.escapeHtml(policy.reviewDate || '-')}</dd></div>
            <div><dt>${context.t(context.locale, 'access')}</dt><dd>${renderRolePills(policy.roles) || context.t(context.locale, 'all')}</dd></div>
          </dl>
        </div>
        <div class="policy-body">
          <div class="markdown-body">${policy.html}</div>
          ${renderToc(policy)}
        </div>
      </article>
    `;
  }

  function renderPolicyAdminActions(context, policy) {
    const actions = [
      `<a class="button ghost policy-admin-button" href="/admin/documentation?page=${encodeURIComponent(policy.slug)}">${context.tf(context.locale, 'editPage', 'Edit page')}</a>`
    ];
    const categoryDir = getCategoryDirFromPolicySlug(policy.slug);
    if (categoryDir) {
      actions.push(`<a class="button ghost policy-admin-button" href="/admin/documentation?dir=${encodeURIComponent(categoryDir)}">${context.tf(context.locale, 'editCategory', 'Edit category')}</a>`);
    }
    return `<div class="policy-admin-actions">${actions.join('')}</div>`;
  }

  function renderBreadcrumbs(breadcrumbs, policy) {
    const trail = breadcrumbs.length ? breadcrumbs : [{ label: policy.title, href: `/policy/${encodeURIComponent(policy.slug)}` }];
    return `
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <a class="crumb-home-icon" href="/" aria-label="Home">💠</a>
        ${trail.map((item, index) => `
          <span class="crumb-separator">›</span>
          <a class="${index === trail.length - 1 ? 'current' : ''}" href="${helpers.escapeHtml(item.href)}">${helpers.escapeHtml(item.label)}</a>
        `).join('')}
      </nav>
    `;
  }

  function renderToc(policy) {
    if (!policy.headings?.length) return '';
    return `
      <aside class="toc" aria-label="Table of contents">
        ${policy.headings.map((heading) => `<a class="toc-level-${heading.level}" href="#${helpers.escapeHtml(heading.id)}">${helpers.escapeHtml(heading.text)}</a>`).join('')}
      </aside>
    `;
  }

  function renderEmptyState(context) {
    return `
      <section class="empty-state">
        <h1>${context.t(context.locale, 'noPolicies')}</h1>
        <p>${context.t(context.locale, 'noPoliciesText')}</p>
      </section>
    `;
  }

  function sidebarContainsActive(items, activeSlug) {
    for (const item of items) {
      if (typeof item === 'string') {
        if (item === activeSlug) return true;
        continue;
      }
      if (item.slug === activeSlug || sidebarContainsActive(item.items || [], activeSlug)) return true;
    }
    return false;
  }

  function findBreadcrumbs(items, activeSlug, trail = []) {
    for (const item of items) {
      if (typeof item === 'string') {
        const policy = catalog.bySlug.get(item);
        if (item === activeSlug && policy) return [...trail, { label: policy.title, href: `/policy/${encodeURIComponent(policy.slug)}` }];
        continue;
      }
      const categoryPolicy = item.slug ? catalog.bySlug.get(item.slug) : null;
      const nextTrail = categoryPolicy
        ? [...trail, { label: item.label || categoryPolicy.title, href: `/policy/${encodeURIComponent(categoryPolicy.slug)}` }]
        : [...trail, { label: item.label || 'Category', href: '#' }];
      if (item.slug === activeSlug) return nextTrail;
      const found = findBreadcrumbs(item.items || [], activeSlug, nextTrail);
      if (found.length) return found;
    }
    return [];
  }

  function canReadPolicy(user, policy) {
    if (user?.is_admin) return true;
    if (!policy.roles.length) return true;
    return policy.roles.some((role) => user.roles.includes(role));
  }

  function renderRolePills(roleNames = []) {
    return roleNames.map((role) => `<span class="role-pill">${helpers.escapeHtml(role)}</span>`).join('');
  }

  function getCategoryDirFromPolicySlug(slug) {
    const value = String(slug || '').trim();
    if (!value || value === '__home') return '';
    const parts = value.split('/').filter(Boolean);
    if (parts.length === 1) return '';
    return parts.slice(0, -1).join('/');
  }

  function getEditableContentTree() {
    const directories = [{ relativeDir: '', label: 'Documentation root' }];
    const docs = existsSync(docsDir()) ? scanEditableDocsDirectory(docsDir(), '', directories) : [];
    return {
      tree: [
        { type: 'page', slug: '__home', title: 'Home', relativePath: 'home.md' },
        ...docs
      ],
      directories
    };
  }

  function scanEditableDocsDirectory(dir, relativeDir, directories) {
    const categoryMeta = readCategoryMeta(relativeDir);
    const label = categoryMeta.label || helpers.titleFromSlug(relativeDir.split('/').pop() || 'docs');
    if (!directories.some((item) => item.relativeDir === relativeDir)) {
      directories.push({ relativeDir, label });
    }

    const entries = readdirSync(dir)
      .filter((entry) => !entry.startsWith('.') && entry !== 'category.json')
      .map((entry) => {
        const fullPath = join(dir, entry);
        return { entry, fullPath, isDirectory: statSync(fullPath).isDirectory() };
      })
      .sort((a, b) => {
        if (a.entry === 'index.md') return -1;
        if (b.entry === 'index.md') return 1;
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.entry.localeCompare(b.entry, 'de');
      });

    const children = [];
    for (const item of entries) {
      if (item.isDirectory) {
        const childRelative = relativeDir ? `${relativeDir}/${item.entry}` : item.entry;
        children.push({
          type: 'category',
          relativeDir: childRelative,
          label: readCategoryMeta(childRelative).label || helpers.titleFromSlug(item.entry),
          children: scanEditableDocsDirectory(item.fullPath, childRelative, directories)
        });
        continue;
      }

      if (!item.entry.endsWith('.md')) continue;
      const basename = item.entry.replace(/\.md$/i, '');
      const slug = basename === 'index' ? relativeDir : (relativeDir ? `${relativeDir}/${basename}` : basename);
      if (!slug) continue;
      const policy = catalog.bySlug.get(slug);
      children.push({
        type: 'page',
        slug,
        title: policy?.title || helpers.titleFromSlug(basename === 'index' ? relativeDir.split('/').pop() || 'index' : basename),
        relativePath: toContentRelativePath(item.fullPath)
      });
    }
    return children;
  }

  function handleGetEditablePage(context) {
    const slug = String(context.url.searchParams.get('slug') || '').trim();
    const page = getEditablePage(slug);
    if (!page) return context.sendJson(context.res, 404, { error: 'Page not found.' });
    context.sendJson(context.res, 200, page);
  }

  async function handleSaveEditablePage(context) {
    const payload = await context.readJson(context.req);
    const mode = payload.mode === 'create' ? 'create' : 'update';
    const meta = normalizeEditablePageMeta(payload);
    const markdown = String(payload.markdown || '');

    if (mode === 'create') {
      const parentDir = sanitizeRelativeDir(payload.parentDir);
      const asIndex = payload.asIndex === true;
      const slugSegment = sanitizeSlugSegment(payload.slug);
      if (asIndex && !parentDir) return context.sendJson(context.res, 400, { error: 'A root index page is not supported.' });
      if (!asIndex && !slugSegment) return context.sendJson(context.res, 400, { error: 'A page slug is required.' });

      const targetDir = resolveDocsDirectory(parentDir);
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      const fileName = asIndex ? 'index.md' : `${slugSegment}.md`;
      const filePath = resolveDocsPath(parentDir ? `${parentDir}/${fileName}` : fileName);
      if (existsSync(filePath)) return context.sendJson(context.res, 409, { error: 'This page already exists.' });

      if (!meta.title) meta.title = helpers.titleFromSlug(asIndex ? parentDir.split('/').pop() || 'index' : slugSegment);
      const initialRaw = serializeEditablePage({
        meta,
        extraMeta: normalizeExtraMeta(payload.extraMeta),
        markdown: markdown.trim() || `# ${meta.title}\n\nWrite your content here.\n`
      });
      writeFileSync(filePath, context.ensureTrailingNewline(initialRaw), 'utf8');
      catalog = loadCatalog();
      const slug = asIndex ? parentDir : (parentDir ? `${parentDir}/${slugSegment}` : slugSegment);
      return context.sendJson(context.res, 200, { ok: true, slug });
    }

    const slug = String(payload.slug || '').trim();
    const page = getEditablePage(slug);
    if (!page) return context.sendJson(context.res, 404, { error: 'Page not found.' });
    const nextRaw = serializeEditablePage({
      meta,
      extraMeta: normalizeExtraMeta(payload.extraMeta),
      markdown
    });
    writeFileSync(page.filePath, context.ensureTrailingNewline(nextRaw), 'utf8');
    catalog = loadCatalog();
    context.sendJson(context.res, 200, { ok: true, slug });
  }

  function handleGetEditableCategory(context) {
    const relativeDir = sanitizeRelativeDir(context.url.searchParams.get('dir') || '');
    const directoryPath = resolveDocsDirectory(relativeDir);
    if (!existsSync(directoryPath)) return context.sendJson(context.res, 404, { error: 'Category not found.' });

    const meta = readCategoryMeta(relativeDir);
    context.sendJson(context.res, 200, {
      relativeDir,
      label: meta.label || helpers.titleFromSlug(relativeDir.split('/').pop() || 'docs'),
      position: Number(meta.position ?? meta.sidebar_position ?? 999),
      roles: Array.isArray(meta.roles) ? meta.roles : [],
      configPath: toContentRelativePath(join(directoryPath, 'category.json'))
    });
  }

  async function handleSaveEditableCategory(context) {
    const payload = await context.readJson(context.req);
    const mode = payload.mode === 'create' ? 'create' : 'update';

    if (mode === 'create') {
      const parentDir = sanitizeRelativeDir(payload.parentDir);
      const slugSegment = sanitizeSlugSegment(payload.slug);
      if (!slugSegment) return context.sendJson(context.res, 400, { error: 'A category slug is required.' });
      const relativeDir = parentDir ? `${parentDir}/${slugSegment}` : slugSegment;
      const directoryPath = resolveDocsDirectory(relativeDir);
      if (existsSync(directoryPath)) return context.sendJson(context.res, 409, { error: 'This category already exists.' });
      mkdirSync(directoryPath, { recursive: true });

      const label = String(payload.label || '').trim() || helpers.titleFromSlug(slugSegment);
      writeCategoryMeta(relativeDir, {
        label,
        position: Number(payload.position ?? 999),
        roles: helpers.normalizeRoleList(payload.roles)
      });

      if (payload.createIndex === true) {
        const indexPath = resolveDocsPath(`${relativeDir}/index.md`);
        const indexTitle = String(payload.indexTitle || '').trim() || label;
        const raw = String(payload.raw || '').trim() || `# ${indexTitle}\n\nWrite your content here.\n`;
        writeFileSync(indexPath, context.ensureTrailingNewline(raw), 'utf8');
      }

      catalog = loadCatalog();
      return context.sendJson(context.res, 200, { ok: true, relativeDir });
    }

    const relativeDir = sanitizeRelativeDir(payload.relative_dir || payload.relativeDir || '');
    const directoryPath = resolveDocsDirectory(relativeDir);
    if (!existsSync(directoryPath)) return context.sendJson(context.res, 404, { error: 'Category not found.' });

    writeCategoryMeta(relativeDir, {
      label: String(payload.label || '').trim() || helpers.titleFromSlug(relativeDir.split('/').pop() || 'docs'),
      position: Number(payload.position ?? 999),
      roles: helpers.normalizeRoleList(payload.roles)
    });
    catalog = loadCatalog();
    context.sendJson(context.res, 200, { ok: true, relativeDir });
  }

  function getEditablePage(slug) {
    if (slug === '__home') {
      const path = homePath();
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf8');
      const parsed = helpers.parseFrontmatter(raw);
      return {
        slug,
        title: 'Home',
        relativePath: 'home.md',
        filePath: path,
        raw,
        markdown: parsed.markdown,
        meta: extractEditablePageMeta(parsed.meta),
        extraMeta: extractExtraPageMeta(parsed.meta)
      };
    }

    const policy = catalog.bySlug.get(slug);
    if (!policy?.file || !existsSync(policy.file)) return null;
    const raw = readFileSync(policy.file, 'utf8');
    const parsed = helpers.parseFrontmatter(raw);
    return {
      slug,
      title: policy.title,
      relativePath: toContentRelativePath(policy.file),
      filePath: policy.file,
      raw,
      markdown: parsed.markdown,
      meta: extractEditablePageMeta(parsed.meta),
      extraMeta: extractExtraPageMeta(parsed.meta)
    };
  }

  function readCategoryMeta(relativeDir) {
    const filePath = resolveDocsPath(relativeDir ? `${relativeDir}/category.json` : 'category.json');
    if (!existsSync(filePath)) return {};
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      helpers.logWarn(`Invalid category file ignored for ${relativeDir || '.'}`, error instanceof Error ? error.message : String(error));
      return {};
    }
  }

  function writeCategoryMeta(relativeDir, meta) {
    const directoryPath = resolveDocsDirectory(relativeDir);
    if (!existsSync(directoryPath)) mkdirSync(directoryPath, { recursive: true });
    const filePath = resolveDocsPath(relativeDir ? `${relativeDir}/category.json` : 'category.json');
    const payload = {
      label: String(meta.label || '').trim(),
      position: Number.isFinite(Number(meta.position)) ? Number(meta.position) : 999,
      roles: Array.isArray(meta.roles) ? meta.roles : []
    };
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  function sanitizeRelativeDir(value = '') {
    return String(value || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => sanitizeSlugSegment(part))
      .filter(Boolean)
      .join('/');
  }

  function sanitizeSlugSegment(value = '') {
    return helpers.slugify(String(value || '').trim());
  }

  function resolveDocsDirectory(relativeDir = '') {
    const fullPath = normalize(join(docsDir(), relativeDir || '.'));
    if (!fullPath.startsWith(docsDir())) throw new Error('Invalid docs directory.');
    return fullPath;
  }

  function resolveDocsPath(relativePath = '') {
    const fullPath = normalize(join(docsDir(), relativePath || '.'));
    if (!fullPath.startsWith(docsDir())) throw new Error('Invalid docs path.');
    return fullPath;
  }

  function toContentRelativePath(filePath) {
    const contentDir = join(helpers.ROOT, 'content');
    return normalize(filePath).slice(contentDir.length + 1).replace(/\\/g, '/');
  }

  function extractEditablePageMeta(meta = {}) {
    return {
      title: String(meta.title || '').trim(),
      description: String(meta.description || '').trim(),
      owner: String(meta.owner || '').trim(),
      version: String(meta.version || '').trim(),
      reviewDate: String(meta.reviewDate || '').trim(),
      roles: Array.isArray(meta.roles) ? meta.roles : [],
      position: Number(meta.position ?? meta.sidebar_position ?? 999)
    };
  }

  function extractExtraPageMeta(meta = {}) {
    const known = new Set(['title', 'description', 'owner', 'version', 'reviewDate', 'roles', 'position', 'sidebar_position']);
    return Object.fromEntries(Object.entries(meta).filter(([key]) => !known.has(key)));
  }

  function normalizeEditablePageMeta(payload = {}) {
    const positionValue = Number(payload.position ?? 999);
    return {
      title: String(payload.title || '').trim(),
      description: String(payload.description || '').trim(),
      owner: String(payload.owner || '').trim(),
      version: String(payload.version || '').trim(),
      reviewDate: String(payload.reviewDate || '').trim(),
      roles: helpers.normalizeRoleList(payload.roles),
      position: Number.isFinite(positionValue) ? positionValue : 999
    };
  }

  function normalizeExtraMeta(value) {
    if (!value) return {};
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function serializeEditablePage({ meta, extraMeta = {}, markdown = '' }) {
    const merged = { ...extraMeta };
    if (meta.title) merged.title = meta.title;
    if (meta.description) merged.description = meta.description;
    if (meta.owner) merged.owner = meta.owner;
    if (meta.version) merged.version = meta.version;
    if (meta.reviewDate) merged.reviewDate = meta.reviewDate;
    merged.roles = Array.isArray(meta.roles) ? meta.roles : [];
    merged.position = Number.isFinite(Number(meta.position)) ? Number(meta.position) : 999;

    const lines = ['---'];
    for (const [key, value] of Object.entries(merged)) {
      if (Array.isArray(value)) {
        lines.push(`${key}: [${value.map((item) => String(item).trim()).filter(Boolean).join(', ')}]`);
        continue;
      }
      lines.push(`${key}: ${String(value ?? '').trim()}`);
    }
    lines.push('---', '', String(markdown || '').replace(/\r\n/g, '\n').replace(/^\n+/, ''));
    return lines.join('\n');
  }
}
