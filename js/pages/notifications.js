// ─── Notification centre (full page) ─────────────────────────────────
//
// v2: filtering and search moved from the client to Firestore.
//
// The old implementation fetched 25 rows and then filtered them in
// JavaScript. Because the list auto-pages, a category with no items in the
// current window rendered as "nothing here" even when hundreds existed
// further down — the filter could only ever see what had been fetched.
// Category and search are now `where` clauses backed by composite indexes
// (userId+category+createdAt, userId+searchText+createdAt).
//
// Consequence worth knowing: documents written before this version have no
// `category` field, so they only match All/Unread until the background
// reindex in scripts/push-sender.cjs has walked over them.

import { db } from '../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs, getCountFromServer,
  updateDoc, deleteDoc, doc, serverTimestamp, writeBatch, startAfter
} from 'firebase/firestore';
import { mountShell } from '../shell.js';
import { esc, fmtRelative, fmtDateTime, fmtNPR, dayKey, dayLabel, debounce } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState, skeletonRows, autoPager, confirmDialog, toast } from '../ui.js';
import { CATEGORIES } from '../notify.js';

let { user, content } = await mountShell('notifications');
document.getElementById('page-skeleton')?.remove();

// ─── Tabs ────────────────────────────────────────────────────────────
// `in` lets one tab cover several buckets, so Announcements can swallow
// promotions and System can swallow maintenance without either becoming a
// tab of its own. Firestore caps `in` at 10 values.
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'task', label: 'Tasks' },
  { id: 'reward', label: 'Rewards' },
  { id: 'payment', label: 'Payments' },
  { id: 'referral', label: 'Referrals' },
  { id: 'security', label: 'Security' },
  { id: 'account', label: 'Account' },
  { id: 'announcement', label: 'Announcements', in: ['announcement', 'promotion'] },
  { id: 'system', label: 'System', in: ['system', 'maintenance'] }
];

// Display metadata only — the storage format is `type`, not this table.
const TONE = {
  task_approved: 'green', reward_released: 'green', reward_hold: 'amber',
  task_rejected: 'red', penalty: 'red', withdrawal: 'blue', task_assigned: 'blue',
  admin_message: 'gold', announcement: 'gold', security: 'red',
  referral_joined: 'green', referral_milestone: 'green', referral_reward: 'green',
  referral_review: 'amber'
};
const ICONS = {
  task_approved: 'check', task_rejected: 'x', reward_hold: 'clock', reward_released: 'unlock',
  withdrawal: 'bank', penalty: 'alert', announcement: 'megaphone', security: 'shield',
  task_assigned: 'briefcase', admin_message: 'message',
  maintenance: 'wrench', system: 'info',
  referral_joined: 'users', referral_milestone: 'coins', referral_reward: 'coins',
  referral_review: 'shield'
};
const PRIORITY_LABEL = { urgent: 'Priority', high: 'Important' };

const EMPTY = {
  all: ['No notifications yet', 'Task updates, rewards and announcements will appear here.'],
  unread: ["You're all caught up", 'No unread notifications.'],
  task: ['No task updates', 'Task assignments and review results will appear here.'],
  reward: ['No earning updates', 'Reward holds and releases will appear here.'],
  payment: ['No payment updates', 'Withdrawals, deposits and penalties will appear here.'],
  referral: ['No referral updates', 'Referral joins and rewards will appear here.'],
  security: ['No security alerts', 'Login, password and new-device warnings will appear here.'],
  account: ['No account messages', 'Replies from the admin team will appear here.'],
  announcement: ['No announcements', 'Platform news and offers will appear here.'],
  system: ['No system messages', 'Maintenance and other system notices will appear here.']
};

const SEARCH_LIMIT = 100;
const PAGE = 25;

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Notifications</h1>
      <p class="sub">Updates about your tasks, rewards, withdrawals and account.</p>
    </div>
    <div class="page-head-actions">
      <span class="badge tone-green" id="unread-pill" hidden></span>
      <a class="btn ghost btn-sm" href="notification-settings.html">${icon('settings')} Settings</a>
      <button class="btn ghost btn-sm" id="mark-all">${icon('check')} Mark all read</button>
    </div>
  </div>

  <div class="card notif-panel">
    <div class="notif-tools">
      <label class="notif-search">
        ${icon('search')}
        <input type="search" id="notif-q" placeholder="Search notifications…"
               autocomplete="off" aria-label="Search notifications">
      </label>
    </div>
    <div class="tabs notif-tabs" role="tablist">
      ${TABS.map((t, i) => `<button class="tab ${i === 0 ? 'active' : ''}" role="tab" data-tab="${t.id}">${esc(t.label)}<span class="count" data-count="${t.id}" hidden></span></button>`).join('')}
    </div>
    <div id="notif-list">${skeletonRows(5, 58)}</div>
  </div>`;

let activeTab = 'all';
let searchTerm = '';
let cursor = null;
let lastDay = '';

const listEl = content.querySelector('#notif-list');
const unreadPill = content.querySelector('#unread-pill');
const searchInput = content.querySelector('#notif-q');

content.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  content.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  tab.classList.add('active');
  activeTab = tab.dataset.tab;
  refresh();
}));

content.querySelector('#mark-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    // 400 rather than "everything": this runs in the user's own session and
    // a batch is capped at 500 operations.
    const snap = await getDocs(query(
      collection(db, 'notifications'),
      where('userId', '==', user.uid),
      where('read', '==', false),
      limit(400)
    ));
    if (snap.size) {
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.update(d.ref, { read: true, readAt: serverTimestamp() }));
      await batch.commit();
      toast(`Marked ${snap.size} as read.`);
    }
    refresh();
    loadCounts();
  } catch (_) { toast('Could not mark all as read.', { type: 'error' }); }
  btn.disabled = false;
});

// ─── Search ──────────────────────────────────────────────────────────
// Debounced: one keystroke per query would turn typing a word into eight
// round trips against a free-tier quota we are already careful with.
const runSearch = debounce(() => {
  const next = searchInput.value.trim().toLowerCase();
  if (next === searchTerm) return;
  searchTerm = next;
  refresh();
}, 300);

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; runSearch(); }
});

/**
 * Backend search over `searchText` (a lowercased title+body index written
 * by js/notify.js). Prefix semantics: "with" matches "withd raw", which is
 * what people expect from a search box.
 */
function searchQuery() {
  return query(
    collection(db, 'notifications'),
    where('userId', '==', user.uid),
    where('searchText', '>=', searchTerm),
    where('searchText', '<=', searchTerm + ''),
    orderBy('searchText'),
    orderBy('createdAt', 'desc'),
    limit(SEARCH_LIMIT)
  );
}

function tabQuery() {
  const tab = TABS.find((t) => t.id === activeTab);
  const parts = [collection(db, 'notifications'), where('userId', '==', user.uid)];

  if (activeTab === 'unread') {
    parts.push(where('read', '==', false));
    parts.push(orderBy('createdAt', 'desc'), limit(PAGE));
  } else if (activeTab === 'all') {
    parts.push(orderBy('createdAt', 'desc'), limit(PAGE));
  } else {
    // Composite index: userId + category + createdAt.
    if (tab.in) parts.push(where('category', 'in', tab.in));
    else parts.push(where('category', '==', tab.id));
    parts.push(orderBy('createdAt', 'desc'), limit(PAGE));
  }
  if (cursor) parts.push(startAfter(cursor));
  return query(...parts);
}

// ─── Counts ──────────────────────────────────────────────────────────
// Exact aggregates rather than "fetch 150 and count". The old approach
// silently showed a wrong number the moment a user had more than 150.
async function loadCounts() {
  const agg = (filters) => getCountFromServer(
    query(collection(db, 'notifications'), where('userId', '==', user.uid), ...filters)
  );

  try {
    const results = await Promise.all([
      agg([]),
      agg([where('read', '==', false)]),
      ...TABS.filter((t) => !['all', 'unread'].includes(t.id)).map((t) =>
        agg([t.in ? where('category', 'in', t.in) : where('category', '==', t.id)]))
    ]);

    const total = results[0].data().count;
    const unread = results[1].data().count;

    TABS.forEach((t, i) => {
      const el = content.querySelector(`[data-count="${t.id}"]`);
      if (!el) return;
      const n = i === 0 ? total : i === 1 ? unread : results[i + 1].data().count;
      el.hidden = !n;
      el.textContent = n > 99 ? '99+' : String(n);
    });

    unreadPill.hidden = !unread;
    unreadPill.textContent = unread > 99 ? '99+ unread' : `${unread} unread`;
  } catch (e) {
    console.warn('notification counts failed', e);
  }
}

// ─── Rendering ───────────────────────────────────────────────────────

function renderItems(items) {
  if (!items.length) {
    if (searchTerm) {
      return emptyState({
        icon: 'search',
        title: 'No matches',
        message: `Nothing matches “${searchInput.value.trim()}”. Search covers title and description.`
      });
    }
    const [title, msg] = EMPTY[activeTab] || EMPTY.all;
    return emptyState({ icon: 'bell', title, message: msg });
  }

  return items.map((d) => {
    const n = d.data();
    const tone = TONE[n.type] || n.tone || 'gray';
    const ic = ICONS[n.type] || n.icon || (CATEGORIES[n.category] ? CATEGORIES[n.category].icon : 'info');
    const key = dayKey(n.createdAt);
    let head = '';
    if (key && key !== lastDay) {
      lastDay = key;
      const label = dayLabel(n.createdAt);
      if (label) head = `<div class="notif-group">${esc(label)}</div>`;
    }
    const amt = n.amountPaisa != null
      ? `<span class="act-amt ${n.amountPaisa >= 0 ? 'pos' : 'neg'}">${esc(fmtNPR(n.amountPaisa, { sign: 1 }))}</span>` : '';
    // Older notifications predate the `priority` field — fall back to type.
    const prio = n.priority || (n.type === 'task_assigned' ? 'urgent' : n.type === 'admin_message' ? 'high' : '');
    const prioLabel = PRIORITY_LABEL[prio];
    const link = esc(n.link || '');
    const when = n.createdAt ? ` title="${esc(fmtDateTime(n.createdAt))}"` : '';
    const cat = CATEGORIES[n.category];

    return `${head}
      <div class="notif-item ${!n.read ? 'unread' : ''} ${prio ? 'prior-' + prio : ''}" data-id="${esc(d.id)}"${when}>
        <button class="notif-main" data-open data-link="${link}" type="button">
          <span class="act-ic ${esc(tone)}">${icon(ic)}</span>
          <span class="act-body">
            <span class="act-title">${esc(n.title || 'Notification')}${prioLabel ? ` <span class="prio-pill ${prio}">${prioLabel}</span>` : ''}</span>
            ${n.body ? `<span class="act-desc">${esc(n.body)}</span>` : ''}
            <span class="act-time">${cat ? `${esc(cat.label)} · ` : ''}${esc(fmtRelative(n.createdAt))}</span>
          </span>
          ${amt}
          ${!n.read ? '<span class="unread-dot"></span>' : ''}
          ${link ? `<span class="ni-go">${icon('chevRight')}</span>` : ''}
        </button>
        <button class="notif-del" data-del type="button" aria-label="Delete notification" title="Delete">${icon('trash')}</button>
      </div>`;
  }).join('');
}

// One page of the list. `run` comes from autoPager: when a newer run starts
// (tab switch, search, mark-all) this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) {
    cursor = null;
    lastDay = '';
    listEl.innerHTML = skeletonRows(5, 58);
  }
  try {
    const snap = await getDocs(searchTerm ? searchQuery() : tabQuery());
    if (run.stale) return null;

    // Search caps at SEARCH_LIMIT rows, so there is no cursor to page on.
    const items = snap.docs;
    if (reset) {
      listEl.innerHTML = renderItems(items);
      if (items.length) listEl.querySelectorAll('.notif-main, [data-del]').forEach(wireItem);
    } else if (items.length) {
      listEl.insertAdjacentHTML('beforeend', renderItems(items));
      listEl.querySelectorAll('.notif-main:not([data-wired]), [data-del]:not([data-wired])').forEach(wireItem);
    }
    cursor = searchTerm ? null : (snap.docs[snap.docs.length - 1] || null);
    return cursor;
  } catch (e) {
    console.warn('notifications load failed', e);
    if (reset) {
      listEl.innerHTML = emptyState({
        icon: 'alert',
        title: 'Could not load notifications',
        message: (e && (e.code || e.message) ? (e.code || e.message) + ' — ' : '') + 'Please refresh the page.'
      });
    }
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);

async function refresh(reset = true) {
  await loadAll(reset);
}

function wireItem(btn) {
  btn.dataset.wired = '1';

  if (btn.hasAttribute('data-del')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.notif-item');
      const id = row.dataset.id;
      const ok = await confirmDialog({
        title: 'Delete this notification?',
        message: 'It is removed from your list only. This cannot be undone.',
        confirmText: 'Delete',
        danger: true
      });
      if (!ok) return;
      try {
        await deleteDoc(doc(db, 'notifications', id));
        row.remove();
        loadCounts();
        toast('Notification deleted.');
      } catch (err) {
        console.warn('delete failed', err);
        toast('Could not delete that notification.', { type: 'error' });
      }
    });
    return;
  }

  btn.addEventListener('click', async () => {
    const row = btn.closest('.notif-item');
    const id = row.dataset.id;
    try { await updateDoc(doc(db, 'notifications', id), { read: true, readAt: serverTimestamp() }); } catch (_) {}
    const link = btn.dataset.link;
    if (link) location.href = link;
  });
}

// ─── Boot ────────────────────────────────────────────────────────────

refresh();
loadCounts();
