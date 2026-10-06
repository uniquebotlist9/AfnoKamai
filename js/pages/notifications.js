// ─── Notification center ─────────────────────────────────────────────
import { db } from '../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs,
  updateDoc, doc, serverTimestamp, writeBatch, startAfter
} from 'firebase/firestore';
import { mountShell } from '../shell.js';
import { esc, fmtRelative, fmtNPR, fmtDateTime, dayKey, dayLabel } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState, skeletonRows, badge, autoPager } from '../ui.js';

let { user, content } = await mountShell('notifications');
document.getElementById('page-skeleton')?.remove();

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'messages', label: 'Admin messages' },
  { id: 'earnings', label: 'Earnings' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'withdrawals', label: 'Withdrawals' },
  { id: 'system', label: 'System' }
];
const TYPE_CATEGORY = {
  reward_hold: 'earnings', reward_released: 'earnings', penalty: 'earnings',
  referral_milestone: 'earnings', referral_reward: 'earnings',
  task_assigned: 'tasks', task_approved: 'tasks', task_rejected: 'tasks', task_request_update: 'tasks',
  withdrawal: 'withdrawals', withdrawal_completed: 'withdrawals', withdrawal_rejected: 'withdrawals',
  admin_message: 'messages',
  announcement: 'system', maintenance: 'system', security: 'system', system: 'system',
  referral_joined: 'system', referral_review: 'system'
};
const TONE = {
  task_approved: 'green', reward_released: 'green', reward_hold: 'amber',
  task_rejected: 'red', penalty: 'red', withdrawal: 'blue', task_assigned: 'blue',
  admin_message: 'gold',
  announcement: 'gold', security: 'amber',
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
// How strongly a notification demands attention. Rendered as a pill so
// task assignments and admin messages are never lost among routine updates.
const PRIORITY_LABEL = { urgent: 'Priority', high: 'Important' };

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Notifications</h1>
      <p class="sub">Updates about your tasks, rewards, withdrawals and account.</p>
    </div>
    <div class="page-head-actions">
      <span class="badge tone-green" id="unread-pill" hidden></span>
      <button class="btn ghost btn-sm" id="mark-all">${icon('check')} Mark all read</button>
    </div>
  </div>

  <div class="card notif-panel">
    <div class="tabs notif-tabs" role="tablist">
      ${TABS.map((t, i) => `<button class="tab ${i === 0 ? 'active' : ''}" role="tab" data-tab="${t.id}">${t.label}<span class="count" data-count="${t.id}" hidden></span></button>`).join('')}
    </div>
    <div id="notif-list">${skeletonRows(5, 58)}</div>
  </div>`;

let activeTab = 'all';
let cursor = null;
let lastDay = '';

const listEl = content.querySelector('#notif-list');
const unreadPill = content.querySelector('#unread-pill');

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
    const snap = await getDocs(query(
      collection(db, 'notifications'),
      where('userId', '==', user.uid),
      where('read', '==', false),
      limit(100)
    ));
    if (snap.size) {
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.update(d.ref, { read: true, readAt: serverTimestamp() }));
      await batch.commit();
    }
    refresh();
  } catch (_) { toastMsg('Could not mark all as read.', 'error'); }
  btn.disabled = false;
});

function categoryOf(n) {
  return TYPE_CATEGORY[n.type] || 'system';
}

async function updateCounts() {
  try {
    const tabs = ['all', 'unread', 'messages', 'earnings', 'tasks', 'withdrawals', 'system'];
    const snap = await getDocs(query(
      collection(db, 'notifications'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc'),
      limit(150)
    ));
    const counts = { all: snap.size, unread: 0, messages: 0, earnings: 0, tasks: 0, withdrawals: 0, system: 0 };
    snap.docs.forEach((d) => {
      const n = d.data();
      if (!n.read) counts.unread++;
      counts[categoryOf(n)]++;
    });
    for (const t of tabs) {
      const el = content.querySelector(`[data-count="${t}"]`);
      const n = counts[t];
      el.hidden = !n;
      el.textContent = n > 99 ? '99+' : n;
    }
    unreadPill.hidden = !counts.unread;
    unreadPill.textContent = counts.unread > 99 ? '99+ unread' : `${counts.unread} unread`;
  } catch (e) {
    console.warn('notification counts failed', e);
  }
}

function renderItems(items) {
  if (!items.length) {
    const messages = {
      all: ['No notifications yet', 'Task updates, rewards and announcements will appear here.'],
      unread: ["You're all caught up", 'No unread notifications.'],
      messages: ['No admin messages', 'Messages from the administrator will appear here, ahead of routine updates.'],
      earnings: ['No earning updates', 'Reward and hold updates will appear here.'],
      tasks: ['No task updates', 'Task assignments and review results will appear here.'],
      withdrawals: ['No withdrawal updates', 'Withdrawal status changes will appear here.'],
      system: ['No system messages', 'Announcements and maintenance notices will appear here.']
    };
    const [title, msg] = messages[activeTab] || messages.all;
    return emptyState({ icon: 'bell', title, message: msg });
  }
  return items.map((d) => {
    const n = d.data();
    const tone = TONE[n.type] || 'gray';
    const ic = ICONS[n.type] || 'info';
    const key = dayKey(n.createdAt);
    let head = '';
    if (key && key !== lastDay) {
      lastDay = key;
      const label = dayLabel(n.createdAt);
      if (label) head = `<div class="notif-group">${esc(label)}</div>`;
    }
    const amt = n.amountPaisa != null
      ? `<span class="act-amt ${n.amountPaisa >= 0 ? 'pos' : 'neg'}">${esc(fmtNPR(n.amountPaisa, { sign: 1 }))}</span>` : '';
    // Older notifications predate the `priority` field — fall back to the type.
    const prio = n.priority || (n.type === 'task_assigned' ? 'urgent' : n.type === 'admin_message' ? 'high' : '');
    const prioLabel = PRIORITY_LABEL[prio];
    const link = esc(n.link || '');
    const when = n.createdAt ? ` title="${esc(fmtDateTime(n.createdAt))}"` : '';
    return `${head}
      <button class="notif-item ${!n.read ? 'unread' : ''} ${prio ? 'prior-' + prio : ''}" data-id="${esc(d.id)}" data-link="${link}"${when}>
        <span class="act-ic ${tone}">${icon(ic)}</span>
        <span class="act-body">
          <span class="act-title">${esc(n.title || 'Notification')}${prioLabel ? ` <span class="prio-pill ${prio}">${prioLabel}</span>` : ''}</span>
          ${n.body ? `<span class="act-desc">${esc(n.body)}</span>` : ''}
          <span class="act-time">${esc(fmtRelative(n.createdAt))}</span>
        </span>
        ${amt}
        ${!n.read ? '<span class="unread-dot"></span>' : ''}
        ${link ? `<span class="ni-go">${icon('chevRight')}</span>` : ''}
      </button>`;
  }).join('');
}

// One page of the list. `run` comes from autoPager: when a newer run starts
// (tab switch, mark-all) this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) {
    cursor = null;
    lastDay = '';
    listEl.innerHTML = skeletonRows(5, 58);
  }
  try {
    const parts = [collection(db, 'notifications'), where('userId', '==', user.uid)];
    if (activeTab === 'unread') parts.push(where('read', '==', false));
    parts.push(orderBy('createdAt', 'desc'), limit(25));
    if (cursor) parts.push(startAfter(cursor));
    const snap = await getDocs(query(...parts));
    if (run.stale) return null;
    let items = snap.docs;
    if (['messages', 'earnings', 'tasks', 'withdrawals', 'system'].includes(activeTab)) {
      items = items.filter((d) => categoryOf(d.data()) === activeTab);
    }
    if (reset) {
      listEl.innerHTML = renderItems(items);
      if (items.length) listEl.querySelectorAll('.notif-item').forEach(wireItem);
    } else if (items.length) {
      listEl.insertAdjacentHTML('beforeend', renderItems(items));
      listEl.querySelectorAll('.notif-item:not([data-wired])').forEach(wireItem);
    }
    cursor = snap.docs[snap.docs.length - 1] || null;
    return cursor;
  } catch (e) {
    console.warn('notifications load failed', e);
    if (reset) listEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load notifications', message: (e && (e.code || e.message) ? (e.code || e.message) + ' — ' : '') + 'Please refresh the page.' });
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);

async function refresh(reset = true) {
  await loadAll(reset);
  updateCounts();
}

function wireItem(btn) {
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    try { await updateDoc(doc(db, 'notifications', id), { read: true, readAt: serverTimestamp() }); } catch (_) {}
    const link = btn.dataset.link;
    if (link) location.href = link;
  });
}

// small local toast fallback (avoids circular import)
function toastMsg(msg, type) {
  import('../ui.js')
    .then(({ toast }) => toast(msg, { type }))
    .catch(() => {}); // a failed lazy import must never surface as an unhandled rejection
}

refresh();
