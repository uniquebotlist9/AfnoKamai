// ─── Theme: light / dark / system (persisted, no flash) ──────────────
const KEY = 'ak_theme';

export function getTheme() {
  try { return localStorage.getItem(KEY) || 'system'; } catch (_) { return 'system'; }
}

function apply(theme) {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = resolved;
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch (_) {}
  apply(theme);
  window.dispatchEvent(new CustomEvent('ak-theme-changed', { detail: getTheme() }));
}

export function initTheme() {
  apply(getTheme());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system') apply('system');
  });
}

/** Renders a Light/Dark/System segmented control into `container`. */
export function mountThemeControl(container) {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.gap = '6px';
  wrap.innerHTML = `
    <div class="segmented" role="group" aria-label="Theme">
      ${['light', 'dark', 'system'].map((t) =>
        `<button type="button" data-theme-opt="${t}" class="${getTheme() === t ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>`;
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-opt]');
    if (!btn) return;
    setTheme(btn.dataset.themeOpt);
    wrap.querySelectorAll('[data-theme-opt]').forEach((b) =>
      b.classList.toggle('active', b.dataset.themeOpt === getTheme()));
  });
  container.appendChild(wrap);
}
