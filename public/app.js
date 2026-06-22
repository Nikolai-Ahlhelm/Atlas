const I18N = readPortalI18n().messages || {};
const msg = (key, fallback) => I18N[key] || fallback || key;
const savedTheme = localStorage.getItem('atlas-theme') || localStorage.getItem('isms-theme') || document.body.dataset.defaultTheme || 'light';
const ADMIN_POPUP_STORAGE_KEY = 'atlas-admin-popup-flash';
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

initAdminPopupManager();
initNetworkBackground();

function readPortalI18n() {
  try {
    return JSON.parse(document.querySelector('#portal-i18n')?.textContent || '{}');
  } catch {
    return {};
  }
}

function initAdminPopupManager() {
  const state = {
    element: null,
    hideTimer: null
  };

  window.DisplayPopupMsg = (message, options = {}) => {
    const text = String(message || '').trim();
    if (!text) return;
    const popup = ensureAdminPopup(state);
    const duration = Math.max(1200, Number(options.duration) || 3200);
    const tone = options.tone === 'error' ? 'error' : 'success';
    popup.className = `admin-toast ${tone}`;
    popup.querySelector('[data-admin-popup-message]').textContent = text;
    popup.hidden = false;
    popup.setAttribute('aria-hidden', 'false');

    const progress = popup.querySelector('[data-admin-popup-progress]');
    progress.style.transition = 'none';
    progress.style.transform = 'scaleX(1)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        progress.style.transition = `transform ${duration}ms linear`;
        progress.style.transform = 'scaleX(0)';
      });
    });

    window.clearTimeout(state.hideTimer);
    state.hideTimer = window.setTimeout(() => {
      hideAdminPopup(state);
    }, duration);
  };

  window.DisplayPopupMsgAfterReload = (message, options = {}) => {
    try {
      sessionStorage.setItem(ADMIN_POPUP_STORAGE_KEY, JSON.stringify({
        message: String(message || ''),
        tone: options.tone === 'error' ? 'error' : 'success',
        duration: Math.max(1200, Number(options.duration) || 3200)
      }));
    } catch {}
  };

  window.ClosePopupMsg = () => hideAdminPopup(state);
  showQueuedAdminPopup();
}

function ensureAdminPopup(state) {
  if (state.element) return state.element;
  const popup = document.createElement('div');
  popup.className = 'admin-toast success';
  popup.hidden = true;
  popup.setAttribute('role', 'status');
  popup.setAttribute('aria-live', 'polite');
  popup.setAttribute('aria-hidden', 'true');
  popup.innerHTML = `
    <div class="admin-toast__body">
      <p class="admin-toast__message" data-admin-popup-message></p>
      <button class="admin-toast__close" type="button" aria-label="${escapeHtml(msg('close', 'Close'))}" data-admin-popup-close>x</button>
    </div>
    <div class="admin-toast__progress-track" aria-hidden="true">
      <span class="admin-toast__progress" data-admin-popup-progress></span>
    </div>
  `;
  popup.querySelector('[data-admin-popup-close]')?.addEventListener('click', () => hideAdminPopup(state));
  document.body.appendChild(popup);
  state.element = popup;
  return popup;
}

function hideAdminPopup(state) {
  window.clearTimeout(state.hideTimer);
  if (!state.element) return;
  state.element.hidden = true;
  state.element.setAttribute('aria-hidden', 'true');
}

function showQueuedAdminPopup() {
  try {
    const raw = sessionStorage.getItem(ADMIN_POPUP_STORAGE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(ADMIN_POPUP_STORAGE_KEY);
    const payload = JSON.parse(raw);
    if (payload?.message) window.DisplayPopupMsg(payload.message, payload);
  } catch {}
}

function initNetworkBackground() {
  const canvas = document.querySelector('[data-network-bg]');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let points = [];
  let animationFrame = 0;
  let metrics = {
    widthCss: 0,
    heightCss: 0,
    dpr: 1,
    maxDistance: 120,
    lineAlpha: 0.18
  };

  const createPoint = () => ({
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.00038,
    vy: (Math.random() - 0.5) * 0.00038,
    size: 1.6 + Math.random() * 2.2
  });

  const rebuildPoints = () => {
    const area = metrics.widthCss * metrics.heightCss;
    const baseCount = Math.round(area / 36000);
    const mobileAdjustment = metrics.widthCss < 720 ? -5 : 0;
    const count = Math.max(14, Math.min(42, baseCount + mobileAdjustment));
    points = Array.from({ length: count }, createPoint);
    metrics.maxDistance = Math.max(92, Math.min(180, metrics.widthCss * 0.15)) * metrics.dpr;
    metrics.lineAlpha = metrics.widthCss < 720 ? 0.1 : 0.16;
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    metrics.widthCss = Math.max(1, rect.width);
    metrics.heightCss = Math.max(1, rect.height);
    metrics.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.floor(metrics.widthCss * metrics.dpr));
    canvas.height = Math.max(1, Math.floor(metrics.heightCss * metrics.dpr));
    rebuildPoints();
  };

  const draw = () => {
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    for (const point of points) {
      if (!reducedMotion.matches) {
        point.x += point.vx;
        point.y += point.vy;
        if (point.x < 0 || point.x > 1) point.vx *= -1;
        if (point.y < 0 || point.y > 1) point.vy *= -1;
      }
    }

    ctx.lineWidth = 1 * metrics.dpr;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        const dx = (a.x - b.x) * width;
        const dy = (a.y - b.y) * height;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const maxDistance = metrics.maxDistance;
        if (distance >= maxDistance) continue;
        const alpha = (1 - distance / maxDistance) * metrics.lineAlpha;
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
      const radius = point.size * metrics.dpr;
      ctx.fillStyle = 'rgba(232, 243, 255, 0.92)';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    animationFrame = requestAnimationFrame(draw);
  };

  resize();
  addEventListener('resize', resize);
  reducedMotion.addEventListener?.('change', resize);
  animationFrame = requestAnimationFrame(draw);
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

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
