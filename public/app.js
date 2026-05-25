const I18N = readPortalI18n().messages || {};
const msg = (key, fallback) => I18N[key] || fallback || key;
const savedTheme = localStorage.getItem('atlas-theme') || localStorage.getItem('isms-theme') || document.body.dataset.defaultTheme || 'light';
document.documentElement.dataset.theme = savedTheme;

document.addEventListener('click', (event) => {
  const opener = event.target.closest('[data-sidebar-open]');
  const closer = event.target.closest('[data-sidebar-close]');
  const toggle = event.target.closest('[data-toggle-section]');
  const themeToggle = event.target.closest('[data-theme-toggle]');
  const profileOpen = event.target.closest('[data-profile-open]');
  const profileClose = event.target.closest('[data-profile-close]');
  const passwordOpen = event.target.closest('[data-password-open]');
  const passwordClose = event.target.closest('[data-password-close]');
  const profile = document.querySelector('[data-profile-popover]');
  const passwordModal = document.querySelector('[data-password-modal]');

  if (opener) document.body.classList.add('sidebar-open');
  if (closer) document.body.classList.remove('sidebar-open');
  if (toggle) toggle.closest('.nav-group')?.classList.toggle('collapsed');
  if (themeToggle) {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('atlas-theme', next);
  }
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
});

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
  const points = Array.from({ length: 54 }, () => ({
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.00045,
    vy: (Math.random() - 0.5) * 0.00045
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
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1 * devicePixelRatio;

    for (const point of points) {
      point.x += point.vx;
      point.y += point.vy;
      if (point.x < 0 || point.x > 1) point.vx *= -1;
      if (point.y < 0 || point.y > 1) point.vy *= -1;
    }

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        const dx = (a.x - b.x) * width;
        const dy = (a.y - b.y) * height;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 170 * devicePixelRatio) {
          ctx.globalAlpha = 1 - distance / (170 * devicePixelRatio);
          ctx.beginPath();
          ctx.moveTo(a.x * width, a.y * height);
          ctx.lineTo(b.x * width, b.y * height);
          ctx.stroke();
        }
      }
    }

    ctx.globalAlpha = 1;
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, 2.4 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }

    requestAnimationFrame(draw);
  };

  resize();
  addEventListener('resize', resize);
  requestAnimationFrame(draw);
}
