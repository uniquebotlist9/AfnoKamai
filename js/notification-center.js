// ─── Notification centre (bell dropdown) ─────────────────────────────
//
// The shell owns the badge and the priority popups; this module owns the
// panel you get when you click the bell.
//
// Two things it deliberately does:
//  1. Category filtering runs as a Firestore query, not a client-side
//     filter over 8 rows — filtering after the fact would show "0 items in
//     Tasks" simply because Tasks fell outside the page limit.
//  2. The device-permission card only ever appears when the browser is in
//     the `default` state, and its button is the sole trigger for the
//     permission dialog. Nothing here prompts on its own.

import { auth, db } from './firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs, writeBatch,
  doc, serverTimestamp, getCountFromServer
} from 'firebase/firestore';
import { esc, fmtRelative } from './utils.js';
import { icon } from './icons.js';
import { emptyState, toast } from './ui.js';
import { CATEGORIES } from './notify.js';
import {
  permissionState, pushSupported, enablePush, syncSubscription
} from './push.js';

// Only the buckets users actually switch between — showing all ten would
// turn a two-line chip row into a scrollbar.
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'task', label: 'Tasks' },
  { id: 'reward', label: 'Rewards' },
  { id: 'referral', label: 'Referrals' },
  { id: 'payment', label: 'Payments' },
  { id: 'security', label: 'Security' },
  { id: 'system', label: 'System' }
];

const LIMIT = 12;

let activeTab = 'all';
let loading = false;

/** Read back a Firestore Timestamp/Date/number as milliseconds. */
function tsMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

function buildQuery(uid, tab) {
  const base = [collection(db, 'notifications'), where('userId', '==', uid)];
  if (tab === 'unread') {
    return query(...base, where('read', '==', false), orderBy('createdAt', 'desc'), limit(LIMIT));
  }
  if (tab === 'all') {
    return query(...base, orderBy('createdAt', 'desc'), limit(LIMIT));
  }
  // Composite index: userId + category + createdAt.
  return query(...base, where('category', '==', tab), orderBy('createdAt', 'desc'), limit(LIMIT));
}

function renderTabs(unread) {
  // Class names deliberately differ from the full page's `.notif-tabs`:
  // both live on `notifications.html` at once, and a shared selector would
  // let one panel's styles leak into the other.
  return `
    <div class="notif-chips" role="tablist" aria-label="Notification categories">
      ${TABS.map((t) => `
        <button class="notif-chip${t.id === activeTab ? ' is-active' : ''}"
                data-tab="${t.id}" role="tab"
                aria-selected="${t.id === activeTab}">
          ${esc(t.label)}${t.id === 'unread' && unread ? ` <span class="notif-chip-count">${unread > 99 ? '99+' : unread}</span>` : ''}
        </button>`).join('')}
    </div>`;
}

function renderItem(d) {
  const n = d.data();
  const cat = CATEGORIES[n.category] || null;
  const prio = n.priority === 'urgent' ? 'Priority' : n.priority === 'high' ? 'Important' : '';
  const catLabel = cat && n.category !== 'system' ? `<span class="notif-cat">${esc(cat.label)}</span>` : '';
  const amount = typeof n.amountPaisa === 'number' && n.amountPaisa > 0
    ? `<span class="notif-amt">${esc(fmtPaisa(n.amountPaisa))}</span>` : '';

  return `
    <a class="activity-item${n.read ? '' : ' is-unread'}" href="${esc(n.link || 'notifications.html')}"
       data-notif-id="${esc(d.id)}" style="padding:12px 14px">
      <span class="act-ic ${esc(n.tone || 'gray')}">${icon(n.icon || (cat ? cat.icon : 'info'))}</span>
      <div class="act-body">
        <div class="act-title">${esc(n.title || 'Notification')}${prio ? ` <span class="prio-pill ${esc(n.priority)}">${prio}</span>` : ''}</div>
        <div class="act-desc">${esc(n.body || '')}</div>
        <div class="act-meta">${catLabel}<span class="act-time">${esc(fmtRelative(n.createdAt))}</span>${amount}</div>
      </div>
      ${n.read ? '' : '<span class="unread-dot"></span>'}
    </a>`;
}

// Kept tiny and local: the panel should not import the whole wallet
// formatting surface for one number.
function fmtPaisa(paisa) {
  const n = Math.round(paisa / 100);
  return 'Rs ' + n.toLocaleString('en-IN');
}

/**
 * The only place in the app that may trigger a permission prompt.
 * Returns true when the user opted in.
 */
function permissionCard() {
  if (!pushSupported()) return '';
  const state = permissionState();

  if (state === 'granted') {
    return `<div class="push-card push-card-on">
      <span class="push-card-ic">${icon('bell')}</span>
      <div><strong>Device notifications on</strong>
        <div class="push-card-sub">Alerts arrive even when AfnoKamai is closed.</div></div>
      <a class="btn btn-ghost btn-sm" href="notification-settings.html">Manage</a>
    </div>`;
  }

  if (state === 'denied') {
    // Requesting again here would be silently ignored by every browser, so
    // we say what to do instead of offering a button that cannot work.
    return `<div class="push-card push-card-off">
      <span class="push-card-ic">${icon('ban')}</span>
      <div><strong>Device notifications are blocked</strong>
        <div class="push-card-sub">Allow notifications for this site in your browser's address bar, then reload.</div></div>
      <a class="btn btn-ghost btn-sm" href="notification-settings.html">Help</a>
    </div>`;
  }

  return `<div class="push-card">
    <span class="push-card-ic">${icon('bell')}</span>
    <div><strong>Get notified off-site</strong>
      <div class="push-card-sub">Task assignments and releases reach this device even when the site is closed.</div></div>
    <button class="btn btn-primary btn-sm" data-enable-push type="button">Turn on</button>
  </div>`;
}

async function loadList(listEl) {
  loading = true;
  listEl.innerHTML = `<div class="state-block loading"><span class="spin dark"></span></div>`;

  try {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const snap = await getDocs(buildQuery(uid, activeTab));

    if (snap.empty) {
      listEl.innerHTML = emptyState({
        icon: 'bell',
        title: activeTab === 'unread' ? 'Nothing unread' : 'All caught up',
        message: activeTab === 'unread'
          ? 'Every notification has been read.'
          : 'New notifications will appear here.'
      });
      return;
    }

    listEl.innerHTML = snap.docs.map(renderItem).join('');

    // Viewing the list is a read. Only the rows on screen are cleared, so
    // switching tabs does not mark an entire category read unseen.
    const unread = snap.docs.filter((d) => !d.data().read);
    if (unread.length) {
      const batch = writeBatch(db);
      unread.forEach((d) => batch.update(d.ref, { read: true, readAt: serverTimestamp() }));
      await batch.commit().catch(() => { /* badge stays honest either way */ });
    }
  } catch (err) {
    console.error('[notif-center] load failed', err);
    listEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load', message: 'Please try again.' });
  } finally {
    loading = false;
  }
}

async function markAllRead(uid, statusEl) {
  try {
    const snap = await getDocs(
      query(
        collection(db, 'notifications'),
        where('userId', '==', uid),
        where('read', '==', false),
        limit(400)
      )
    );
    if (snap.empty) return;

    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.update(d.ref, { read: true, readAt: serverTimestamp() }));
    await batch.commit();

    toast(`Marked ${snap.size} notification${snap.size === 1 ? '' : 's'} as read`);
    if (statusEl) statusEl.textContent = '';
    const listEl = document.querySelector('.notif-pop-list');
    if (listEl) await loadList(listEl);
  } catch (err) {
    console.error('[notif-center] mark all failed', err);
    toast('Could not mark notifications as read.', { type: 'error' });
  }
}

/**
 * Build and open the panel. Called from the shell's bell handler.
 * Toggling is the caller's job — it removes the panel when one is present.
 */
export async function openNotificationPanel({ wrap, uid }) {
  const pop = document.createElement('div');
  pop.className = 'notif-pop notif-pop-wide';
  pop.innerHTML = `
    <div class="notif-pop-head">
      <h4>Notifications</h4>
      <button class="btn btn-ghost btn-xs" data-mark-all type="button">Mark all read</button>
    </div>
    <div class="notif-push-slot"></div>
    <div class="notif-tabs-slot"></div>
    <div class="notif-pop-list"><div class="state-block loading"><span class="spin dark"></span></div></div>
    <div class="notif-pop-foot">
      <a href="notifications.html" style="font-weight:600; font-size:13.5px">View all notifications</a>
      <a href="notification-settings.html" style="font-size:13.5px">Settings</a>
    </div>`;
  wrap.appendChild(pop);

  const listEl = pop.querySelector('.notif-pop-list');
  const tabsSlot = pop.querySelector('.notif-tabs-slot');
  const pushSlot = pop.querySelector('.notif-push-slot');

  pushSlot.innerHTML = permissionCard();

  // Unread total drives the "Unread" chip; failures just leave it blank.
  try {
    const uidNow = auth.currentUser?.uid || uid;
    const agg = await getCountFromServer(
      query(collection(db, 'notifications'), where('userId', '==', uidNow), where('read', '==', false))
    );
    const unread = agg.data().count;
    tabsSlot.innerHTML = renderTabs(unread);
  } catch (_) {
    tabsSlot.innerHTML = renderTabs(0);
  }

  tabsSlot.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || loading) return;
    activeTab = btn.dataset.tab;
    tabsSlot.innerHTML = renderTabs(0);
    // Re-render with the real count would cost another aggregate read on
    // every switch; the chip only matters before the first click.
    loadList(listEl);
  });

  pushSlot.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-enable-push]');
    if (!btn) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Waiting…';

    const result = await enablePush();

    if (result.ok) {
      toast('Device notifications turned on.', { type: 'success' });
      pushSlot.innerHTML = permissionCard();
      await syncSubscription({ prompt: false }).catch(() => {});
      return;
    }

    btn.disabled = false;
    btn.textContent = original;
    if (result.reason === 'denied') {
      pushSlot.innerHTML = permissionCard(); // now renders the blocked card
      toast('Notifications are blocked for this site.', { type: 'warn' });
    } else if (result.reason === 'device_limit') {
      toast('This account already has the maximum number of devices.', { type: 'warn' });
    } else if (result.reason === 'dismissed') {
      toast('No problem — you can turn them on any time.');
    } else {
      toast('Could not turn on notifications on this device.', { type: 'error' });
    }
  });

  pop.querySelector('[data-mark-all]').addEventListener('click', (e) => {
    e.stopPropagation();
    markAllRead(auth.currentUser?.uid || uid);
  });

  await loadList(listEl);
  return pop;
}
