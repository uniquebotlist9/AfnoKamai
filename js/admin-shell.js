// ─── Admin shell: guarded navigation, badges, presence heartbeat ─────
import { db, isConfigured } from './firebase.js';
import {
  collection, query, where, onSnapshot, doc, setDoc, serverTimestamp,
  getCountFromServer
} from 'firebase/firestore';
import { requireAdminAccess, doLogout, ensureConfigured, redirectSignal, isRedirect } from './guard.js';
import { initTheme, mountThemeControl } from './theme.js';
import { sweepHolds } from './admin-actions.js';
import { icon, logo } from './icons.js';
import { esc, initials } from './utils.js';
import { initOfflineBanner, renderMountFailure } from './ui.js';
import { initInstallPopup } from './install-popup.js';

const PAGES = {
  index: { title: 'Overview', icon: 'dashboard' },
  users: { title: 'Users', icon: 'users' },
  tasks: { title: 'Tasks', icon: 'briefcase' },
  reviews: { title: 'Task Reviews', icon: 'check', badge: 'reviews' },
  chats: { title: 'Chats', icon: 'message', badge: 'chats' },
  withdrawals: { title: 'Withdrawals', icon: 'wallet', badge: 'withdrawals' },
  referrals: { title: 'Referrals', icon: 'link' },
  transactions: { title: 'Transactions', icon: 'list' },
  penalties: { title: 'Penalties', icon: 'alert' },
  announcements: { title: 'Announcements', icon: 'megaphone' },
  notifications: { title: 'Notifications', icon: 'bell' },
  maintenance: { title: 'Maintenance', icon: 'wrench' },
  logs: { title: 'Audit Logs', icon: 'scroll' },
  settings: { title: 'Settings', icon: 'settings' }
};

function navLink(id, current, badgeKey) {
  const p = PAGES[id];
  const href = id === 'index' ? '/admin/index.html' : `/admin/${id}.html`;
  return `
    <a class="side-link ${current === id ? 'active' : ''}" href="${href}" ${current === id ? 'aria-current="page"' : ''}>
      ${icon(p.icon)}<span>${esc(p.title)}</span>
      ${badgeKey ? `<span class="side-badge gold" data-admin-badge="${badgeKey}" hidden></span>` : ''}
    </a>`;
}

const NAV = ['index', 'users', 'tasks', 'reviews', 'chats', 'withdrawals', 'referrals', 'transactions', 'penalties', 'announcements', 'notifications', 'maintenance', 'logs', 'settings'];

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

export async function mountAdminShell(pageId) {
  if (!ensureConfigured()) throw redirectSignal();
  initTheme();
  let access;
  try {
    access = await requireAdminAccess();
  } catch (e) {
    if (isRedirect(e)) throw e;
    renderMountFailure('Could not load the admin panel', 'Check your connection and try again.');
    throw e;
  }
  const { user, profile } = access;

  const layout = document.createElement('div');
  layout.className = 'app-layout admin';
  layout.innerHTML = `
    <aside class="sidebar" id="sidebar">
      <a class="brand" href="/admin/index.html">${logo({ light: true })}</a>
      <div style="padding:0 10px 16px">
        <span class="badge tone-gold" style="background:rgba(217,166,46,.15); color:var(--gold-500)">${icon('shield')} Administrator</span>
      </div>
      <nav class="side-nav" aria-label="Admin">
        ${NAV.map((id) => navLink(id, pageId, PAGES[id].badge)).join('')}
        <div class="side-foot">
          <div class="side-user">
            <span class="avatar gold">${esc(initials(profile.fullName))}</span>
            <div class="meta">
              <div class="nm">${esc(profile.fullName)}</div>
              <div class="em">${esc(profile.email)}</div>
            </div>
          </div>
          <a class="side-link" href="#" id="side-logout">${icon('logout')}<span>Log out</span></a>
        </div>
      </nav>
    </aside>
    <div class="sidebar-backdrop" id="sidebar-backdrop" hidden></div>
    <div style="min-width:0">
      <header class="topbar">
        <button class="btn-icon menu-btn" id="menu-btn" aria-label="Open navigation">${icon('menu')}</button>
        <div class="topbar-actions">
          <a class="btn ghost btn-sm" href="/dashboard.html" style="text-decoration:none">${icon('arrowRight')} User app</a>
          <button class="avatar-btn" id="user-btn" aria-label="Account menu"><span class="avatar gold">${esc(initials(profile.fullName))}</span></button>
        </div>
      </header>
      <main class="app-content" id="page-content">
        <div class="skeleton-list" id="page-skeleton">
          <div class="skeleton-row" style="height:110px"></div>
          <div class="skeleton-row" style="height:220px"></div>
        </div>
      </main>
    </div>
    <nav class="mobile-nav" style="grid-template-columns:repeat(4,1fr)" aria-label="Quick navigation">
      <a href="/admin/index.html" class="${pageId === 'index' ? 'active' : ''}">${icon('dashboard')}<span>Overview</span></a>
      <a href="/admin/reviews.html" class="${pageId === 'reviews' ? 'active' : ''}">${icon('check')}<span>Reviews</span></a>
      <a href="/admin/withdrawals.html" class="${pageId === 'withdrawals' ? 'active' : ''}">${icon('wallet')}<span>Payouts</span></a>
      <button id="more-btn">${icon('menu')}<span>More</span></button>
    </nav>`;
  document.body.appendChild(layout);

  const content = layout.querySelector('#page-content');

  // sidebar mobile
  const sidebar = layout.querySelector('#sidebar');
  const backdrop = layout.querySelector('#sidebar-backdrop');
  layout.querySelector('#menu-btn').addEventListener('click', () => { sidebar.classList.add('open'); backdrop.hidden = false; });
  backdrop.addEventListener('click', () => { sidebar.classList.remove('open'); backdrop.hidden = true; });

  // user menu
  layout.querySelector('#user-btn').addEventListener('click', () => {
    if (layout.querySelector('.user-menu')) { layout.querySelector('.user-menu').remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'user-menu';
    menu.innerHTML = `
      <div class="um-head"><div class="nm">${esc(profile.fullName)}</div><div class="em">${esc(profile.email)}</div></div>
      <button id="um-settings">${icon('settings')} Platform settings</button>
      <button id="um-install" hidden>${icon('download')} Install app</button>
      <div style="padding:8px 12px 4px" id="um-theme"></div>
      <button id="um-logout" class="danger">${icon('logout')} Log out</button>`;
    layout.querySelector('.topbar-actions').appendChild(menu);
    menu.querySelector('#um-settings').addEventListener('click', () => { location.href = '/admin/settings.html'; });
    menu.querySelector('#um-logout').addEventListener('click', () => doLogout());
    mountThemeControl(menu.querySelector('#um-theme'));
    const installBtn = menu.querySelector('#um-install');
    if (installEvent) {
      installBtn.hidden = false;
      installBtn.addEventListener('click', async () => {
        installBtn.hidden = true;
        try { await installEvent.prompt(); } catch (_) {}
        installEvent = null;
      });
    }
    setTimeout(() => document.addEventListener('click', function h(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', h); }
    }), 0);
  });
  layout.querySelector('#side-logout').addEventListener('click', (e) => { e.preventDefault(); doLogout(); });

  // more sheet
  layout.querySelector('#more-btn').addEventListener('click', () => {
    const ov = document.createElement('div');
    ov.className = 'sheet-overlay';
    const sheet = document.createElement('div');
    sheet.className = 'action-sheet';
    sheet.innerHTML = `<div class="sheet-grip"></div>${NAV.map((id) => navLink(id, pageId)).join('')}
      <button class="side-link" id="sheet-logout">${icon('logout')}<span>Log out</span></button>`;
    document.body.append(ov, sheet);
    requestAnimationFrame(() => { ov.classList.add('open'); sheet.classList.add('open'); });
    const close = () => { ov.classList.remove('open'); sheet.classList.remove('open'); setTimeout(() => { ov.remove(); sheet.remove(); }, 250); };
    ov.addEventListener('click', close);
    sheet.querySelector('#sheet-logout').addEventListener('click', () => doLogout());
  });

  // ── badges ──
  const badgeDefs = [
    { key: 'reviews', col: 'taskAssignments', field: 'status', values: ['requested', 'submitted'] },
    { key: 'withdrawals', col: 'withdrawals', field: 'status', values: ['pending', 'under_review'] },
    { key: 'chats', col: 'conversations', field: 'unreadForAdmin', values: ['>0'] }
  ];
  for (const b of badgeDefs) {
    try {
      let q;
      if (b.values[0] === '>0') {
        q = query(collection(db, b.col), where(b.field, '>', 0));
      } else {
        q = query(collection(db, b.col), where(b.field, 'in', b.values));
      }
      const unsub = onSnapshot(q, (snap) => {
        const n = snap.size;
        layout.querySelectorAll(`[data-admin-badge="${b.key}"]`).forEach((el) => {
          el.hidden = !n; el.textContent = n > 99 ? '99+' : n;
        });
      }, () => {});
      window.addEventListener('pagehide', () => unsub());
    } catch (_) {}
  }

  // ── presence heartbeat: admins stay "active" while panel is open ──
  const availRef = doc(db, 'config', 'availability');
  const beat = () => setDoc(availRef, {
    state: 'active',
    updatedAt: serverTimestamp()
  }, { merge: true }).catch(() => {});
  beat();
  // 4 min instead of 1 min: chat.js only treats the admin as "currently
  // active" within a 5-minute window, so this keeps a 60s safety margin and
  // cuts heartbeat writes 4× for tabs left open all day.
  const beatTimer = setInterval(beat, 4 * 60 * 1000);
  window.addEventListener('pagehide', () => clearInterval(beatTimer));

  // mark state away when leaving
  window.addEventListener('beforeunload', () => {
    try {
      setDoc(availRef, { state: 'away', updatedAt: serverTimestamp() }, { merge: true });
    } catch (_) {}
  });

  initOfflineBanner();
  initInstallPopup();

  // Hold sweep: release any matured holds (idempotent, timestamp-driven).
  // It runs on EVERY admin page load and can read hundreds of documents (200
  // hold candidates + 2 reads per transaction), so it is throttled to once per
  // 15 minutes per browser. Holds are timestamp-driven, so a delayed sweep is
  // harmless — they simply release up to 15 min later.
  try {
    const SWEEP_KEY = 'ak_last_sweep';
    const SWEEP_GAP = 15 * 60 * 1000;
    const lastSweep = Number(localStorage.getItem(SWEEP_KEY) || 0);
    if (Date.now() - lastSweep > SWEEP_GAP) {
      localStorage.setItem(SWEEP_KEY, String(Date.now()));
      sweepHolds().then((n) => { if (n > 0) console.info(`Hold sweep: released ${n} transaction(s)`); }).catch(() => {});
    }
  } catch (_) { /* localStorage unavailable — sweep on every load as before */ }

  return { user, profile, content };
}

/** Generic stats via aggregation query (cheap counts). */
export async function countWhere(col, field, values) {
  const q = query(collection(db, col), where(field, 'in', values));
  const snap = await getCountFromServer(q);
  return snap.data().count;
}
