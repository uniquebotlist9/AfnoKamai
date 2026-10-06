// ─── Admin: task review queue ────────────────────────────────────────
import { db } from '../../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs, startAfter, doc, getDoc
} from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=2';
import { esc, fmtNPR, fmtDateTime, fmtRelative } from '../../utils.js';
import { ASSIGNMENT_STATUS } from '../../utils.js';
import { icon } from '../../icons.js';
import { emptyState, skeletonRows, badge, modal, btnBusy, toast, autoPager } from '../../ui.js';
import { reviewTask, sweepHolds } from '../../admin-actions.js';

let { content } = await mountAdminShell('reviews');
document.getElementById('page-skeleton')?.remove();

const FILTERS = [
  { id: 'submitted', label: 'To review' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'clarification', label: 'Clarification' },
  { id: 'requested', label: 'Requested' },
  { id: 'assigned', label: 'In progress' },
  { id: '', label: 'All' }
];

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Task reviews</h1>
      <p class="sub">Approve, reject or request clarification for submitted tasks. Approval creates the hold transaction.</p>
    </div>
  </div>
  <div class="filters-bar">
    <div class="segmented" id="status-filter">
      ${FILTERS.map((f, i) => `<button data-f="${f.id}" class="${i === 0 ? 'active' : ''}">${f.label}</button>`).join('')}
    </div>
    <span style="flex:1"></span>
    <span class="small muted" id="rv-count"></span>
  </div>
  <div class="card"><div id="reviews-table">${skeletonRows(5, 56)}</div>
  </div>`;

const tableEl = content.querySelector('#reviews-table');
let statusFilter = 'submitted';
let cursor = null;

content.querySelector('#status-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-f]');
  if (!btn) return;
  content.querySelectorAll('#status-filter button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  statusFilter = btn.dataset.f;
  loadAll(true);
});

// One page of the list. `run` comes from autoPager: when a newer run starts
// (filter switch, approve/reject) this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) { cursor = null; tableEl.innerHTML = skeletonRows(5, 56); }
  try {
    const parts = [collection(db, 'taskAssignments')];
    if (statusFilter) parts.push(where('status', '==', statusFilter));
    parts.push(orderBy('requestedAt', 'desc'), limit(30));
    if (cursor) parts.push(startAfter(cursor));
    const snap = await getDocs(query(...parts));
    if (run.stale) return null;
    const items = snap.docs;
    if (reset) {
      if (!items.length) {
        tableEl.innerHTML = emptyState({
          icon: 'check', title: statusFilter === 'submitted' ? 'Review queue is clear' : 'Nothing here',
          message: statusFilter === 'submitted' ? 'No submissions are waiting for review right now.' : 'No assignments match this filter.'
        });
        return null;
      }
      tableEl.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th>Task</th><th>User</th><th>Reward</th><th>Submitted</th><th>Status</th><th></th></tr></thead>
        <tbody></tbody></table></div>`;
    }
    const body = tableEl.querySelector('tbody');
    body.insertAdjacentHTML('beforeend', items.map((d) => {
      const a = d.data();
      const st = ASSIGNMENT_STATUS[a.status] || { label: a.status, tone: 'gray' };
      return `<tr data-id="${esc(d.id)}" style="cursor:pointer">
        <td><div class="cell-strong">${esc(a.title)}</div><div class="small muted">${esc(a.category || '')}</div></td>
        <td><div>${esc(a.userName || '—')}</div><div class="small muted">${esc(a.userEmail || '')}</div></td>
        <td class="cell-strong num">${esc(fmtNPR(a.rewardPaisa))}</td>
        <td class="small num">${a.submittedAt ? esc(fmtRelative(a.submittedAt)) : esc(fmtRelative(a.requestedAt))}</td>
        <td>${badge(st.label, st.tone, { dot: true })}</td>
        <td style="text-align:right"><button class="btn primary btn-sm" data-review="${esc(d.id)}">Review</button></td>
      </tr>`;
    }).join(''));
    // Bind only rows added by THIS page: re-binding the whole tbody would open
    // two stacked review modals for every row after a "Load more".
    tableEl.querySelectorAll('tr[data-id]:not([data-wired])').forEach((tr) => {
      tr.dataset.wired = '1';
      const btn = tr.querySelector('[data-review]');
      if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); reviewModal(btn.dataset.review); });
      tr.addEventListener('click', () => reviewModal(tr.dataset.id));
    });
    cursor = snap.docs[snap.docs.length - 1] || null;
    content.querySelector('#rv-count').textContent = `${tableEl.querySelectorAll('tbody tr').length} shown`;
    return cursor;
  } catch (_) {
    if (reset) tableEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load reviews', message: 'Please refresh the page.' });
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);
loadAll(true);

async function reviewModal(assignmentId) {
  try {
    const snap = await getDoc(doc(db, 'taskAssignments', assignmentId));
    const a = snap.data();
    if (!a) return;
    const st = ASSIGNMENT_STATUS[a.status] || { label: a.status, tone: 'gray' };
    const actions = [];
    if (a.status === 'submitted' || a.status === 'under_review') {
      actions.push('<button class="btn danger" data-act="reject">Reject</button>');
      actions.push('<button class="btn ghost" data-act="clarify">Request clarification</button>');
      actions.push(`<button class="btn primary" data-act="approve">${icon('check')} Approve & hold ${esc(fmtNPR(a.rewardPaisa))}</button>`);
    }
    const m = modal({
      title: a.title,
      width: 640,
      body: `
        <div class="summary-box" style="margin-bottom:14px">
          <div class="sum-row"><span class="k">User</span><span class="v">${esc(a.userName || '—')} <span class="muted small">(${esc(a.userEmail || '')})</span></span></div>
          <div class="sum-row"><span class="k">Reward</span><span class="v num">${esc(fmtNPR(a.rewardPaisa))}</span></div>
          <div class="sum-row"><span class="k">Status</span><span class="v">${badge(st.label, st.tone, { dot: true })}</span></div>
          <div class="sum-row"><span class="k">Requested</span><span class="v small">${esc(fmtDateTime(a.requestedAt))}</span></div>
          ${a.submittedAt ? `<div class="sum-row"><span class="k">Submitted</span><span class="v small">${esc(fmtDateTime(a.submittedAt))}</span></div>` : ''}
        </div>
        <h4 style="margin-bottom:6px">Task instructions</h4>
        <div class="card card-pad" style="background:var(--surface-2); box-shadow:none; font-size:14px; white-space:pre-wrap; margin-bottom:14px">${esc(a.instructions || '—')}</div>
        ${a.note ? `<h4 style="margin-bottom:6px">User's submission note</h4>
        <div class="card card-pad" style="background:var(--surface-2); box-shadow:none; font-size:14px; white-space:pre-wrap; margin-bottom:8px">${esc(a.note)}</div>` : ''}
        <a class="btn ghost btn-sm" href="/admin/chats.html?uid=${esc(a.userId)}" target="_blank">${icon('message')} Open chat for evidence</a>
        <p class="hint error" id="rv-err" hidden style="margin-top:10px"></p>`,
      actions: actions.join('') || `<a class="btn ghost" href="/admin/chats.html?uid=${esc(a.userId)}">Open chat</a>`
    });
    m.root.querySelector('[data-act="cancel"]')?.addEventListener('click', () => m.close());
    const handler = async (action) => {
      const needReason = action !== 'approve';
      let reason = '';
      if (needReason) {
        const rm = modal({
          title: action === 'reject' ? 'Reject submission' : 'Request clarification',
          width: 460,
          body: `
            <p class="confirm-msg">${action === 'reject' ? 'The user will see this reason on their task.' : 'The user will be asked to resubmit after addressing this.'}</p>
            <textarea class="textarea" id="reason" placeholder="Explain what was wrong or unclear…"></textarea>`,
          actions: `
            <button class="btn ghost" data-act="cancel">Cancel</button>
            <button class="btn ${action === 'reject' ? 'danger' : 'primary'}" data-act="go">${action === 'reject' ? 'Reject task' : 'Send'}</button>`
        });
        rm.root.querySelector('[data-act="cancel"]').addEventListener('click', () => rm.close());
        rm.root.querySelector('[data-act="go"]').addEventListener('click', async (ev) => {
          reason = rm.root.querySelector('#reason').value.trim();
          if (reason.length < 5) { rm.root.querySelector('#reason').classList.add('invalid'); return; }
          await perform(action, reason);
          rm.close();
        });
      } else {
        await perform('approve', '');
      }

      async function perform(act, rsn) {
        try {
          await reviewTask({ assignmentId, action: act, reason: rsn });
          m.close();
          toast(act === 'approve'
            ? `Approved. ${fmtNPR(a.rewardPaisa)} moved to hold — releases after the hold period.`
            : act === 'reject' ? 'Task rejected and user notified.' : 'Clarification requested — user notified.',
            { type: 'success', title: act === 'approve' ? 'Task approved' : 'Review saved' });
          loadAll(true);
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      }
    };
    m.root.querySelectorAll('[data-act]').forEach((btn) => {
      const act = btn.dataset.act;
      if (['approve', 'reject', 'clarify'].includes(act)) btn.addEventListener('click', () => handler(act));
    });
  } catch (_) {
    toast('Could not open the review.', { type: 'error' });
  }
}
