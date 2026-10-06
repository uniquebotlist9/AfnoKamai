// ─── Transaction history (paginated ledger) ──────────────────────────
import { db } from '../firebase.js';
import { mountShell } from '../shell.js';
import { collection, query, where, getCountFromServer } from 'firebase/firestore';
import { fetchTransactionsPage, txTypeMeta, txStatusMeta } from '../wallet.js';
import { esc, fmtNPR, fmtDateTime, TX_TYPE, TX_STATUS } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState, skeletonRows, badge, toast, autoPager } from '../ui.js';

let { user, content } = await mountShell('transactions');
document.getElementById('page-skeleton')?.remove();

const PAGE_SIZE = 25;
let filterType = '';
let filterStatus = '';
let cursor = null;
let loadedTotal = 0;   // records rendered so far

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Transactions</h1>
      <p class="sub">Every balance change on your account, recorded permanently.</p>
    </div>
  </div>

  <div class="filters-bar">
    <input class="input" type="month" id="tx-month" style="max-width:180px" aria-label="Monthly report month">
    <button class="btn ghost btn-sm" id="tx-csv">${icon('download')} Download CSV</button>
    <span style="flex:1"></span>
    <select class="select" id="f-type" aria-label="Filter by type">
      <option value="">All types</option>
      ${Object.entries(TX_TYPE).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}
    </select>
    <select class="select" id="f-status" aria-label="Filter by status">
      <option value="">All statuses</option>
      <option value="hold">On hold</option>
      <option value="available">Available</option>
      <option value="pending">Pending</option>
      <option value="completed">Completed</option>
      <option value="reversed">Reversed</option>
    </select>
    <span class="small muted" id="tx-count" aria-live="polite"></span>
  </div>

  <div class="card card-pad" id="month-report" hidden style="margin-bottom:16px">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px">
      <h3 style="margin:0" id="mr-title">Monthly report</h3>
      <span class="small muted">Computed from your real transactions</span>
    </div>
    <div class="kv-grid" id="mr-grid" style="margin-bottom:0"></div>
  </div>

  <div class="card">
    <div id="tx-list">${skeletonRows(6, 52)}</div>
  </div>`;

const listEl = content.querySelector('#tx-list');
const countEl = content.querySelector('#tx-count');

function tableHTML() {
  return `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead>
      <tbody id="tx-body"></tbody>
    </table></div>`;
}

function setCount(shown, total = null) {
  if (total === null) { countEl.textContent = `${shown} loaded`; return; }
  countEl.textContent = `${shown} of ${total} record${total === 1 ? '' : 's'}`;
}

/** Total matching the current filter — one cheap count query. */
async function countMatching() {
  const parts = [collection(db, 'transactions'), where('userId', '==', user.uid)];
  if (filterType) parts.push(where('type', '==', filterType));
  if (filterStatus) parts.push(where('status', '==', filterStatus));
  const snap = await getCountFromServer(query(...parts));
  return snap.data().count;
}

// One page of the list. `run` comes from autoPager: when a newer run starts
// (filter switch, retry) this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) {
    cursor = null;
    loadedTotal = 0;
    listEl.innerHTML = skeletonRows(6, 52);
    countEl.textContent = '';
  }

  try {
    const { items, cursor: next } = await fetchTransactionsPage(user.uid, {
      type: filterType, status: filterStatus, pageSize: PAGE_SIZE, cursor
    });
    if (run.stale) return null; // a newer load superseded this one

    // First page of this filter
    if (reset) {
      if (!items.length) {
        listEl.innerHTML = emptyState({
          icon: 'list',
          title: 'No transactions yet',
          message: 'Once you complete tasks or withdraw funds, every record will be listed here.'
        });
        setCount(0, 0);
        return null;
      }
      listEl.innerHTML = tableHTML();
    } else if (!items.length && !loadedTotal) {
      return null;
    }

    const body = listEl.querySelector('#tx-body');
    body.insertAdjacentHTML('beforeend', items.map((t) => {
      const tm = txTypeMeta(t.type);
      const sm = txStatusMeta(t.status);
      const sign = t.amountPaisa >= 0 ? 'pos' : 'neg';
      return `<tr>
        <td class="num small">${esc(fmtDateTime(t.createdAt))}</td>
        <td><span style="display:inline-flex; gap:8px; align-items:center">${icon(tm.icon)} ${esc(tm.label)}</span></td>
        <td class="small">${esc(t.description || '—')}</td>
        <td class="cell-strong num ${sign}">${esc(fmtNPR(t.amountPaisa, { sign: 1 }))}</td>
        <td>${badge(sm.label, sm.tone, { dot: true })}${t.status === 'hold' && t.availableAt ? `<div class="small muted" style="margin-top:3px">until ${esc(fmtDateTime(t.availableAt))}</div>` : ''}</td>
        <td class="small muted num">${esc((t.referenceId || t.transactionId || t.id || '—').slice(0, 14))}</td>
      </tr>`;
    }).join(''));

    loadedTotal += items.length;
    cursor = next;

    // Accurate total when everything is loaded; otherwise show what we have.
    const total = await countMatching();
    if (!run.stale) setCount(loadedTotal, next ? Math.max(total, loadedTotal) : total);
    return next;
  } catch (err) {
    if (run.stale) return null;
    const idxHint = err && err.code === 'failed-precondition'
      ? 'A database index is still building. Try again in a few minutes.'
      : 'Check your connection and try again.';
    if (reset) {
      listEl.innerHTML = emptyState({
        icon: 'alert',
        title: 'We could not load your transactions',
        message: idxHint,
        actionHTML: '<button class="btn subtle" data-tx-retry>' + icon('refresh') + ' Try again</button>'
      });
      const retry = listEl.querySelector('[data-tx-retry]');
      if (retry) retry.addEventListener('click', () => loadAll(true));
    } else {
      toast('Could not load more transactions.', { type: 'error' });
    }
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);

content.querySelector('#f-type').addEventListener('change', (e) => { filterType = e.target.value; loadAll(true); });
content.querySelector('#f-status').addEventListener('change', (e) => { filterStatus = e.target.value; loadAll(true); });
loadAll(true);


// ── Monthly report + CSV statement ──
const monthInput = content.querySelector('#tx-month');
const reportCard = content.querySelector('#month-report');

/** Current month in Asia/Kathmandu (Nepal time), as YYYY-MM. */
function ktmToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());
}
monthInput.value = ktmToday().slice(0, 7);

const EXPORT_MAX = 5000;
async function allMyTransactions(max = EXPORT_MAX) {
  const out = [];
  let c = null;
  for (let i = 0; i < Math.ceil(max / 200); i++) {
    const page = await fetchTransactionsPage(user.uid, { pageSize: 200, cursor: c });
    out.push(...page.items);
    c = page.cursor;
    if (!c || out.length >= max) break;
  }
  return out;
}

function monthKeyOf(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(d).slice(0, 7);
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /["\r\n,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function updateMonthReport() {
  const month = monthInput.value;
  if (!month) { reportCard.hidden = true; return; }
  reportCard.hidden = false;
  content.querySelector('#mr-title').textContent =
    new Date(month + '-02').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Asia/Kathmandu' }) + ' — earnings report';
  const grid = content.querySelector('#mr-grid');
  grid.innerHTML = '<span class="spin dark"></span>';
  try {
    const all = await allMyTransactions();
    const monthTx = all.filter((t) => monthKeyOf(t.createdAt) === month);
    const sum = (fn) => monthTx.filter(fn).reduce((s, t) => s + Math.abs(t.amountPaisa || 0), 0);
    const earned = sum((t) => t.type === 'task_reward' && t.amountPaisa > 0);
    const released = sum((t) => t.type === 'task_reward' && t.status === 'available');
    const referralEarned = sum((t) => (t.type === 'referral_reward' || t.type === 'referral_task_reward') && t.amountPaisa > 0);
    const referralCount = monthTx.filter((t) => t.type === 'referral_reward' || t.type === 'referral_task_reward').length;
    const penalties = sum((t) => t.type === 'penalty');
    const withdrawn = sum((t) => t.type === 'withdrawal' && t.amountPaisa < 0);
    grid.innerHTML = `
      <div class="kv-cell"><div class="k">Reward transactions</div><div class="v">${monthTx.filter((t) => t.type === 'task_reward').length}</div></div>
      <div class="kv-cell"><div class="k">Earned</div><div class="v num">${esc(fmtNPR(earned))}</div></div>
      <div class="kv-cell"><div class="k">Released from hold</div><div class="v num">${esc(fmtNPR(released))}</div></div>
      <div class="kv-cell"><div class="k">Referral earnings</div><div class="v num">${esc(fmtNPR(referralEarned))}</div></div>
      <div class="kv-cell"><div class="k">Referral rewards</div><div class="v">${referralCount}</div></div>
      <div class="kv-cell"><div class="k">Penalties</div><div class="v num">${esc(fmtNPR(penalties))}</div></div>
      <div class="kv-cell"><div class="k">Withdrawn</div><div class="v num">${esc(fmtNPR(withdrawn))}</div></div>
      <div class="kv-cell"><div class="k">All transactions</div><div class="v">${monthTx.length}</div></div>`;
  } catch (_) {
    grid.innerHTML = '<div class="small muted">Could not load the report. Please try again.</div>';
  }
}

monthInput.addEventListener('change', updateMonthReport);
updateMonthReport();

content.querySelector('#tx-csv').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = `<span class="spin"></span>Preparing…`;
  try {
    const rows = [['Transaction ID', 'Date (Nepal time)', 'Type', 'Description', 'Amount (NPR)', 'Status', 'Reference']];
    const all = await allMyTransactions();
    for (const t of all) {
      rows.push([
        t.transactionId || t.id || '',
        t.createdAt ? fmtDateTime(t.createdAt) : '',
        (TX_TYPE[t.type] || { label: t.type }).label,
        t.description || '',
        ((t.amountPaisa || 0) / 100).toFixed(2),
        (TX_STATUS[t.status] || { label: t.status }).label,
        t.referenceId || ''
      ]);
    }
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `afnokamai-statement-${ktmToday()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast(`Statement downloaded (${all.length} record${all.length === 1 ? '' : 's'}).`, { type: 'success' });
  } catch (_) {
    toast('Could not build the statement. Please try again.', { type: 'error' });
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});
