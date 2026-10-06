// ─── Admin: all-platform transaction ledger ──────────────────────────
import { db } from '../../firebase.js';
import { collection, query, where, orderBy, limit, getDocs, startAfter } from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=3';
import { esc, fmtNPR, fmtDateTime, TX_TYPE, TX_STATUS } from '../../utils.js';
import { emptyState, skeletonRows, autoPager } from '../../ui.js';

let { content } = await mountAdminShell('transactions');
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Transactions</h1>
      <p class="sub">Read-only ledger of every financial event on the platform.</p>
    </div>
  </div>
  <div class="filters-bar">
    <select class="select" id="f-type" aria-label="Filter by type">
      <option value="">All types</option>
      ${Object.entries(TX_TYPE).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}
    </select>
    <select class="select" id="f-status" aria-label="Filter by status">
      <option value="">All statuses</option>
      ${Object.entries(TX_STATUS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}
    </select>
  </div>
  <div class="card"><div id="tx-table">${skeletonRows(6, 52)}</div>
  </div>`;

const tableEl = content.querySelector('#tx-table');
let fType = '';
let fStatus = '';
let cursor = null;

// One page of the list. `run` comes from autoPager: when a newer run starts
// (filter switch) this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) { cursor = null; tableEl.innerHTML = skeletonRows(6, 52); }
  try {
    const parts = [collection(db, 'transactions')];
    if (fType) parts.push(where('type', '==', fType));
    if (fStatus) parts.push(where('status', '==', fStatus));
    parts.push(orderBy('createdAt', 'desc'), limit(40));
    if (cursor) parts.push(startAfter(cursor));
    const snap = await getDocs(query(...parts));
    if (run.stale) return null;
    if (reset && snap.empty) {
      tableEl.innerHTML = emptyState({ icon: 'list', title: 'No transactions yet', message: 'Financial records appear here as tasks are approved and withdrawals processed.' });
      return null;
    }
    if (reset) {
      tableEl.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>Type</th><th>User</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody></tbody></table></div>`;
    }
    const body = tableEl.querySelector('tbody');
    body.insertAdjacentHTML('beforeend', snap.docs.map((d) => {
      const t = d.data();
      const tm = TX_TYPE[t.type] || { label: t.type, icon: 'info' };
      const sm = TX_STATUS[t.status] || { label: t.status, tone: 'gray' };
      return `<tr>
        <td class="small num">${esc(fmtDateTime(t.createdAt))}</td>
        <td><span class="chip">${esc(tm.label)}</span></td>
        <td class="small num">${esc((t.userId || '—').slice(0, 10))}…</td>
        <td class="small">${esc(t.description || '—')}</td>
        <td class="cell-strong num ${t.amountPaisa >= 0 ? '' : 'neg'}" style="${t.amountPaisa < 0 ? 'color:var(--red-600)' : ''}">${esc(fmtNPR(t.amountPaisa, { sign: 1 }))}</td>
        <td><span class="badge tone-${sm.tone}">${esc(sm.label)}</span></td>
      </tr>`;
    }).join(''));
    cursor = snap.docs[snap.docs.length - 1] || null;
    return cursor;
  } catch (_) {
    if (reset) tableEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load transactions', message: 'Please refresh the page.' });
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);

content.querySelector('#f-type').addEventListener('change', (e) => { fType = e.target.value; loadAll(true); });
content.querySelector('#f-status').addEventListener('change', (e) => { fStatus = e.target.value; loadAll(true); });
loadAll(true);
