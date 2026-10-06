// ─── Admin: penalty history + apply ──────────────────────────────────
import { db } from '../../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc, startAfter
} from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=2';
import { esc, fmtNPR, fmtDateTime } from '../../utils.js';
import { icon } from '../../icons.js';
import { emptyState, skeletonRows, badge, autoPager } from '../../ui.js';
import { penaltyModal } from './penalty-modal.js';

let { content } = await mountAdminShell('penalties');
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Penalties</h1>
      <p class="sub">Permanent record of every penalty applied. Reasons are mandatory and shown to users.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn danger" id="new-penalty">${icon('alert')} Apply penalty</button>
    </div>
  </div>
  <div class="card"><div id="pen-table">${skeletonRows(5, 52)}</div>
  </div>`;

const tableEl = content.querySelector('#pen-table');
let cursor = null;

// One page of the list. `run` comes from autoPager: when a newer run starts
// (new penalty applied) this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) { cursor = null; tableEl.innerHTML = skeletonRows(5, 52); }
  try {
    const parts = [collection(db, 'penalties'), orderBy('appliedAt', 'desc'), limit(30)];
    if (cursor) parts.push(startAfter(cursor));
    const snap = await getDocs(query(...parts));
    if (run.stale) return null;
    if (reset && snap.empty) {
      tableEl.innerHTML = emptyState({ icon: 'check', title: 'No penalties on record', message: 'A clean record — apply penalties from here or a user profile when needed.' });
      return null;
    }
    if (reset) {
      tableEl.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>User</th><th>Amount</th><th>Reason</th><th>Applied by</th></tr></thead>
        <tbody></tbody></table></div>`;
    }
    const body = tableEl.querySelector('tbody');
    body.insertAdjacentHTML('beforeend', snap.docs.map((d) => {
      const p = d.data();
      return `<tr>
        <td class="small num">${esc(fmtDateTime(p.appliedAt))}</td>
        <td><div class="cell-strong">${esc(p.userName || '—')}</div><div class="small muted">${esc(p.userEmail || '')}</div></td>
        <td class="cell-strong num" style="color:var(--red-600)">−${esc(fmtNPR(p.amountPaisa).replace('−', ''))}</td>
        <td class="small">${esc(p.reason)}</td>
        <td class="small">${esc(p.appliedByName || 'Admin')}</td>
      </tr>`;
    }).join(''));
    cursor = snap.docs[snap.docs.length - 1] || null;
    return cursor;
  } catch (_) {
    if (reset) tableEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load penalties', message: 'Please refresh the page.' });
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);
loadAll(true);

// ── user picker → penalty modal (reuses the shared penaltyModal) ──
content.querySelector('#new-penalty').addEventListener('click', async () => {
  const { modal, emptyState } = await import('../../ui.js');
  const m = modal({
    title: 'Find user',
    width: 480,
    body: `
      <input class="input" id="pick-search" placeholder="Search by email…" aria-label="Search user by email">
      <div id="pick-results" style="margin-top:12px; max-height:300px; overflow-y:auto">
        <div class="state-block loading"><span class="spin dark"></span></div>
      </div>`,
    actions: '<button class="btn ghost" data-act="cancel">Cancel</button>'
  });
  m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());

  const resultsEl = m.root.querySelector('#pick-results');
  m.root.querySelector('#pick-search').addEventListener('input', async (e) => {
    const term = e.target.value.trim().toLowerCase();
    if (term.length < 3) return;
    resultsEl.innerHTML = '<div class="state-block loading"><span class="spin dark"></span></div>';
    try {
      // Prefix-ish search on the most recent 100 users
      const snap = await getDocs(query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(100)));
      const matches = snap.docs.filter((d) => (d.data().email || '').toLowerCase().includes(term)).slice(0, 12);
      if (!matches.length) {
        resultsEl.innerHTML = emptyState({ icon: 'search', title: 'No matches', message: 'Try a different email fragment.' });
        return;
      }
      resultsEl.innerHTML = matches.map((d) => {
        const u = d.data();
        return `<button class="notif-item" data-uid="${esc(d.id)}" style="cursor:pointer">
          <span class="act-ic gray">${icon('user')}</span>
          <span class="act-body"><span class="act-title">${esc(u.fullName || '—')}</span>
          <span class="act-desc">${esc(u.email)}</span></span>
        </button>`;
      }).join('');
      resultsEl.querySelectorAll('[data-uid]').forEach((b) => b.addEventListener('click', async () => {
        const uSnap = await getDoc(doc(db, 'users', b.dataset.uid));
        m.close();
        if (uSnap.exists()) penaltyModal({ id: uSnap.id, ...uSnap.data() }, () => loadAll(true));
      }));
    } catch (_) {
      resultsEl.innerHTML = emptyState({ icon: 'alert', title: 'Search failed', message: 'Please try again.' });
    }
  });
});
