// ─── Withdraw: eSewa withdrawal with PIN + hold breakdown ────────────
import { db } from '../firebase.js';
import { collection, query, where, orderBy, limit, getDocs, doc, getDoc } from 'firebase/firestore';
import { mountShell, renderRestriction } from '../shell.js';
import { watchWallet, watchPlatformConfig, fetchWalletSummary } from '../wallet.js';
import { esc, fmtNPR, fmtDateTime, countdownUntil, toPaisa, isNepaliPhone, isPin4, fmtRelative } from '../utils.js';
import { WITHDRAWAL_STATUS } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState, skeletonRows, badge, modal, btnBusy, toast } from '../ui.js';
import { requestWithdrawal } from '../api.js';

let { user, profile, content } = await mountShell('withdraw');
if (profile.status === 'banned') {
  document.getElementById('page-skeleton')?.remove();
  renderRestriction(profile);
  throw new Error('restricted');
}
document.getElementById('page-skeleton')?.remove();

let wallet = null;
let config = { holdDays: 3, minWithdrawalPaisa: 50000 };

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Withdraw</h1>
      <p class="sub">Cash out your withdrawable balance to your eSewa account.</p>
    </div>
  </div>

  <div class="withdraw-hero">
    <div class="withdraw-main-card">
      <div class="wm-label">${icon('coins')} Withdrawable balance</div>
      <div class="wm-value num" id="wd-available">…</div>
      <div class="wm-note" id="wd-available-note">Loading your wallet…</div>
      <div class="wm-actions">
        <button class="btn btn-gold" id="open-form">${icon('bank')} Withdraw to eSewa</button>
      </div>
    </div>
    <div class="hold-summary">
      <div class="card stat-card hs-card">
        <span class="stat-label">${icon('clock')} Hold balance</span>
        <span class="stat-value num" id="wd-hold">…</span>
        <span class="stat-note" id="wd-hold-note">Funds locked during the hold period</span>
      </div>
      <div class="card hs-card" style="padding:14px 18px">
        <div style="font-weight:700; font-size:13.5px; margin-bottom:6px">Next release</div>
        <div class="small muted" id="wd-next-release">—</div>
      </div>
    </div>
  </div>

  <div class="withdraw-note">
    ${icon('info')}
    <span>Only your <strong>withdrawable balance</strong> can be withdrawn. Funds currently on hold cannot be used for withdrawals — they become available automatically after the hold period ends.</span>
  </div>

  <div class="card" id="withdraw-form-card" hidden>
    <div class="card-head"><h3>Withdrawal request</h3></div>
    <div class="card-pad">
      <form id="withdraw-form" novalidate>
        <div class="field">
          <label class="label" for="esewa-name">eSewa account name <span class="req">*</span></label>
          <input class="input" id="esewa-name" placeholder="Name registered on eSewa" autocomplete="name">
        </div>
        <div class="field">
          <label class="label" for="esewa-number">eSewa number <span class="req">*</span></label>
          <div class="input-affix">
            <span class="affix">+977</span>
            <input class="input" id="esewa-number" inputmode="numeric" placeholder="98XXXXXXXX">
          </div>
          <p class="hint">Withdrawals are only sent to eSewa accounts in your own name.</p>
        </div>
        <div class="field">
          <label class="label" for="amount">Amount (NPR) <span class="req">*</span></label>
          <input class="input" id="amount" type="number" inputmode="numeric" min="1" step="1" placeholder="e.g. 500">
          <p class="hint" id="amount-hint">Minimum withdrawal: …</p>
        </div>
        <div class="field">
          <label class="label" for="pin">Security PIN <span class="req">*</span></label>
          <div class="pin-row secure">
            <input class="pin-box" type="text" inputmode="numeric" maxlength="1" aria-label="PIN digit 1">
            <input class="pin-box" type="text" inputmode="numeric" maxlength="1" aria-label="PIN digit 2">
            <input class="pin-box" type="text" inputmode="numeric" maxlength="1" aria-label="PIN digit 3">
            <input class="pin-box" type="text" inputmode="numeric" maxlength="1" aria-label="PIN digit 4">
          </div>
        </div>
        <p class="hint error" id="wd-error" hidden></p>
        <button class="btn btn-primary btn-lg btn-block" type="submit" id="wd-continue">Review withdrawal</button>
      </form>
    </div>
  </div>

  <div class="card" style="margin-top:20px">
    <div class="card-head"><div><h3>Withdrawal history</h3><div class="sub">All your eSewa withdrawal requests</div></div></div>
    <div id="withdrawal-history">${skeletonRows(3, 52)}</div>
  </div>`;

// wallet + config live data
watchPlatformConfig((c) => {
  config = c;
  content.querySelector('#amount-hint').textContent =
    `Minimum withdrawal: ${fmtNPR(config.minWithdrawalPaisa)}. One withdrawal can be processed at a time.`;
});
let pendingLock = false;
async function refreshLock() {
  try {
    const lock = await getDoc(doc(db, 'activeWithdrawals', user.uid));
    pendingLock = lock.exists();
  } catch (_) { pendingLock = false; }
  updateFormAvailability();
}
async function refreshSummary() {
  const summary = await fetchWalletSummary(user.uid);
  wallet = summary;
  content.querySelector('#wd-available').textContent = fmtNPR(summary.withdrawablePaisa);
  content.querySelector('#wd-available-note').textContent = pendingLock
    ? 'You already have a withdrawal being processed.'
    : (summary.maturedPaisa > 0
        ? `Includes ${fmtNPR(summary.maturedPaisa)} that has finished its hold period.`
        : 'Ready for eSewa withdrawal.');
  content.querySelector('#wd-hold').textContent = fmtNPR(summary.holdUnmaturedPaisa);
  content.querySelector('#wd-hold-note').textContent =
    summary.holdUnmaturedPaisa > 0 ? `Releases automatically after the ${config.holdDays}-day hold` : 'Nothing on hold right now';

  const next = content.querySelector('#wd-next-release');
  if (summary.nextReleaseAt) {
    next.innerHTML = `<strong class="num">${esc(fmtNPR(summary.holdUnmaturedPaisa))}</strong> available in <strong>${esc(countdownUntil(summary.nextReleaseAt))}</strong><br>
      <span class="small muted">${esc(fmtDateTime(summary.nextReleaseAt))}</span>`;
  } else {
    next.textContent = summary.holdUnmaturedPaisa > 0 ? 'Calculating…' : 'No funds are on hold.';
  }
  updateFormAvailability();
}
function updateFormAvailability() {
  const canWithdraw = wallet && (wallet.withdrawablePaisa || 0) >= config.minWithdrawalPaisa && !pendingLock;
  content.querySelector('#open-form').disabled = !canWithdraw;
  content.querySelector('#open-form').title = canWithdraw ? '' :
    (pendingLock ? 'You already have a withdrawal being processed.' : `You need at least ${fmtNPR(config.minWithdrawalPaisa)} to withdraw.`);
}
watchWallet(user.uid, () => { refreshSummary(); refreshLock(); });
refreshLock();
refreshSummary();

content.querySelector('#open-form').addEventListener('click', () => {
  const card = content.querySelector('#withdraw-form-card');
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  content.querySelector('#esewa-name').focus();
});

// PIN box behaviour
const pinBoxes = Array.from(content.querySelectorAll('.pin-row .pin-box'));
pinBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(-1);
    if (box.value && i < pinBoxes.length - 1) pinBoxes[i + 1].focus();
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !box.value && i > 0) pinBoxes[i - 1].focus(); });
});

// ── Review + confirm flow ──
content.querySelector('#withdraw-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = content.querySelector('#wd-error');
  errEl.hidden = true;
  const name = content.querySelector('#esewa-name').value.trim().replace(/\s+/g, ' ');
  const number = content.querySelector('#esewa-number').value.replace(/[\s-]/g, '');
  const npr = Number(content.querySelector('#amount').value);
  const pin = pinBoxes.map((b) => b.value).join('');

  if (name.length < 3) { errEl.textContent = 'Please enter the account name registered on eSewa.'; errEl.hidden = false; return; }
  if (!isNepaliPhone(number)) { errEl.textContent = 'Please enter a valid eSewa mobile number, e.g. 98XXXXXXXX.'; errEl.hidden = false; return; }
  if (!npr || npr <= 0) { errEl.textContent = 'Please enter a valid withdrawal amount.'; errEl.hidden = false; return; }
  const amountPaisa = toPaisa(npr);
  if (amountPaisa < config.minWithdrawalPaisa) { errEl.textContent = `The minimum withdrawal is ${fmtNPR(config.minWithdrawalPaisa)}.`; errEl.hidden = false; return; }
  if (wallet && amountPaisa > (wallet.withdrawablePaisa || 0)) { errEl.textContent = 'That amount exceeds your withdrawable balance. Funds still on hold cannot be withdrawn.'; errEl.hidden = false; return; }
  if (!isPin4(pin)) { errEl.textContent = 'Please enter your 4-digit security PIN.'; errEl.hidden = false; return; }

  const m = modal({
    title: 'Confirm withdrawal',
    width: 460,
    body: `
      <div class="summary-box">
        <div class="sum-row"><span class="k">Withdrawal amount</span><span class="v num">${esc(fmtNPR(amountPaisa))}</span></div>
        <div class="sum-row"><span class="k">eSewa name</span><span class="v">${esc(name)}</span></div>
        <div class="sum-row"><span class="k">eSewa number</span><span class="v num">+977 ${esc(number)}</span></div>
        <div class="sum-row"><span class="k">Processing</span><span class="v">Pending admin verification</span></div>
      </div>
      <p class="muted small">Make sure your eSewa details are correct. A rejected withdrawal returns the amount to your balance, but processing takes time.</p>`,
    actions: `
      <button class="btn ghost" data-act="cancel">Back</button>
      <button class="btn primary" data-act="confirm">${icon('check')} Confirm Withdrawal</button>`
  });
  m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.root.querySelector('[data-act="confirm"]').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btnBusy(btn, true, 'Submitting…');
    try {
      await requestWithdrawal({ amountPaisa, esewaName: name, esewaNumber: number, pin });
      m.close();
      showSuccess(amountPaisa);
      const amt = fmtNPR(amountPaisa);
    } catch (err) {
      btnBusy(btn, false);
      errEl.textContent = err.message || 'Withdrawal failed. Please try again.';
      errEl.hidden = false;
      m.close();
    }
  });
});

function showSuccess(amountPaisa) {
  const card = content.querySelector('#withdraw-form-card');
  card.innerHTML = `
    <div class="success-panel">
      <div class="sp-ic">${icon('check')}</div>
      <h2 style="margin-bottom:6px">Withdrawal submitted</h2>
      <p class="muted">${esc(fmtNPR(amountPaisa))} has been reserved from your balance and is now <strong>pending admin verification</strong>. You'll be notified when it's processed.</p>
      <button class="btn ghost" id="wd-again">Make another request</button>
    </div>`;
  card.hidden = false;
  card.querySelector('#wd-again').addEventListener('click', () => location.reload());
  loadHistory();
}

// ── History ──
async function loadHistory() {
  const el = content.querySelector('#withdrawal-history');
  try {
    const snap = await getDocs(query(
      collection(db, 'withdrawals'),
      where('userId', '==', user.uid),
      orderBy('requestedAt', 'desc'),
      limit(25)
    ));
    if (snap.empty) {
      el.innerHTML = emptyState({ icon: 'bank', title: 'No withdrawals yet', message: 'Your eSewa withdrawal requests will appear here.' });
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Amount</th><th>eSewa</th><th>Status</th></tr></thead>
      <tbody>${snap.docs.map((d) => {
        const w = d.data();
        const st = WITHDRAWAL_STATUS[w.status] || { label: w.status, tone: 'gray' };
        return `<tr data-wid="${esc(d.id)}" style="cursor:pointer">
          <td class="num">${esc(fmtDateTime(w.requestedAt))}</td>
          <td class="cell-strong num">${esc(fmtNPR(w.amountPaisa))}</td>
          <td><div>${esc(w.esewaName)}</div><div class="small muted num">+977 ${esc(w.esewaNumber)}</div></td>
          <td>${badge(st.label, st.tone, { dot: true })}${w.reason ? `<div class="small muted" style="margin-top:4px">${esc(w.reason)}</div>` : ''}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
    el.querySelectorAll('tr[data-wid]').forEach((tr) =>
      tr.addEventListener('click', () => {
        const d = snap.docs.find((x) => x.id === tr.dataset.wid);
        if (d) trackerModal(d.data());
      }));
  } catch (_) {
    el.innerHTML = emptyState({ icon: 'alert', title: 'Could not load history', message: 'Please refresh the page.' });
  }
}
loadHistory();


// ── Withdrawal status tracker ──
function trackerModal(w) {
  const st = WITHDRAWAL_STATUS[w.status] || { label: w.status, tone: 'gray' };
  const s = w.status;
  const steps = [
    { label: 'Requested', date: w.requestedAt, state: 'done', note: 'Your request was received with your eSewa details and PIN confirmation.' },
    { label: 'Under review', date: null, state: ['under_review', 'approved', 'processing', 'completed'].includes(s) ? 'done' : (s === 'pending' ? 'current' : 'pending'), note: 'An administrator checks your request.' },
    { label: 'Approved', date: null, state: ['approved', 'processing', 'completed'].includes(s) ? 'done' : (s === 'under_review' ? 'current' : 'pending') },
    { label: 'Processing', date: null, state: ['processing', 'completed'].includes(s) ? 'done' : (s === 'approved' ? 'current' : 'pending'), note: 'The eSewa transfer is being sent.' },
    { label: 'Completed', date: s === 'completed' ? w.reviewedAt : null, state: s === 'completed' ? 'done' : (s === 'processing' ? 'current' : 'pending') }
  ];
  const rejected = s === 'rejected';
  const m = modal({
    title: 'Withdrawal tracker',
    width: 480,
    body: `
      <div class="summary-box" style="margin-bottom:16px">
        <div class="sum-row"><span class="k">Amount</span><span class="v num">${esc(fmtNPR(w.amountPaisa))}</span></div>
        <div class="sum-row"><span class="k">eSewa</span><span class="v">${esc(w.esewaName)} · <span class="num">+977 ${esc(w.esewaNumber)}</span></span></div>
        <div class="sum-row"><span class="k">Requested</span><span class="v small">${esc(fmtDateTime(w.requestedAt))}</span></div>
        <div class="sum-row"><span class="k">Status</span><span class="v">${badge(st.label, st.tone, { dot: true })}</span></div>
        <div class="sum-row"><span class="k">Reference ID</span><span class="v small num">${esc(w.txId || '(issued on completion)')}</span></div>
      </div>
      ${rejected ? `
      <div class="wtracker" style="margin-bottom:4px">
        <div class="wstep done">
          <div class="wstep-dot">${icon('check')}</div>
          <div class="wstep-body"><div class="wstep-title">Requested</div><div class="wstep-date">${esc(fmtDateTime(w.requestedAt))}</div></div>
        </div>
        <div class="wstep rejected">
          <div class="wstep-dot">${icon('x')}</div>
          <div class="wstep-body">
            <div class="wstep-title" style="color:var(--red-600)">Rejected</div>
            ${w.reviewedAt ? `<div class="wstep-date">${esc(fmtDateTime(w.reviewedAt))}</div>` : ''}
            <div class="wstep-note">${esc(w.reason || 'Contact support for details.')}<br><strong>Your balance was never debited for this request.</strong></div>
          </div>
        </div>
      </div>` : `
      <div class="wtracker">
        ${steps.map((step) => `
          <div class="wstep ${step.state}">
            <div class="wstep-dot">${step.state === 'done' ? icon('check') : step.state === 'current' ? icon('clock') : icon('chevRight')}</div>
            <div class="wstep-body">
              <div class="wstep-title">${esc(step.label)}</div>
              ${step.date ? `<div class="wstep-date">${esc(fmtDateTime(step.date))}</div>` : ''}
              ${step.note ? `<div class="wstep-note">${esc(step.note)}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>`}
      <p class="hint" style="margin-top:14px">Tap any row in your withdrawal history to reopen this tracker. Status changes also arrive as notifications.</p>`,
    actions: '<button class="btn primary" data-act="close">Close</button>'
  });
  m.root.querySelector('[data-act="close"]').addEventListener('click', () => m.close());
}
