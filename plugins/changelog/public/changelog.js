(() => {
  const I18N = readPortalI18n();
  const msg = (key, fallback) => I18N.messages?.[key] || fallback || key;
  const adminRoot = document.querySelector('[data-changelog-admin-page]');
  const publicRoot = document.querySelector('[data-changelog-app]');

  const state = {
    support: { users: [], roles: [], manageableLists: [] },
    lists: [],
    selectedSlug: '',
    activeTab: 'entries',
    detail: null,
    columnsDraft: [],
    tagSuggestionsDraft: [],
    tagColorsDraft: {},
    tagSuggestionsDirty: false,
    filters: {},
    entries: null,
    analytics: null,
    q: '',
    creator: '',
    updatedFrom: '',
    updatedTo: '',
    sort: 'updated_at',
    dir: 'desc',
    page: 1,
    pageSize: 50,
    activeColumnMenu: '',
    activeColumnMenuStyle: null,
    activeEntryPicker: '',
    activeEntryPickerStyle: null,
    toastTimeout: null,
    editor: {
      open: false,
      mode: 'create',
      entryId: null,
      values: {},
      focusColumn: ''
    }
  };

  if (adminRoot) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAdmin, { once: true });
    else initAdmin();
  }

  if (publicRoot) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPublic, { once: true });
    else initPublic();
  }

  async function initAdmin() {
    state.selectedSlug = adminRoot.dataset.listSlug || '';
    bindAdminEvents();
    await refreshAdmin();
  }

  async function initPublic() {
    state.selectedSlug = publicRoot.dataset.listSlug || '';
    document.addEventListener('click', handleGlobalClick);
    await loadPublicList();
  }

  function bindAdminEvents() {
    document.addEventListener('click', handleGlobalClick);
    document.querySelector('[data-new-changelog-list]')?.addEventListener('click', openCreateListDialog);
    document.querySelectorAll('[data-changelog-tab]').forEach((button) => {
      button.addEventListener('click', () => setAdminTab(button.dataset.changelogTab || 'entries'));
    });
    document.querySelector('[data-new-entry]')?.addEventListener('click', () => openEntryEditor());
    document.querySelector('[data-export-entries]')?.addEventListener('click', exportCurrentCsv);
    document.querySelector('[data-add-column]')?.addEventListener('click', () => openColumnDialog());
    document.querySelector('[data-save-columns]')?.addEventListener('click', saveColumnsDraft);
    document.querySelector('[data-save-permissions]')?.addEventListener('click', savePermissions);
    document.querySelector('[data-refresh-analytics]')?.addEventListener('click', refreshAnalytics);
    document.querySelector('#changelogSettingsForm')?.addEventListener('submit', saveListSettings);
  }

  async function refreshAdmin() {
    try {
      clearError();
      const [support, listsResponse] = await Promise.all([
        fetchJson('/api/admin/changelogs/support-data'),
        fetchJson('/api/admin/changelogs/lists')
      ]);
      state.support = {
        users: Array.isArray(support?.users) ? support.users : [],
        roles: Array.isArray(support?.roles) ? support.roles : [],
        manageableLists: Array.isArray(support?.manageableLists) ? support.manageableLists : []
      };
      state.lists = Array.isArray(listsResponse?.items) ? listsResponse.items : [];
      if (!state.selectedSlug && state.lists[0]?.slug) state.selectedSlug = state.lists[0].slug;
      renderListTree();
      if (state.selectedSlug) await loadAdminList(state.selectedSlug);
      else renderAdminEmpty();
    } catch (error) {
      renderError(error);
    }
  }

  async function loadAdminList(slug) {
    try {
      clearError();
      const detail = await fetchJson(`/api/admin/changelogs/list?slug=${encodeURIComponent(slug)}`);
      state.selectedSlug = detail.slug;
      state.detail = detail;
      hydrateTagDrafts(detail);
      state.columnsDraft = structuredClone(detail.columns || []);
      state.page = 1;
      state.entries = null;
      closeEntryEditor();
      renderAdminDetail();
      await Promise.all([refreshEntries(), refreshAnalytics()]);
    } catch (error) {
      renderError(error);
    }
  }

  async function loadPublicList() {
    try {
      clearError();
      const detail = await fetchJson(`/api/changelogs/list?slug=${encodeURIComponent(state.selectedSlug)}`);
      state.detail = detail;
      hydrateTagDrafts(detail);
      state.entries = null;
      closeEntryEditor();
      renderPublicShell();
      await Promise.all([refreshEntries(), refreshAnalytics()]);
    } catch (error) {
      renderPublicError(error);
    }
  }

  function renderListTree() {
    const target = document.querySelector('#changelogListTree');
    if (!target) return;
    target.innerHTML = state.lists.length
      ? `<div class="content-tree-list">${state.lists.map((item) => `
        <button class="content-tree-item ${state.selectedSlug === item.slug ? 'active' : ''}" type="button" data-open-changelog-list="${esc(item.slug)}">
          <span class="content-tree-kind">${item.status === 'archived' ? 'ARC' : 'LOG'}</span>
          <span class="content-tree-label">${esc(item.title)}</span>
        </button>
      `).join('')}</div>`
      : `<div class="notice">${msg('noListsYet', 'No changelog lists yet.')}</div>`;
    target.querySelectorAll('[data-open-changelog-list]').forEach((button) => {
      button.addEventListener('click', () => loadAdminList(button.dataset.openChangelogList));
    });
  }

  function renderAdminEmpty() {
    document.querySelector('#changelogAdminEmpty')?.removeAttribute('hidden');
    document.querySelector('#changelogAdminDetail')?.setAttribute('hidden', 'hidden');
    document.querySelector('#changelogAdminTitle').textContent = msg('selectList', 'Select a list');
    document.querySelector('#changelogAdminSubtitle').textContent = msg('selectListToManage', 'Choose a changelog list to manage entries, columns, access and settings.');
    const liveButton = document.querySelector('#openLiveChangelogButton');
    if (liveButton) liveButton.hidden = true;
  }

  function renderAdminDetail() {
    if (!state.detail) return renderAdminEmpty();
    document.querySelector('#changelogAdminEmpty')?.setAttribute('hidden', 'hidden');
    document.querySelector('#changelogAdminDetail')?.removeAttribute('hidden');
    document.querySelector('#changelogAdminTitle').textContent = state.detail.title;
    document.querySelector('#changelogAdminSubtitle').textContent = state.detail.description || msg('changelogAdminSummary', 'Manage entries, columns, permissions and list settings.');
    const liveButton = document.querySelector('#openLiveChangelogButton');
    if (liveButton) {
      liveButton.href = state.detail.liveHref;
      liveButton.hidden = false;
    }
    fillSettingsForm();
    renderTagSuggestionManager();
    renderColumnsEditor();
    renderPermissionsEditor();
    setAdminTab(state.activeTab);
    renderEntryEditor();
    syncAdminUrl();
  }

  function renderPublicShell() {
    const target = document.querySelector('#changelogPublicRoot');
    if (!target || !state.detail) return;
    target.innerHTML = `
      <div class="policy-header changelog-hero">
        <div>
          <p class="eyebrow">${esc(msg('changelog', 'Changelog'))}</p>
          <h1>${esc(state.detail.title)}</h1>
          <p>${esc(state.detail.description || '')}</p>
        </div>
        <div class="row-actions">
          ${state.detail.can?.edit ? `<button class="button primary" type="button" id="publicNewEntryButton">${esc(msg('newEntry', 'New entry'))}</button>` : ''}
          ${state.detail.can?.manage ? `<a class="button ghost" href="${esc(state.detail.adminHref)}">${esc(msg('openAdmin', 'Open admin'))}</a>` : ''}
        </div>
      </div>
      ${state.detail.introText ? `<section class="panel changelog-intro-panel"><p>${esc(state.detail.introText)}</p></section>` : ''}
      <section id="changelogPublicToolbar"></section>
      <section id="changelogEntryEditor"></section>
      <section id="changelogPublicTable"></section>
      <section id="changelogPublicAnalytics" class="changelog-public-analytics"></section>
    `;
    document.querySelector('#publicNewEntryButton')?.addEventListener('click', () => openEntryEditor());
    renderEntryEditor();
  }

  function fillSettingsForm() {
    const form = document.querySelector('#changelogSettingsForm');
    if (!form || !state.detail) return;
    hydrateTagDrafts(state.detail);
    form.elements.id.value = state.detail.id || '';
    form.elements.slug.value = state.detail.slug || '';
    form.elements.title.value = state.detail.title || '';
    form.elements.status.value = state.detail.status || 'active';
    form.elements.description.value = state.detail.description || '';
    form.elements.intro_text.value = state.detail.introText || '';
    form.elements.tag_suggestions.value = JSON.stringify(buildTagSuggestionPayload());
  }

  function setAdminTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('[data-changelog-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.changelogTab === tab);
    });
    document.querySelectorAll('[data-changelog-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.changelogPanel !== tab;
    });
  }

  async function refreshEntries() {
    if (!state.detail) return;
    const params = buildSharedQueryParams();
    params.set('page', String(state.page));
    params.set('page_size', String(state.pageSize));
    params.set('sort', state.sort);
    params.set('dir', state.dir);
    state.entries = await fetchJson(`/api/changelogs/entries?${params.toString()}`);
    renderEntryToolbar();
    renderEntryTable();
  }

  async function refreshAnalytics() {
    if (!state.detail) return;
    const params = buildSharedQueryParams();
    state.analytics = await fetchJson(`/api/changelogs/analytics?${params.toString()}`);
    renderAnalytics();
  }

  function buildSharedQueryParams() {
    const params = new URLSearchParams();
    params.set('slug', state.detail.slug);
    if (state.q) params.set('q', state.q);
    if (state.creator) params.set('creator', state.creator);
    if (state.updatedFrom) params.set('updated_from', state.updatedFrom);
    if (state.updatedTo) params.set('updated_to', state.updatedTo);
    if (Object.keys(state.filters).length) params.set('filters', JSON.stringify(state.filters));
    return params;
  }

  function renderEntryToolbar() {
    const target = adminRoot ? document.querySelector('#changelogEntryToolbar') : document.querySelector('#changelogPublicToolbar');
    if (!target || !state.detail) return;
    const activeChips = buildActiveFilterChips();
    const pageSizeOptions = [25, 50, 100, 200];
    target.innerHTML = `
      <div class="changelog-toolbar changelog-toolbar-compact">
        <div class="changelog-toolbar-main">
          <label class="toolbar-search">${msg('search', 'Search')} <input id="changelogSearchInput" value="${esc(state.q)}" placeholder="${esc(msg('searchEntries', 'Search entries'))}"></label>
        </div>
        <div class="changelog-toolbar-actions">
          <div class="filter-chip-row">${activeChips.length ? activeChips.map((chip) => `<button class="filter-chip" type="button" data-clear-filter="${esc(chip.key)}">${esc(chip.label)} x</button>`).join('') : `<span class="hint">${esc(msg('noActiveFilters', 'No active filters.'))}</span>`}</div>
          <div class="row-actions">
            <label class="toolbar-page-size">${esc(msg('rowsPerPage', 'Rows'))}
              <select id="changelogPageSizeSelect">
                ${pageSizeOptions.map((option) => `<option value="${option}" ${state.pageSize === option ? 'selected' : ''}>${option}</option>`).join('')}
              </select>
            </label>
            ${state.detail.can?.manage ? `<a class="button ghost" href="${esc(state.detail.adminHref)}">${esc(msg('openAdmin', 'Open admin'))}</a>` : ''}
            <button class="button ghost" type="button" id="resetChangelogFilters">${msg('resetFilters', 'Reset filters')}</button>
            ${state.detail.can?.edit ? `<button class="button primary" type="button" id="newEntryButtonInline">${msg('newEntry', 'New entry')}</button>` : ''}
          </div>
        </div>
      </div>
    `;
    target.querySelector('#changelogSearchInput')?.addEventListener('change', async (event) => {
      state.q = event.currentTarget.value.trim();
      state.page = 1;
      await reloadData();
    });
    target.querySelectorAll('[data-clear-filter]').forEach((button) => button.addEventListener('click', async () => {
      clearSingleFilter(button.dataset.clearFilter);
      state.page = 1;
      await reloadData();
    }));
    target.querySelector('#resetChangelogFilters')?.addEventListener('click', async () => {
      state.q = '';
      state.creator = '';
      state.updatedFrom = '';
      state.updatedTo = '';
      state.filters = {};
      state.page = 1;
      await reloadData();
    });
    target.querySelector('#changelogPageSizeSelect')?.addEventListener('change', async (event) => {
      state.pageSize = Math.max(25, Number(event.currentTarget.value) || 50);
      state.page = 1;
      await refreshEntries();
    });
    target.querySelector('#newEntryButtonInline')?.addEventListener('click', () => openEntryEditor());
  }

  function clearSingleFilter(key) {
    if (key === '__search') state.q = '';
    else if (key === '__creator') state.creator = '';
    else if (key === '__updated_from') state.updatedFrom = '';
    else if (key === '__updated_to') state.updatedTo = '';
    else delete state.filters[key];
  }

  function buildActiveFilterChips() {
    const chips = [];
    if (state.q) chips.push({ key: '__search', label: `${msg('search', 'Search')}: ${state.q}` });
    if (state.creator) chips.push({ key: '__creator', label: `${msg('creator', 'Creator')}: ${state.creator}` });
    if (state.updatedFrom) chips.push({ key: '__updated_from', label: `${msg('updatedFrom', 'Updated from')}: ${state.updatedFrom}` });
    if (state.updatedTo) chips.push({ key: '__updated_to', label: `${msg('updatedTo', 'Updated to')}: ${state.updatedTo}` });
    Object.entries(state.filters).forEach(([key, value]) => {
      const column = (state.detail?.columns || []).find((item) => item.key === key);
      if (!column) return;
      if (Array.isArray(value)) chips.push({ key, label: `${column.label}: ${value.join(', ')}` });
      else if (value && typeof value === 'object') {
        const parts = Object.values(value).filter(Boolean).join(' - ');
        if (parts) chips.push({ key, label: `${column.label}: ${parts}` });
      } else if (value) chips.push({ key, label: `${column.label}: ${value}` });
    });
    return chips;
  }

  function renderEntryTable() {
    const target = adminRoot ? document.querySelector('#changelogEntryTable') : document.querySelector('#changelogPublicTable');
    removeFloatingColumnMenu();
    removeFloatingEntryPicker();
    if (!target || !state.detail || !state.entries) return;
    const visibleColumns = getTableColumns();
    const activeMenuColumn = visibleColumns.find((column) => column.key === state.activeColumnMenu) || null;
    const activePickerColumn = (state.detail.columns || []).find((column) => column.key === state.activeEntryPicker) || null;
    const items = Array.isArray(state.entries.items) ? state.entries.items : [];
    const rows = state.editor.open && state.editor.mode === 'create'
      ? [{ id: '__new__', canEdit: true, values: state.editor.values, displayValues: {}, createdByName: '', updatedAt: '', isDraft: true }, ...items]
      : items;
    const columnCount = 1 + visibleColumns.length + (state.detail.can?.edit ? 1 : 0);
    target.innerHTML = `
      <div class="changelog-table-wrap spreadsheet-table-wrap">
        <table class="changelog-table spreadsheet-table">
          <thead>
            <tr>
              <th class="row-index-head">#</th>
              ${visibleColumns.map((column) => `
                <th class="sheet-column-head ${state.activeColumnMenu === column.key ? 'is-menu-open' : ''}" style="${column.width ? `width:${esc(column.width)};` : ''}">
                  <div class="sheet-head-cell">
                    ${renderColumnHead(column)}
                  </div>
                </th>
              `).join('')}
              ${state.detail.can?.edit ? '<th class="row-action-head"></th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((item, index) => {
              const isEditing = state.editor.open && (item.isDraft || Number(state.editor.entryId) === Number(item.id));
              return `
              <tr class="${isEditing ? 'is-active is-editing' : ''} ${item.isDraft ? 'is-draft' : ''}" data-entry-row="${esc(item.id)}">
                <td class="row-index-cell">${item.isDraft ? esc(msg('new', 'Neu')) : (state.page - 1) * state.pageSize + (state.editor.mode === 'create' ? index : index + 1)}</td>
                ${visibleColumns.map((column) => renderInlineTableCell(item, column, isEditing)).join('')}
                ${state.detail.can?.edit ? renderInlineRowActions(item, isEditing) : ''}
              </tr>
            `;
            }).join('') : `
              <tr class="table-empty-row">
                <td colspan="${columnCount}">
                  <div class="empty-state compact table-empty-state">
                    <h1>${esc(msg('noEntries', 'No entries yet.'))}</h1>
                    <p>${esc(msg('noEntriesText', 'Create the first entry to start using this changelog.'))}</p>
                  </div>
                </td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
      ${renderPagination()}
    `;
    if (activeMenuColumn && columnSupportsMenu(activeMenuColumn)) mountFloatingColumnMenu(activeMenuColumn);
    if (activePickerColumn) mountFloatingEntryPicker(activePickerColumn);
    target.querySelectorAll('[data-column-menu]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      const key = button.dataset.columnMenu;
      if (state.activeColumnMenu === key) {
        state.activeColumnMenu = '';
        state.activeColumnMenuStyle = null;
      } else {
        state.activeColumnMenu = key;
        state.activeColumnMenuStyle = buildFloatingMenuStyle(button.getBoundingClientRect(), { preferredWidth: 320, preferredHeight: 420 });
      }
      renderEntryTable();
    }));
    target.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', async () => {
      state.page = Number(button.dataset.page);
      await refreshEntries();
    }));
    target.querySelectorAll('[data-edit-entry]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      const entry = state.entries.items.find((item) => Number(item.id) === Number(button.dataset.editEntry));
      if (entry) openEntryEditor(entry);
    }));
    target.querySelectorAll('[data-inline-cell]').forEach((cell) => cell.addEventListener('click', () => {
      if (state.editor.open || !state.detail.can?.edit || cell.dataset.editable !== 'true') return;
      const entry = state.entries.items.find((item) => Number(item.id) === Number(cell.dataset.entryId));
      if (entry?.canEdit) openEntryEditor(entry, cell.dataset.columnKey);
    }));
    target.querySelectorAll('[data-inline-save]').forEach((button) => button.addEventListener('click', saveInlineEntry));
    target.querySelectorAll('[data-inline-cancel]').forEach((button) => button.addEventListener('click', closeEntryEditor));
    if (!target.dataset.inlinePickerBound) {
      target.dataset.inlinePickerBound = 'true';
      target.addEventListener('click', handleInlinePickerClick);
      target.addEventListener('keydown', handleInlinePickerKeydown);
    }
    bindEntryEditorEvents(target);
    focusInlineEditorCell(target);
  }

  function renderInlineTableCell(item, column, isEditing) {
    const editable = isEditableEntryColumn(column) && state.detail?.can?.edit && item.canEdit;
    const value = getEntryCellValue(item, column);
    if (isEditing && editable) {
      return `<td class="inline-edit-cell" data-inline-cell data-entry-id="${esc(item.id)}" data-column-key="${esc(column.key)}" data-editable="true">${renderEntryField(column, state.editor.values[column.key])}</td>`;
    }
    return `<td class="${editable ? 'inline-display-cell' : ''}" data-inline-cell data-entry-id="${esc(item.id)}" data-column-key="${esc(column.key)}" data-editable="${editable ? 'true' : 'false'}">${renderCellValue(column, value)}</td>`;
  }

  function renderInlineRowActions(item, isEditing) {
    if (isEditing) {
      return `
        <td class="row-actions inline-row-actions">
          <button class="button small primary" type="button" data-inline-save>${esc(msg('save', 'Save'))}</button>
          <button class="button small ghost" type="button" data-inline-cancel>${esc(msg('cancel', 'Cancel'))}</button>
        </td>
      `;
    }
    return `<td class="row-actions">${item.canEdit ? `<button class="button small ghost" type="button" data-edit-entry="${esc(item.id)}">${esc(msg('edit', 'Edit'))}</button>` : ''}</td>`;
  }

  function isEditableEntryColumn(column) {
    return Boolean(column && !column.system && (state.detail?.columns || []).some((item) => item.key === column.key));
  }

  function renderPagination() {
    const totalPages = Number(state.entries?.totalPages || 1);
    if (totalPages <= 1) return '';
    const currentPage = Number(state.page || 1);
    const windowPages = buildPaginationWindow(currentPage, totalPages, 5);
    return `
      <div class="pagination-row compact-pagination">
        <div class="pagination-summary">${esc(`${msg('page', 'Page')} ${currentPage} ${msg('of', 'of')} ${totalPages}`)}</div>
        <div class="pagination-controls">
          <button class="button small ghost" type="button" data-page="${Math.max(1, currentPage - 1)}" ${currentPage <= 1 ? 'disabled' : ''}>${esc(msg('previous', 'Previous'))}</button>
          ${windowPages.map((page) => page === '…'
            ? `<span class="pagination-ellipsis">...</span>`
            : `<button class="button small ${page === currentPage ? 'primary' : 'ghost'}" type="button" data-page="${page}">${page}</button>`).join('')}
          <button class="button small ghost" type="button" data-page="${Math.min(totalPages, currentPage + 1)}" ${currentPage >= totalPages ? 'disabled' : ''}>${esc(msg('next', 'Next'))}</button>
        </div>
      </div>
    `;
  }

  function buildPaginationWindow(currentPage, totalPages, radius = 2) {
    if (totalPages <= radius * 2 + 5) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }
    const pages = new Set([1, totalPages]);
    for (let page = currentPage - radius; page <= currentPage + radius; page += 1) {
      if (page > 1 && page < totalPages) pages.add(page);
    }
    const sorted = Array.from(pages).sort((a, b) => a - b);
    const result = [];
    for (let index = 0; index < sorted.length; index += 1) {
      const page = sorted[index];
      const previous = sorted[index - 1];
      if (previous && page - previous > 1) result.push('…');
      result.push(page);
    }
    return result;
  }

  function getTableColumns() {
    const customColumns = (state.detail?.columns || []).filter((column) => column.visible);
    return [
      { key: 'created_by_name', label: msg('creator', 'Creator'), type: 'user', visible: true, sortable: true, filterable: true, width: '14rem', system: true },
      ...customColumns,
      { key: 'updated_at', label: msg('updated', 'Updated'), type: 'date', visible: true, sortable: true, filterable: true, width: '12rem', system: true }
    ];
  }

  function getEntryCellValue(entry, column) {
    if (column.key === 'created_by_name') return entry.createdByName || '';
    if (column.key === 'updated_at') return entry.updatedAt || '';
    if (column.key === 'created_at') return entry.createdAt || '';
    if (column.key === 'updated_by_name') return entry.updatedByName || '';
    return entry.values?.[column.key];
  }

  function renderColumnHead(column) {
    if (!columnSupportsMenu(column)) {
      return `<div class="sheet-head-label"><span>${esc(column.label)}</span></div>`;
    }
    return `
      <button class="sheet-head-trigger" type="button" data-column-menu="${esc(column.key)}">
        <span>${esc(column.label)}</span>
        <span class="sheet-filter-glyph">${hasActiveColumnFilter(column.key) ? '●' : '▾'}</span>
      </button>
    `;
  }

  function columnSupportsMenu(column) {
    return Boolean(column?.sortable || column?.filterable);
  }

  function renderColumnMenu(column) {
    const current = resolveColumnMenuValue(column.key);
    const sortActions = column.sortable ? `
      <button class="sheet-menu-action" type="button" data-sort-key="${esc(column.key)}" data-sort-dir="asc">${esc(msg('sortAsc', 'Von A bis Z sortieren'))}</button>
      <button class="sheet-menu-action" type="button" data-sort-key="${esc(column.key)}" data-sort-dir="desc">${esc(msg('sortDesc', 'Von Z bis A sortieren'))}</button>
    ` : '';
    const filterMarkup = column.filterable ? renderColumnMenuFilterInputs(column, current) : '';
    return `
      <div class="sheet-column-menu" data-column-menu-panel="${esc(column.key)}" style="${inlineStyle(state.activeColumnMenuStyle)}">
        ${sortActions}
        ${sortActions && filterMarkup ? '<div class="sheet-menu-divider"></div>' : ''}
        ${filterMarkup}
        ${column.filterable ? `
          <div class="sheet-menu-actions">
            <button class="button small primary" type="button" data-apply-column-filter="${esc(column.key)}">${esc(msg('apply', 'OK'))}</button>
            <button class="button small ghost" type="button" data-clear-column-filter="${esc(column.key)}">${esc(msg('clear', 'Zuruecksetzen'))}</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  function mountFloatingColumnMenu(column) {
    const menu = document.createElement('div');
    menu.id = 'changelogFloatingColumnMenu';
    menu.innerHTML = renderColumnMenu(column);
    const panel = menu.firstElementChild;
    if (!panel) return;
    document.body.appendChild(panel);
    panel.querySelectorAll('[data-sort-key]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      state.sort = button.dataset.sortKey;
      state.dir = button.dataset.sortDir || 'asc';
      state.activeColumnMenu = '';
      state.activeColumnMenuStyle = null;
      removeFloatingColumnMenu();
      await refreshEntries();
    }));
    panel.querySelectorAll('[data-apply-column-filter]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      applyColumnMenuFilter(button.dataset.applyColumnFilter, panel);
      state.activeColumnMenu = '';
      state.activeColumnMenuStyle = null;
      state.page = 1;
      removeFloatingColumnMenu();
      await reloadData();
    }));
    panel.querySelectorAll('[data-clear-column-filter]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      clearColumnMenuFilter(button.dataset.clearColumnFilter);
      state.activeColumnMenu = '';
      state.activeColumnMenuStyle = null;
      state.page = 1;
      removeFloatingColumnMenu();
      await reloadData();
    }));
  }

  function removeFloatingColumnMenu() {
    document.querySelector('#changelogFloatingColumnMenu')?.remove();
    document.querySelector('#changelogFloatingColumnMenuPanel')?.remove();
    document.querySelector('.sheet-column-menu[data-column-menu-panel]')?.remove();
  }

  function renderColumnMenuFilterInputs(column, current) {
    if (column.key === 'created_by_name') {
      return `
        <label class="sheet-menu-field">${esc(msg('creator', 'Creator'))}
          <select data-menu-filter-key="__creator">
            <option value="">${esc(msg('allCreators', 'All creators'))}</option>
            ${(state.detail.creators || []).map((creator) => `<option value="${esc(creator)}" ${current === creator ? 'selected' : ''}>${esc(creator)}</option>`).join('')}
          </select>
        </label>
      `;
    }
    if (column.key === 'updated_at') {
      return `
        <label class="sheet-menu-field">${esc(msg('updatedFrom', 'Updated from'))}<input data-menu-filter-key="__updated_at" data-filter-mode="from" type="date" value="${esc(current?.from || state.updatedFrom || '')}"></label>
        <label class="sheet-menu-field">${esc(msg('updatedTo', 'Updated to'))}<input data-menu-filter-key="__updated_at" data-filter-mode="to" type="date" value="${esc(current?.to || state.updatedTo || '')}"></label>
      `;
    }
    if (column.type === 'status' || column.type === 'single_select' || column.type === 'user') {
      const options = column.type === 'user' ? (state.detail.users || []).map((user) => user.name) : buildFilterOptions(column);
      return `
        <label class="sheet-menu-field">${esc(msg('filter', 'Filter'))}
          <select data-menu-filter-key="${esc(column.key)}">
            <option value="">${esc(msg('all', 'All'))}</option>
            ${options.map((option) => `<option value="${esc(option)}" ${current === option ? 'selected' : ''}>${esc(option)}</option>`).join('')}
          </select>
        </label>
      `;
    }
    if (column.type === 'tags' || column.type === 'multi_select') {
      const options = buildFilterOptions(column);
      return `
        <fieldset class="sheet-menu-checklist">
          <legend>${esc(msg('filter', 'Filter'))}</legend>
          <div class="sheet-menu-checklist-body">
            ${options.length ? options.map((option) => `
              <label class="check sheet-menu-check-option">
                <input data-menu-filter-key="${esc(column.key)}" type="checkbox" value="${esc(option)}" ${Array.isArray(current) && current.includes(option) ? 'checked' : ''}>
                <span>${esc(option)}</span>
              </label>
            `).join('') : `<span class="hint">${esc(msg('noTagsAvailable', 'Keine Tags vorhanden.'))}</span>`}
          </div>
        </fieldset>
      `;
    }
    if (column.type === 'boolean') {
      return `
        <label class="sheet-menu-field">${esc(msg('filter', 'Filter'))}
          <select data-menu-filter-key="${esc(column.key)}">
            <option value="">${esc(msg('all', 'All'))}</option>
            <option value="true" ${current === 'true' ? 'selected' : ''}>${esc(msg('yes', 'Yes'))}</option>
            <option value="false" ${current === 'false' ? 'selected' : ''}>${esc(msg('no', 'No'))}</option>
          </select>
        </label>
      `;
    }
    if (column.type === 'date') {
      return `
        <label class="sheet-menu-field">${esc(msg('from', 'Von'))}<input data-menu-filter-key="${esc(column.key)}" data-filter-mode="from" type="date" value="${esc(current?.from || '')}"></label>
        <label class="sheet-menu-field">${esc(msg('to', 'Bis'))}<input data-menu-filter-key="${esc(column.key)}" data-filter-mode="to" type="date" value="${esc(current?.to || '')}"></label>
      `;
    }
    if (column.type === 'number') {
      return `
        <label class="sheet-menu-field">${esc(msg('min', 'Min'))}<input data-menu-filter-key="${esc(column.key)}" data-filter-mode="min" type="number" value="${esc(current?.min ?? '')}"></label>
        <label class="sheet-menu-field">${esc(msg('max', 'Max'))}<input data-menu-filter-key="${esc(column.key)}" data-filter-mode="max" type="number" value="${esc(current?.max ?? '')}"></label>
      `;
    }
    return `<label class="sheet-menu-field">${esc(msg('search', 'Suchen'))}<input data-menu-filter-key="${esc(column.key)}" value="${esc(current || '')}" placeholder="${esc(msg('search', 'Suchen'))}"></label>`;
  }

  function buildFilterOptions(column) {
    const set = new Set([...(column.options || []), ...((state.detail.dynamicOptions && state.detail.dynamicOptions[column.key]) || [])]);
    if (column.type === 'tags') getEffectiveTagSuggestions().forEach((item) => set.add(item));
    (state.entries?.items || []).forEach((item) => {
      const value = item.values?.[column.key];
      if (Array.isArray(value)) value.forEach((entry) => set.add(entry));
      else if (value) set.add(value);
    });
    return Array.from(set).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), 'de'));
  }

  function buildEditorOptions(column, currentValue) {
    const set = new Set([...(column.options || []), ...((state.detail.dynamicOptions && state.detail.dynamicOptions[column.key]) || [])]);
    if (column.type === 'tags') getEffectiveTagSuggestions().forEach((item) => set.add(item));
    (state.entries?.items || []).forEach((item) => {
      const value = item.values?.[column.key];
      if (Array.isArray(value)) value.forEach((entry) => set.add(entry));
      else if (value) set.add(value);
    });
    if (Array.isArray(currentValue)) currentValue.forEach((item) => set.add(item));
    return Array.from(set).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), 'de'));
  }

  function resolveColumnMenuValue(key) {
    if (key === 'created_by_name') return state.creator;
    if (key === 'updated_at') return { from: state.updatedFrom, to: state.updatedTo };
    return state.filters[key];
  }

  function applyColumnMenuFilter(key, panel) {
    if (!panel) return;
    if (key === 'created_by_name') {
      state.creator = panel.querySelector('[data-menu-filter-key="__creator"]')?.value || '';
      return;
    }
    if (key === 'updated_at') {
      state.updatedFrom = panel.querySelector('[data-menu-filter-key="__updated_at"][data-filter-mode="from"]')?.value || '';
      state.updatedTo = panel.querySelector('[data-menu-filter-key="__updated_at"][data-filter-mode="to"]')?.value || '';
      return;
    }
    const column = (state.detail.columns || []).find((item) => item.key === key);
    if (!column) return;
    const element = panel.querySelector(`[data-menu-filter-key="${cssEscape(key)}"]`);
    const multiInputs = panel.querySelectorAll(`input[data-menu-filter-key="${cssEscape(key)}"][type="checkbox"]:checked`);
    if (multiInputs.length) {
      const values = Array.from(multiInputs).map((input) => input.value).filter(Boolean);
      if (values.length) state.filters[key] = values;
      else delete state.filters[key];
      return;
    }
    if (!element) return;
    if (column.type === 'date' || column.type === 'number') {
      const data = {};
      panel.querySelectorAll(`[data-menu-filter-key="${cssEscape(key)}"]`).forEach((input) => {
        if (input.value !== '') data[input.dataset.filterMode] = input.value;
      });
      if (Object.keys(data).length) state.filters[key] = data;
      else delete state.filters[key];
      return;
    }
    if (element.value) state.filters[key] = element.value;
    else delete state.filters[key];
  }

  function clearColumnMenuFilter(key) {
    delete state.filters[key];
    if (key === '__creator' || key === 'created_by_name') state.creator = '';
    if (key === '__updated_at' || key === 'updated_at') {
      state.updatedFrom = '';
      state.updatedTo = '';
    }
  }

  function hasActiveColumnFilter(key) {
    if (key === 'created_by_name') return Boolean(state.creator);
    if (key === 'updated_at') return Boolean(state.updatedFrom || state.updatedTo);
    return Object.prototype.hasOwnProperty.call(state.filters, key);
  }

  function handleGlobalClick(event) {
    if (
      event.target.closest('.sheet-column-menu')
      || event.target.closest('.sheet-head-trigger')
      || event.target.closest('.entry-picker-menu')
      || event.target.closest('.entry-picker-trigger')
    ) return;
    let rerenderTable = false;
    let rerenderEditor = false;
    if (state.activeColumnMenu) {
      state.activeColumnMenu = '';
      state.activeColumnMenuStyle = null;
      rerenderTable = true;
    }
    if (state.activeEntryPicker) {
      state.activeEntryPicker = '';
      state.activeEntryPickerStyle = null;
      rerenderEditor = true;
    }
    if (rerenderTable) renderEntryTable();
    if (rerenderEditor) renderEntryTable();
  }

  function renderCellValue(column, value) {
    if (value === null || value === undefined || value === '') return '<span class="hint">-</span>';
    if (Array.isArray(value)) return `<div class="chip-list">${value.map((item) => renderTagPill(item)).join('')}</div>`;
    if (column.type === 'boolean') return `<span class="pill">${esc(value ? msg('yes', 'Yes') : msg('no', 'No'))}</span>`;
    if (column.type === 'date') return esc(formatDateTime(value));
    if (column.type === 'long_text') return `<div class="cell-multiline spreadsheet-multiline">${esc(String(value))}</div>`;
    return esc(String(value));
  }

  function renderEntryEditor() {
    const target = document.querySelector('#changelogEntryEditor');
    if (!target) return;
    target.innerHTML = '';
    target.hidden = true;
  }

  function openEntryEditor(entry = null, focusColumn = '') {
    state.editor.open = true;
    state.editor.mode = entry ? 'edit' : 'create';
    state.editor.entryId = entry?.id || null;
    state.editor.values = {};
    state.editor.focusColumn = focusColumn || (state.detail?.columns || []).find((column) => isEditableEntryColumn(column))?.key || '';
    (state.detail?.columns || []).forEach((column) => {
      const fallback = column.defaultValue ?? (column.type === 'multi_select' || column.type === 'tags' ? [] : column.type === 'boolean' ? false : '');
      const value = entry?.values?.[column.key];
      state.editor.values[column.key] = Array.isArray(value ?? fallback) ? [...(value ?? fallback)] : (value ?? fallback);
    });
    renderEntryTable();
  }

  function closeEntryEditor() {
    state.editor.open = false;
    state.editor.mode = 'create';
    state.editor.entryId = null;
    state.editor.values = {};
    state.editor.focusColumn = '';
    state.activeEntryPicker = '';
    state.activeEntryPickerStyle = null;
    renderEntryTable();
  }

  function renderEntryField(column, value) {
    const fieldName = `field_${column.key}`;
    const label = `${esc(column.label)}${column.required ? ' *' : ''}`;
    if (column.type === 'long_text') {
      return `<label>${label}<textarea name="${esc(fieldName)}" ${column.required ? 'required' : ''}>${esc(value ?? '')}</textarea></label>`;
    }
    if (column.type === 'single_select' || column.type === 'status') {
      return `<label>${label}<select name="${esc(fieldName)}" ${column.required ? 'required' : ''}><option value=""></option>${(column.options || []).map((option) => `<option value="${esc(option)}" ${value === option ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select></label>`;
    }
    if (column.type === 'user') {
      return `<label>${label}<select name="${esc(fieldName)}"><option value=""></option>${(state.detail.users || []).map((user) => `<option value="${esc(user.name)}" ${value === user.name ? 'selected' : ''}>${esc(user.name)}</option>`).join('')}</select></label>`;
    }
    if (column.type === 'multi_select' || column.type === 'tags') {
      const options = buildEditorOptions(column, value);
      const selected = Array.isArray(value) ? value : [];
      const isOpen = state.activeEntryPicker === column.key;
      return `
        <div class="entry-picker-field">
          <span class="entry-picker-label">${label}</span>
          <button class="entry-picker-trigger" type="button" data-entry-picker="${esc(column.key)}">
            <span data-entry-picker-summary="${esc(column.key)}">${esc(selected.length ? `${selected.length} ${msg('selected', 'ausgewaehlt')}` : msg('selectTags', 'Auswaehlen'))}</span>
            <span class="sheet-filter-glyph">▾</span>
          </button>
        </div>
      `;
    }
    if (column.type === 'boolean') {
      return `<label class="check changelog-check-row"><input name="${esc(fieldName)}" type="checkbox" ${value ? 'checked' : ''}> ${label}</label>`;
    }
    const inputType = column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text';
    return `<label>${label}<input name="${esc(fieldName)}" type="${inputType}" value="${esc(value ?? '')}" ${column.required ? 'required' : ''}></label>`;
  }

  function renderEntryPickerMenu(column) {
    const value = state.editor.values[column.key];
    const options = buildEditorOptions(column, value);
    const selected = Array.isArray(value) ? value : [];
    return `
      <div class="entry-picker-menu" data-entry-picker-panel="${esc(column.key)}" style="${inlineStyle(state.activeEntryPickerStyle)}">
        <fieldset class="sheet-menu-checklist">
          <legend>${esc(column.label)}</legend>
          <div class="sheet-menu-checklist-body">
            ${options.length ? options.map((option) => `
              <div class="entry-picker-option-row">
                <button class="sheet-menu-check-option entry-picker-option ${selected.includes(option) ? 'is-selected' : ''}" type="button" data-picker-option-key="${esc(column.key)}" data-picker-option-value="${esc(option)}" aria-pressed="${selected.includes(option) ? 'true' : 'false'}">
                  <span class="entry-picker-checkmark">${selected.includes(option) ? 'x' : ''}</span>
                  ${renderTagSwatch(option)}
                  <span>${esc(option)}</span>
                </button>
                <label class="entry-picker-color-control" title="${esc(msg('tagColor', 'Tag-Farbe'))}">
                  <span class="sr-only">${esc(msg('tagColor', 'Tag-Farbe'))}</span>
                  <input class="tag-color-input compact" data-picker-option-color="${esc(option)}" type="color" value="${esc(getTagColor(option))}">
                </label>
              </div>
            `).join('') : `<span class="hint">${esc(msg('noTagOptions', 'Noch keine Vorschlaege vorhanden.'))}</span>`}
          </div>
        </fieldset>
        <div class="entry-picker-add-row">
          <input data-picker-add-input="${esc(column.key)}" type="text" placeholder="${esc(msg('addTag', 'Tag hinzufuegen'))}">
          <label class="entry-picker-color-control" title="${esc(msg('tagColor', 'Tag-Farbe'))}">
            <span class="sr-only">${esc(msg('tagColor', 'Tag-Farbe'))}</span>
            <input class="tag-color-input" data-picker-add-color="${esc(column.key)}" type="color" value="${esc(defaultTagColor(''))}">
          </label>
          <button class="button small ghost" type="button" data-picker-add-button="${esc(column.key)}">${esc(msg('add', 'Add'))}</button>
        </div>
        <div class="sheet-menu-actions">
          <button class="button small primary" type="button" data-close-entry-picker="${esc(column.key)}">${esc(msg('done', 'Fertig'))}</button>
        </div>
      </div>
    `;
  }

  function mountFloatingEntryPicker(column) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderEntryPickerMenu(column);
    const panel = wrapper.firstElementChild;
    if (!panel) return;
    document.body.appendChild(panel);
    panel.querySelectorAll('[data-picker-option-key]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleInlinePickerValue(document, button.dataset.pickerOptionKey, button.dataset.pickerOptionValue);
    }));
    panel.querySelectorAll('[data-picker-option-color]').forEach((input) => input.addEventListener('input', (event) => {
      event.stopPropagation();
      const tag = input.dataset.pickerOptionColor;
      if (Array.isArray(state.tagSuggestionsDraft) && tag && !state.tagSuggestionsDraft.includes(tag)) {
        state.tagSuggestionsDraft.push(tag);
        state.tagSuggestionsDraft.sort((a, b) => a.localeCompare(b, 'de'));
      }
      state.tagSuggestionsDirty = true;
      setTagColor(tag, input.value);
    }));
    panel.querySelector('[data-picker-add-button]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      addInlinePickerValue(document, column.key);
    });
    panel.querySelector('[data-picker-add-input]')?.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addInlinePickerValue(document, column.key);
    });
    panel.querySelector('[data-close-entry-picker]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      state.activeEntryPicker = '';
      state.activeEntryPickerStyle = null;
      removeFloatingEntryPicker();
      renderEntryTable();
    });
  }

  function removeFloatingEntryPicker() {
    document.querySelector('.entry-picker-menu[data-entry-picker-panel]')?.remove();
  }

  async function saveInlineEntry(event) {
    event?.preventDefault();
    syncAllInlineEditorValues();
    const mode = state.editor.mode;
    const payload = {
      slug: state.detail.slug,
      id: state.editor.entryId || undefined,
      values: readEntryValues(state.detail.columns || [])
    };
    if (state.tagSuggestionsDirty && state.detail.can?.manage) payload.tag_suggestions = buildTagSuggestionPayload();
    try {
      await fetchJson('/api/changelogs/entry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      closeEntryEditor();
      await reloadData();
      showToast(mode === 'edit' ? msg('entrySaved', 'Entry saved.') : msg('entryCreated', 'Entry created.'));
    } catch (error) {
      renderError(error);
    }
  }

  function readEntryValues(columns) {
    const values = {};
    columns.forEach((column) => {
      if (column.type === 'multi_select' || column.type === 'tags') {
        values[column.key] = Array.isArray(state.editor.values[column.key]) ? [...state.editor.values[column.key]] : [];
        return;
      }
      values[column.key] = state.editor.values[column.key];
    });
    return values;
  }

  function bindEntryEditorEvents(root = document) {
    const editorRoot = root.querySelector('.is-editing');
    if (!editorRoot || !state.detail) return;
    (state.detail.columns || []).forEach((column) => {
      const fieldName = `field_${column.key}`;
      if (column.type === 'multi_select' || column.type === 'tags') return;
      const elements = editorRoot.querySelectorAll(`[name="${cssEscape(fieldName)}"]`);
      elements.forEach((element) => {
        const eventName = element.type === 'checkbox' || element.tagName === 'SELECT' ? 'change' : 'input';
        element.addEventListener(eventName, () => syncEditorFieldValue(editorRoot, column));
        element.addEventListener('keydown', handleInlineEditorKeydown);
      });
    });
  }

  function handleInlinePickerClick(event) {
    const trigger = event.target.closest('[data-entry-picker]');
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    const key = trigger.dataset.entryPicker;
    const rect = trigger.getBoundingClientRect();
    if (state.activeEntryPicker === key) {
      state.activeEntryPicker = '';
      state.activeEntryPickerStyle = null;
    } else {
      state.activeEntryPicker = key;
      state.activeEntryPickerStyle = buildFloatingMenuStyle(rect, { preferredWidth: Math.max(320, rect.width), preferredHeight: 420 });
    }
    renderEntryTable();
  }

  function handleInlinePickerKeydown(event) {
    if (!event.target.closest('[data-entry-picker]') || event.key !== 'Enter') return;
    handleInlinePickerClick(event);
  }

  function syncEditorFieldValue(root, column) {
    const fieldName = `field_${column.key}`;
    const element = root.querySelector(`[name="${cssEscape(fieldName)}"]`);
    if (!element) return;
    if (element.type === 'checkbox') state.editor.values[column.key] = element.checked;
    else state.editor.values[column.key] = element.value;
  }

  function syncAllInlineEditorValues() {
    const editorRoot = document.querySelector('.is-editing');
    if (!editorRoot) return;
    (state.detail?.columns || []).forEach((column) => {
      if (column.type === 'multi_select' || column.type === 'tags') return;
      syncEditorFieldValue(editorRoot, column);
    });
  }

  function handleInlineEditorKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEntryEditor();
      return;
    }
    if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
      event.preventDefault();
      saveInlineEntry(event);
    }
  }

  function updateInlinePickerSummary(root, key) {
    const summary = root.querySelector(`[data-entry-picker-summary="${cssEscape(key)}"]`);
    if (!summary) return;
    const count = Array.isArray(state.editor.values[key]) ? state.editor.values[key].length : 0;
    summary.textContent = count ? `${count} ${msg('selected', 'ausgewaehlt')}` : msg('selectTags', 'Auswaehlen');
  }

  function toggleInlinePickerValue(root, key, value) {
    if (!key || !value) return;
    const current = Array.isArray(state.editor.values[key]) ? [...state.editor.values[key]] : [];
    const index = current.indexOf(value);
    if (index >= 0) current.splice(index, 1);
    else current.push(value);
    state.editor.values[key] = current;
    const option = Array.from(root.querySelectorAll(`[data-picker-option-key="${cssEscape(key)}"]`))
      .find((item) => item.dataset.pickerOptionValue === value);
    if (option) {
      const selected = index < 0;
      option.classList.toggle('is-selected', selected);
      option.setAttribute('aria-pressed', selected ? 'true' : 'false');
      const mark = option.querySelector('.entry-picker-checkmark');
      if (mark) mark.textContent = selected ? 'x' : '';
    }
    updateInlinePickerSummary(root, key);
  }

  function addInlinePickerValue(root, key) {
    const input = root.querySelector(`[data-picker-add-input="${cssEscape(key)}"]`);
    const value = String(input?.value || '').trim();
    if (!value) return;
    const colorInput = root.querySelector(`[data-picker-add-color="${cssEscape(key)}"]`);
    const color = sanitizeTagColor(colorInput?.value) || defaultTagColor(value);
    const current = Array.isArray(state.editor.values[key]) ? [...state.editor.values[key]] : [];
    if (!current.includes(value)) current.push(value);
    state.editor.values[key] = current;
    state.tagColorsDraft[value] = color;
    if (Array.isArray(state.tagSuggestionsDraft) && !state.tagSuggestionsDraft.includes(value)) {
      state.tagSuggestionsDraft.push(value);
      state.tagSuggestionsDraft.sort((a, b) => a.localeCompare(b, 'de'));
    }
    state.tagSuggestionsDirty = true;
    if (input) input.value = '';
    if (colorInput) colorInput.value = defaultTagColor('');
    renderEntryTable();
  }

  function focusInlineEditorCell(root) {
    if (!state.editor.open || !state.editor.focusColumn) return;
    const focusColumn = state.editor.focusColumn;
    if (!focusColumn) return;
    const cell = root.querySelector(`.is-editing [data-column-key="${cssEscape(focusColumn)}"]`);
    const focusTarget = cell?.querySelector('input:not([type="checkbox"]), textarea, select, button.entry-picker-trigger');
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
      if (typeof focusTarget.select === 'function' && focusTarget.tagName !== 'SELECT') focusTarget.select();
    }
    state.editor.focusColumn = '';
  }

  function renderColumnsEditor() {
    const target = document.querySelector('#changelogColumnsEditor');
    if (!target) return;
    target.innerHTML = state.columnsDraft.length ? state.columnsDraft.map((column, index) => `
      <section class="changelog-column-card">
        <div class="form-field-row-head">
          <div class="form-field-row-title">
            <div><strong>${esc(column.label)}</strong><p class="hint">${esc(column.type)} · ${esc(column.key)}</p></div>
          </div>
          <div class="row-actions">
            <button class="button small" type="button" data-move-column="${index}" data-direction="-1">↑</button>
            <button class="button small" type="button" data-move-column="${index}" data-direction="1">↓</button>
            <button class="button small" type="button" data-edit-column="${index}">${msg('edit', 'Edit')}</button>
            <button class="button small danger" type="button" data-remove-column="${index}">${msg('delete', 'Delete')}</button>
          </div>
        </div>
        <div class="form-field-summary">
          ${column.required ? `<span class="pill">${esc(msg('required', 'Required'))}</span>` : ''}
          ${column.visible ? `<span class="pill">${esc(msg('visible', 'Visible'))}</span>` : `<span class="pill">${esc(msg('hidden', 'Hidden'))}</span>`}
          ${column.filterable ? `<span class="pill">${esc(msg('filterable', 'Filterable'))}</span>` : ''}
          ${column.sortable ? `<span class="pill">${esc(msg('sortable', 'Sortable'))}</span>` : ''}
        </div>
      </section>
    `).join('') : `<div class="notice">${msg('noColumnsYet', 'No columns yet.')}</div>`;
    target.querySelectorAll('[data-edit-column]').forEach((button) => button.addEventListener('click', () => openColumnDialog(state.columnsDraft[Number(button.dataset.editColumn)], Number(button.dataset.editColumn))));
    target.querySelectorAll('[data-remove-column]').forEach((button) => button.addEventListener('click', () => {
      state.columnsDraft.splice(Number(button.dataset.removeColumn), 1);
      renderColumnsEditor();
    }));
    target.querySelectorAll('[data-move-column]').forEach((button) => button.addEventListener('click', () => {
      const index = Number(button.dataset.moveColumn);
      const direction = Number(button.dataset.direction);
      const swapIndex = index + direction;
      if (swapIndex < 0 || swapIndex >= state.columnsDraft.length) return;
      const [column] = state.columnsDraft.splice(index, 1);
      state.columnsDraft.splice(swapIndex, 0, column);
      renderColumnsEditor();
    }));
  }

  function renderTagSuggestionManager() {
    const target = document.querySelector('#changelogTagSuggestionManager');
    const form = document.querySelector('#changelogSettingsForm');
    if (!target || !form || !state.detail) return;
    const knownTags = collectKnownTags();
    const activeTags = Array.isArray(state.tagSuggestionsDraft) ? state.tagSuggestionsDraft : [];
    target.innerHTML = `
      <div class="changelog-tag-manager">
        <div class="changelog-tag-manager-add">
          <label>${esc(msg('addTag', 'Tag hinzufuegen'))}
            <div class="row-actions">
              <input id="changelogTagSuggestionInput" placeholder="${esc(msg('tagPlaceholder', 'z. B. release'))}">
              <label class="tag-color-control visible" title="${esc(msg('tagColor', 'Tag-Farbe'))}">
                <span>${esc(msg('color', 'Farbe'))}</span>
                <input id="changelogTagSuggestionColor" class="tag-color-input" type="color" value="${esc(defaultTagColor(''))}">
              </label>
              <button class="button small primary" type="button" data-add-tag-suggestion>${esc(msg('add', 'Add'))}</button>
            </div>
          </label>
        </div>
        <div class="changelog-tag-manager-section">
          <strong>${esc(msg('activeTagSuggestions', 'Aktive Tag-Liste'))}</strong>
          <div class="tag-suggestion-list">
            ${activeTags.length ? activeTags.map((tag) => `
              <div class="tag-suggestion-row">
                ${renderTagPill(tag)}
                <label class="tag-color-control" title="${esc(msg('tagColor', 'Tag-Farbe'))}">
                  <span>${esc(msg('color', 'Farbe'))}</span>
                  <input class="tag-color-input" type="color" value="${esc(getTagColor(tag))}" data-tag-color="${esc(tag)}">
                </label>
                <button class="button small ghost" type="button" data-remove-tag-suggestion="${esc(tag)}">${esc(msg('delete', 'Delete'))}</button>
              </div>
            `).join('') : `<span class="hint">${esc(msg('noTagSuggestionsYet', 'Noch keine Tags hinterlegt.'))}</span>`}
          </div>
        </div>
        <div class="changelog-tag-manager-section">
          <strong>${esc(msg('knownTags', 'Bereits verwendete Tags'))}</strong>
          <div class="chip-list">
            ${knownTags.length ? knownTags.map((tag) => `
              <button class="pill tag-pill ${activeTags.includes(tag) ? 'is-active' : ''}" style="${tagColorStyle(tag)}" type="button" data-import-tag-suggestion="${esc(tag)}" ${activeTags.includes(tag) ? 'disabled' : ''}>
                ${esc(tag)}
              </button>
            `).join('') : `<span class="hint">${esc(msg('noKnownTagsYet', 'Noch keine verwendeten Tags gefunden.'))}</span>`}
          </div>
        </div>
      </div>
    `;
    form.elements.tag_suggestions.value = JSON.stringify(buildTagSuggestionPayload());
    target.querySelector('[data-add-tag-suggestion]')?.addEventListener('click', () => {
      const input = target.querySelector('#changelogTagSuggestionInput');
      const colorInput = target.querySelector('#changelogTagSuggestionColor');
      addTagSuggestion(input?.value || '', colorInput?.value || '');
      if (input) input.value = '';
      if (colorInput) colorInput.value = defaultTagColor('');
    });
    target.querySelector('#changelogTagSuggestionInput')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const input = event.currentTarget;
      const colorInput = target.querySelector('#changelogTagSuggestionColor');
      addTagSuggestion(input.value || '', colorInput?.value || '');
      input.value = '';
      if (colorInput) colorInput.value = defaultTagColor('');
    });
    target.querySelectorAll('[data-remove-tag-suggestion]').forEach((button) => button.addEventListener('click', () => {
      state.tagSuggestionsDraft = state.tagSuggestionsDraft.filter((item) => item !== button.dataset.removeTagSuggestion);
      renderTagSuggestionManager();
    }));
    target.querySelectorAll('[data-tag-color]').forEach((input) => input.addEventListener('input', () => {
      setTagColor(input.dataset.tagColor, input.value);
    }));
    target.querySelectorAll('[data-import-tag-suggestion]').forEach((button) => button.addEventListener('click', () => {
      addTagSuggestion(button.dataset.importTagSuggestion);
    }));
  }

  function collectKnownTags() {
    const set = new Set(getEffectiveTagSuggestions());
    Object.values(state.detail?.dynamicOptions || {}).forEach((items) => {
      if (!Array.isArray(items)) return;
      items.forEach((item) => set.add(item));
    });
    (state.entries?.items || []).forEach((entry) => {
      Object.values(entry.values || {}).forEach((value) => {
        if (Array.isArray(value)) value.forEach((item) => set.add(item));
      });
    });
    return Array.from(set).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), 'de'));
  }

  function addTagSuggestion(value, color = '') {
    const tag = String(value || '').trim();
    if (!tag) return;
    if (!Array.isArray(state.tagSuggestionsDraft)) state.tagSuggestionsDraft = [];
    if (!state.tagSuggestionsDraft.includes(tag)) state.tagSuggestionsDraft.push(tag);
    state.tagColorsDraft[tag] = sanitizeTagColor(color) || state.tagColorsDraft[tag] || defaultTagColor(tag);
    state.tagSuggestionsDirty = true;
    state.tagSuggestionsDraft = state.tagSuggestionsDraft
      .map((item) => String(item).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'de'));
    renderTagSuggestionManager();
  }

  function getEffectiveTagSuggestions() {
    return Array.isArray(state.tagSuggestionsDraft)
      ? state.tagSuggestionsDraft
      : Array.isArray(state.detail?.tagSuggestions)
        ? state.detail.tagSuggestions
        : [];
  }

  function buildTagSuggestionPayload() {
    const labels = Array.isArray(state.tagSuggestionsDraft) ? state.tagSuggestionsDraft : parseCsv(document.querySelector('#changelogSettingsForm')?.elements?.tag_suggestions?.value || '');
    return labels.map((label) => ({
      label,
      color: getTagColor(label)
    }));
  }

  function normalizeTagColorMap(value, labels = []) {
    const map = {};
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([label, color]) => {
        const normalizedLabel = String(label || '').trim();
        const normalizedColor = sanitizeTagColor(color);
        if (normalizedLabel && normalizedColor) map[normalizedLabel] = normalizedColor;
      });
    }
    labels.forEach((label) => {
      if (!map[label]) map[label] = defaultTagColor(label);
    });
    return map;
  }

  function hydrateTagDrafts(detail) {
    state.tagSuggestionsDraft = Array.isArray(detail?.tagSuggestions) ? [...detail.tagSuggestions] : [];
    state.tagColorsDraft = normalizeTagColorMap(detail?.tagColors || {}, state.tagSuggestionsDraft);
    state.tagSuggestionsDirty = false;
  }

  function setTagColor(tag, color) {
    const label = String(tag || '').trim();
    const normalized = sanitizeTagColor(color);
    if (!label || !normalized) return;
    state.tagColorsDraft[label] = normalized;
    state.tagSuggestionsDirty = true;
    document.querySelectorAll(`[data-tag-preview="${cssEscape(label)}"]`).forEach((element) => {
      element.style.setProperty('--tag-color', normalized);
    });
    const form = document.querySelector('#changelogSettingsForm');
    if (form?.elements?.tag_suggestions) form.elements.tag_suggestions.value = JSON.stringify(buildTagSuggestionPayload());
  }

  function getTagColor(tag) {
    const label = String(tag || '').trim();
    return sanitizeTagColor(state.tagColorsDraft?.[label])
      || sanitizeTagColor(state.detail?.tagColors?.[label])
      || defaultTagColor(label);
  }

  function defaultTagColor(tag) {
    const palette = ['#2563eb', '#0f766e', '#ea580c', '#7c3aed', '#e11d48', '#16a34a', '#ca8a04', '#0891b2', '#be123c', '#4f46e5'];
    const text = String(tag || '');
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash) + text.charCodeAt(index);
      hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  function sanitizeTagColor(value) {
    const text = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : '';
  }

  function tagColorStyle(tag) {
    return `--tag-color:${getTagColor(tag)}`;
  }

  function renderTagPill(tag) {
    const label = String(tag || '').trim();
    if (!label) return '';
    return `<span class="pill tag-pill" data-tag-preview="${esc(label)}" style="${tagColorStyle(label)}">${esc(label)}</span>`;
  }

  function renderTagSwatch(tag) {
    return `<span class="tag-color-swatch" aria-hidden="true" style="${tagColorStyle(tag)}"></span>`;
  }

  function renderPermissionsEditor() {
    const target = document.querySelector('#changelogPermissionsEditor');
    if (!target || !state.detail) return;
    const permissions = state.detail.permissions || { viewer: [], editor: [], admin: [] };
    target.innerHTML = ['viewer', 'editor', 'admin'].map((key) => `
      <section class="permission-card">
        <div><strong>${esc(permissionTitle(key))}</strong><p class="hint">${esc(permissionHint(key))}</p></div>
        <fieldset>
          <legend>${esc(msg('roles', 'Roles'))}</legend>
          <div class="permission-grid compact">
            ${state.support.roles.map((role) => `
              <label class="check">
                <input type="checkbox" data-permission-key="${esc(key)}" value="${esc(role.name)}" ${(permissions[key] || []).includes(role.name) ? 'checked' : ''}>
                ${esc(role.name)}
              </label>
            `).join('')}
          </div>
        </fieldset>
      </section>
    `).join('');
  }

  function renderAnalytics() {
    const adminTarget = document.querySelector('#changelogAnalyticsPanel');
    const publicTarget = document.querySelector('#changelogPublicAnalytics');
    const html = state.analytics ? `
      <section class="analytics-shell">
        <div class="changelog-metrics analytics-metrics-grid">
          ${renderMetricCard(msg('totalEntries', 'Total entries'), state.analytics.totalEntries, msg('entries', 'Eintraege'))}
          ${renderMetricCard(msg('recentChanges', 'Recent changes (14d)'), state.analytics.recentChanges, msg('lastTwoWeeks', 'letzte 14 Tage'))}
          ${renderMetricCard(msg('lastUpdate', 'Last update'), state.analytics.latestUpdatedAt ? formatDateTime(state.analytics.latestUpdatedAt) : '-', msg('mostRecentActivity', 'neueste Aktivitaet'))}
        </div>
        <div class="analytics-grid">
        ${renderAnalyticsList(msg('topTags', 'Top tags'), state.analytics.topTags)}
        ${renderAnalyticsList(msg('statusDistribution', 'Status distribution'), state.analytics.statusDistribution)}
        ${renderAnalyticsList(msg('entriesByCreator', 'Entries by creator'), state.analytics.entriesByCreator)}
        </div>
      </section>
    ` : `<div class="notice">${esc(msg('analyticsUnavailable', 'Analytics are unavailable.'))}</div>`;
    if (adminTarget) adminTarget.innerHTML = html;
    if (publicTarget) publicTarget.innerHTML = html;
  }

  function renderMetricCard(label, value, meta = '') {
    return `
      <article class="metric-card">
        <span class="metric-label">${esc(label)}</span>
        <strong class="metric-value">${esc(value)}</strong>
        <small class="metric-meta">${esc(meta)}</small>
      </article>
    `;
  }

  function renderAnalyticsList(title, items) {
    const maxCount = Array.isArray(items) && items.length
      ? Math.max(...items.map((item) => Number(item.count || 0)), 1)
      : 1;
    return `
      <section class="panel analytics-panel">
        <div class="panel-head compact analytics-panel-head">
          <div>
            <h2>${esc(title)}</h2>
            <p class="hint">${esc(Array.isArray(items) && items.length ? `${items.length} ${msg('results', 'Ergebnisse')}` : msg('noData', 'No data yet.'))}</p>
          </div>
        </div>
        ${Array.isArray(items) && items.length ? `
          <div class="analytics-list">
            ${items.map((item) => `
              <div class="analytics-item">
                <div class="analytics-item-main">
                  <div class="analytics-item-copy">
                    <span class="analytics-item-label">${esc(item.label || '-')}</span>
                    <span class="analytics-item-bar"><span style="width:${Math.max(10, Math.round((Number(item.count || 0) / maxCount) * 100))}%"></span></span>
                  </div>
                  <strong class="analytics-item-value">${esc(item.count)}</strong>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `<div class="analytics-empty"><p class="hint">${esc(msg('noData', 'No data yet.'))}</p></div>`}
      </section>
    `;
  }

  async function reloadData() {
    await Promise.all([refreshEntries(), refreshAnalytics()]);
    if (state.detail) {
      state.detail.dynamicOptions = {
        ...(state.detail.dynamicOptions || {}),
        ...Object.fromEntries(
          (state.detail.columns || [])
            .filter((column) => column.type === 'tags' || column.type === 'multi_select')
            .map((column) => [column.key, buildEditorOptions(column, state.editor.values[column.key])])
        )
      };
      renderTagSuggestionManager();
    }
  }

  async function saveListSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const result = await fetchJson('/api/admin/changelogs/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: form.elements.id.value || undefined,
          slug: form.elements.slug.value,
          title: form.elements.title.value,
          status: form.elements.status.value,
          description: form.elements.description.value,
          intro_text: form.elements.intro_text.value,
          tag_suggestions: buildTagSuggestionPayload()
        })
      });
      await refreshAdmin();
      if (result?.slug) await loadAdminList(result.slug);
      showToast(msg('settingsSaved', 'Settings saved.'));
    } catch (error) {
      renderError(error);
    }
  }

  async function saveColumnsDraft() {
    if (!state.detail) return;
    try {
      await fetchJson('/api/admin/changelogs/columns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: state.detail.slug,
          columns: state.columnsDraft
        })
      });
      await loadAdminList(state.detail.slug);
      showToast(msg('columnsSaved', 'Columns saved.'));
    } catch (error) {
      renderError(error);
    }
  }

  async function savePermissions() {
    if (!state.detail) return;
    const permissions = { viewer: [], editor: [], admin: [] };
    document.querySelectorAll('[data-permission-key]:checked').forEach((input) => {
      permissions[input.dataset.permissionKey].push(input.value);
    });
    try {
      await fetchJson('/api/admin/changelogs/permissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: state.detail.slug,
          permissions
        })
      });
      await loadAdminList(state.detail.slug);
      showToast(msg('permissionsSaved', 'Permissions saved.'));
    } catch (error) {
      renderError(error);
    }
  }

  function openCreateListDialog() {
    const dialog = modal(`
      <form class="modal-form">
        <h2>${msg('createList', 'Create list')}</h2>
        <label>${msg('title', 'Title')} <input name="title" required placeholder="Release Notes"></label>
        <label>${msg('slug', 'Slug')} <input name="slug" required placeholder="release-notes"></label>
        <label>${msg('description', 'Description')} <textarea name="description"></textarea></label>
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
        const result = await fetchJson('/api/admin/changelogs/list', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: form.get('title'),
            slug: form.get('slug'),
            description: form.get('description')
          })
        });
        dialog.remove();
        await refreshAdmin();
        if (result?.slug) await loadAdminList(result.slug);
        showToast(msg('listCreated', 'List created.'));
      } catch (error) {
        renderError(error);
      }
    });
  }

  function openColumnDialog(column = null, index = null) {
    const editMode = Number.isInteger(index);
    const dialog = modal(`
      <form class="modal-form">
        <h2>${editMode ? msg('editColumn', 'Edit column') : msg('addColumn', 'Add column')}</h2>
        <div class="content-meta">
          <label>${msg('label', 'Label')} <input name="label" required value="${esc(column?.label || '')}"></label>
          <label>${msg('key', 'Key')} <input name="key" required value="${esc(column?.key || '')}" placeholder="status"></label>
          <label>${msg('type', 'Type')}
            <select name="type">
              ${['text', 'long_text', 'number', 'date', 'single_select', 'multi_select', 'status', 'user', 'tags', 'boolean'].map((type) => `<option value="${type}" ${column?.type === type ? 'selected' : ''}>${esc(type)}</option>`).join('')}
            </select>
          </label>
        </div>
        <p class="hint">${esc(msg('systemColumnsHint', 'Systemspalten wie Ersteller und Aktualisierung werden automatisch eingeblendet und muessen nicht als eigene Spalten angelegt werden.'))}</p>
        <label>${msg('optionsCsv', 'Options (comma separated)')} <input name="options" value="${esc((column?.options || []).join(', '))}" placeholder="open, in_progress, done"></label>
        <div class="content-meta">
          <label>${msg('width', 'Width')} <input name="width" value="${esc(column?.width || '')}" placeholder="14rem"></label>
          <label class="check"><input name="required" type="checkbox" ${column?.required ? 'checked' : ''}> ${msg('required', 'Required')}</label>
          <label class="check"><input name="visible" type="checkbox" ${column?.visible !== false ? 'checked' : ''}> ${msg('visible', 'Visible')}</label>
          <label class="check"><input name="sortable" type="checkbox" ${column?.sortable !== false ? 'checked' : ''}> ${msg('sortable', 'Sortable')}</label>
          <label class="check"><input name="filterable" type="checkbox" ${column?.filterable !== false ? 'checked' : ''}> ${msg('filterable', 'Filterable')}</label>
        </div>
        <label>${msg('defaultValue', 'Default value')} <input name="default_value" value="${esc(formatDefaultValue(column?.defaultValue))}"></label>
        <div class="modal-actions">
          <button class="button" type="button" data-close>${msg('cancel', 'Cancel')}</button>
          <button class="button primary" type="submit">${msg('save', 'Save')}</button>
        </div>
      </form>
    `);
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const type = String(form.get('type') || 'text');
      const nextColumn = {
        id: column?.id,
        key: String(form.get('key') || '').trim(),
        label: String(form.get('label') || '').trim(),
        type,
        options: parseCsv(form.get('options')),
        width: String(form.get('width') || '').trim(),
        required: form.get('required') === 'on',
        visible: form.get('visible') === 'on',
        sortable: form.get('sortable') === 'on',
        filterable: form.get('filterable') === 'on',
        defaultValue: parseDefaultValue(type, form.get('default_value'))
      };
      if (editMode) state.columnsDraft[index] = nextColumn;
      else state.columnsDraft.push(nextColumn);
      renderColumnsEditor();
      renderTagSuggestionManager();
      dialog.remove();
    });
  }

  async function exportCurrentCsv() {
    if (!state.detail) return;
    const params = buildSharedQueryParams();
    window.location.href = `/api/changelogs/export.csv?${params.toString()}`;
  }

  function permissionTitle(key) {
    return {
      viewer: msg('viewers', 'Viewers'),
      editor: msg('editors', 'Editors'),
      admin: msg('admins', 'Admins')
    }[key] || key;
  }

  function permissionHint(key) {
    return {
      viewer: msg('viewerHint', 'May open and filter the list.'),
      editor: msg('editorHint', 'May create entries and edit their own entries.'),
      admin: msg('adminHint', 'May manage structure, permissions and all entries.')
    }[key] || '';
  }

  function syncAdminUrl() {
    if (!adminRoot || !state.selectedSlug) return;
    history.replaceState({}, '', `/admin/changelogs/${encodeURIComponent(state.selectedSlug)}`);
  }

  function renderPublicError(error) {
    const box = document.querySelector('#changelogPublicError');
    if (box) {
      box.hidden = false;
      box.innerHTML = `<strong>${esc(msg('unexpectedError', 'An unexpected error occurred.'))}</strong><p>${esc(error?.message || String(error))}</p>`;
    }
  }

  function renderError(error) {
    const box = document.querySelector('#changelogAdminError');
    if (box) {
      box.hidden = false;
      box.innerHTML = `<strong>${esc(msg('unexpectedError', 'An unexpected error occurred.'))}</strong><p>${esc(error?.message || String(error))}</p>`;
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      renderPublicError(error);
    }
  }

  function clearError() {
    document.querySelectorAll('#changelogAdminError, #changelogPublicError').forEach((box) => {
      box.hidden = true;
      box.textContent = '';
    });
  }

  function showToast(message) {
    let toast = document.querySelector('[data-changelog-toast]');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'admin-toast success';
      toast.setAttribute('data-changelog-toast', '');
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(state.toastTimeout);
    state.toastTimeout = setTimeout(() => {
      toast.hidden = true;
    }, 2400);
  }

  function formatDateTime(value) {
    if (!value) return '-';
    try {
      return new Intl.DateTimeFormat(I18N.locale || 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    } catch {
      return value;
    }
  }

  function parseCsv(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  }

  function parseDefaultValue(type, value) {
    if (type === 'multi_select' || type === 'tags') return parseCsv(value);
    if (type === 'boolean') return String(value || '').trim().toLowerCase() === 'true';
    if (type === 'number') return value === '' ? null : Number(value);
    return value === '' ? null : String(value || '').trim();
  }

  function formatDefaultValue(value) {
    if (Array.isArray(value)) return value.join(', ');
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function modal(html) {
    const wrapper = document.createElement('div');
    wrapper.className = 'modal-backdrop';
    wrapper.innerHTML = `<div class="modal-card">${html}</div>`;
    wrapper.addEventListener('click', (event) => {
      if (event.target === wrapper || event.target.closest('[data-close]')) wrapper.remove();
    });
    document.body.appendChild(wrapper);
    return wrapper;
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || response.statusText);
    return payload;
  }

  function esc(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cssEscape(value = '') {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function buildFloatingMenuStyle(rect, { preferredWidth = 320, preferredHeight = 360 } = {}) {
    const width = Math.min(preferredWidth, Math.max(220, window.innerWidth - 24));
    const unclampedTop = rect.bottom + 8;
    const maxHeight = Math.max(180, window.innerHeight - 24);
    const availableHeight = Math.min(preferredHeight, maxHeight);
    const maxTop = Math.max(12, window.innerHeight - availableHeight - 12);
    const top = Math.max(12, Math.min(maxTop, unclampedTop));
    const maxLeft = Math.max(12, window.innerWidth - width - 12);
    const left = Math.max(12, Math.min(rect.left, maxLeft));
    return {
      position: 'fixed',
      top: `${top}px`,
      left: `${left}px`,
      width: `${width}px`,
      maxHeight: `${Math.max(180, window.innerHeight - top - 12)}px`
    };
  }

  function inlineStyle(style) {
    if (!style) return '';
    return Object.entries(style).map(([key, value]) => `${key}:${value}`).join(';');
  }

  function readPortalI18n() {
    try {
      return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}');
    } catch {
      return {};
    }
  }
})();
