// ─── Admin: user management + detail drawer ──────────────────────────
import { db } from '../../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc, startAfter
} from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=3';
import { esc, fmtNPR, fmtDateTime, fmtRelative, initials } from '../../utils.js';
import { WITHDRAWAL_STATUS, ASSIGNMENT_STATUS } from '../../utils.js';
import { icon } from '../../icons.js';
import { emptyState, skeletonRows, badge, modal, confirmDialog, btnBusy, toast, autoPager } from '../../ui.js';
import { addAdminNote } from '../../admin-actions.js';
import { banUser, applyPenalty, adjustBalance, computeRiskFlags } from '../../admin-actions.js';
import { penaltyModal } from './penalty-modal.js';

let { content } = await mountAdminShell('users');
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Users</h1>
      <p class="sub">Search, inspect and moderate platform accounts.</p>
    </div>
  </div>
  <div class="filters-bar">
    <input class="input search" id="u-search" placeholder="Search name, email or phone…" aria-label="Search users">
    <select class="select" id="u-filter" aria-label="Filter users">
      <option value="">All users</option>
      <option value="active">Active</option>
      <option value="banned">Banned</option>
    </select>
    <span style="flex:1"></span>
    <span class="small muted" id="u-count"></span>
  </div>
  <div class="card"><div id="users-table">${skeletonRows(6, 52)}</div>
  </div>`;

const tableEl = content.querySelector('#users-table');
const searchEl = content.querySelector('#u-search');
const filterEl = content.querySelector('#u-filter');
let cursor = null;
let filterText = '';

const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// One page of the list. `run` comes from autoPager: when a newer run starts
// (search, filter change, ban/unban) this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) { cursor = null; tableEl.innerHTML = skeletonRows(6, 52); }
  try {
    const parts = [collection(db, 'users')];
    const f = filterEl.value;
    if (f) parts.push(where('status', '==', f));
    parts.push(orderBy('createdAt', 'desc'), limit(40));
    if (cursor) parts.push(startAfter(cursor));
    const snap = await getDocs(query(...parts));
    if (run.stale) return null;
    let users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (filterText) {
      const t = filterText.toLowerCase();
      users = users.filter((u) =>
        (u.fullName || '').toLowerCase().includes(t) ||
        (u.email || '').toLowerCase().includes(t) ||
        (u.phone || '').includes(t));
    }
    if (reset) {
      if (!users.length) {
        tableEl.innerHTML = emptyState({ icon: 'users', title: 'No users found', message: filterText ? 'No users match your search on this page — try different terms or load more.' : 'No registered users yet.' });
        return null;
      }
      tableEl.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th></th><th>User</th><th>Phone</th><th>Status</th><th>Joined</th><th>Earnings</th><th></th></tr></thead>
        <tbody id="users-body"></tbody></table></div>`;
    }
    const body = tableEl.querySelector('#users-body');
    body.insertAdjacentHTML('beforeend', users.map((u) => `
      <tr data-uid="${esc(u.id)}" style="cursor:pointer">
        <td style="width:44px"><span class="avatar sm">${esc(initials(u.fullName))}</span></td>
        <td><div class="cell-strong">${esc(u.fullName || '—')}</div><div class="small muted">${esc(u.email)}</div></td>
        <td class="num">${esc(u.phone || '—')}</td>
        <td>${u.status === 'banned' ? badge('Banned', 'red', { dot: true }) : badge('Active', 'green', { dot: true })}
            ${computeRiskFlags(u).length ? badge('Review recommended', 'amber') : ''}</td>
        <td class="small num">${esc(fmtDateTime(u.createdAt))}</td>
        <td class="cell-strong num">${esc(fmtNPR(u.stats?.earnedPaisa || 0))}</td>
        <td style="text-align:right"><button class="btn ghost btn-sm" data-open="${esc(u.id)}">Open</button></td>
      </tr>`).join(''));
    // Bind only rows added by THIS page — re-binding the whole tbody would make
    // every previously-bound row open two drawers after a "Load more".
    body.querySelectorAll('tr:not([data-wired])').forEach((tr) => {
      tr.dataset.wired = '1';
      tr.addEventListener('click', () => openUser(tr.dataset.uid));
    });
    cursor = snap.docs[snap.docs.length - 1] || null;
    const total = tableEl.querySelectorAll('#users-body tr').length;
    content.querySelector('#u-count').textContent = `${total} shown`;
    return cursor;
  } catch (_) {
    if (reset) tableEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load users', message: 'Please refresh the page.' });
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);

searchEl.addEventListener('input', debounce(() => { filterText = searchEl.value.trim(); loadAll(true); }));
filterEl.addEventListener('change', () => loadAll(true));
loadAll(true);

// ── user detail drawer ──
/** Internal admin notes for a user — admin-only, never visible to the user. */
async function renderNotes(uid) {
  const snap = await getDocs(query(
    collection(db, 'users', uid, 'notes'),
    orderBy('createdAt', 'desc'),
    limit(50)
  ));
  const notes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const list = notes.length
    ? `<ul class="notes-list">${notes.map((n) => `
        <li class="notes-item">
          <div class="notes-text">${esc(n.text)}</div>
          <div class="small muted">${esc(n.createdByName || 'Admin')} · ${esc(fmtDateTime(n.createdAt))}</div>
        </li>`).join('')}</ul>`
    : emptyState({ icon: 'edit', title: 'No internal notes', message: 'Notes are only visible to administrators.' });

  return `
    <div class="notes-compose">
      <label class="label" for="note-text">Add a note</label>
      <textarea class="textarea" id="note-text" rows="3" maxlength="2000"
        placeholder="Visible to admins only — never shown to the user."></textarea>
      <div style="margin-top:10px">
        <button class="btn primary btn-sm" id="note-add">${icon('check')} Save note</button>
      </div>
    </div>
    ${list}`;
}

async function openUser(uid) {
  const ov = document.createElement('div');
  ov.className = 'drawer-overlay';
  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.innerHTML = `<div class="drawer-body"><div class="state-block loading"><span class="spin dark"></span></div></div>`;
  document.body.append(ov, drawer);
  requestAnimationFrame(() => { ov.classList.add('open'); drawer.classList.add('open'); });
  const close = () => { ov.classList.remove('open'); drawer.classList.remove('open'); setTimeout(() => { ov.remove(); drawer.remove(); }, 250); };
  ov.addEventListener('click', close);
  document.addEventListener('keydown', function esc2(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); } });

  try {
    const uSnap = await getDoc(doc(db, 'users', uid));
    const wSnap = await getDoc(doc(db, 'wallets', uid));
    if (!uSnap.exists()) { drawer.innerHTML = '<div class="drawer-body">' + emptyState({ icon: 'alert', title: 'User not found' }) + '</div>'; return; }
    const u = { id: uid, ...uSnap.data() };
    const w = wSnap.exists() ? wSnap.data() : {};
    const s = u.stats || {};

    const [assigns, withdrawals, penalties] = await Promise.all([
      getDocs(query(collection(db, 'taskAssignments'), where('userId', '==', uid), orderBy('requestedAt', 'desc'), limit(15))),
      getDocs(query(collection(db, 'withdrawals'), where('userId', '==', uid), orderBy('requestedAt', 'desc'), limit(15))),
      getDocs(query(collection(db, 'penalties'), where('userId', '==', uid), orderBy('appliedAt', 'desc'), limit(10)))
    ]);

    drawer.innerHTML = `
      <div class="drawer-head">
        <span class="avatar lg">${esc(initials(u.fullName))}</span>
        <div class="dh-body">
          <div class="dh-name">${esc(u.fullName || '—')}
            ${u.status === 'banned' ? badge('Banned', 'red', { dot: true }) : badge('Active', 'green', { dot: true })}
            ${u.role === 'admin' ? badge('Admin', 'gold') : ''}
          </div>
          <div class="dh-sub">${esc(u.email)} · joined ${esc(fmtDateTime(u.createdAt))}</div>
        </div>
        <button class="btn-icon" id="drawer-close" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="drawer-tabs">
        <button class="tab active" data-dt="overview">Overview</button>
        <button class="tab" data-dt="financial">Financial</button>
        <button class="tab" data-dt="tasks">Tasks</button>
        <button class="tab" data-dt="withdrawals">Withdrawals</button>
        <button class="tab" data-dt="penalties">Penalties</button>
        <button class="tab" data-dt="notes">Internal notes</button>
      </div>
      <div class="drawer-body" id="drawer-body"></div>
      <div style="display:flex; gap:10px; padding:14px 20px; background:var(--surface); border-top:1px solid var(--line); flex-wrap:wrap">
        <a class="btn primary btn-sm" href="/admin/chats.html?uid=${esc(uid)}">${icon('message')} Chat</a>
        <button class="btn ghost btn-sm" id="act-adjust">${icon('edit')} Adjustment</button>
        <button class="btn ghost btn-sm" id="act-penalty">${icon('alert')} Penalty</button>
        ${u.status === 'banned'
          ? `<button class="btn subtle btn-sm" id="act-unban">${icon('check')} Unban</button>`
          : `<button class="btn outline-danger btn-sm" id="act-ban">${icon('ban')} Ban user</button>`}
      </div>`;

    drawer.querySelector('#drawer-close').addEventListener('click', close);

    const bodyEl = drawer.querySelector('#drawer-body');
    const kv = (k, v, sub = '') => `<div class="kv-cell"><div class="k">${esc(k)}</div><div class="v">${v}${sub ? ` <small>${sub}</small>` : ''}</div></div>`;

    const TABS = {
      overview: () => `
        <div class="kv-grid">
          ${kv('Email', esc(u.email))}
          ${kv('Phone', esc(u.phone ? '+977 ' + u.phone : '—'))}
          ${kv('Email verified', u.emailVerified === false ? 'No' : 'Yes')}
          ${kv('Profile complete', u.profileComplete ? 'Yes' : 'No')}
          ${kv('PIN set', u.pinSetAt ? 'Yes' : 'No', u.pinSetAt ? fmtDateTime(u.pinSetAt) : '')}
          ${kv('Last active', esc(fmtRelative(u.lastActiveAt)))}
          ${u.ban ? kv('Ban reason', esc(u.ban.reason || '—'), u.ban.type + (u.ban.until ? ' · until ' + fmtDateTime(u.ban.until) : '')) : ''}
        </div>`,
      financial: () => `
        <div class="kv-grid">
          ${kv('Total earnings', esc(fmtNPR(w.earnedPaisa || 0)))}
          ${kv('Withdrawable', esc(fmtNPR(w.availablePaisa || 0)))}
          ${kv('On hold', esc(fmtNPR(w.holdPaisa || 0)))}
          ${kv('Pending withdrawal', esc(fmtNPR(w.pendingWithdrawalPaisa || 0)))}
          ${kv('Total withdrawn', esc(fmtNPR(w.withdrawnPaisa || 0)))}
          ${kv('Penalties total', esc(fmtNPR(s.penaltiesPaisa || 0)))}
        </div>
        <p class="hint">Wallet balances are maintained by audited Cloud Functions and cannot be edited directly.</p>`,
      tasks: () => assigns.empty
        ? emptyState({ icon: 'briefcase', title: 'No tasks yet' })
        : `<div class="table-wrap"><table class="table"><thead><tr><th>Task</th><th>Reward</th><th>Status</th><th>Requested</th></tr></thead><tbody>
            ${assigns.docs.map((d) => {
              const a = d.data();
              const st = ASSIGNMENT_STATUS[a.status] || { label: a.status, tone: 'gray' };
              return `<tr><td class="cell-strong">${esc(a.title)}</td><td class="num">${esc(fmtNPR(a.rewardPaisa))}</td>
                <td>${badge(st.label, st.tone)}</td><td class="small num">${esc(fmtDateTime(a.requestedAt))}</td></tr>`;
            }).join('')}</tbody></table></div>`,
      withdrawals: () => withdrawals.empty
        ? emptyState({ icon: 'bank', title: 'No withdrawals' })
        : `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Amount</th><th>eSewa</th><th>Status</th></tr></thead><tbody>
            ${withdrawals.docs.map((d) => {
              const wv = d.data();
              const st = WITHDRAWAL_STATUS[wv.status] || { label: wv.status, tone: 'gray' };
              return `<tr><td class="small num">${esc(fmtDateTime(wv.requestedAt))}</td><td class="cell-strong num">${esc(fmtNPR(wv.amountPaisa))}</td>
                <td class="small">${esc(wv.esewaName)}<br><span class="muted num">+977 ${esc(wv.esewaNumber)}</span></td>
                <td>${badge(st.label, st.tone, { dot: true })}</td></tr>`;
            }).join('')}</tbody></table></div>`,
      penalties: () => penalties.empty
        ? emptyState({ icon: 'alert', title: 'No penalties', message: 'This user has a clean record.' })
        : `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Amount</th><th>Reason</th></tr></thead><tbody>
            ${penalties.docs.map((d) => {
              const p = d.data();
              return `<tr><td class="small num">${esc(fmtDateTime(p.appliedAt))}</td><td class="cell-strong num">${esc(fmtNPR(p.amountPaisa))}</td><td class="small">${esc(p.reason)}</td></tr>`;
            }).join('')}</tbody></table></div>`
    };

    function showTab(id) {
      drawer.querySelectorAll('.drawer-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.dt === id));
      if (id === 'notes') {
        bodyEl.innerHTML = '<div class="state-block loading"><span class="spin dark"></span></div>';
        (async () => {
          const html = await renderNotes(uid);
          bodyEl.innerHTML = html;
          const addBtn = bodyEl.querySelector('#note-add');
          const noteInput = bodyEl.querySelector('#note-text');
          if (noteInput) noteInput.addEventListener('input', () => noteInput.classList.remove('invalid'));
          if (addBtn) addBtn.addEventListener('click', async (ev) => {
            const text = (noteInput ? noteInput.value : '').trim();
            if (text.length < 1) {
              if (noteInput) noteInput.classList.add('invalid');
              toast('Write the note first.', { type: 'warn' });
              return;
            }
            btnBusy(addBtn, true, 'Saving…');
            try {
              await addAdminNote(uid, text);
              toast('Note added.', { type: 'success' });
              showTab('notes'); // reload the list
            } catch (err) {
              btnBusy(addBtn, false);
              toast((err && err.message) || 'Could not save the note.', { type: 'error' });
            }
          });
        })().catch(() => {
          bodyEl.innerHTML = emptyState({
            icon: 'alert', title: 'Could not load notes',
            message: 'Check your connection and try again.',
            actionHTML: '<button class="btn subtle" data-notes-retry>' + icon('refresh') + ' Try again</button>'
          });
          bodyEl.querySelector('[data-notes-retry]')?.addEventListener('click', () => showTab('notes'));
        });
        return;
      }
      bodyEl.innerHTML = TABS[id]();
    }
    drawer.querySelectorAll('.drawer-tabs .tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.dt)));
    showTab('overview');

    // ── actions ──
    drawer.querySelector('#act-penalty').addEventListener('click', () => penaltyModal(u, close));
    drawer.querySelector('#act-adjust').addEventListener('click', () => adjustModal(u, close));
    const banBtn = drawer.querySelector('#act-ban');
    const unbanBtn = drawer.querySelector('#act-unban');
    if (banBtn) banBtn.addEventListener('click', async () => {
      const m = modal({
        title: `Ban ${u.fullName}?`,
        width: 480,
        body: `
          <div class="field">
            <label class="label">Ban type</label>
            <select class="select" id="ban-type"><option value="temporary">Temporary</option><option value="permanent">Permanent</option></select>
          </div>
          <div class="field" id="ban-until-field">
            <label class="label">Restriction ends</label>
            <input class="input" type="date" id="ban-until">
          </div>
          <div class="field">
            <label class="label">Reason <span class="req">*</span></label>
            <textarea class="textarea" id="ban-reason" placeholder="Shown to the user"></textarea>
          </div>`,
        actions: `
          <button class="btn ghost" data-act="cancel">Cancel</button>
          <button class="btn danger" data-act="ban">Ban user</button>`
      });
      const typeSel = m.root.querySelector('#ban-type');
      typeSel.addEventListener('change', () => { m.root.querySelector('#ban-until-field').hidden = typeSel.value === 'permanent'; });
      m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
      m.root.querySelector('[data-act="ban"]').addEventListener('click', async (ev) => {
        const reason = m.root.querySelector('#ban-reason').value.trim();
        if (reason.length < 5) { m.root.querySelector('#ban-reason').classList.add('invalid'); return; }
        const until = typeSel.value === 'temporary' ? m.root.querySelector('#ban-until').value : null;
        const btn = ev.currentTarget;
        btnBusy(btn, true, 'Banning…');
        try {
          await banUser({
            userId: uid, action: 'ban', type: typeSel.value, reason,
            until: until ? until : null
          });
          m.close(); close();
          toast('User has been banned.', { type: 'success' });
          loadAll(true);
        } catch (err) { btnBusy(btn, false); toast(err.message, { type: 'error' }); }
      });
    });
    if (unbanBtn) unbanBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Unban this user?',
        message: 'The account will regain full access immediately.',
        confirmText: 'Unban user'
      });
      if (!ok) return;
      try {
        await banUser({ userId: uid, action: 'unban' });
        close();
        toast('User has been unbanned.', { type: 'success' });
        loadAll(true);
      } catch (err) { toast(err.message, { type: 'error' }); }
    });
  } catch (_) {
    drawer.innerHTML = '<div class="drawer-body">' + emptyState({ icon: 'alert', title: 'Could not load user', message: 'Please try again.' }) + '</div>';
  }
}

function adjustModal(u, closeDrawer) {
  const m = modal({
    title: `Balance adjustment — ${u.fullName}`,
    width: 460,
    body: `
      <p class="small muted">Creates an audited adjustment transaction. This is the only sanctioned way to change a balance.</p>
      <div class="field">
        <label class="label">Type</label>
        <select class="select" id="adj-type"><option value="credit">Credit (add funds)</option><option value="debit">Debit (remove funds)</option></select>
      </div>
      <div class="field">
        <label class="label">Amount (NPR) <span class="req">*</span></label>
        <input class="input" type="number" id="adj-amt" min="1" step="1">
      </div>
      <div class="field">
        <label class="label">Reason <span class="req">*</span></label>
        <textarea class="textarea" id="adj-reason" placeholder="Why is this adjustment needed?"></textarea>
      </div>`,
    actions: `
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="apply">Create adjustment</button>`
  });
  m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.root.querySelector('[data-act="apply"]').addEventListener('click', async (ev) => {
    const amt = Number(m.root.querySelector('#adj-amt').value);
    const type = m.root.querySelector('#adj-type').value;
    const reason = m.root.querySelector('#adj-reason').value.trim();
    if (!amt || amt <= 0) { toast('Enter a valid amount.', { type: 'error' }); return; }
    if (reason.length < 5) { toast('A clear reason is required.', { type: 'error' }); return; }
    const ok = await confirmDialog({
      title: 'Confirm adjustment',
      message: `${fmtNPR(Math.round(amt * 100))} will be ${type === 'credit' ? 'added to' : 'removed from'} ${u.fullName}'s withdrawable balance.`,
      confirmText: 'Confirm', danger: type === 'debit'
    });
    if (!ok) return;
    const btn = ev.currentTarget;
    btnBusy(btn, true, 'Recording…');
    try {
      await adjustBalance({ userId: u.id, amountPaisa: Math.round(amt * 100) * (type === 'credit' ? 1 : -1), reason });
      m.close(); closeDrawer && closeDrawer();
      toast('Adjustment recorded.', { type: 'success' });
    } catch (err) { btnBusy(btn, false); toast(err.message, { type: 'error' }); }
  });
}

// deep link: users.html?uid=…
const target = new URLSearchParams(location.search).get('uid');
if (target) setTimeout(() => openUser(target), 400);
