const I18N = readPortalI18n().messages || {};
const msg = (key, fallback) => I18N[key] || fallback || key;
const savedTheme = localStorage.getItem('atlas-theme') || localStorage.getItem('isms-theme') || document.body.dataset.defaultTheme || 'light';
document.documentElement.dataset.theme = savedTheme;

document.addEventListener('click', (event) => {
  const opener = event.target.closest('[data-sidebar-open]');
  const closer = event.target.closest('[data-sidebar-close]');
  const toggle = event.target.closest('[data-toggle-section]');
  const themeToggle = event.target.closest('[data-theme-toggle]');
  const copyCode = event.target.closest('[data-copy-code]');
  const navDropdownTrigger = event.target.closest('[data-nav-dropdown-trigger]');
  const languageSelect = event.target.closest('select.language-select');
  const profileOpen = event.target.closest('[data-profile-open]');
  const profileClose = event.target.closest('[data-profile-close]');
  const passwordOpen = event.target.closest('[data-password-open]');
  const passwordClose = event.target.closest('[data-password-close]');
  const profile = document.querySelector('[data-profile-popover]');
  const passwordModal = document.querySelector('[data-password-modal]');

  if (opener) document.body.classList.add('sidebar-open');
  if (closer) document.body.classList.remove('sidebar-open');
  if (toggle) toggle.closest('.nav-group')?.classList.toggle('collapsed');
  if (navDropdownTrigger) toggleNavDropdown(navDropdownTrigger);
  if (themeToggle) {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('atlas-theme', next);
  }
  if (languageSelect) updateLanguageFlag(languageSelect);
  if (copyCode) copyCodeToClipboard(copyCode);
  if (profileOpen && profile) profile.hidden = !profile.hidden;
  if (profileClose && profile) profile.hidden = true;
  if (passwordOpen && passwordModal) {
    if (profile) profile.hidden = true;
    passwordModal.hidden = false;
  }
  if ((passwordClose || event.target === passwordModal) && passwordModal) passwordModal.hidden = true;
  if (profile && !profile.hidden && !event.target.closest('[data-profile-popover]') && !profileOpen) {
    profile.hidden = true;
  }
  if (!event.target.closest('[data-nav-dropdown]')) {
    closeNavDropdowns();
  }
});

document.addEventListener('change', (event) => {
  const languageSelect = event.target.closest('select.language-select');
  if (languageSelect) updateLanguageFlag(languageSelect);
});

async function copyCodeToClipboard(button) {
  const wrapper = button.closest('.code-block-wrap');
  const code = wrapper?.querySelector('code');
  if (!code) return;
  const defaultLabel = button.dataset.copyDefault || 'Copy';
  const successLabel = button.dataset.copySuccess || 'Copied';
  try {
    await navigator.clipboard.writeText(code.textContent || '');
    button.textContent = successLabel;
    setTimeout(() => {
      button.textContent = defaultLabel;
    }, 1400);
  } catch {
    button.textContent = 'Failed';
    setTimeout(() => {
      button.textContent = defaultLabel;
    }, 1400);
  }
}

function updateLanguageFlag(select) {
  const flagCode = select.selectedOptions?.[0]?.dataset.flag;
  if (!flagCode) return;

  const wrapper = select.closest('.language-select-wrapper');
  const flagImage = wrapper?.querySelector('.language-select-flag');
  if (!flagImage) return;

  flagImage.src = `/assets/flags/4x3/${flagCode}.svg`;
  flagImage.alt = select.selectedOptions?.[0]?.textContent || '';
}

document.querySelector('[data-profile-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const response = await fetch('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(form.entries()))
  });
  if (!response.ok) {
    const text = await response.text();
    try {
      alert(JSON.parse(text).error || text);
    } catch {
      alert(text);
    }
    return;
  }
  location.reload();
});

document.querySelector('[data-password-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const password = String(form.get('password') || '');
  const passwordConfirm = String(form.get('password_confirm') || '');
  if (password !== passwordConfirm) {
    alert(msg('passwordMismatch', 'Die neuen Passwoerter stimmen nicht ueberein.'));
    return;
  }
  const profileForm = document.querySelector('[data-profile-form]');
  const profileData = new FormData(profileForm);
  const response = await fetch('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: profileData.get('name'),
      email: profileData.get('email'),
      language: profileData.get('language'),
      current_password: form.get('current_password'),
      password,
      password_confirm: passwordConfirm
    })
  });
  if (!response.ok) {
    const text = await response.text();
    try {
      alert(JSON.parse(text).error || text);
    } catch {
      alert(text);
    }
    return;
  }
  location.reload();
});

initNetworkBackground();
initDownloadsApp();

function readPortalI18n() {
  try {
    return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}');
  } catch {
    return {};
  }
}

function initNetworkBackground() {
  const canvas = document.querySelector('[data-network-bg]');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const points = Array.from({ length: 42 }, () => ({
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.00045,
    vy: (Math.random() - 0.5) * 0.00045,
    size: 1.8 + Math.random() * 2.4
  }));

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * devicePixelRatio));
    canvas.height = Math.max(1, Math.floor(rect.height * devicePixelRatio));
  };

  const draw = () => {
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    for (const point of points) {
      point.x += point.vx;
      point.y += point.vy;
      if (point.x < 0 || point.x > 1) point.vx *= -1;
      if (point.y < 0 || point.y > 1) point.vy *= -1;
    }

    ctx.lineWidth = 1 * devicePixelRatio;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        const dx = (a.x - b.x) * width;
        const dy = (a.y - b.y) * height;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const maxDistance = 145 * devicePixelRatio;
        if (distance >= maxDistance) continue;
        const alpha = (1 - distance / maxDistance) * 0.22;
        ctx.strokeStyle = `rgba(182, 221, 255, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(a.x * width, a.y * height);
        ctx.lineTo(b.x * width, b.y * height);
        ctx.stroke();
      }
    }

    for (const point of points) {
      const x = point.x * width;
      const y = point.y * height;
      const radius = point.size * devicePixelRatio;
      ctx.fillStyle = 'rgba(232, 243, 255, 0.92)';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    requestAnimationFrame(draw);
  };

  resize();
  addEventListener('resize', resize);
  requestAnimationFrame(draw);
}

function toggleNavDropdown(trigger) {
  const dropdown = trigger.closest('[data-nav-dropdown]');
  const isOpen = dropdown?.classList.contains('open');
  closeNavDropdowns();
  if (!dropdown || isOpen) return;
  dropdown.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
}

function closeNavDropdowns() {
  document.querySelectorAll('[data-nav-dropdown].open').forEach((dropdown) => {
    dropdown.classList.remove('open');
    dropdown.querySelector('[data-nav-dropdown-trigger]')?.setAttribute('aria-expanded', 'false');
  });
}

async function initDownloadsApp() {
  const shell = document.querySelector('[data-downloads-app]');
  if (!shell) return;

  const treeTarget = document.querySelector('#downloadTree');
  const emptyState = document.querySelector('#downloadExplorerEmpty');
  const detailTarget = document.querySelector('#downloadFileView');
  let activeFileId = new URLSearchParams(location.search).get('file');

  try {
    const response = await fetch('/api/downloads/tree');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load files.');
    const tree = Array.isArray(data.tree) ? data.tree : [];
    treeTarget.innerHTML = tree.length
      ? renderDownloadExplorer(tree, activeFileId)
      : `<div class="notice">${msg('noFiles', 'No files available for your roles yet.')}</div>`;

    treeTarget.querySelectorAll('[data-download-file]').forEach((button) => button.addEventListener('click', async () => {
      activeFileId = button.dataset.downloadFile;
      syncDownloadUrl(activeFileId);
      treeTarget.innerHTML = renderDownloadExplorer(tree, activeFileId);
      await loadDownloadDetail(activeFileId, detailTarget, emptyState);
      bindDownloadLinks(tree, activeFileId, detailTarget, emptyState);
    }));

    bindDownloadLinks(tree, activeFileId, detailTarget, emptyState);

    const firstFileId = activeFileId || findFirstDownloadId(tree);
    if (firstFileId) {
      activeFileId = firstFileId;
      syncDownloadUrl(activeFileId);
      treeTarget.innerHTML = renderDownloadExplorer(tree, activeFileId);
      bindDownloadLinks(tree, activeFileId, detailTarget, emptyState);
      await loadDownloadDetail(activeFileId, detailTarget, emptyState);
    } else {
      emptyState.hidden = false;
      detailTarget.hidden = true;
    }
  } catch (error) {
    emptyState.innerHTML = `<h1>${msg('unexpectedError', 'An unexpected error occurred.')}</h1><p>${escapeHtml(error.message || String(error))}</p>`;
  }
}

function bindDownloadLinks(tree, activeFileId, detailTarget, emptyState) {
  const treeTarget = document.querySelector('#downloadTree');
  treeTarget.querySelectorAll('[data-download-file]').forEach((button) => button.addEventListener('click', async () => {
    const nextFileId = button.dataset.downloadFile;
    syncDownloadUrl(nextFileId);
    treeTarget.innerHTML = renderDownloadExplorer(tree, nextFileId);
    bindDownloadLinks(tree, nextFileId, detailTarget, emptyState);
    await loadDownloadDetail(nextFileId, detailTarget, emptyState);
  }));
}

function renderDownloadExplorer(nodes, activeFileId) {
  return nodes.map((node) => {
    if (node.type === 'file') {
      return `<button class="nav-link ${String(node.id) === String(activeFileId) ? 'active' : ''}" type="button" data-download-file="${escapeHtml(node.id)}">${escapeHtml(node.name)}</button>`;
    }
    return `
      <section class="nav-group active-group">
        <div class="nav-group-title">
          <span class="nav-category-label">${escapeHtml(node.label || node.relativeDir || 'Folder')}</span>
        </div>
        <div class="nav-group-items">${renderDownloadExplorer(node.children || [], activeFileId)}</div>
      </section>
    `;
  }).join('');
}

function findFirstDownloadId(nodes) {
  for (const node of nodes) {
    if (node.type === 'file') return node.id;
    const nested = findFirstDownloadId(node.children || []);
    if (nested) return nested;
  }
  return '';
}

async function loadDownloadDetail(id, detailTarget, emptyState) {
  const isAdmin = document.querySelector('[data-downloads-app]')?.dataset.isAdmin === 'true';
  const response = await fetch(`/api/downloads/file?id=${encodeURIComponent(id)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to load file details.');
  emptyState.hidden = true;
  detailTarget.hidden = false;
  detailTarget.innerHTML = `
    <div class="panel-head">
      <h2>${escapeHtml(data.name)}</h2>
      <a class="button primary" href="${escapeHtml(data.downloadHref)}">${msg('download', 'Download')}</a>
    </div>
    <div class="content-editor-body">
      <div class="content-meta">
        <label>${msg('folderPath', 'Folder path')}<input value="${escapeHtml(data.relativeDir || '/')}" readonly></label>
        <label>${msg('mimeType', 'MIME type')}<input value="${escapeHtml(data.mimeType || '')}" readonly></label>
        <label>${msg('tags', 'Tags')}<input value="${escapeHtml((data.tags || []).join(', '))}" readonly></label>
        <label>${msg('roles', 'Roles')}<input value="${escapeHtml((data.roles || []).join(', ') || msg('all', 'All'))}" readonly></label>
      </div>
      <label>${msg('description', 'Description')}<textarea readonly>${escapeHtml(data.description || '')}</textarea></label>
      ${data.isText ? `<label>${msg('textContent', 'Text content')}<textarea class="code-input content-raw-input" readonly>${escapeHtml(data.contentText || '')}</textarea></label>` : `<div class="notice">${msg('binaryPreviewHint', 'This file is binary and can be downloaded directly.')}</div>`}
      <div class="modal-actions">
        <span class="hint">${msg('updated', 'Updated')}: ${escapeHtml(data.updatedAt || '-')}</span>
        ${isAdmin ? `<a class="button ghost" href="/admin?tab=downloads&download=${encodeURIComponent(data.id)}">${msg('manageInAdmin', 'Manage in admin')}</a>` : ''}
      </div>
    </div>
  `;
}

function syncDownloadUrl(fileId) {
  const url = new URL(location.href);
  if (fileId) url.searchParams.set('file', fileId);
  else url.searchParams.delete('file');
  history.replaceState({}, '', url);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
