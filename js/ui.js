// ─── UI primitives: toasts, modals, dialogs, states, badges ──────────
import { esc } from './utils.js';
import { icon } from './icons.js';

// ── Toasts ──
let toastStack;
function ensureToastStack() {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    toastStack.setAttribute('role', 'status');
    toastStack.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastStack);
  }
  return toastStack;
}

/**
 * `action` renders an extra button inside the toast ({ label, onClick }) —
 * used by high-priority notifications that must deep-link (e.g. "Open chat").
 */
export function toast(message, { type = 'info', title = '', duration = 4200, action = null } = {}) {
  const icons = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <span class="toast-ic">${icon(icons[type] || 'info')}</span>
    <div class="toast-body">
      ${title ? `<div class="toast-title">${esc(title)}</div>` : ''}
      <div class="toast-msg">${esc(message)}</div>
    </div>
    <button class="toast-x" aria-label="Dismiss">${icon('x')}</button>`;
  const remove = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('.toast-x').addEventListener('click', remove);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-act';
    btn.type = 'button';
    btn.textContent = action.label || 'Open';
    btn.addEventListener('click', () => { remove(); action.onClick && action.onClick(); });
    el.querySelector('.toast-body').appendChild(btn);
  }
  ensureToastStack().appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  if (duration) setTimeout(remove, duration);
  return remove;
}

// ── Modal ──
export function modal({ title = '', body = '', actions = null, width = 520, onClose = null, dismissible = true } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:${width}px" role="dialog" aria-modal="true" ${title ? `aria-label="${esc(title)}"` : ''}>
      ${title ? `<div class="modal-head"><h3>${esc(title)}</h3><button class="modal-x btn-icon" aria-label="Close">${icon('x')}</button></div>` : '<button class="modal-x btn-icon floating" aria-label="Close">' + icon('x') + '</button>'}
      <div class="modal-body">${body}</div>
      ${actions ? `<div class="modal-foot">${actions}</div>` : ''}
    </div>`;
  const close = (val) => {
    document.removeEventListener('keydown', keyHandler);
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
    overlay.classList.add('closing'); setTimeout(() => { overlay.remove(); onClose && onClose(val); }, 160);
  };
  const lastFocus = document.activeElement;
  if (dismissible) {
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    const x = overlay.querySelector('.modal-x');
    if (x) x.addEventListener('click', () => close());
  }
  // Focus trap: Tab cycles inside the dialog and Escape closes it, so keyboard
  // users are never dropped behind the overlay.
  const keyHandler = (e) => {
    if (e.key === 'Escape' && dismissible) { close(); return; }
    if (e.key !== 'Tab') return;
    const focusables = overlay.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', keyHandler);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const focusable = overlay.querySelector('input, select, textarea, button.btn');
  if (focusable) setTimeout(() => focusable.focus(), 120);
  return { root: overlay, close };
}

/** Confirmation dialog. Resolves true/false; requireText returns the typed text. */
export function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false, requireText = null, requireTextPlaceholder = '' } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      width: 460,
      body: `
        ${message ? `<p class="confirm-msg">${esc(message)}</p>` : ''}
        ${requireText ? `
          <label class="label">Type "<strong>${esc(requireText)}</strong>" to confirm</label>
          <input class="input" id="cd-text" type="text" placeholder="${esc(requireTextPlaceholder)}" autocomplete="off">` : ''}`,
      actions: `
        <button class="btn ghost" data-act="cancel">${esc(cancelText)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(confirmText)}</button>`,
      onClose: () => resolve(null)
    });
    m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
    const okBtn = m.root.querySelector('[data-act="ok"]');
    okBtn.addEventListener('click', () => {
      if (requireText) {
        const v = m.root.querySelector('#cd-text').value.trim();
        if (v !== requireText) { m.root.querySelector('#cd-text').classList.add('invalid'); return; }
        resolve(v);
      } else resolve(true);
      m.close();
    });
  });
}

// ── Buttons: loading state helper ──
export function btnBusy(btn, busy, busyText = 'Please wait…') {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.innerHTML = `<span class="spin"></span>${esc(busyText)}`;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

// ── Auto pagination (no "Load more" buttons — lists load themselves) ──
/**
 * Turns a one-page loader into a loader that keeps going until everything is
 * loaded.
 *
 * `page(reset, run)` fetches and renders exactly one page, then resolves with
 * the cursor for the next page — or null when the list is exhausted. `run` is
 * the current run: starting a newer run marks the old one stale, and a stale
 * run stops right after its in-flight request instead of appending rows from
 * the previous tab/filter.
 */
export function autoPager(page) {
  let current = null;
  return async function loadAll(reset = true) {
    if (current) current.stale = true;
    const run = (current = { stale: false });
    let cursor = await page(reset, run);
    while (cursor && !run.stale) cursor = await page(false, run);
    if (run.stale) return false;
    current = null;
    return true;
  };
}

// ── States ──
export function emptyState({ icon: ic = 'inbox', title = 'Nothing here yet', message = '', actionHTML = '' } = {}) {
  return `
    <div class="state-block empty">
      <div class="state-ic">${icon(ic)}</div>
      <h3>${esc(title)}</h3>
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${actionHTML}
    </div>`;
}

export function errorState({ message = 'Something went wrong. Please try again.', retry = true } = {}) {
  return `
    <div class="state-block error">
      <div class="state-ic">${icon('alert')}</div>
      <h3>Something went wrong</h3>
      <p>${esc(message)}</p>
      ${retry ? '<button class="btn subtle" data-retry>' + icon('refresh') + 'Try again</button>' : ''}
    </div>`;
}

export function skeletonRows(n = 4, h = 64) {
  return `<div class="skeleton-list">${Array.from({ length: n }, () =>
    `<div class="skeleton-row" style="height:${h}px"></div>`).join('')}</div>`;
}

export function spinnerBlock(label = 'Loading…') {
  return `<div class="state-block loading"><span class="spin lg"></span><p>${esc(label)}</p></div>`;
}

/**
 * Replaces the boot skeleton when the auth/session chain fails for a reason
 * other than a redirect — previously these pages just spun forever.
 */
export function renderMountFailure(title = 'Could not load this page', message = 'Check your connection and try again.') {
  const skel = document.getElementById('page-skeleton');
  if (skel) skel.remove();
  const target = document.getElementById('page-content') || document.body;
  target.innerHTML = `<div class="state-block error">
      <div class="state-ic">${icon('alert')}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      <button class="btn subtle" id="mount-retry">${icon('refresh')} Try again</button>
    </div>`;
  const btn = document.getElementById('mount-retry');
  if (btn) btn.addEventListener('click', () => location.reload());
}

// ── Badges ──
export function badge(text, tone = 'gray', { dot = false } = {}) {
  return `<span class="badge tone-${tone}">${dot ? '<span class="dot"></span>' : ''}${esc(text)}</span>`;
}

// ── Offline banner ──
export function initOfflineBanner() {
  const mk = () => {
    let b = document.querySelector('.offline-banner');
    if (!navigator.onLine) {
      if (!b) {
        b = document.createElement('div');
        b.className = 'offline-banner';
        b.innerHTML = `${icon('wifiOff')} You're currently offline. Some features may be unavailable.`;
        document.body.appendChild(b);
      }
    } else if (b) b.remove();
  };
  window.addEventListener('online', mk);
  window.addEventListener('offline', mk);
  mk();
}
