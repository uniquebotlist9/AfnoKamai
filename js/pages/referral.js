// ─── Referral page: invite & earn dashboard ──────────────────────────
// Everything on this page is READ from Firebase — real referral records,
// real reward transactions, real timestamps. Reward values come from
// config/referral (admin-managed). No client-side reward math, no fake
// placeholders: loading shows skeletons, errors show an honest retry.
import { db } from '../firebase.js';
import {
  collection, collectionGroup, query, where, orderBy, limit, getDocs, getDoc, doc,
  getCountFromServer, startAfter
} from 'firebase/firestore';
import { mountShell } from '../shell.js';
import { esc, fmtNPR, fmtDate, fmtRelative, initials } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState, skeletonRows, badge, toast, btnBusy, modal } from '../ui.js';
import {
  fetchReferralConfig, referralLink, copyText, claimReferralIdentity,
  setReferralHandle, finalizeReferral, readPendingCode, referralMemberStatus,
  isValidHandle, normalizeHandle
} from '../referral.js';

let { user, profile, content } = await mountShell('referral');
document.getElementById('page-skeleton')?.remove();

const PAGE_SIZE = 20;
let cfg = null;
let cursor = null;
let membersLoaded = 0;
let stats = null;

// ── Page skeleton (structural only — no numbers before real data) ─────
content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Referral</h1>
      <p class="sub">Invite friends &amp; earn — share your link, track everyone who joins, and see every referral rupee.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn ghost btn-sm" id="ref-refresh">${icon('refresh')} Refresh</button>
    </div>
  </div>

  <div id="ref-finalize-slot"></div>

  <section class="hero-greeting" id="ref-hero">
    <div>
      <h2>Invite Friends &amp; Earn</h2>
      <p class="sub">Share your AfnoKamai referral link with friends. When someone joins using your link and completes approved tasks, you earn referral rewards.</p>
    </div>
    <div class="hero-cta">
      <a class="btn btn-gold" href="#ref-invite">${icon('link')} My link &amp; code</a>
      <a class="btn ghost" style="color:#fff; border-color:rgba(255,255,255,.25)" href="#ref-rules">${icon('scroll')} Reward rules</a>
    </div>
  </section>

  <div class="grid grid-4" id="ref-stats">
    <div class="card stat-card"><span class="spin dark"></span></div>
    <div class="card stat-card"><span class="spin dark"></span></div>
    <div class="card stat-card"><span class="spin dark"></span></div>
    <div class="card stat-card"><span class="spin dark"></span></div>
  </div>

  <div class="grid" style="grid-template-columns: 1.6fr 1fr; margin-top:16px" id="ref-invite-row">
    <div class="card" id="ref-invite">
      <div class="card-head"><div><h3>Your referral link</h3><div class="sub">Anyone who joins with this link is recorded as your referral</div></div></div>
      <div class="card-pad" id="ref-invite-body">
        ${skeletonRows(3, 44)}
      </div>
    </div>
    <div class="card" id="ref-rules">
      <div class="card-head"><div><h3>Reward rules</h3><div class="sub">How referral rewards are earned</div></div></div>
      <div class="card-pad" id="ref-rules-body">
        ${skeletonRows(3, 40)}
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-head">
      <div><h3>My Referrals</h3><div class="sub">Everyone who registered through your referral link or code</div></div>
      <span class="small muted" id="ref-list-count" aria-live="polite"></span>
    </div>
    <div id="ref-members">${skeletonRows(4, 52)}</div>
    <div style="text-align:center; padding:0 16px 16px" id="ref-more-wrap" hidden>
      <button class="btn ghost" id="ref-more">${icon('chevDown')} Load more referrals</button>
    </div>
  </div>

  <div class="grid grid-2" style="margin-top:16px">
    <div class="card">
      <div class="card-head"><div><h3>Referral activity</h3><div class="sub">Real-time timeline of your referrals</div></div></div>
      <div class="activity-list" id="ref-activity">${skeletonRows(4, 52)}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Recent referral earnings</h3><div class="sub">Every reward is a permanent ledger transaction</div></div></div>
      <div id="ref-rewards">${skeletonRows(3, 52)}</div>
    </div>
  </div>`;

// responsive invite row
const inviteRow = content.querySelector('#ref-invite-row');
const applyInviteCols = () => { inviteRow.style.gridTemplateColumns = window.innerWidth < 920 ? '1fr' : '1.6fr 1fr'; };
applyInviteCols();
window.addEventListener('resize', applyInviteCols);

const statsEl = content.querySelector('#ref-stats');
const inviteBody = content.querySelector('#ref-invite-body');
const rulesBody = content.querySelector('#ref-rules-body');
const membersEl = content.querySelector('#ref-members');
const moreWrap = content.querySelector('#ref-more-wrap');
const listCount = content.querySelector('#ref-list-count');
const activityEl = content.querySelector('#ref-activity');
const rewardsEl = content.querySelector('#ref-rewards');
const finalizeSlot = content.querySelector('#ref-finalize-slot');

// ── Helpers ───────────────────────────────────────────────────────────
const statusMeta = (r) => referralMemberStatus(r);

async function copyWithFeedback(text, okMsg) {
  const ok = await copyText(text);
  if (ok) toast(okMsg, { type: 'success' });
  else toast('Could not copy to your clipboard. Please select and copy manually.', { type: 'error' });
  return ok;
}

async function shareLink(link, code) {
  const shareData = {
    title: 'Join me on AfnoKamai',
    text: 'Join me on AfnoKamai and complete legitimate tasks to earn. Use my referral link:',
    url: link
  };
  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user closed the sheet
    }
  }
  await copyWithFeedback(link, 'Referral link copied!');
  if (code) { /* code already visible on screen */ }
}

// ── Invite & rules card (profile + config driven) ────────────────────
function renderInviteCard() {
  const code = profile.referralCode || '';
  const handle = profile.referralHandle || '';
  if (!code) {
    inviteBody.innerHTML = `
      <div class="state-block" style="padding:24px 8px">
        <div class="state-ic">${icon('link')}</div>
        <h3>Create your referral code</h3>
        <p>Every AfnoKamai account gets one unique, stable referral code and link. It takes one click — and you can share it right away.</p>
        <button class="btn primary" id="ref-activate">${icon('zap')} Generate my referral code</button>
      </div>`;
    inviteBody.querySelector('#ref-activate').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btnBusy(btn, true, 'Creating…');
      try {
        const res = await claimReferralIdentity({});
        profile.referralCode = res.code;
        profile.referralHandle = res.handle || '';
        toast('Your referral code is ready!', { type: 'success' });
        renderInviteCard();
      } catch (err) {
        toast(err.message || 'Could not create your referral code. Please try again.', { type: 'error' });
      }
      btnBusy(btn, false);
    });
    return;
  }

  const link = referralLink(code);
  const vanity = handle ? `https://afnokamai.web.app/ref/${encodeURIComponent(handle)}` : '';
  inviteBody.innerHTML = `
    <div class="field" style="margin-bottom:12px">
      <span class="label" id="lbl-link">Referral link</span>
      <div class="input-wrap">
        <input class="input" id="ref-link-input" readonly value="${esc(link)}" aria-labelledby="lbl-link" style="padding-right:12px">
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px">
        <button class="btn primary btn-sm" id="ref-copy-link">${icon('copy')} Copy Link</button>
        <button class="btn ghost btn-sm" id="ref-share">${icon('share')} Share</button>
      </div>
    </div>
    <div class="field" style="margin-bottom:12px">
      <span class="label" id="lbl-code">Your referral code</span>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <span class="chip" style="font-size:16px; font-weight:700; letter-spacing:.08em; padding:8px 14px" id="ref-code-chip">${esc(code)}</span>
        <button class="btn ghost btn-sm" id="ref-copy-code">${icon('copy')} Copy Code</button>
      </div>
      <p class="hint">Share the code verbally or offline — your friends can enter it during signup.</p>
    </div>
    <div class="field" style="margin-bottom:0">
      <label class="label" for="ref-handle">Custom referral link (optional)</label>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-start">
        <div style="flex:1; min-width:200px">
          <input class="input" id="ref-handle" placeholder="e.g. yourname" maxlength="30" value="${esc(handle)}" autocomplete="off" spellcheck="false" aria-describedby="ref-handle-hint">
          <p class="hint" id="ref-handle-hint">${vanity ? `Your vanity link: <strong>${esc(vanity)}</strong>` : '3–30 letters, numbers, dots, dashes or underscores. Reserved names are blocked.'}</p>
        </div>
        <button class="btn ghost btn-sm" id="ref-save-handle" style="margin-top:2px">${icon('check')} Save</button>
      </div>
    </div>`;

  inviteBody.querySelector('#ref-copy-link').addEventListener('click', () => copyWithFeedback(link, 'Referral link copied!'));
  inviteBody.querySelector('#ref-copy-code').addEventListener('click', () => copyWithFeedback(code, 'Referral code copied!'));
  inviteBody.querySelector('#ref-share').addEventListener('click', () => shareLink(link, code));
  inviteBody.querySelector('#ref-save-handle').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const raw = normalizeHandle(inviteBody.querySelector('#ref-handle').value);
    if (!raw) { toast('Enter a handle first, or leave it empty to keep your current link.', { type: 'warn' }); return; }
    if (!isValidHandle(raw)) { toast('That handle is not valid. Use 3–30 letters, numbers, dots, dashes or underscores.', { type: 'error' }); return; }
    btnBusy(btn, true, 'Saving…');
    try {
      const res = await setReferralHandle(raw);
      profile.referralHandle = res.handle;
      toast('Referral link updated.', { type: 'success' });
      renderInviteCard();
    } catch (err) {
      toast(err.message || 'Could not save that handle. Please try another.', { type: 'error' });
    }
    btnBusy(btn, false);
  });
}

function renderRulesCard() {
  const c = cfg || {};
  const milestone = c.milestoneTasks || 2;
  const mAmt = fmtNPR(c.milestoneRewardPaisa || 1500);
  const rAmt = fmtNPR(c.recurringRewardPaisa || 500);
  rulesBody.innerHTML = `
    <div class="kv-grid" style="grid-template-columns:1fr 1fr; margin-bottom:12px">
      <div class="kv-cell tone-green"><div class="k">First ${milestone} approved tasks</div><div class="v num">${esc(mAmt)} <small>one-time, per referral</small></div></div>
      <div class="kv-cell tone-gold"><div class="k">Every approved task after</div><div class="v num">${esc(rAmt)} <small>per approved task</small></div></div>
    </div>
    <ul style="margin:0; padding-left:18px; font-size:13.5px; color:var(--ink-2); line-height:1.65">
      <li>Rewards start only when your referral's task is <strong>approved</strong> — submitted or pending work never counts.</li>
      <li>Rejected, cancelled, duplicate or reversed tasks never earn referral rewards.</li>
      <li>Rewards follow the platform's standard hold period before becoming withdrawable.</li>
      <li>Self-referrals and multi-account abuse are prohibited and may be reviewed.</li>
    </ul>
    <details style="margin-top:12px">
      <summary style="cursor:pointer; font-weight:600; font-size:13.5px">Full referral rules</summary>
      <ol style="margin:10px 0 0; padding-left:20px; font-size:13px; color:var(--ink-2); line-height:1.7">
        <li>Each account receives a unique referral link and code.</li>
        <li>A referral must create a legitimate account through your link or code.</li>
        <li>Referral ownership is assigned only once and cannot be changed later.</li>
        <li>You receive ${esc(mAmt)} when your referred user completes their first ${milestone} approved tasks.</li>
        <li>You receive ${esc(rAmt)} for each additional approved task completed by that referred user.</li>
        <li>Rejected, cancelled, duplicate or fraudulent tasks do not count.</li>
        <li>Self-referrals are prohibited.</li>
        <li>Multiple accounts created to manipulate referrals are prohibited.</li>
        <li>Referral rewards may be reviewed for suspicious activity.</li>
        <li>Abuse or manipulation may result in reward cancellation, suspension, or account action.</li>
        <li>Follow all AfnoKamai task rules and applicable third-party rules.</li>
      </ol>
    </details>`;
}

// ── Stats (real aggregation queries + server-maintained earnings) ─────
async function loadStats() {
  const uid = user.uid;
  const base = () => query(collection(db, 'referrals'), where('referrerId', '==', uid));
  const [total, started, milestone, joined, rewardsSnap] = await Promise.all([
    getCountFromServer(base()),
    getCountFromServer(query(collection(db, 'referrals'), where('referrerId', '==', uid), where('approvedTaskCount', '>', 0))),
    getCountFromServer(query(collection(db, 'referrals'), where('referrerId', '==', uid), where('milestoneReached', '==', true))),
    getCountFromServer(query(collection(db, 'referrals'), where('referrerId', '==', uid), where('status', '==', 'joined'))),
    // earnings from the inviter's server-maintained aggregate (admin-written)
    getDoc(doc(db, 'users', uid))
  ]);
  const u = rewardsSnap.exists() ? (rewardsSnap.data() || {}) : {};
  const rs = u.referralStats || {};
  stats = {
    total: total.data().count,
    active: started.data().count,
    successful: milestone.data().count,
    pending: joined.data().count,
    earningsPaisa: rs.totalEarnedPaisa || 0
  };
  statsEl.innerHTML = `
    <div class="card stat-card"><div class="stat-corner"></div>
      <span class="stat-label">${icon('users')} Total Referrals</span>
      <span class="stat-value num">${stats.total}</span>
      <span class="stat-note">Members registered through your link or code</span>
    </div>
    <div class="card stat-card tone-gold"><div class="stat-corner"></div>
      <span class="stat-label">${icon('target')} Successful Referrals</span>
      <span class="stat-value num">${stats.successful}</span>
      <span class="stat-note">Reached the first-${cfg ? cfg.milestoneTasks : 2}-task milestone</span>
    </div>
    <div class="card stat-card tone-blue"><div class="stat-corner"></div>
      <span class="stat-label">${icon('trendUp')} Active Referrals</span>
      <span class="stat-value num">${stats.active}</span>
      <span class="stat-note">Have at least one approved task</span>
    </div>
    <div class="card stat-card tone-amber"><div class="stat-corner"></div>
      <span class="stat-label">${icon('coins')} Referral Earnings</span>
      <span class="stat-value num">${esc(fmtNPR(stats.earningsPaisa, { sign: 1 }))}</span>
      <span class="stat-note">Paid into your wallet through the standard ledger</span>
    </div>`;
}

// ── Members list (paginated, Load more) ───────────────────────────────
async function loadMembersPage(reset = false) {
  if (reset) {
    cursor = null;
    membersLoaded = 0;
    membersEl.innerHTML = skeletonRows(4, 52);
    moreWrap.hidden = true;
    listCount.textContent = '';
  }
  try {
    const parts = [collection(db, 'referrals'), where('referrerId', '==', user.uid), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
    if (cursor) parts.push(startAfter(cursor));
    const snap = await getDocs(query(...parts));

    if (reset && snap.empty) {
      membersEl.innerHTML = emptyState({
        icon: 'users',
        title: 'No referrals yet',
        message: 'Share your referral link with friends to start building your referral network.',
        actionHTML: `
          <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-top:6px">
            <button class="btn primary btn-sm" id="ref-empty-copy">${icon('copy')} Copy Referral Link</button>
            <button class="btn ghost btn-sm" id="ref-empty-share">${icon('share')} Share Link</button>
          </div>`
      });
      const link = profile.referralCode ? referralLink(profile.referralCode) : '';
      const c1 = membersEl.querySelector('#ref-empty-copy');
      if (c1) c1.addEventListener('click', () => link && copyWithFeedback(link, 'Referral link copied!'));
      const s1 = membersEl.querySelector('#ref-empty-share');
      if (s1) s1.addEventListener('click', () => link && shareLink(link, profile.referralCode));
      return;
    }

    const rows = snap.docs.map((d) => {
      const r = d.data() || {};
      const st = statusMeta(r);
      return `
        <tr data-ref="${esc(d.id)}" tabindex="0" role="button" aria-label="Open referral details for ${esc(r.referredName || 'member')}">
          <td>
            <div style="display:flex; align-items:center; gap:10px">
              <span class="avatar sm">${esc(initials(r.referredName || '?'))}</span>
              <div>
                <div class="cell-strong">${esc(r.referredName || 'Member')}</div>
                <div class="small muted">Joined ${esc(fmtDate(r.createdAt))}</div>
              </div>
            </div>
          </td>
          <td>${badge(st.label, st.tone, { dot: true })}</td>
          <td class="num">${r.approvedTaskCount || 0}</td>
          <td class="small">${r.milestoneReached ? badge('Milestone ✓', 'green') : '<span class="small muted">—</span>'}</td>
          <td class="cell-strong num">${esc(fmtNPR(r.totalEarnedPaisa || 0, { sign: 1 }))}</td>
        </tr>`;
    }).join('');

    if (reset) {
      membersEl.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Member</th><th>Status</th><th>Approved tasks</th><th>Milestone</th><th>Earned for you</th></tr></thead>
          <tbody id="ref-members-body">${rows}</tbody>
        </table></div>`;
    } else {
      membersEl.querySelector('#ref-members-body').insertAdjacentHTML('beforeend', rows);
    }

    membersLoaded += snap.size;
    cursor = snap.docs[snap.docs.length - 1] || null;
    moreWrap.hidden = !(cursor && snap.size === PAGE_SIZE);
    if (stats) listCount.textContent = `${membersLoaded} of ${stats.total} shown`;
    else listCount.textContent = `${membersLoaded} loaded`;

    membersEl.querySelectorAll('tr[data-ref]').forEach((tr) => {
      const open = () => openMemberDetail(tr.dataset.ref);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  } catch (err) {
    if (reset) {
      const idxHint = err && err.code === 'failed-precondition'
        ? 'A database index is still building. Try again in a few minutes.'
        : 'Check your connection and try again.';
      membersEl.innerHTML = emptyState({
        icon: 'alert',
        title: 'We could not load your referrals',
        message: idxHint,
        actionHTML: '<button class="btn subtle" data-ref-retry>' + icon('refresh') + ' Try again</button>'
      });
      const retry = membersEl.querySelector('[data-ref-retry]');
      if (retry) retry.addEventListener('click', () => loadMembersPage(true));
    } else {
      toast('Could not load more referrals.', { type: 'error' });
    }
  }
}

// ── Member detail (privacy-safe: no PIN, no IP, no financial accounts) ─
async function openMemberDetail(referralId) {
  const m = modal({
    title: 'Referral details',
    width: 560,
    body: `<div class="state-block loading"><span class="spin dark"></span><p>Loading…</p></div>`,
    actions: '<button class="btn ghost" data-close>Close</button>'
  });
  m.root.querySelector('[data-close]').addEventListener('click', () => m.close());

  try {
    const snap = await getDoc(doc(db, 'referrals', referralId));
    if (!snap.exists()) { m.root.querySelector('.modal-body').innerHTML = emptyState({ icon: 'alert', title: 'Referral not found' }); return; }
    const r = snap.data() || {};
    const [rewardsSnap, eventsSnap] = await Promise.all([
      getDocs(query(
        collection(db, 'referralRewards'),
        where('referrerId', '==', user.uid),
        where('referredUserId', '==', r.referredUserId),
        orderBy('createdAt', 'desc'),
        limit(50)
      )),
      getDocs(query(collection(db, 'referrals', referralId, 'events'), orderBy('createdAt', 'asc'), limit(50)))
    ]);
    const rewards = rewardsSnap.docs.map((d) => d.data() || {});
    const events = eventsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const st = statusMeta(r);
    const milestoneTasks = cfg ? cfg.milestoneTasks : 2;

    const rewardRows = rewards.length
      ? rewards.map((rw) => `
          <div style="display:flex; justify-content:space-between; gap:10px; padding:7px 0; border-bottom:1px solid var(--line); font-size:13.5px">
            <span>${rw.type === 'referral_milestone'
              ? `First ${milestoneTasks} approved tasks`
              : `Task reward${rw.taskId ? ` · ${esc(String(rw.taskId).slice(0, 12))}…` : ''}`}</span>
            <strong class="num">${esc(fmtNPR(rw.amountPaisa || 0, { sign: 1 }))}</strong>
          </div>`).join('')
      : '<p class="small muted" style="margin:6px 0">No referral rewards yet — they start when this member completes approved tasks.</p>';

    const eventRows = events.length
      ? events.map((ev) => `
          <div style="display:flex; gap:10px; padding:7px 0; border-bottom:1px solid var(--line); font-size:13.5px">
            <span style="flex:none; margin-top:1px; color:${ev.amountPaisa > 0 ? 'var(--green-600)' : 'var(--ink-3)'}">${icon(ev.amountPaisa > 0 ? 'coins' : ev.type === 'joined' ? 'user' : 'check')}</span>
            <div style="flex:1; min-width:0">
              <div>${esc(ev.title || ev.type || 'Activity')}</div>
              <div class="small muted">${esc(fmtRelative(ev.createdAt))}${ev.amountPaisa > 0 ? ` · ${esc(fmtNPR(ev.amountPaisa, { sign: 1 }))}` : ''}</div>
            </div>
          </div>`).join('')
      : '<p class="small muted" style="margin:6px 0">No activity recorded yet.</p>';

    m.root.querySelector('.modal-body').innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px">
        <span class="avatar lg">${esc(initials(r.referredName || '?'))}</span>
        <div style="min-width:0">
          <h3 style="margin:0; font-size:17px">${esc(r.referredName || 'Member')}</h3>
          <div class="small muted">Joined ${esc(fmtDate(r.createdAt))} · ${badge(st.label, st.tone)}</div>
        </div>
      </div>
      <div class="kv-grid" style="grid-template-columns:1fr 1fr; margin-bottom:14px">
        <div class="kv-cell"><div class="k">Approved tasks</div><div class="v num">${r.approvedTaskCount || 0}</div></div>
        <div class="kv-cell tone-green"><div class="k">Milestone</div><div class="v">${r.milestoneReached ? `✓ First ${milestoneTasks} tasks completed` : `Not yet (needs ${milestoneTasks})`}</div></div>
        <div class="kv-cell tone-gold"><div class="k">Referral earnings</div><div class="v num">${esc(fmtNPR(r.totalEarnedPaisa || 0, { sign: 1 }))}</div></div>
        <div class="kv-cell"><div class="k">Referral code used</div><div class="v" style="font-size:12.5px">${esc(r.referralCode || '—')}</div></div>
      </div>
      ${r.underReview ? `<p class="hint" style="color:var(--amber-700); margin-bottom:10px">${icon('shield')} This referral is under a routine review. Rewards continue normally unless a specific reward is paused.</p>` : ''}
      ${r.rewardsSuspended ? `<p class="hint" style="color:var(--red-600); margin-bottom:10px">${icon('alert')} Referral rewards for this member are temporarily paused during a review.</p>` : ''}
      <h4 style="margin:0 0 6px; font-size:14px">Earnings breakdown</h4>
      ${rewardRows}
      <h4 style="margin:14px 0 6px; font-size:14px">Activity</h4>
      ${eventRows}
      <p class="small muted" style="margin-top:12px">Only privacy-safe information is shown here. Reward amounts, task counts and timestamps come directly from your permanent ledger.</p>`;
  } catch (_) {
    m.root.querySelector('.modal-body').innerHTML = emptyState({
      icon: 'alert', title: 'Could not load details', message: 'Check your connection and try again.'
    });
  }
}

// ── Activity timeline (collection-group over my referrals' events) ────
async function loadActivity() {
  try {
    // Events live in per-referral subcollections; a collection-group query
    // needs the events index. Fall back to per-referral loading when the
    // index is not ready yet.
    let events = [];
    try {
      const cg = await getDocs(query(
        collectionGroup(db, 'events'),
        where('referrerId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        limit(20)
      ));
      events = cg.docs.map((d) => d.data() || {});
    } catch (_) {
      // Index building / offline — load events per referral instead.
      const refs = await getDocs(query(
        collection(db, 'referrals'),
        where('referrerId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        limit(5)
      ));
      for (const d of refs.docs) {
        const evs = await getDocs(query(collection(db, 'referrals', d.id, 'events'), orderBy('createdAt', 'desc'), limit(6)));
        events.push(...evs.docs.map((x) => x.data() || {}));
      }
      events.sort((a, b) => {
        const av = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
        const bv = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        return bv - av;
      });
      events = events.slice(0, 20);
    }

    if (!events.length) {
      activityEl.innerHTML = emptyState({
        icon: 'clock',
        title: 'No referral activity yet',
        message: 'Joins and approved tasks from your referrals will appear here.'
      });
      return;
    }
    activityEl.innerHTML = events.map((ev) => `
      <div class="activity-item" style="cursor:default">
        <span class="act-ic ${ev.amountPaisa > 0 ? 'green' : ev.type === 'joined' ? 'blue' : 'gray'}">${icon(ev.amountPaisa > 0 ? 'coins' : ev.type === 'joined' ? 'user' : 'check')}</span>
        <div class="act-body">
          <div class="act-title">${esc(ev.title || 'Referral activity')}</div>
          <div class="act-time">${esc(fmtRelative(ev.createdAt))}</div>
        </div>
        ${ev.amountPaisa > 0 ? `<span class="act-amt pos">${esc(fmtNPR(ev.amountPaisa, { sign: 1 }))}</span>` : ''}
      </div>`).join('');
  } catch (_) {
    activityEl.innerHTML = emptyState({
      icon: 'alert', title: 'Could not load activity', message: 'Check your connection and try again.'
    });
  }
}

// ── Recent rewards ────────────────────────────────────────────────────
async function loadRewards() {
  try {
    // Reward records + their paired ledger entries: hold → release state
    // lives on `transactions`, never on the reward doc.
    const [snap, txSnap] = await Promise.all([
      getDocs(query(
        collection(db, 'referralRewards'),
        where('referrerId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        limit(15)
      )),
      getDocs(query(
        collection(db, 'transactions'),
        where('userId', '==', user.uid),
        where('type', 'in', ['referral_reward', 'referral_task_reward']),
        orderBy('createdAt', 'desc'),
        limit(60)
      )).catch(() => null)
    ]);
    const txStatus = new Map();
    if (txSnap) txSnap.forEach((t) => txStatus.set(t.id, t.data().status));
    if (snap.empty) {
      rewardsEl.innerHTML = emptyState({
        icon: 'coins',
        title: 'No referral rewards yet',
        message: 'Rewards appear here the moment an admin approves your referral\'s tasks — रु15 after their first 2, then रु5 for every approved task after.'
      });
      return;
    }
    rewardsEl.innerHTML = `<div class="activity-list">${snap.docs.map((d) => {
      const rw = d.data() || {};
      const st = txStatus.get(d.id);
      const state = st === 'available' ? 'Now withdrawable'
        : st === 'hold' ? 'On hold'
          : st === 'reversed' ? 'Reversed'
            : st === 'pending' ? 'Pending'
              : 'Added to hold';
      return `
        <div class="activity-item" style="cursor:default">
          <span class="act-ic green">${icon(rw.type === 'referral_milestone' ? 'target' : 'coins')}</span>
          <div class="act-body">
            <div class="act-title">${rw.type === 'referral_milestone' ? 'Milestone reward' : 'Referral task reward'}</div>
            <div class="act-desc">${rw.type === 'referral_milestone' ? 'First 2 approved tasks completed' : 'Your referral completed an approved task'}</div>
            <div class="act-time">${esc(fmtRelative(rw.createdAt))} · ${esc(state)}</div>
          </div>
          <span class="act-amt pos">${esc(fmtNPR(rw.amountPaisa || 0, { sign: 1 }))}</span>
        </div>`;
    }).join('')}</div>`;
  } catch (_) {
    rewardsEl.innerHTML = emptyState({
      icon: 'alert', title: 'Could not load earnings', message: 'Check your connection and try again.'
    });
  }
}

// ── Finalize banner (attribution retry for very recent signups) ──────
async function renderFinalizeBanner() {
  const pending = readPendingCode();
  if (!pending || profile.referredBy) return;
  const createdMs = profile.createdAt && profile.createdAt.toMillis ? profile.createdAt.toMillis() : 0;
  if (!createdMs || Date.now() - createdMs > 48 * 3600 * 1000) return; // too old — ownership stays fixed
  finalizeSlot.innerHTML = `
    <div class="announce-banner" style="margin-bottom:14px">
      ${icon('link')}
      <div class="ab-body">
        <h4>Finish connecting your referral</h4>
        <p>A referral code was captured during signup but could not be applied yet. Apply it now to credit your inviter.</p>
      </div>
      <button class="btn primary btn-sm" id="ref-apply-pending" style="margin-right:6px">Apply code</button>
      <button class="ab-x" id="ref-dismiss-pending" aria-label="Dismiss">${icon('x')}</button>
    </div>`;
  finalizeSlot.querySelector('#ref-apply-pending').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btnBusy(btn, true, 'Applying…');
    const res = await finalizeReferral(pending);
    btnBusy(btn, false);
    finalizeSlot.innerHTML = '';
    if (res && res.ok) {
      toast(res.skipped ? 'No referral was applied to this account.' : 'Referral code applied — welcome to the network!', { type: 'success' });
      profile = (await getDoc(doc(db, 'users', user.uid))).data() || profile;
      renderInviteCard();
      loadStats().catch(() => {});
      loadMembersPage(true);
      loadActivity();
      loadRewards();
    } else {
      toast('Could not apply the referral code right now. Please try again later.', { type: 'error' });
    }
  });
  finalizeSlot.querySelector('#ref-dismiss-pending').addEventListener('click', () => { finalizeSlot.innerHTML = ''; });
}

// ── Boot ──────────────────────────────────────────────────────────────
async function boot() {
  try {
    cfg = await fetchReferralConfig();
  } catch (_) { cfg = null; }
  renderInviteCard();
  renderRulesCard();
  renderFinalizeBanner().catch(() => {});
  await Promise.allSettled([
    loadStats(),
    loadMembersPage(true),
    loadActivity(),
    loadRewards()
  ]);
}

content.querySelector('#ref-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btnBusy(btn, true, 'Refreshing…');
  profile = (await getDoc(doc(db, 'users', user.uid))).data() || profile;
  renderInviteCard();
  await Promise.allSettled([loadStats(), loadMembersPage(true), loadActivity(), loadRewards()]);
  btnBusy(btn, false);
});
content.querySelector('#ref-more').addEventListener('click', () => loadMembersPage(false));

boot();
