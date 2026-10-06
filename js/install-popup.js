// ─── PWA Install Popup ──────────────────────────────────────────────────────
// One authoritative install-promotion system for the whole app.
//
// Behaviour:
//   • X close        → temporary dismissal, no localStorage write
//   • Don't show again → writes afnokamai_install_popup_dismissed = "true"
//   • Install App    → triggers the native beforeinstallprompt flow
//
// The popup is suppressed when:
//   • localStorage key afnokamai_install_popup_dismissed === "true"
//   • The app is already running as an installed PWA (standalone / iOS)
//   • The browser does not support beforeinstallprompt (no fake button)

import { icon, logo } from './icons.js';

const DISMISS_KEY = 'afnokamai_install_popup_dismissed';

let deferredPrompt = null;
let popupRoot = null;

// ── Public API ───────────────────────────────────────────────────────────────

/** Call once on every page load (from shell.js / admin-shell.js). */
export function initInstallPopup() {
  // Capture the native install prompt if the browser fires it.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Only show our popup if the user hasn't permanently dismissed it.
    if (shouldShowInstallPopup()) {
      showInstallPopup();
    }
  });

  // If the browser never fires beforeinstallprompt (e.g. already installed,
  // or not eligible), we still want to show the popup on first visit — but
  // only if the user hasn't dismissed it and the app isn't already installed.
  // We defer a tick so the page can paint first.
  setTimeout(() => {
    if (shouldShowInstallPopup() && !deferredPrompt) {
      showInstallPopup();
    }
  }, 1200);

  // If the app gets installed while the popup is open, hide it.
  window.addEventListener('appinstalled', () => {
    hideInstallPopup();
  });
}

// ── Visibility logic ────────────────────────────────────────────────────────

function shouldShowInstallPopup() {
  try {
    if (localStorage.getItem(DISMISS_KEY) === 'true') return false;
  } catch (_) {}
  if (window.matchMedia('(display-mode: standalone)').matches) return false;
  if (window.navigator.standalone === true) return false;
  return true;
}

// ── Popup lifecycle ─────────────────────────────────────────────────────────

function showInstallPopup() {
  if (popupRoot) return; // already visible — never stack

  const overlay = document.createElement('div');
  overlay.className = 'ip-overlay';
  overlay.innerHTML = `
    <div class="ip-card" role="dialog" aria-modal="true" aria-labelledby="ip-title">
      <button class="ip-close" aria-label="Close install popup" title="Close">${icon('x')}</button>
      <div class="ip-icon">${logo({ light: false })}</div>
      <h2 class="ip-title" id="ip-title">Install AfnoKamai</h2>
      <p class="ip-desc">Install AfnoKamai on your device for a faster and more convenient experience.</p>
      <button class="ip-install" id="ip-install-btn">${icon('download')} Install App</button>
      <button class="ip-dismiss" id="ip-dismiss-btn">Don't show again</button>
    </div>`;
  document.body.appendChild(overlay);
  popupRoot = overlay;

  // Entrance animation
  requestAnimationFrame(() => overlay.classList.add('open'));

  // ── Wire up controls ──
  overlay.querySelector('.ip-close').addEventListener('click', () => {
    hideInstallPopup();
  });

  overlay.querySelector('#ip-dismiss-btn').addEventListener('click', () => {
    try { localStorage.setItem(DISMISS_KEY, 'true'); } catch (_) {}
    hideInstallPopup();
  });

  overlay.querySelector('#ip-install-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!deferredPrompt) {
      // Browser doesn't support native install — show instructions.
      showInstallInstructions(overlay);
      return;
    }
    btn.disabled = true;
    try {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredPrompt = null;
        hideInstallPopup();
      } else {
        btn.disabled = false;
      }
    } catch (_) {
      btn.disabled = false;
    }
  });

  // Close on overlay click (outside the card)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideInstallPopup();
  });

  // Close on Escape
  const onKey = (e) => {
    if (e.key === 'Escape') {
      hideInstallPopup();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);

  // Focus the install button for keyboard users
  setTimeout(() => overlay.querySelector('#ip-install-btn').focus(), 150);
}

function hideInstallPopup() {
  if (!popupRoot) return;
  const overlay = popupRoot;
  popupRoot = null;
  overlay.classList.remove('open');
  overlay.classList.add('closing');
  setTimeout(() => overlay.remove(), 200);
}

// ── Fallback for unsupported browsers ───────────────────────────────────────

function showInstallInstructions(overlay) {
  const existing = overlay.querySelector('.ip-instructions');
  if (existing) return;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);

  let msg;
  if (isIOS) {
    msg = 'Tap the Share button in Safari, then choose "Add to Home Screen".';
  } else if (isAndroid) {
    msg = 'Tap the menu (⋮) in your browser, then choose "Install app" or "Add to Home screen".';
  } else {
    msg = 'Use your browser\'s "Install app" or "Add to Home Screen" option.';
  }

  const div = document.createElement('div');
  div.className = 'ip-instructions';
  div.innerHTML = `<p>${msg}</p>`;
  overlay.querySelector('.ip-card').insertBefore(div, overlay.querySelector('.ip-dismiss'));
}
