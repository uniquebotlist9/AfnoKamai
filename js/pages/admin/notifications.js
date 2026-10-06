// ─── Admin: broadcast + delivery audit ───────────────────────────────
//
// Composing a notification and watching whether it actually left the
// building are two halves of the same job, so they share a page.
//
// The send path never fans out from this browser. Every document is written
// with `pushState: 'queued'` and the GitHub Actions sender drains them on
// its five-minute cron — which is what keeps a 5,000-recipient announcement
// out of one HTTP request and out of this session's memory.

import { db } from '../../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc, getCountFromServer
} from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=3';
import { esc, fmtRelative } from '../../utils.js';
import { icon } from '../../icons.js';
import {
  emptyState, skeletonRows, btnBusy, confirmDialog, toast, autoPager
} from '../../ui.js';
import {
  CATEGORIES, CATEGORY_IDS, broadcast, notifyAdmins, notifyUser, listUserIds
} from '../../notify.js';

let { profile, content } = await mountAdminShell('notifications');
document.getElementById('page-skeleton')?.remove();

const AUDIENCES = [
  { id: 'all', label: 'Every active user' },
  { id: 'admins', label: 'Admin team only' },
  { id: 'one', label: 'A single user' }
];

// Deliberately excludes `security`: only the code path that actually
// detects a security event may write it. A compose box that can emit
// "your password changed" is a phishing tool waiting to be abused.
const SENDABLE = CATEGORY_IDS.filter((c) => c !== 'security');

const PRIORITIES = [
  { id: '', label: 'Normal' },
  { id: 'high', label: 'Important — toast + badge' },
  { id: 'urgent', label: 'Urgent — modal, pins on screen' }
];

const STATUS = {
  queued: 'Queued for push',
  sent: 'Push accepted',
  retrying: 'Retrying',
  failed: 'Failed',
  skipped: 'Skipped',
  none: 'In-app only'
};
const STATUS_TONE = {
  queued: 'blue', sent: 'green', retrying: 'amber',
  failed: 'red', skipped: 'gray', none: 'gray'
};

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Notifications</h1>
      <p class="sub">Send a notification, then audit how far each one got.</p>
    </div>
    <div class="page-head-actions">
      <span class="badge tone-blue" id="queue-pill" hidden></span>
    </div>
  </div>

  <div class="card ns-card">
    <div class="card-head"><h3>Compose</h3></div>
    <div class="card-pad">
      <div class="np-form">
        <label class="field">
          <span class="label">Audience</span>
          <select id="np-audience" class="input">
            ${AUDIENCES.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('')}
          </select>
        </label>

        <label class="field" id="np-target-wrap" hidden>
          <span class="label">User (UID or email)</span>
          <input class="input" id="np-target" placeholder="user@example.com" autocomplete="off">
          <span class="hint">Resolved against the <code>users</code> collection at send time.</span>
        </label>

        <label class="field">
          <span class="label">Category</span>
          <select id="np-category" class="input">
            ${SENDABLE.map((c) => `<option value="${c}">${esc(CATEGORIES[c].label)}</option>`).join('')}
          </select>
        </label>

        <label class="field">
          <span class="label">Priority</span>
          <select id="np-priority" class="input">
            ${PRIORITIES.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}
          </select>
        </label>

        <label class="field">
          <span class="label">Title</span>
          <input class="input" id="np-title" maxlength="140" placeholder="Withdrawal approved" required>
        </label>

        <label class="field">
          <span class="label">Message</span>
          <textarea class="input" id="np-body" rows="3" maxlength="600"
                    placeholder="Your withdrawal of Rs 1,200 has been approved."></textarea>
        </label>

        <label class="field">
          <span class="label">Link (optional)</span>
          <input class="input" id="np-link" placeholder="withdraw.html" autocomplete="off">
          <span class="hint">Root-relative page. Clicking the notification opens it.</span>
        </label>
      </div>

      <div class="np-actions">
        <button class="btn primary" id="np-send" type="button">${icon('send')} Queue notification</button>
        <span class="np-note" id="np-note"></span>
      </div>
    </div>
  </div>

  <div class="card ns-card">
    <div class="card-head"><h3>Recent activity</h3></div>
    <div class="notif-tools">
      <label class="notif-search">
        ${icon('search')}
        <input type="search" id="np-q" placeholder="Filter by title or type…" autocomplete="off"
               aria-label="Filter notifications">
      </label>
      <span class="muted small" id="np-filter-note"></span>
    </div>
    <div id="np-list">${skeletonRows(5, 64)}</div>
  </div>`;

const audienceSel = content.querySelector('#np-audience');
const targetWrap = content.querySelector('#np-target-wrap');
const targetInput = content.querySelector('#np-target');
const listEl = content.querySelector('#np-list');
const noteEl = content.querySelector('#np-note');
const queuePill = content.querySelector('#np-queue-pill') || content.querySelector('#queue-pill');
const searchInput = content.querySelector('#np-q');
const filterNote = content.querySelector('#np-filter-note');

audienceSel.addEventListener('change', () => {
  targetWrap.hidden = audienceSel.value !== 'one';
});

// ─── Resolve audience ────────────────────────────────────────────────

async function resolveUser(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  // UID first: it is exact and costs one point read.
  try {
    const byId = await getDoc(doc(db, 'users', raw));
    if (byId.exists()) return byId.id;
  } catch (_) { /* fall through to email */ }

  try {
    const snap = await getDocs(query(
      collection(db, 'users'), where('email', '==', raw.toLowerCase()), limit(1)
    ));
    if (!snap.empty) return snap.docs[0].id;
  } catch (_) { /* handled below */ }

  return null;
}

// ─── Send ────────────────────────────────────────────────────────────

content.querySelector('#np-send').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const title = content.querySelector('#np-title').value.trim();
  const body = content.querySelector('#np-body').value.trim();

  if (!title) {
    toast('Give the notification a title.', { type: 'warn' });
    content.querySelector('#np-title').focus();
    return;
  }
  if (title.length > 140 || body.length > 600) {
    toast('Title must be 140 characters and message 600 characters or fewer.', { type: 'warn' });
    return;
  }

  const audience = audienceSel.value;
  const category = content.querySelector('#np-category').value;
  const priority = content.querySelector('#np-priority').value;
  const link = content.querySelector('#np-link').value.trim();

  // Validate before asking for confirmation: a failed resolve after the
  // admin has already said "yes" reads like a silent no-op send.
  let targetIds = [];
  if (audience === 'one') {
    const uid = await resolveUser(targetInput.value);
    if (!uid) {
      toast('No user matches that UID or email.', { type: 'error' });
      targetInput.focus();
      return;
    }
    targetIds = [uid];
  }

  const ok = await confirmDialog({
    title: 'Queue this notification?',
    message: audience === 'all'
      ? 'It is written now and pushed to every active user on the next sender run (within five minutes).'
      : audience === 'admins'
        ? 'It is written now and pushed to the admin team on the next sender run.'
        : `It is written now and pushed to 1 user on the next sender run.`,
    confirmText: 'Queue it'
  });
  if (!ok) return;

  btnBusy(btn, true, 'Queueing…');
  noteEl.textContent = '';

  const payload = { type: `broadcast_${category}`, category, title, body, link, priority };

  try {
    let result;
    if (audience === 'all') {
      const ids = await listUserIds();
      if (!ids.length) throw new Error('No active users found.');
      result = await broadcast(ids, {
        ...payload,
        // Fresh per send, so sending the same text twice a week apart is
        // still two broadcasts. Idempotency lives inside one send: the
        // per-user document id is derived from this, so a retried chunk
        // overwrites rather than duplicating.
        broadcastId: `bc_${Date.now().toString(36)}`
      });
      noteEl.textContent = `Queued for ${result.written} of ${result.attempted} users.`;
    } else if (audience === 'admins') {
      await notifyAdmins(payload);
      noteEl.textContent = 'Queued for the admin team.';
    } else {
      await notifyUser(targetIds[0], payload);
      noteEl.textContent = `Queued for ${targetIds[0]}.`;
    }

    toast('Queued. The sender will push it within five minutes.', { type: 'success' });
    content.querySelector('#np-title').value = '';
    content.querySelector('#np-body').value = '';
    content.querySelector('#np-link').value = '';
    refresh();
    loadQueueCount();
  } catch (err) {
    console.error('[admin/notifications] send failed', err);
    const detail = err && (err.code || err.message) ? ` — ${err.code || err.message}` : '';
    toast(`Could not queue the notification${detail}`, { type: 'error' });
  }
  btnBusy(btn, false);
});

// ─── Delivery audit ──────────────────────────────────────────────────

let filter = '';

function row(d) {
  const n = d.data();
  const state = n.pushState || 'none';
  const skip = n.pushSkipReason ? ` · ${n.pushSkipReason}` : '';
  const attempts = n.pushAttempts && n.pushAttempts > 1 ? ` · attempt ${n.pushAttempts}` : '';
  const cat = CATEGORIES[n.category];

  return `
    <div class="np-row">
      <span class="act-ic ${esc(n.tone || (cat ? cat.tint : 'gray'))}">${icon(n.icon || (cat ? cat.icon : 'info'))}</span>
      <div class="np-row-body">
        <div class="act-title">${esc(n.title || '(untitled)')}</div>
        <div class="act-desc">${esc(n.body || '')}</div>
        <div class="act-meta">
          <span class="notif-cat">${esc(cat ? cat.label : n.category || '—')}</span>
          <span>${esc(n.userId || '')}</span>
          <span>${esc(n.pushDeviceCount != null ? `${n.pushDeviceCount} device(s)` : '')}</span>
          <span class="act-time">${esc(n.createdAt ? fmtRelative(n.createdAt) : '')}</span>
        </div>
      </div>
      <span class="badge tone-${STATUS_TONE[state] || 'gray'}" title="${esc((STATUS[state] || state) + skip + attempts)}">
        ${esc(STATUS[state] || state)}
      </span>
    </div>`;
}

function filtered(snap) {
  if (!filter) return snap.docs;
  return snap.docs.filter((d) => {
    const n = d.data();
    return (n.title || '').toLowerCase().includes(filter)
      || (n.type || '').toLowerCase().includes(filter);
  });
}

let run = { stale: false };

async function load(reset) {
  if (reset) {
    listEl.innerHTML = skeletonRows(5, 64);
    run.stale = true;
    run = { stale: false };
  }
  const mine = run;

  try {
    const snap = await getDocs(query(
      collection(db, 'notifications'),
      orderBy('createdAt', 'desc'),
      limit(60)
    ));
    if (mine.stale) return null;

    const docs = filtered(snap);
    if (!docs.length) {
      listEl.innerHTML = filter
        ? emptyState({ icon: 'search', title: 'No matches', message: 'Nothing matches this filter.' })
        : emptyState({ icon: 'bell', title: 'Nothing sent yet', message: 'Queued notifications appear here with their delivery state.' });
      filterNote.textContent = '';
      return null;
    }

    listEl.innerHTML = docs.map(row).join('');
    filterNote.textContent = filter
      ? `${docs.length} of ${snap.size} match`
      : `${snap.size} most recent`;
    // The queue pill has its own exact aggregate — see loadQueueCount().
    return null;
  } catch (err) {
    console.error('[admin/notifications] load failed', err);
    if (mine.stale || reset) {
      listEl.innerHTML = emptyState({
        icon: 'alert', title: 'Could not load',
        message: `${(err && (err.code || err.message)) || 'Unknown error'} — please refresh.`
      });
    }
    return null;
  }
}

async function loadQueueCount() {
  // An aggregate rather than a capped query: a pill reading "50 queued"
  // when 400 are waiting is worse than no pill at all.
  try {
    const agg = await getCountFromServer(query(
      collection(db, 'notifications'),
      where('pushState', '==', 'queued')
    ));
    const n = agg.data().count;
    queuePill.hidden = !n;
    queuePill.textContent = `${n} queued`;
  } catch (_) { /* pill is informational */ }
}

const loadAll = autoPager(load);
async function refresh(reset = true) { await loadAll(reset); }

// Debounced so typing does not fan out a query per keystroke against a
// free-tier quota this project is already careful with.
let timer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const next = searchInput.value.trim().toLowerCase();
    if (next === filter) return;
    filter = next;
    refresh();
  }, 300);
});

refresh();
loadQueueCount();
