// ─── Admin: referral program (overview, members, rewards, risk, config) ──
// Rewards are processed by the admin client when a task is approved
// (reviewTask → processReferralReward) and released by the normal hold sweep,
// so everything here is read-only unless an admin explicitly acts.
import { db } from '../../firebase.js';
import {
  collection, doc, getDoc, query, where, orderBy, limit, getDocs,
  getCountFromServer, getAggregateFromServer, sum
} from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=3';
import { esc, fmtNPR, fmtDate, fmtDateTime, fmtRelative } from '../../utils.js';
import { icon } from '../../icons.js';
import { emptyState, skeletonRows, badge, modal, confirmDialog, btnBusy, toast } from '../../ui.js';
import {
  reconcileReferral, reconcileAllReferrals, computeReferralRiskFlags,
  resolveReferralRiskFlag, saveReferralConfig, setReferralUnderReview,
  setReferralRewardsSuspended
} from '../../admin-actions.js';
import { fetchReferralConfig, referralMemberStatus } from '../../referral.js';

let { content } = await mountAdminShell('referrals');
document.getElementById('page-skeleton')?.remove();

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'members', label: 'Members' },
  { id: 'rewards', label: 'Rewards' },
  { id: 'flags', label: 'Risk flags' },
  { id: 'config', label: 'Configuration' },
  { id: 'audit', label: 'Audit' }
];

let cfg = null;
let activeTab = 'overview';
const userCache = new Map();

// Short, stable identifier for tables — full ids stay in the title/detail view.
const sid = (v) => (v ? String(v).slice(0, 10) : '—');

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
async function getUser(uid) {
  if (!uid) return null;
  if (userCache.has(uid)) return userCache.get(uid);
  let d = null;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    d = snap.exists() ? snap.data() : null;
  } catch (_) { d = null; }
  userCache.set(uid, d);
  return d;
}

const who = (u, uid) => (u && (u.fullName || u.email)) || sid(uid);

async function loadConfig() {
  cfg = await fetchReferralConfig();
  return cfg;
}

/** Referral rewards ledger — reward records joined with their money status. */
async function loadRewards(parts, size = 60) {
  const snap = await getDocs(query(...parts, limit(size)));
  const rewards = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!rewards.length) return { rewards, txById: new Map() };

  // Hold/release status lives on the paired `transactions` record.
  const types = ['referral_reward', 'referral_task_reward'];
  let txSnap;
  try {
    txSnap = await getDocs(query(collection(db, 'transactions'),
      where('type', 'in', types), orderBy('createdAt', 'desc'), limit(200)));
  } catch (_) { txSnap = null; }
  const txById = new Map();
  if (txSnap) txSnap.forEach((t) => txById.set(t.id, t.data()));
  return { rewards, txById };
}

function rewardStatus(reward, tx) {
  // The reward record itself is always `credited`; hold → release happens on
  // the paired `transactions` doc (`available` = released, per TX_STATUS).
  const status = (tx && tx.status) || reward.status || 'credited';
  if (status === 'available' || status === 'released' || status === 'completed') return { label: 'Released', tone: 'green' };
  if (status === 'hold') return { label: 'On hold', tone: 'amber' };
  if (status === 'failed' || status === 'reversed') return { label: 'Failed', tone: 'red' };
  return { label: 'Credited', tone: 'blue' };
}

// ---------------------------------------------------------------------------
// Shell + tabs
// ---------------------------------------------------------------------------
function renderShell() {
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 style="font-size:22px">Referrals</h1>
        <p class="sub">Invite growth, reward processing, risk review and program configuration.</p>
      </div>
      <div class="page-head-actions">
        <button class="btn ghost" id="rf-scan">${icon('shield')} Scan risk</button>
        <button class="btn ghost" id="rf-reconcile">${icon('refresh')} Reconcile all</button>
      </div>
    </div>
    <div class="tabs" id="rf-tabs">
      ${TABS.map((t) => `<button class="tab ${t.id === activeTab ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>
    <div id="rf-body" style="margin-top:16px"></div>`;

  content.querySelector('#rf-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    content.querySelectorAll('#rf-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
    renderTab();
  });
  content.querySelector('#rf-scan').addEventListener('click', onScanRisk);
  content.querySelector('#rf-reconcile').addEventListener('click', onReconcileAll);
}

const body = () => content.querySelector('#rf-body');

function renderTab() {
  const el = body();
  if (!el) return;
  if (activeTab === 'members') return renderMembers();
  if (activeTab === 'rewards') return renderRewards();
  if (activeTab === 'flags') return renderFlags();
  if (activeTab === 'config') return renderConfig();
  if (activeTab === 'audit') return renderAudit();
  return renderOverview();
}

function fail(el, err, what) {
  if (!el) return;
  el.innerHTML = emptyState({
    icon: 'alert',
    title: `Could not load ${what}`,
    message: (err && err.message) || 'Please refresh and try again.'
  });
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
async function renderOverview() {
  const el = body();
  el.innerHTML = `<div class="grid grid-4">
      ${Array.from({ length: 4 }, () => '<div class="card stat-card"><span class="stat-label">…</span><span class="stat-value">…</span></div>').join('')}
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>Top referrers</h3></div><div style="padding:8px 0" id="rf-top">${skeletonRows(4, 44)}</div></div>
      <div class="card"><div class="card-head"><h3>Recent referrals</h3></div><div style="padding:8px 0" id="rf-recent">${skeletonRows(4, 44)}</div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h3>Program status</h3></div><div style="padding:18px 22px" id="rf-status">${skeletonRows(2, 40)}</div></div>`;

  try {
    if (!cfg) await loadConfig();

    const cnt = async (fn) => { try { return (await fn()).data().count; } catch (_) { return 0; } };
    const money = async (field) => {
      try {
        const agg = await getAggregateFromServer(collection(db, 'referralRewards'), { total: sum(field) });
        return agg.data().total || 0;
      } catch (_) { return 0; }
    };

    const [members, relationships, activeRefs, flagsOpen, issued, rewardCount] = await Promise.all([
      cnt(() => getCountFromServer(query(collection(db, 'users'), where('referredBy', '!=', '')))),
      cnt(() => getCountFromServer(collection(db, 'referrals'))),
      cnt(() => getCountFromServer(query(collection(db, 'referrals'), where('status', '==', 'started')))),
      cnt(() => getCountFromServer(query(collection(db, 'referralRiskFlags'), where('status', '==', 'open')))),
      money('amountPaisa'),
      cnt(() => getCountFromServer(collection(db, 'referralRewards')))
    ]);

    const cards = [
      { label: 'Referred members', value: members, note: 'Accounts attributed to an invite', tone: '' },
      { label: 'Referral relationships', value: relationships, note: `${activeRefs} with an approved task`, tone: 'tone-blue' },
      { label: 'Rewards issued', value: fmtNPR(issued), note: `${rewardCount} reward records`, tone: 'tone-gold' },
      { label: 'Open risk flags', value: flagsOpen, note: flagsOpen ? 'Review recommended' : 'Nothing pending', tone: flagsOpen ? 'tone-amber' : '' }
    ];
    el.querySelector('.grid.grid-4').innerHTML = cards.map((c) => `
      <div class="card stat-card ${c.tone}">
        <span class="stat-label">${c.label}<span class="stat-corner"></span></span>
        <span class="stat-value">${esc(String(c.value))}</span>
        <span class="stat-note">${esc(c.note)}</span>
      </div>`).join('');

    // Top referrers + recent referrals come from the same relationship list.
    const recent = await getDocs(query(collection(db, 'referrals'), orderBy('createdAt', 'desc'), limit(200)));
    const byReferrer = new Map();
    recent.forEach((d) => {
      const r = d.data() || {};
      const cur = byReferrer.get(r.referrerId) || { referrerId: r.referrerId, count: 0, approved: 0, earned: 0 };
      cur.count += 1;
      cur.approved += r.approvedTaskCount || 0;
      cur.earned += r.totalEarnedPaisa || 0;
      byReferrer.set(r.referrerId, cur);
    });
    const top = [...byReferrer.values()].sort((a, b) => b.approved - a.approved || b.count - a.count).slice(0, 6);

    const topEl = el.querySelector('#rf-top');
    const recentEl = el.querySelector('#rf-recent');
    if (topEl) {
      topEl.innerHTML = top.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Referrer</th><th>Members</th><th>Approved</th><th>Rewards</th></tr></thead>
        <tbody>${top.map((t) => `<tr>
          <td class="cell-strong">${esc(t.referrerId ? sid(t.referrerId) : '—')}</td>
          <td class="num">${t.count}</td>
          <td class="num">${t.approved}</td>
          <td class="num">${esc(fmtNPR(t.earned))}</td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyState({ icon: 'users', title: 'No referrals yet', message: 'Invite links appear here once members join with a code.' });
      // Resolve referrer names in the background (keeps the table instant).
      const topCells = [...topEl.querySelectorAll('tbody tr td:first-child')];
      top.forEach(async (t, i) => {
        const u = await getUser(t.referrerId);
        if (topCells[i] && u) topCells[i].textContent = who(u, t.referrerId);
      });
    }
    if (recentEl) {
      const rows = recent.docs.slice(0, 8).map((d) => {
        const r = d.data() || {};
        const st = referralMemberStatus(r);
        return `<tr>
          <td class="cell-strong">${esc(r.referredName || 'Member')}</td>
          <td>${badge(st.label, st.tone, { dot: true })}</td>
          <td class="num">${r.approvedTaskCount || 0}</td>
          <td class="small muted">${esc(fmtRelative(r.createdAt))}</td>
        </tr>`;
      }).join('');
      recentEl.innerHTML = recent.empty
        ? emptyState({ icon: 'users', title: 'No referrals yet', message: 'New members will show up here after they join with an invite.' })
        : `<div class="table-wrap"><table class="table">
            <thead><tr><th>Member</th><th>Status</th><th>Approved</th><th>Joined</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`;
    }

    const statusEl = el.querySelector('#rf-status');
    if (statusEl) {
      statusEl.innerHTML = `
        <div class="summary-box">
          <div class="sum-row"><span class="k">Program</span><span class="v">${cfg && cfg.enabled ? badge('Active', 'green', { dot: true }) : badge('Paused', 'amber', { dot: true })}</span></div>
          <div class="sum-row"><span class="k">Milestone reward</span><span class="v">${esc(fmtNPR(cfg.milestoneRewardPaisa))} after ${cfg.milestoneTasks} approved tasks</span></div>
          <div class="sum-row"><span class="k">Recurring reward</span><span class="v">${esc(fmtNPR(cfg.recurringRewardPaisa))} per approved task after the milestone</span></div>
          <div class="sum-row"><span class="k">Risk thresholds</span><span class="v">${cfg.maxReferralsPerDevice} per device · ${cfg.maxReferralsPerWeek} per week · inactive after ${cfg.inactiveDays}d</span></div>
        </div>
        <p class="small muted" style="margin:12px 0 0">
          Rewards are created only when a referred member's task is approved — never on submission.
          They enter the platform hold period before release. Changes made in Configuration apply to
          future rewards only.
        </p>
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px">
          <button class="btn ${cfg.enabled ? 'outline-danger' : 'primary'}" id="rf-toggle">
            ${cfg.enabled ? icon('ban') + ' Pause rewards' : icon('check') + ' Resume rewards'}
          </button>
        </div>`;
      statusEl.querySelector('#rf-toggle').addEventListener('click', onToggleEnabled);
    }
  } catch (err) {
    fail(el, err, 'overview');
  }
}

async function onToggleEnabled(e) {
  const btn = e.currentTarget;
  const enabling = cfg && !cfg.enabled;
  if (!enabling) {
    const ok = await confirmDialog({
      title: 'Pause referral rewards?',
      message: 'New approved tasks will stop creating referral rewards until you resume. Nothing already credited changes.',
      confirmText: 'Pause rewards',
      danger: true
    });
    if (!ok) return;
  }
  btnBusy(btn, true, enabling ? 'Resuming…' : 'Pausing…');
  try {
    await saveReferralConfig({ cfg: { ...cfg, enabled: !cfg.enabled }, reason: enabling ? 'Resumed by admin' : 'Paused by admin' });
    await loadConfig();
    toast(enabling ? 'Referral rewards resumed.' : 'Referral rewards paused.', { type: 'success' });
    renderOverview();
  } catch (err) {
    toast(err.message || 'Could not update the program.', { type: 'error' });
    btnBusy(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
async function renderMembers() {
  const el = body();
  el.innerHTML = `
    <div class="filters-bar">
      <input class="input search" id="rf-q" placeholder="Search referral code, handle, email or UID…" aria-label="Search referrals">
      <select class="select" id="rf-mfilter" aria-label="Filter by status">
        <option value="">All relationships</option>
        <option value="started">With approved tasks</option>
        <option value="joined">Joined only</option>
      </select>
      <span style="flex:1"></span>
      <span class="small muted" id="rf-mlist-count"></span>
    </div>
    <div class="card"><div id="rf-members">${skeletonRows(6, 56)}</div></div>`;

  const searchEl = el.querySelector('#rf-q');
  const filterEl = el.querySelector('#rf-mfilter');
  const listEl = el.querySelector('#rf-members');
  const countEl = el.querySelector('#rf-mlist-count');

  const load = async () => {
    listEl.innerHTML = skeletonRows(6, 56);
    try {
      const parts = [collection(db, 'referrals')];
      if (filterEl.value) parts.push(where('status', '==', filterEl.value));
      parts.push(orderBy('createdAt', 'desc'), limit(80));
      const snap = await getDocs(query(...parts));

      let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      // Free-text pass: code / handle / email / uid.
      const term = searchEl.value.trim().toLowerCase();
      if (term) {
        rows = rows.filter((r) =>
          (r.referralCode || '').toLowerCase().includes(term) ||
          (r.referredName || '').toLowerCase().includes(term) ||
          (r.referrerId || '').toLowerCase().includes(term) ||
          (r.referredUserId || '').toLowerCase().includes(term));
        if (rows.length === 0) rows = await searchOutside(term);
      }

      countEl.textContent = rows.length ? `${rows.length} shown` : '';
      if (!rows.length) {
        listEl.innerHTML = emptyState({
          icon: 'users',
          title: term ? 'No matches' : 'No referrals yet',
          message: term ? 'Try a full email, UID, or a referral code like AFK-XXXXXXX.' : 'Members appear here after they join with a referral code.'
        });
        return;
      }

      listEl.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th>Referrer</th><th>Member</th><th>Code</th><th>Status</th><th>Approved</th><th>Rewards</th><th>Joined</th><th></th></tr></thead>
        <tbody>${rows.map((r) => {
          const st = referralMemberStatus(r);
          const flagged = r.underReview || r.rewardsSuspended;
          return `<tr data-id="${esc(r.id)}">
            <td class="cell-strong" data-cell="referrer">${esc(sid(r.referrerId))}</td>
            <td>${esc(r.referredName || 'Member')}</td>
            <td class="small">${esc(r.referralCode || '—')}</td>
            <td>${badge(st.label, st.tone, { dot: true })}${flagged ? ' ' + badge('Review', 'red') : ''}</td>
            <td class="num">${r.approvedTaskCount || 0}</td>
            <td class="num">${esc(fmtNPR(r.totalEarnedPaisa || 0))}</td>
            <td class="small muted">${esc(fmtDate(r.createdAt))}</td>
            <td><button class="btn ghost btn-sm" data-open="${esc(r.id)}">${icon('eye')} Open</button></td>
          </tr>`;
        }).join('')}</tbody></table></div>`;

      listEl.querySelectorAll('[data-open]').forEach((b) => {
        b.addEventListener('click', () => openReferral(b.dataset.open));
      });

      // Resolve referrer names without blocking the table.
      rows.forEach(async (r) => {
        const u = await getUser(r.referrerId);
        const cell = listEl.querySelector(`tr[data-id="${cssEscape(r.id)}"] [data-cell="referrer"]`);
        if (cell && u) cell.textContent = who(u, r.referrerId);
      });
    } catch (err) {
      fail(listEl, err, 'members');
    }
  };

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  searchEl.addEventListener('input', debounce(load, 260));
  filterEl.addEventListener('change', load);
  load();
}

// Code / handle / email lookups that the relationship filter can't reach.
async function searchOutside(term) {
  const out = [];
  const code = term.toUpperCase().startsWith('AFK-') ? term.toUpperCase() : null;
  if (code) {
    const snap = await getDoc(doc(db, 'referralCodes', code)).catch(() => null);
    if (snap && snap.exists()) {
      const uid = snap.data().userId;
      const rels = await getDocs(query(collection(db, 'referrals'), where('referrerId', '==', uid), limit(50)));
      rels.forEach((d) => out.push({ id: d.id, ...d.data() }));
    }
  }
  if (term.includes('@')) {
    const users = await getDocs(query(collection(db, 'users'), where('email', '==', term), limit(1)));
    if (!users.empty) {
      const uid = users.docs[0].id;
      const rels = await getDocs(query(collection(db, 'referrals'), where('referrerId', '==', uid), limit(50)));
      rels.forEach((d) => out.push({ id: d.id, ...d.data() }));
    }
  }
  return out;
}

// Query selectors can't take arbitrary ids — escape them for the DOM.
function cssEscape(v) {
  if (window.CSS && CSS.escape) return CSS.escape(v);
  return String(v).replace(/["\\]/g, '\\$&');
}

// Short free-text note in the app's own modal (never window.prompt — the
// admin UI must look and behave like the rest of the product).
function promptNote({ title, message = '', placeholder = '', confirmText = 'Save', initial = '' }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      width: 480,
      body: `
        ${message ? `<p class="confirm-msg">${esc(message)}</p>` : ''}
        <label class="label" for="rf-note">Note</label>
        <textarea class="textarea" id="rf-note" rows="3" placeholder="${esc(placeholder)}">${esc(initial)}</textarea>`,
      actions: `
        <button class="btn ghost" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="ok">${esc(confirmText)}</button>`,
      onClose: () => resolve(null)
    });
    const input = m.root.querySelector('#rf-note');
    m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
    m.root.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const v = (input.value || '').trim();
      if (v.length < 3) { input.classList.add('invalid'); return; }
      resolve(v);
      m.close();
    });
    setTimeout(() => input && input.focus(), 30);
  });
}

// ── Referral detail ──────────────────────────────────────────────────
async function openReferral(referralId) {
  const m = modal({ title: 'Referral details', width: 620, body: skeletonRows(5, 52) });
  const el = m.root.querySelector('.modal-body');
  try {
    const snap = await getDoc(doc(db, 'referrals', referralId));
    if (!snap.exists()) { el.innerHTML = emptyState({ icon: 'alert', title: 'Referral not found' }); return; }
    const r = snap.data() || {};
    const st = referralMemberStatus(r);
    const [referrer, referred, rewardData] = await Promise.all([
      getUser(r.referrerId),
      getUser(r.referredUserId),
      loadRewards([
        collection(db, 'referralRewards'),
        where('referrerId', '==', r.referrerId),
        where('referredUserId', '==', r.referredUserId),
        orderBy('createdAt', 'desc')
      ], 50)
    ]);
    const { rewards, txById } = rewardData;

    const rewardRows = rewards.map((rw) => {
      const s = rewardStatus(rw, txById.get(rw.id) || null);
      return `<tr>
        <td>${rw.type === 'referral_milestone' ? badge('Milestone', 'gold') : badge('Task', 'blue')}</td>
        <td class="num cell-strong">${esc(fmtNPR(rw.amountPaisa || 0))}</td>
        <td>${badge(s.label, s.tone)}</td>
        <td class="small">${esc(fmtDate(rw.createdAt))}</td>
      </tr>`;
    }).join('');

    const flags = await getDocs(query(collection(db, 'referralRiskFlags'),
      where('referrerId', '==', r.referrerId), orderBy('createdAt', 'desc'), limit(10)));

    el.innerHTML = `
      <div class="summary-box">
        <div class="sum-row"><span class="k">Referrer</span><span class="v">${esc(who(referrer, r.referrerId))}</span></div>
        <div class="sum-row"><span class="k">Member</span><span class="v">${esc(who(referred, r.referredUserId))}</span></div>
        <div class="sum-row"><span class="k">Code</span><span class="v">${esc(r.referralCode || '—')}</span></div>
        <div class="sum-row"><span class="k">Status</span><span class="v">${badge(st.label, st.tone, { dot: true })}</span></div>
        <div class="sum-row"><span class="k">Approved tasks</span><span class="v">${r.approvedTaskCount || 0}</span></div>
        <div class="sum-row"><span class="k">Rewards earned</span><span class="v">${esc(fmtNPR(r.totalEarnedPaisa || 0))}</span></div>
        <div class="sum-row"><span class="k">Joined</span><span class="v">${esc(fmtDateTime(r.createdAt))}</span></div>
      </div>
      ${r.rewardsSuspended ? `<p class="small" style="color:var(--red-600); margin:12px 0 0">Rewards for this referral are suspended: ${esc(r.suspensionReason || 'under review')}.</p>` : ''}

      <h4 style="margin:18px 0 8px">Reward records</h4>
      ${!rewards.length ? emptyState({ icon: 'coins', title: 'No rewards yet', message: 'Rewards appear when this member completes approved tasks.' }) : `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>${rewardRows}</tbody></table></div>`}

      <h4 style="margin:18px 0 8px">Risk flags</h4>
      ${flags.empty ? '<p class="small muted">No flags recorded for this referrer.</p>' : flags.docs.map((d) => {
        const f = d.data() || {};
        return `<div class="kv-cell" style="margin-bottom:8px">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap">
            <strong class="small">${esc(f.riskType || 'signal')}</strong>
            ${badge(f.status === 'open' ? 'Open' : 'Resolved', f.status === 'open' ? 'red' : 'green', { dot: true })}
          </div>
          <div class="small muted" style="margin-top:4px">${esc(f.reason || '')}</div>
          ${f.status === 'open' ? `<button class="btn ghost btn-sm" style="margin-top:8px" data-flag="${esc(d.id)}">${icon('check')} Resolve flag</button>` : ''}
        </div>`;
      }).join('')}

      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:18px">
        <button class="btn ghost" id="rf-recon-one">${icon('refresh')} Reconcile this referral</button>
        <button class="btn ghost" id="rf-review">${icon('shield')} ${r.underReview ? 'Clear review mark' : 'Mark under review'}</button>
        <button class="btn ${r.rewardsSuspended ? 'primary' : 'outline-danger'}" id="rf-suspend">
          ${r.rewardsSuspended ? icon('check') + ' Resume rewards' : icon('ban') + ' Suspend rewards'}
        </button>
      </div>`;

    el.querySelector('#rf-recon-one').addEventListener('click', async (e) => {
      btnBusy(e.currentTarget, true, 'Reconciling…');
      try {
        const res = await reconcileReferral(referralId);
        toast(res.caughtUp
          ? 'Already up to date — no missing rewards.'
          : `Reconciled: ${res.processed} reward(s) created.`, { type: 'success' });
        openReferral(referralId);
        m.close();
      } catch (err) { toast(err.message || 'Reconcile failed.', { type: 'error' }); btnBusy(e.currentTarget, false); }
    });

    el.querySelector('#rf-review').addEventListener('click', async (e) => {
      btnBusy(e.currentTarget, true, 'Saving…');
      try {
        await setReferralUnderReview({ referralId, underReview: !r.underReview, note: r.underReview ? '' : 'Marked for manual referral review.' });
        toast(r.underReview ? 'Review mark cleared.' : 'Referral marked under review.', { type: 'success' });
        m.close();
        renderTab();
      } catch (err) { toast(err.message || 'Could not update.', { type: 'error' }); btnBusy(e.currentTarget, false); }
    });

    el.querySelector('#rf-suspend').addEventListener('click', async (e) => {
      if (!r.rewardsSuspended) {
        const ok = await confirmDialog({
          title: 'Suspend rewards for this referral?',
          message: 'Future approved tasks will count but pay nothing until you resume. Existing records are untouched.',
          confirmText: 'Suspend rewards',
          danger: true
        });
        if (!ok) return;
      }
      btnBusy(e.currentTarget, true, 'Saving…');
      try {
        await setReferralRewardsSuspended({
          referralId,
          suspended: !r.rewardsSuspended,
          reason: r.rewardsSuspended ? 'Resumed by admin' : 'Routine referral review — rewards paused pending verification.'
        });
        toast(r.rewardsSuspended ? 'Rewards resumed.' : 'Rewards suspended.', { type: 'success' });
        m.close();
        renderTab();
      } catch (err) { toast(err.message || 'Could not update.', { type: 'error' }); btnBusy(e.currentTarget, false); }
    });

    el.querySelectorAll('[data-flag]').forEach((b) => {
      b.addEventListener('click', async () => {
        const note = await promptNote({
          title: 'Resolve risk flag',
          message: 'Record what you checked. Flags say “Review recommended” — a resolution note documents the decision for the audit log.',
          placeholder: 'Reviewed — no abuse found. Shared network, legitimate accounts.',
          confirmText: 'Resolve flag'
        });
        if (!note) return;
        try {
          await resolveReferralRiskFlag({ flagId: b.dataset.flag, note });
          toast('Flag resolved.', { type: 'success' });
          m.close();
          openReferral(referralId);
        } catch (err) { toast(err.message || 'Could not resolve the flag.', { type: 'error' }); }
      });
    });
  } catch (err) {
    el.innerHTML = emptyState({ icon: 'alert', title: 'Could not load details', message: err.message || '' });
  }
}

// ---------------------------------------------------------------------------
// Rewards ledger
// ---------------------------------------------------------------------------
async function renderRewards() {
  const el = body();
  el.innerHTML = `
    <div class="filters-bar">
      <div class="segmented" id="rf-rfilter">
        <button data-f="all" class="active">All</button>
        <button data-f="hold">On hold</button>
        <button data-f="released">Released</button>
        <button data-f="referral_milestone">Milestones</button>
      </div>
      <span style="flex:1"></span>
      <button class="btn ghost btn-sm" id="rf-export">${icon('download')} Export CSV</button>
    </div>
    <div class="card"><div id="rf-rewards">${skeletonRows(6, 56)}</div></div>`;

  const listEl = el.querySelector('#rf-rewards');
  let current = [];

  const load = async (mode) => {
    listEl.innerHTML = skeletonRows(6, 56);
    try {
      const { rewards, txById } = await loadRewards([collection(db, 'referralRewards'), orderBy('createdAt', 'desc')], 120);
      let rows = rewards.map((r) => ({ ...r, tx: txById.get(r.id) || null }));
      if (mode === 'hold') rows = rows.filter((r) => (r.tx ? r.tx.status === 'hold' : true));
      else if (mode === 'released') rows = rows.filter((r) => r.tx && ['available', 'completed', 'released'].includes(r.tx.status));
      else if (mode === 'referral_milestone') rows = rows.filter((r) => r.type === 'referral_milestone');
      current = rows;

      if (!rows.length) {
        listEl.innerHTML = emptyState({ icon: 'coins', title: 'No rewards in this view', message: 'Rewards are created when referred members complete approved tasks.' });
        return;
      }
      listEl.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th>Reward</th><th>Referrer</th><th>Member</th><th>Amount</th><th>Status</th><th>Task</th><th>Date</th></tr></thead>
        <tbody>${rows.map((r) => {
          const s = rewardStatus(r, r.tx);
          return `<tr>
            <td>${r.type === 'referral_milestone' ? badge('Milestone', 'gold') : badge('Task reward', 'blue')}</td>
            <td class="cell-strong" data-cell="ref-${esc(r.id)}">${esc(sid(r.referrerId))}</td>
            <td class="small" data-cell="usr-${esc(r.id)}">${esc(sid(r.referredUserId))}</td>
            <td class="num cell-strong">${esc(fmtNPR(r.amountPaisa || 0))}</td>
            <td>${badge(s.label, s.tone, { dot: true })}</td>
            <td class="small">${esc(sid(r.taskId || r.assignmentId))}</td>
            <td class="small muted">${esc(fmtDate(r.createdAt))}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`;

      rows.forEach(async (r) => {
        const [ru, uu] = await Promise.all([getUser(r.referrerId), getUser(r.referredUserId)]);
        const a = listEl.querySelector(`[data-cell="ref-${cssEscape(r.id)}"]`);
        const b = listEl.querySelector(`[data-cell="usr-${cssEscape(r.id)}"]`);
        if (a && ru) a.textContent = who(ru, r.referrerId);
        if (b && uu) b.textContent = who(uu, r.referredUserId);
      });
    } catch (err) {
      fail(listEl, err, 'rewards');
    }
  };

  el.querySelector('#rf-rfilter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-f]');
    if (!btn) return;
    el.querySelectorAll('#rf-rfilter button').forEach((b) => b.classList.toggle('active', b === btn));
    load(btn.dataset.f);
  });
  el.querySelector('#rf-export').addEventListener('click', () => exportCsv(current));
  load('all');
}

function exportCsv(rows) {
  const header = 'rewardId,type,referrerId,referredUserId,amountPaisa,status,taskId,createdAt\n';
  const bodyText = rows.map((r) => [
    r.id, r.type, r.referrerId, r.referredUserId, r.amountPaisa || 0,
    (r.tx && r.tx.status) || r.status || '', r.taskId || r.assignmentId || '',
    (r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString() : '')
  ].join(',')).join('\n');
  const blob = new Blob([header + bodyText], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `referral-rewards-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Risk flags
// ---------------------------------------------------------------------------
async function renderFlags() {
  const el = body();
  el.innerHTML = `
    <div class="filters-bar">
      <div class="segmented" id="rf-ffilter">
        <button data-f="open" class="active">Open</button>
        <button data-f="resolved">Resolved</button>
        <button data-f="">All</button>
      </div>
      <span style="flex:1"></span>
      <span class="small muted">Signals are advisory — shared networks alone are never treated as proof of abuse.</span>
    </div>
    <div class="card"><div id="rf-flags">${skeletonRows(5, 60)}</div></div>`;

  const listEl = el.querySelector('#rf-flags');

  const load = async (status) => {
    listEl.innerHTML = skeletonRows(5, 60);
    try {
      const parts = [collection(db, 'referralRiskFlags')];
      if (status) parts.push(where('status', '==', status));
      parts.push(orderBy('createdAt', 'desc'), limit(80));
      const snap = await getDocs(query(...parts));

      if (snap.empty) {
        listEl.innerHTML = emptyState({
          icon: 'shield',
          title: status === 'resolved' ? 'No resolved flags' : 'No open flags',
          message: 'Run a scan to check recent referrals for shared-device or velocity signals.'
        });
        return;
      }

      listEl.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th>Referrer</th><th>Signal</th><th>Severity</th><th>Reason</th><th>Status</th><th>Seen</th><th></th></tr></thead>
        <tbody>${snap.docs.map((d) => {
          const f = d.data() || {};
          const sev = f.severity === 'high' ? 'red' : f.severity === 'low' ? 'blue' : 'amber';
          return `<tr>
            <td class="cell-strong" data-cell="flag-${esc(d.id)}">${esc(sid(f.referrerId))}</td>
            <td>${esc(f.riskType || 'signal')}</td>
            <td>${badge(f.severity || 'medium', sev)}</td>
            <td class="small muted" style="max-width:340px">${esc(f.reason || '')}</td>
            <td>${badge(f.status === 'open' ? 'Open' : 'Resolved', f.status === 'open' ? 'red' : 'green', { dot: true })}</td>
            <td class="small muted">${esc(fmtRelative(f.createdAt))}</td>
            <td style="white-space:nowrap">
              ${f.status === 'open' ? `<button class="btn ghost btn-sm" data-resolve="${esc(d.id)}">${icon('check')} Resolve</button>` : ''}
              <button class="btn ghost btn-sm" data-view="${esc(f.referrerId || '')}">${icon('eye')}</button>
            </td>
          </tr>`;
        }).join('')}</tbody></table></div>`;

      snap.docs.forEach(async (d) => {
        const f = d.data() || {};
        const u = await getUser(f.referrerId);
        const cell = listEl.querySelector(`[data-cell="flag-${cssEscape(d.id)}"]`);
        if (cell && u) cell.textContent = who(u, f.referrerId);
      });

      listEl.querySelectorAll('[data-resolve]').forEach((b) => {
        b.addEventListener('click', async () => {
          const note = await promptNote({
            title: 'Resolve risk flag',
            message: 'Flags say “Review recommended” — record what you checked so the audit trail explains the decision.',
            placeholder: 'Reviewed — no abuse found. Shared network, legitimate accounts.',
            confirmText: 'Resolve flag'
          });
          if (!note) return;
          btnBusy(b, true, 'Saving…');
          try {
            await resolveReferralRiskFlag({ flagId: b.dataset.resolve, note });
            toast('Flag resolved.', { type: 'success' });
            load(status);
          } catch (err) { toast(err.message || 'Could not resolve the flag.', { type: 'error' }); btnBusy(b, false); }
        });
      });
      listEl.querySelectorAll('[data-view]').forEach((b) => {
        b.addEventListener('click', async () => {
          const rels = await getDocs(query(collection(db, 'referrals'), where('referrerId', '==', b.dataset.view), limit(1)));
          if (!rels.empty) openReferral(rels.docs[0].id);
          else toast('No referral relationship found for this member.', { type: 'warn' });
        });
      });
    } catch (err) {
      fail(listEl, err, 'risk flags');
    }
  };

  el.querySelector('#rf-ffilter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-f]');
    if (!btn) return;
    el.querySelectorAll('#rf-ffilter button').forEach((b) => b.classList.toggle('active', b === btn));
    load(btn.dataset.f);
  });
  load('open');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
async function renderConfig() {
  const el = body();
  el.innerHTML = skeletonRows(5, 56);
  try {
    if (!cfg) await loadConfig();
    el.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>Reward rules</h3><span class="small muted">Applied to future rewards only</span></div>
          <div class="card-pad">
            <form id="rf-cfg">
              <div class="field">
                <label class="label" for="c-milestoneTasks">Approved tasks before the first reward</label>
                <input class="input" id="c-milestoneTasks" type="number" min="1" max="50" value="${cfg.milestoneTasks}">
                <div class="hint">Currently: ${cfg.milestoneTasks} approved tasks unlock ${esc(fmtNPR(cfg.milestoneRewardPaisa))}.</div>
              </div>
              <div class="field">
                <label class="label" for="c-milestoneRewardPaisa">First-referral reward (paisa)</label>
                <input class="input" id="c-milestoneRewardPaisa" type="number" min="100" max="100000" step="100" value="${cfg.milestoneRewardPaisa}">
                <div class="hint">1500 paisa = ${esc(fmtNPR(1500))}.</div>
              </div>
              <div class="field">
                <label class="label" for="c-recurringRewardPaisa">Recurring reward per approved task (paisa)</label>
                <input class="input" id="c-recurringRewardPaisa" type="number" min="100" max="100000" step="100" value="${cfg.recurringRewardPaisa}">
                <div class="hint">500 paisa = ${esc(fmtNPR(500))} — paid on every approved task after the milestone.</div>
              </div>
              <div class="field">
                <label class="checkbox"><input type="checkbox" id="c-enabled" ${cfg.enabled ? 'checked' : ''}> Referral rewards enabled</label>
              </div>
              <button class="btn primary" type="submit">${icon('check')} Save reward rules</button>
            </form>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Risk thresholds</h3><span class="small muted">Advisory signals only</span></div>
          <div class="card-pad">
            <form id="rf-risk">
              <div class="field">
                <label class="label" for="c-maxReferralsPerDevice">Accounts per device signature</label>
                <input class="input" id="c-maxReferralsPerDevice" type="number" min="2" max="100" value="${cfg.maxReferralsPerDevice}">
                <div class="hint">Above this, a "Review recommended" flag is written. Shared family devices are common — keep it conservative.</div>
              </div>
              <div class="field">
                <label class="label" for="c-maxReferralsPerWeek">Signups per referral code (window)</label>
                <input class="input" id="c-maxReferralsPerWeek" type="number" min="2" max="200" value="${cfg.maxReferralsPerWeek}">
              </div>
              <div class="field">
                <label class="label" for="c-inactiveDays">Days before "inactive referrals" flag</label>
                <input class="input" id="c-inactiveDays" type="number" min="1" max="365" value="${cfg.inactiveDays}">
              </div>
              <button class="btn primary" type="submit">${icon('check')} Save thresholds</button>
            </form>
            <p class="small muted" style="margin-top:14px">
              Flags say <strong>Review recommended</strong> — they never auto-penalise anyone. Shared Wi-Fi,
              schools, offices and families are normal; a human always decides.
            </p>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>Upgrade path</h3></div>
        <div class="card-pad">
          <p class="small muted" style="margin:0">
            On the free Spark plan, rewards are processed by the admin-signed client during task approval
            and validated entirely by security rules. A reference Cloud Functions implementation
            (<code>processReferralReward</code>) lives in <code>optional-cloud-functions/</code> for when you
            move to the Blaze plan — it is not required and is not deployed.
          </p>
        </div>
      </div>`;

    const num = (id) => Number(el.querySelector(id).value);
    const collect = (ids) => {
      const o = {};
      for (const [key, id] of Object.entries(ids)) {
        const v = num(id);
        if (!Number.isFinite(v)) { toast(`"${key}" must be a number.`, { type: 'error' }); return null; }
        o[key] = Math.round(v);
      }
      return o;
    };

    el.querySelector('#rf-cfg').addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = collect({
        milestoneTasks: '#c-milestoneTasks',
        milestoneRewardPaisa: '#c-milestoneRewardPaisa',
        recurringRewardPaisa: '#c-recurringRewardPaisa'
      });
      if (!values) return;
      const btn = e.submitter;
      btnBusy(btn, true, 'Saving…');
      try {
        await saveReferralConfig({
          cfg: { ...cfg, ...values, enabled: el.querySelector('#c-enabled').checked },
          reason: 'Reward rules updated from the referrals panel'
        });
        await loadConfig();
        toast('Reward rules saved. Existing rewards are unchanged.', { type: 'success' });
        renderConfig();
      } catch (err) { toast(err.message || 'Could not save.', { type: 'error' }); btnBusy(btn, false); }
    });

    el.querySelector('#rf-risk').addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = collect({
        maxReferralsPerDevice: '#c-maxReferralsPerDevice',
        maxReferralsPerWeek: '#c-maxReferralsPerWeek',
        inactiveDays: '#c-inactiveDays'
      });
      if (!values) return;
      const btn = e.submitter;
      btnBusy(btn, true, 'Saving…');
      try {
        await saveReferralConfig({ cfg: { ...cfg, ...values }, reason: 'Risk thresholds updated' });
        await loadConfig();
        toast('Thresholds saved.', { type: 'success' });
        renderConfig();
      } catch (err) { toast(err.message || 'Could not save.', { type: 'error' }); btnBusy(btn, false); }
    });
  } catch (err) {
    fail(el, err, 'configuration');
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
async function renderAudit() {
  const el = body();
  el.innerHTML = skeletonRows(8, 48);
  try {
    const snap = await getDocs(query(collection(db, 'adminLogs'), orderBy('createdAt', 'desc'), limit(200)));
    const rows = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((l) => String(l.action || '').startsWith('referral'));

    if (!rows.length) {
      el.innerHTML = emptyState({
        icon: 'scroll',
        title: 'No referral audit entries yet',
        message: 'Reward processing, reconciliations, suspensions and configuration changes are recorded here.'
      });
      return;
    }
    el.innerHTML = `<div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Action</th><th>Target</th><th>Admin</th><th>Details</th><th>When</th></tr></thead>
      <tbody>${rows.map((l) => `<tr>
        <td class="cell-strong">${esc(String(l.action || '').replace(/^referral_/, ''))}</td>
        <td class="small">${esc(l.targetType || '—')} ${esc(sid(l.targetId))}</td>
        <td class="small">${esc(l.adminEmail || '—')}</td>
        <td class="small muted" style="max-width:360px">${esc(summarise(l.metadata))}</td>
        <td class="small muted">${esc(fmtRelative(l.createdAt))}</td>
      </tr>`).join('')}</tbody></table></div></div>`;
  } catch (err) {
    fail(el, err, 'audit log');
  }
}

function summarise(meta) {
  if (!meta || typeof meta !== 'object') return '';
  return Object.entries(meta)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------
async function onScanRisk(e) {
  const btn = e.currentTarget;
  btnBusy(btn, true, 'Scanning…');
  try {
    const res = await computeReferralRiskFlags({ windowDays: 30 });
    toast(`Scan complete — ${res.flagsTouched} flag(s) written from ${res.referralsScanned} referral(s).`,
      { type: res.flagsTouched ? 'warn' : 'success' });
    if (activeTab === 'flags') renderTab();
  } catch (err) { toast(err.message || 'Scan failed.', { type: 'error' }); }
  finally { btnBusy(btn, false); }
}

async function onReconcileAll(e) {
  const btn = e.currentTarget;
  const ok = await confirmDialog({
    title: 'Reconcile recent referrals?',
    message: 'This backfills any missing referral rewards from the approved-task ledger. It is idempotent — already-paid rewards are skipped.',
    confirmText: 'Run reconcile'
  });
  if (!ok) return;
  btnBusy(btn, true, 'Reconciling…');
  try {
    const res = await reconcileAllReferrals({ limit: 100 });
    toast(`Scanned ${res.scanned}: ${res.reconciled} reconciled, ${res.caughtUp} already up to date, ${res.failed} failed.`,
      { type: res.failed ? 'warn' : 'success' });
    if (activeTab === 'overview' || activeTab === 'rewards') renderTab();
  } catch (err) { toast(err.message || 'Reconcile failed.', { type: 'error' }); }
  finally { btnBusy(btn, false); }
}

// ---------------------------------------------------------------------------
renderShell();
renderTab();
