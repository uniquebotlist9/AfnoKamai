// ─── Dashboard: financial overview, charts, activity ─────────────────
import { db } from '../firebase.js';
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc
} from 'firebase/firestore';
import { mountShell, renderRestriction } from '../shell.js';
import { watchWallet, watchPlatformConfig, fetchWalletSummary, fetchRecentTransactions, txTypeMeta } from '../wallet.js';
import { esc, fmtNPR, fmtRelative, greeting, countdownUntil } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState } from '../ui.js';

const ACTIVITY_ICONS = {
  task_approved: { ic: 'check', tone: 'green' },
  task_rejected: { ic: 'x', tone: 'red' },
  reward_hold: { ic: 'clock', tone: 'amber' },
  reward_released: { ic: 'unlock', tone: 'green' },
  withdrawal: { ic: 'bank', tone: 'blue' },
  penalty: { ic: 'alert', tone: 'red' },
  announcement: { ic: 'megaphone', tone: 'gold' },
  security: { ic: 'shield', tone: 'amber' },
  system: { ic: 'info', tone: 'gray' },
  task_assigned: { ic: 'briefcase', tone: 'blue' },
  admin_message: { ic: 'message', tone: 'gold' }
};

let { user, profile, content } = await mountShell('dashboard');
if (profile.status === 'banned') {
  document.getElementById('page-skeleton')?.remove();
  renderRestriction(profile);
  throw new Error('restricted');
}

// ── Asia/Kathmandu day bucketing ──────────────────────────────────────
// The chart used `toISOString().slice(0,10)`, which buckets by UTC — so a
// reward approved at 04:00 NPT on the 6th landed in the 5th bucket.
const KT_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit'
});
const dayKey = (d) => KT_DAY.format(d);
const ktLabel = (d) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short'
}).format(d);

// ── Announcement banner ──
try {
  const annSnap = await getDocs(query(
    collection(db, 'announcements'),
    where('published', '==', true),
    orderBy('publishedAt', 'desc'),
    limit(1)
  ));
  if (!annSnap.empty) {
    const a = annSnap.docs[0].data();
    const dismissed = JSON.parse(localStorage.getItem('ak_dismissed_ann') || '[]');
    if (!dismissed.includes(annSnap.docs[0].id)) {
      const banner = document.createElement('div');
      banner.className = 'announce-banner';
      banner.innerHTML = `
        ${icon('megaphone')}
        <div class="ab-body">
          <h4>${esc(a.title)}</h4>
          <p>${esc(a.message)}</p>
        </div>
        <button class="ab-x" aria-label="Dismiss announcement">${icon('x')}</button>`;
      content.parentElement.insertBefore(banner, content);
      banner.querySelector('.ab-x').addEventListener('click', () => {
        dismissed.push(annSnap.docs[0].id);
        localStorage.setItem('ak_dismissed_ann', JSON.stringify(dismissed.slice(-20)));
        banner.remove();
      });
    }
  }
} catch (_) { /* announcements optional */ }

// ── Hero + stat cards skeleton replaced ──
document.getElementById('page-skeleton')?.remove();
content.innerHTML = `
  <section class="hero-greeting">
    <div>
      <h2>${esc(greeting())}, ${esc((profile.fullName || '').split(' ')[0])} 👋</h2>
      <p class="sub">Here's your AfnoKamai activity overview.</p>
    </div>
    <div class="hero-cta">
      <a class="btn btn-gold" href="earn.html">${icon('briefcase')} Find tasks</a>
      <a class="btn ghost" style="color:#fff; border-color:rgba(255,255,255,.25)" href="withdraw.html">${icon('wallet')} Withdraw</a>
    </div>
  </section>

  <div class="grid grid-4" id="stat-cards">
    <div class="card stat-card"><span class="spin dark"></span></div>
    <div class="card stat-card"><span class="spin dark"></span></div>
    <div class="card stat-card"><span class="spin dark"></span></div>
    <div class="card stat-card"><span class="spin dark"></span></div>
  </div>
  <div id="task-strip" style="display:flex; gap:8px; flex-wrap:wrap; margin:14px 2px 0"></div>

  <div class="grid" style="grid-template-columns: 2fr 1fr; margin-top:16px" id="charts-row">
    <div class="card chart-card">
      <h3>Earnings over time</h3>
      <p class="chart-sub">Approved task rewards and withdrawals · last 14 days</p>
      <div class="chart-box"><canvas id="chart-earnings" aria-label="Earnings chart"></canvas></div>
    </div>
    <div class="card chart-card">
      <h3>Task outcomes</h3>
      <p class="chart-sub">Approved vs rejected submissions</p>
      <div class="chart-box"><canvas id="chart-outcomes" aria-label="Task outcomes chart"></canvas></div>
      <div class="legend-row">
        <span class="lg-item"><span class="lg-dot" style="background:#0F7A55"></span>Approved</span>
        <span class="lg-item"><span class="lg-dot" style="background:#D64541"></span>Rejected</span>
        <span class="lg-item"><span class="lg-dot" style="background:#D9A62E"></span>In progress</span>
      </div>
    </div>
  </div>

  <div class="grid grid-2" style="margin-top:16px">
    <div class="card">
      <div class="card-head"><h3>Recent activity</h3><a href="notifications.html" class="small" style="font-weight:600">View all</a></div>
      <div class="activity-list" id="activity-list"><div class="state-block loading"><span class="spin dark"></span></div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Your earning journey</h3></div>
      <div class="card-pad" style="padding-top:8px">
        <div class="journey">
          <div class="journey-step done"><div class="journey-dot">${icon('check')}</div><h4>Complete task</h4><p>Follow the instructions in chat</p></div>
          <div class="journey-step done"><div class="journey-dot">${icon('user')}</div><h4>Admin review</h4><p>Submission is checked</p></div>
          <div class="journey-step current"><div class="journey-dot">${icon('clock')}</div><h4>3-day hold</h4><p>Reward is locked for safety</p></div>
          <div class="journey-step"><div class="journey-dot">${icon('unlock')}</div><h4>Withdrawable</h4><p>Funds become available</p></div>
          <div class="journey-step"><div class="journey-dot">${icon('bank')}</div><h4>eSewa withdrawal</h4><p>Cash out to your account</p></div>
        </div>
      </div>
    </div>
  </div>`;

// responsive charts row
const chartsRow = content.querySelector('#charts-row');
const applyChartCols = () => { chartsRow.style.gridTemplateColumns = window.innerWidth < 920 ? '1fr' : '2fr 1fr'; };
applyChartCols();
window.addEventListener('resize', applyChartCols);

// ── Wallet stats (computed summary — server timestamps decide maturity) ──
let lastWallet = null;
function renderWalletCards(w) {
  const cards = content.querySelector('#stat-cards');
  if (!cards || !w) return;
  const holdNote = w.holdUnmaturedPaisa > 0
    ? `Releasing in ${countdownUntil(w.nextReleaseAt)}`
    : 'Nothing on hold';
  const maturedNote = w.maturedPaisa > 0
    ? `Includes ${fmtNPR(w.maturedPaisa)} that finished its hold`
    : 'Ready to withdraw via eSewa';
  cards.innerHTML = `
    <div class="card stat-card"><div class="stat-corner"></div>
      <span class="stat-label">${icon('trendUp')} Total earnings</span>
      <span class="stat-value num">${esc(fmtNPR(w.earnedPaisa || 0))}</span>
      <span class="stat-note">Lifetime rewards from approved tasks</span>
    </div>
    <div class="card stat-card"><div class="stat-corner"></div>
      <span class="stat-label">${icon('wallet')} Current balance</span>
      <span class="stat-value num">${esc(fmtNPR((w.withdrawablePaisa || 0) + (w.holdUnmaturedPaisa || 0)))}</span>
      <span class="stat-note">Everything you own right now</span>
    </div>
    <div class="card stat-card tone-amber"><div class="stat-corner"></div>
      <span class="stat-label">${icon('clock')} Hold balance</span>
      <span class="stat-value num">${esc(fmtNPR(w.holdUnmaturedPaisa || 0))}</span>
      <span class="stat-note">${esc(holdNote)}</span>
    </div>
    <div class="card stat-card tone-gold"><div class="stat-corner"></div>
      <span class="stat-label">${icon('coins')} Withdrawable</span>
      <span class="stat-value num">${esc(fmtNPR(w.withdrawablePaisa || 0))}</span>
      <span class="stat-note">${esc(maturedNote)}</span>
    </div>`;
  renderTaskStrip(w);
}
async function refreshWallet() {
  const summary = await fetchWalletSummary(user.uid);
  lastWallet = summary;
  renderWalletCards(summary);
}
watchWallet(user.uid, () => refreshWallet().catch(() => {}));
refreshWallet().catch(() => {});

// ── Task stats strip + achievements ──
function renderTaskStrip(w) {
  const s = profile.stats || {};
  const strip = content.querySelector('#task-strip');
  if (!strip) return;
  const pending = (s.assigned || 0) - (s.approved || 0) - (s.rejected || 0);
  const reviewed = (s.approved || 0) + (s.rejected || 0);
  const rate = reviewed ? Math.round(((s.approved || 0) / reviewed) * 100) : 100;
  strip.innerHTML = `
    <span class="chip">${icon('check')} ${s.approved || 0} approved</span>
    <span class="chip">${icon('x')} ${s.rejected || 0} rejected</span>
    <span class="chip">${icon('clock')} ${Math.max(pending, 0)} pending</span>
    <span class="chip">${icon('target')} ${rate}% success rate</span>
    <span class="chip">${icon('alert')} ${fmtNPR(s.penaltiesPaisa || 0)} penalties</span>
    ${achievements(s, w)}
  `;
}
function achievements(s, w) {
  // `stats.earnedPaisa` is never written by any code path — the wallet's
  // `earnedPaisa` is the maintained figure, so achievements read from there.
  const earnedPaisa = (w && w.earnedPaisa) || 0;
  const earned = [];
  if ((s.approved || 0) >= 1) earned.push(['zap', 'First Task']);
  if ((s.approved || 0) >= 10) earned.push(['target', '10 Tasks']);
  if ((s.approved || 0) >= 50) earned.push(['coins', '50 Tasks']);
  if (earnedPaisa >= 50000) earned.push(['trendUp', 'रु500 Earned']);
  if (!earned.length) return '';
  return earned.map(([ic, label]) => `<span class="chip" style="background:var(--green-50); color:var(--green-700); border-color:var(--green-100)">${icon(ic)} ${esc(label)}</span>`).join('');
}

// Paint the strip immediately (before the first wallet snapshot lands) so the
// row isn't an empty gap while fetchWalletSummary round-trips.
renderTaskStrip(null);

// ── Charts (real data only) ──
async function buildCharts() {
  const txs = await fetchRecentTransactions(user.uid, 14);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    days.push({ key: dayKey(d), label: ktLabel(d) });
  }
  const earnedByDay = days.map(() => 0);
  const withdrawnByDay = days.map(() => 0);
  for (const t of txs) {
    if (!t.createdAt) continue;
    const key = dayKey(t.createdAt.toDate());
    const idx = days.findIndex((d) => d.key === key);
    if (idx < 0) continue;
    const amt = Math.abs(t.amountPaisa || 0) / 100;
    if (t.type === 'task_reward' && t.amountPaisa > 0) earnedByDay[idx] += amt;
    if (t.type === 'withdrawal' && t.amountPaisa < 0) withdrawnByDay[idx] += amt;
  }
  const hasData = txs.length > 0;

  // Chart.js comes from a CDN — if it is blocked/offline the page must still
  // work, so degrade to the empty state instead of throwing.
  if (typeof Chart === 'undefined') {
    content.querySelectorAll('.chart-box').forEach((box) => {
      box.innerHTML = emptyState({
        icon: 'info',
        title: 'Charts unavailable',
        message: 'The chart library could not be loaded. Check your connection and refresh.'
      });
    });
    return;
  }

  const earningsCanvas = content.querySelector('#chart-earnings');
  if (hasData) {
    new Chart(earningsCanvas, {
      type: 'line',
      data: {
        labels: days.map((d) => d.label),
        datasets: [
          {
            label: 'Earned (रु)', data: earnedByDay, borderColor: '#0F7A55',
            backgroundColor: 'rgba(15,122,85,.12)', fill: true, tension: .35,
            pointRadius: 2.5, borderWidth: 2.2
          },
          {
            label: 'Withdrawn (रु)', data: withdrawnByDay, borderColor: '#D9A62E',
            backgroundColor: 'rgba(217,166,46,.10)', fill: true, tension: .35,
            pointRadius: 2.5, borderWidth: 2.2
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(19,32,26,.06)' }, ticks: { color: '#71837A', font: { size: 11 } } },
          x: { grid: { display: false }, ticks: { color: '#71837A', font: { size: 11 }, maxTicksLimit: 7 } }
        }
      }
    });
  } else {
    earningsCanvas.parentElement.innerHTML = emptyState({
      icon: 'trendUp',
      title: 'No earnings yet',
      message: 'Once you complete and get tasks approved, your earnings chart will appear here.',
      actionHTML: '<a class="btn subtle" href="earn.html">Browse tasks</a>'
    });
  }

  const s = profile.stats || {};
  const outcomesCanvas = content.querySelector('#chart-outcomes');
  const approved = s.approved || 0, rejected = s.rejected || 0;
  // `stats.onHold` was never written by any code path, so this slice was
  // permanently 0. Derive "still in progress" from the counters that ARE
  // maintained instead: assigned − (approved + rejected).
  const inProgress = Math.max((s.assigned || 0) - approved - rejected, 0);
  if (approved + rejected > 0) {
    new Chart(outcomesCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Approved', 'Rejected', 'In progress'],
        datasets: [{
          data: [approved, rejected, inProgress],
          backgroundColor: ['#0F7A55', '#D64541', '#D9A62E'],
          borderWidth: 0, hoverOffset: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        plugins: { legend: { display: false } }
      }
    });
  } else {
    outcomesCanvas.parentElement.innerHTML = emptyState({
      icon: 'target',
      title: 'No task history yet',
      message: 'Your approved and rejected task counts will show up here after your first review.'
    });
  }
}
buildCharts().catch(() => {
  content.querySelectorAll('.chart-box').forEach((box) => {
    box.innerHTML = emptyState({
      icon: 'alert',
      title: 'Could not load charts',
      message: 'Check your connection and refresh the page.'
    });
  });
});

// ── Recent activity (notifications feed) ──
(async () => {
  const list = content.querySelector('#activity-list');
  try {
    const snap = await getDocs(query(
      collection(db, 'notifications'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc'),
      limit(8)
    ));
    if (snap.empty) {
      list.innerHTML = emptyState({
        icon: 'bell',
        title: 'No activity yet',
        message: 'Task updates, rewards, and withdrawals will show up here.',
        actionHTML: '<a class="btn subtle" href="earn.html">Request your first task</a>'
      });
      return;
    }
    list.innerHTML = snap.docs.map((d) => {
      const n = d.data();
      const meta = ACTIVITY_ICONS[n.type] || { ic: 'info', tone: 'gray' };
      const amt = n.amountPaisa != null
        ? `<span class="act-amt ${n.amountPaisa >= 0 ? 'pos' : 'neg'}">${esc(fmtNPR(n.amountPaisa, { sign: 1 }))}</span>` : '';
      return `
        <a class="activity-item" href="${esc(n.link || 'notifications.html')}">
          <span class="act-ic ${meta.tone}">${icon(meta.ic)}</span>
          <div class="act-body">
            <div class="act-title">${esc(n.title || 'Notification')}</div>
            ${n.body ? `<div class="act-desc">${esc(n.body)}</div>` : ''}
            <div class="act-time">${esc(fmtRelative(n.createdAt))}</div>
          </div>
          ${amt}
        </a>`;
    }).join('');
  } catch (_) {
    list.innerHTML = emptyState({ icon: 'alert', title: 'Could not load activity', message: 'Please refresh the page.' });
  }
})();
