// ─── Admin overview: platform analytics ──────────────────────────────
import { db } from '../../firebase.js';
import {
  collection, doc, getDoc, query, where, getCountFromServer,
  orderBy, limit, getDocs, getAggregateFromServer, sum
} from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=2';
import { esc, fmtNPR } from '../../utils.js';
import { icon } from '../../icons.js';
import { emptyState } from '../../ui.js';

let { profile, content } = await mountAdminShell('index');
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Platform overview</h1>
      <p class="sub">Live operations data — all figures come from Firebase.</p>
    </div>
    <div class="page-head-actions">
      <a class="btn primary" href="/admin/reviews.html">${icon('check')} Review queue</a>
      <a class="btn ghost" href="/admin/withdrawals.html">${icon('wallet')} Withdrawals</a>
    </div>
  </div>

  <div class="grid grid-4" id="stat-cards">
    ${['Total users', 'Pending reviews', 'Pending withdrawals', 'Unread chats'].map((t) =>
      `<div class="card stat-card"><span class="stat-label">${t}</span><span class="stat-value">…</span></div>`).join('')}
  </div>
  <div class="grid grid-4" style="margin-top:16px" id="stat-cards-2">
    ${['Rewards issued', 'Total withdrawn', 'Hold balance', 'Penalties issued'].map((t) =>
      `<div class="card stat-card"><span class="stat-label">${t}</span><span class="stat-value">…</span></div>`).join('')}
  </div>

  <div class="grid grid-2" style="margin-top:16px">
    <div class="card chart-card">
      <h3>User growth & task activity</h3>
      <p class="chart-sub">New users and task outcomes · last 14 days</p>
      <div class="chart-box"><canvas id="chart-growth"></canvas></div>
    </div>
    <div class="card chart-card">
      <h3>Rewards vs withdrawals</h3>
      <p class="chart-sub">Daily NPR totals · last 14 days</p>
      <div class="chart-box"><canvas id="chart-money"></canvas></div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-head"><h3>Latest registered users</h3><a href="/admin/users.html" class="small" style="font-weight:600">All users</a></div>
    <div id="latest-users"><div class="state-block loading"><span class="spin dark"></span></div></div>
  </div>`;

const money = (n) => esc(fmtNPR(n || 0));

async function counts() {
  const cards = content.querySelectorAll('#stat-cards .stat-card .stat-value, #stat-cards-2 .stat-card .stat-value');
  const setValue = (i, v) => { if (cards[i]) cards[i].textContent = v; };
  const count = async (col, field, values) => {
    try {
      const snap = await getCountFromServer(query(collection(db, col), where(field, 'in', values)));
      return snap.data().count;
    } catch (_) { return 0; }
  };
  const [users, active, reviews, withdrawals, chats, penalties] = await Promise.all([
    count('users', 'status', ['active', 'banned']),
    count('users', 'status', ['active']),
    count('taskAssignments', 'status', ['submitted', 'under_review']),
    count('withdrawals', 'status', ['pending', 'under_review', 'processing']),
    (async () => {
      try {
        const s2 = await getCountFromServer(query(collection(db, 'conversations'), where('unreadForAdmin', '>', 0)));
        return s2.data().count;
      } catch (_) { return 0; }
    })(),
    count('penalties', 'type', ['amount', 'warning'])
  ]);
  setValue(0, users);
  setValue(1, reviews);
  setValue(2, withdrawals);
  setValue(3, chats);
  setValue(4, '—'); setValue(5, '—'); setValue(6, '—'); setValue(7, penalties);

  // financial totals via server-side aggregation queries (free plan)
  try {
    const sumOf = async (field, type, status) => {
      const parts = [collection(db, 'transactions'), where('type', '==', type)];
      if (status) parts.push(where('status', '==', status));
      const agg = await getAggregateFromServer(query(...parts), { total: sum(field) });
      return agg.data().total || 0;
    };
    const [rewards, withdrawn, hold] = await Promise.all([
      sumOf('amountPaisa', 'task_reward'),
      sumOf('amountPaisa', 'withdrawal'),
      sumOf('amountPaisa', 'task_reward', 'hold')
    ]);
    setValue(4, money(rewards));
    setValue(5, money(Math.abs(withdrawn)));
    setValue(6, money(hold));
  } catch (_) {}
}
counts().catch(() => {});

// Asia/Kathmandu day keys — `toISOString()` buckets by UTC, which put NPT
// activity into the previous day's column.
const KT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit'
});
const dayKey = (ts) => (ts?.toDate ? ts.toDate() : new Date(ts));
const fmtDay = (d) => KT.format(d).replace(/-/g, '');

async function charts() {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    days.push({
      key: fmtDay(d),
      label: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short' }).format(d)
    });
  }
  const stats = Object.fromEntries(days.map((d) => [d.key, {}]));
  try {
    // Cached for 10 minutes: the 14-day history barely changes, and each
    // uncached run fetched up to 1,500 documents (3 × limit(500)).
    const CACHE_KEY = 'ak_chart_stats';
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (_) {}
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
      Object.assign(stats, cached.stats);
    } else {
      const since = new Date(Date.now() - 14 * 86400000);
      const [txSnap, userSnap, rejectedSnap] = await Promise.all([
        getDocs(query(collection(db, 'transactions'), where('createdAt', '>=', since), orderBy('createdAt', 'desc'), limit(200))),
        getDocs(query(collection(db, 'users'), where('createdAt', '>=', since), orderBy('createdAt', 'desc'), limit(200))),
        // Rejected submissions never create a transaction, so the Rejected
        // series has to come from the assignment history itself.
        getDocs(query(collection(db, 'taskAssignments'), where('status', '==', 'rejected'), orderBy('requestedAt', 'desc'), limit(200)))
      ]);
      const dayOf = (ts) => fmtDay(dayKey(ts));
      for (const d of txSnap.docs) {
        const t = d.data();
        const k = dayOf(t.createdAt);
        if (!(k in stats)) continue;
        if (t.type === 'task_reward' && t.amountPaisa > 0) {
          stats[k].rewardsPaisa = (stats[k].rewardsPaisa || 0) + t.amountPaisa;
          stats[k].tasksApproved = (stats[k].tasksApproved || 0) + 1;
        } else if (t.type === 'withdrawal' && t.amountPaisa < 0) {
          stats[k].withdrawalsPaisa = (stats[k].withdrawalsPaisa || 0) + Math.abs(t.amountPaisa);
        }
      }
      for (const d of rejectedSnap.docs) {
        const a = d.data();
        const k = dayOf(a.reviewedAt || a.requestedAt);
        if (k in stats) stats[k].tasksRejected = (stats[k].tasksRejected || 0) + 1;
      }
      for (const d of userSnap.docs) {
        const k = dayOf(d.data().createdAt);
        if (k in stats) stats[k].usersCreated = (stats[k].usersCreated || 0) + 1;
      }
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), stats })); } catch (_) {}
    }
  } catch (_) {}
  const hasData = Object.values(stats).some((s) => Object.keys(s).length);
  const usersCanvas = content.querySelector('#chart-growth');
  const moneyCanvas = content.querySelector('#chart-money');
  if (!hasData) {
    usersCanvas.parentElement.innerHTML = emptyState({
      icon: 'trendUp', title: 'No activity data yet',
      message: 'Daily statistics appear here as users register and tasks are reviewed.'
    });
    moneyCanvas.parentElement.innerHTML = emptyState({
      icon: 'coins', title: 'No financial data yet',
      message: 'Rewards and withdrawal totals appear here once the platform processes transactions.'
    });
    return;
  }
  if (typeof Chart === 'undefined') {
    content.querySelectorAll('.chart-box').forEach((box) => {
      box.innerHTML = emptyState({
        icon: 'info', title: 'Charts unavailable',
        message: 'The chart library could not be loaded. Check your connection and refresh.'
      });
    });
    return;
  }
  const axis = {
    y: { beginAtZero: true, grid: { color: 'rgba(19,32,26,.06)' }, ticks: { color: '#71837A', font: { size: 11 } } },
    x: { grid: { display: false }, ticks: { color: '#71837A', font: { size: 11 }, maxTicksLimit: 7 } }
  };
  new Chart(usersCanvas, {
    type: 'bar',
    data: {
      labels: days.map((d) => d.label),
      datasets: [
        { label: 'New users', data: days.map((d) => stats[d.key].usersCreated || 0), backgroundColor: '#0F7A55', borderRadius: 5, maxBarThickness: 18 },
        { label: 'Approved', data: days.map((d) => stats[d.key].tasksApproved || 0), backgroundColor: '#12996B', borderRadius: 5, maxBarThickness: 18 },
        { label: 'Rejected', data: days.map((d) => stats[d.key].tasksRejected || 0), backgroundColor: '#D64541', borderRadius: 5, maxBarThickness: 18 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true, font: { size: 11 } } } }, scales: axis }
  });
  new Chart(moneyCanvas, {
    type: 'line',
    data: {
      labels: days.map((d) => d.label),
      datasets: [
        { label: 'Rewards (रु)', data: days.map((d) => (stats[d.key].rewardsPaisa || 0) / 100), borderColor: '#0F7A55', backgroundColor: 'rgba(15,122,85,.12)', fill: true, tension: .35, pointRadius: 2, borderWidth: 2 },
        { label: 'Withdrawals (रु)', data: days.map((d) => (stats[d.key].withdrawalsPaisa || 0) / 100), borderColor: '#D9A62E', backgroundColor: 'rgba(217,166,46,.10)', fill: true, tension: .35, pointRadius: 2, borderWidth: 2 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true, font: { size: 11 } } } }, scales: axis }
  });
}
charts().catch(() => {});

(async () => {
  const el = content.querySelector('#latest-users');
  try {
    const snap = await getDocs(query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(6)));
    if (snap.empty) {
      el.innerHTML = emptyState({ icon: 'users', title: 'No users yet', message: 'New registrations will appear here.' });
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="table"><tbody>
      ${snap.docs.map((d) => {
        const u = d.data();
        return `<tr>
          <td style="width:44px"><span class="avatar sm">${esc((u.fullName || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span></td>
          <td><div class="cell-strong">${esc(u.fullName || '—')}</div><div class="small muted">${esc(u.email)}</div></td>
          <td class="small muted num">${esc(u.phone || '')}</td>
          <td>${u.status === 'banned' ? '<span class="badge tone-red">Banned</span>' : '<span class="badge tone-green">Active</span>'}</td>
          <td style="text-align:right"><a class="btn ghost btn-sm" href="/admin/users.html?uid=${esc(d.id)}">Open</a></td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`;
  } catch (_) {
    el.innerHTML = emptyState({ icon: 'alert', title: 'Could not load users', message: 'Please refresh.' });
  }
})();
