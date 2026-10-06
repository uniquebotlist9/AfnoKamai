// ─── Admin: immutable audit log ──────────────────────────────────────
import { db } from '../../firebase.js';
import { collection, query, orderBy, limit, getDocs, startAfter } from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=2';
import { esc, fmtDateTime } from '../../utils.js';
import { icon } from '../../icons.js';
import { emptyState, skeletonRows, autoPager } from '../../ui.js';

let { content } = await mountAdminShell('logs');
document.getElementById('page-skeleton')?.remove();

const ACTION_ICONS = {
  admin_login: ['shield', 'blue'], user_viewed: ['user', 'gray'],
  user_banned: ['ban', 'red'], user_unbanned: ['check', 'green'],
  penalty_applied: ['alert', 'red'], task_approved: ['check', 'green'],
  task_rejected: ['x', 'red'], withdrawal_completed: ['bank', 'green'],
  withdrawal_rejected: ['bank', 'red'], announcement_created: ['megaphone', 'gold'],
  maintenance_enabled: ['wrench', 'amber'], financial_adjustment: ['edit', 'gold'],
  task_assigned: ['briefcase', 'blue']
};

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Audit log</h1>
      <p class="sub">Immutable record of administrative actions. Written exclusively by Cloud Functions.</p>
    </div>
  </div>
  <div class="card"><div id="log-list">${skeletonRows(8, 52)}</div>
  </div>`;

const listEl = content.querySelector('#log-list');
let cursor = null;

// One page of the list. `run` comes from autoPager: when a newer run starts
// this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) { cursor = null; listEl.innerHTML = skeletonRows(8, 52); }
  try {
    const parts = [collection(db, 'adminLogs'), orderBy('createdAt', 'desc'), limit(40)];
    if (cursor) parts.push(startAfter(cursor));
    const snap = await getDocs(query(...parts));
    if (run.stale) return null;
    if (reset && snap.empty) {
      listEl.innerHTML = emptyState({
        icon: 'scroll', title: 'No audit entries yet',
        message: 'Every administrative action — bans, approvals, payouts, adjustments — is recorded here automatically.'
      });
      return null;
    }
    if (reset) listEl.innerHTML = '';
    listEl.insertAdjacentHTML('beforeend', snap.docs.map((d) => {
      const l = d.data();
      const [ic, tone] = ACTION_ICONS[l.action] || ['info', 'gray'];
      const meta = Object.entries(l.metadata || {}).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(' · ');
      return `
        <div class="activity-item" style="cursor:default">
          <span class="act-ic ${tone}">${icon(ic)}</span>
          <div class="act-body">
            <div class="log-action">${esc(l.action)}</div>
            <div class="log-meta">${esc(l.adminEmail || '—')} · target: ${esc(l.targetType || '—')} ${esc((l.targetId || '').slice(0, 12))}</div>
            ${meta ? `<div class="log-meta">${esc(meta)}</div>` : ''}
          </div>
          <span class="small muted num" style="white-space:nowrap">${esc(fmtDateTime(l.createdAt))}</span>
        </div>`;
    }).join(''));
    cursor = snap.docs[snap.docs.length - 1] || null;
    return cursor;
  } catch (_) {
    if (reset) listEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load logs', message: 'Please refresh the page.' });
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);
loadAll(true);
