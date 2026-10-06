// ─── Admin: withdrawal management ────────────────────────────────────
import { db } from '../../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc, startAfter
} from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=3';
import { esc, fmtNPR, fmtDateTime, fmtRelative } from '../../utils.js';
import { WITHDRAWAL_STATUS } from '../../utils.js';
import { icon } from '../../icons.js';
import { emptyState, skeletonRows, badge, modal, confirmDialog, btnBusy, toast, autoPager } from '../../ui.js';
import { reviewWithdrawal } from '../../admin-actions.js';

let { content } = await mountAdminShell('withdrawals');
document.getElementById('page-skeleton')?.remove();

const FILTERS = [
  { id: 'pending', label: 'Pending' },
  { id: 'under_review', label: 'Under review' },
  { id: 'processing', label: 'Processing' },
  { id: 'completed', label: 'Completed' },
  { id: 'rejected', label: 'Rejected' },
  { id: '', label: 'All' }
];

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Withdrawals</h1>
      <p class="sub">Verify eSewa details against the user's records, then process payouts.</p>
    </div>
  </div>
  <div class="filters-bar">
    <div class="segmented" id="w-filter">
      ${FILTERS.map((f, i) => `<button data-f="${f.id}" class="${i === 0 ? 'active' : ''}">${f.label}</button>`).join('')}
    </div>
    <span style="flex:1"></span>
    <span class="small muted" id="w-count"></span>
  </div>
  <div class="card"><div id="w-table">${skeletonRows(5, 56)}</div>
  </div>`;

const tableEl = content.querySelector('#w-table');
let statusFilter = 'pending';
let cursor = null;

content.querySelector('#w-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-f]');
  if (!btn) return;
  content.querySelectorAll('#w-filter button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  statusFilter = btn.dataset.f;
  loadAll(true);
});

function actionsFor(w) {
  const b = [];
  if (['pending', 'under_review'].includes(w.status)) {
    b.push(`<button class="btn primary btn-sm" data-act="processing" data-id="${esc(w.id)}">Mark processing</button>`);
    b.push(`<button class="btn outline-danger btn-sm" data-act="rejected" data-id="${esc(w.id)}">Reject</button>`);
  }
  if (['processing', 'approved', 'under_review'].includes(w.status)) {
    b.push(`<button class="btn subtle btn-sm" data-act="completed" data-id="${esc(w.id)}">${icon('check')} Mark completed</button>`);
  }
  if (w.status === 'completed') {
    b.push(`<span class="badge tone-green">${icon('check')} Paid</span>`);
  }
  if (w.status === 'rejected') {
    b.push(`<span class="small muted">Refunded to balance</span>`);
  }
  return b.join(' ');
}

// One page of the list. `run` comes from autoPager: when a newer run starts
// (filter switch, review action) this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) { cursor = null; tableEl.innerHTML = skeletonRows(5, 56); }
  try {
    const parts = [collection(db, 'withdrawals')];
    if (statusFilter) parts.push(where('status', '==', statusFilter));
    parts.push(orderBy('requestedAt', 'desc'), limit(30));
    if (cursor) parts.push(startAfter(cursor));
    const snap = await getDocs(query(...parts));
    if (run.stale) return null;
    const items = snap.docs;
    if (reset) {
      if (!items.length) {
        tableEl.innerHTML = emptyState({
          icon: 'bank', title: statusFilter === 'pending' ? 'No pending withdrawals' : 'Nothing here',
          message: statusFilter === 'pending' ? 'Withdrawal requests will appear here for verification.' : 'No withdrawals match this filter.'
        });
        return null;
      }
      tableEl.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th>Requested</th><th>User</th><th>Amount</th><th>eSewa details</th><th>Status</th><th>PIN</th><th>Actions</th></tr></thead>
        <tbody></tbody></table></div>`;
    }
    const body = tableEl.querySelector('tbody');
    body.insertAdjacentHTML('beforeend', items.map((d) => {
      // MUST carry the document id — actionsFor() reads w.id to build data-id.
      // d.data() alone has no id, which produced data-id="" and a doc path of
      // just "withdrawals" ("even number of segments ... has 1").
      const w = { ...d.data(), id: d.id };
      const st = WITHDRAWAL_STATUS[w.status] || { label: w.status, tone: 'gray' };
      return `<tr>
        <td class="small num">${esc(fmtDateTime(w.requestedAt))}</td>
        <td><div class="cell-strong">${esc(w.userName || '—')}</div>
          <a class="small" href="/admin/users.html?uid=${esc(w.userId)}">${esc(w.userEmail || '')}</a></td>
        <td class="cell-strong num">${esc(fmtNPR(w.amountPaisa))}</td>
        <td><div>${esc(w.esewaName)}</div><div class="small muted num">+977 ${esc(w.esewaNumber)}</div></td>
        <td>${badge(st.label, st.tone, { dot: true })}${w.reason ? `<div class="small muted" style="margin-top:4px; max-width:180px">${esc(w.reason)}</div>` : ''}</td>
        <td data-pin="${esc(d.id)}"><span class="spin dark" style="width:13px;height:13px;border-width:2px"></span></td>
        <td style="white-space:nowrap">${actionsFor(w)}</td>
      </tr>`;
    }).join(''));
    const byId = new Map(items.map((d) => [d.id, d.data()]));
    // Bind only rows added by THIS page — otherwise every "Load more" fires each
    // action twice (duplicate reviewWithdrawal calls → duplicate notifications
    // and audit rows) and re-reads the PIN proof for rows already verified.
    const newRows = Array.from(body.querySelectorAll('tr:not([data-wired])'));
    newRows.forEach((tr) => {
      tr.dataset.wired = '1';
      tr.querySelectorAll('[data-act]').forEach((btn) =>
        btn.addEventListener('click', () => actOn(btn.dataset.act, btn.dataset.id)));
      tr.querySelectorAll('td[data-pin]').forEach((td) => {
        const w = byId.get(td.dataset.pin);
        if (w) verifyPinStatus(td, w);
      });
    });
    cursor = snap.docs[snap.docs.length - 1] || null;
    content.querySelector('#w-count').textContent = `${tableEl.querySelectorAll('tbody tr').length} shown`;
    return cursor;
  } catch (_) {
    if (reset) tableEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load withdrawals', message: 'Please refresh the page.' });
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);
loadAll(true);

async function actOn(action, id) {
  if (action === 'completed') {
    const ok = await confirmDialog({
      title: 'Mark as completed?',
      message: 'Only do this after the eSewa transfer has actually been sent. This finalizes the transaction permanently.',
      confirmText: 'Payment sent — mark completed',
      requireText: 'PAID',
      requireTextPlaceholder: 'Type PAID'
    });
    if (!ok) return;
    await perform(action, id, '');
    return;
  }
  if (action === 'rejected') {
    const rm = modal({
      title: 'Reject withdrawal',
      width: 460,
      body: `
        <p class="confirm-msg">The amount will be refunded to the user's withdrawable balance and the user will see this reason.</p>
        <textarea class="textarea" id="reason" placeholder="Why is this withdrawal rejected?"></textarea>`,
      actions: `
        <button class="btn ghost" data-act="cancel">Cancel</button>
        <button class="btn danger" data-act="go">Reject withdrawal</button>`
    });
    rm.root.querySelector('[data-act="cancel"]').addEventListener('click', () => rm.close());
    rm.root.querySelector('[data-act="go"]').addEventListener('click', async (ev) => {
      const reason = rm.root.querySelector('#reason').value.trim();
      if (reason.length < 5) { rm.root.querySelector('#reason').classList.add('invalid'); return; }
      await perform(action, id, reason);
      rm.close();
    });
    return;
  }
  // processing
  await perform(action, id, '');
}

async function perform(action, id, reason) {
  try {
    await reviewWithdrawal({ withdrawalId: id, action, reason });
    toast(action === 'completed' ? 'Withdrawal marked as completed.' :
      action === 'rejected' ? 'Withdrawal rejected and refunded.' : 'Withdrawal marked as processing.',
      { type: 'success' });
    loadAll(true);
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}


// ── PIN proof verification: compare request proof against the stored hash ──
// The hash is stored in users/{uid}/private/pin (owner write-only, admin
// readable) and was computed with the same PBKDF2 salt the user mirrored
// into users/{uid}.pinSalt at withdrawal time.
// Results are cached per withdrawal id: the list re-renders on every filter
// change, and each row costs 2 reads (user doc + PIN doc).
const pinCache = new Map();
async function verifyPinStatus(cell, w) {
  try {
    if (pinCache.has(w.id)) {
      cell.innerHTML = pinCache.get(w.id);
      return;
    }
    const [meSnap, pinSnap] = await Promise.all([
      getDoc(doc(db, 'users', w.userId)),
      getDoc(doc(db, 'users', w.userId, 'private', 'pin'))
    ]);
    let html;
    if (!meSnap.exists() || !pinSnap.exists() || !pinSnap.data().pinHash) {
      html = '<span class="badge tone-gray">No PIN</span>';
    } else {
      const hash = pinSnap.data().pinHash;
      const saltAtRequest = w.pinSaltUsed;
      const currentSalt = meSnap.data().pinSalt;
      if (currentSalt && saltAtRequest && currentSalt !== saltAtRequest) {
        html = '<span class="badge tone-amber">PIN changed after request</span>';
      } else if (hash === w.pinProof) {
        html = '<span class="badge tone-green" title="PBKDF2 proof matches the stored hash">' + icon('check') + ' Verified</span>';
      } else {
        html = '<span class="badge tone-red" title="The PIN proof in the request does not match the stored hash">' + icon('x') + ' Mismatch</span>';
      }
    }
    pinCache.set(w.id, html);
    cell.innerHTML = html;
  } catch (_) {
    cell.innerHTML = '<span class="badge tone-gray">—</span>';
  }
}
