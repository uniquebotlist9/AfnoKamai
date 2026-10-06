// ─── Profile & security settings ─────────────────────────────────────
import { auth } from '../firebase.js';
import {
  EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from 'firebase/auth';
import { mountShell, renderRestriction } from '../shell.js';
import { doLogout } from '../guard.js';
import { esc, fmtDateTime, fmtRelative, isPin4, isWeakPin, passwordStrength } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState, badge, modal, btnBusy, toast, confirmDialog } from '../ui.js';
import { changePin } from '../api.js';

let { user, profile, content } = await mountShell('profile');
if (profile.status === 'banned') {
  document.getElementById('page-skeleton')?.remove();
  renderRestriction(profile);
  throw new Error('restricted');
}
document.getElementById('page-skeleton')?.remove();

const verifiedBadge = user.emailVerified
  ? badge('Email verified', 'green', { dot: true })
  : badge('Not verified', 'red', { dot: true });
// ── Performance + achievements (computed from real stats) ──
const s = profile.stats || {};
const reviewed = (s.approved || 0) + (s.rejected || 0);
const successRate = reviewed ? Math.round(((s.approved || 0) / reviewed) * 100) : 100;
const standing = profile.status === 'banned' ? 'Restricted' : ((s.penaltiesPaisa || 0) >= 3000 ? 'Needs review' : 'Good standing');
const BADGES = [
  { id: 'first', label: 'First Task', icon: 'zap', earned: (s.approved || 0) >= 1 },
  { id: 'ten', label: '10 Tasks', icon: 'target', earned: (s.approved || 0) >= 10 },
  { id: 'fifty', label: '50 Tasks', icon: 'coins', earned: (s.approved || 0) >= 50 },
  { id: 'sharp', label: 'Sharp Eye', icon: 'check', earned: reviewed >= 5 && successRate >= 90 },
  { id: 'trusted', label: 'Trusted Worker', icon: 'shield', earned: (s.approved || 0) >= 25 && successRate >= 85 }
];
const badgesHtml = `<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px">
  ${BADGES.map((b) => `<span class="chip" style="${b.earned ? 'background:var(--green-50); color:var(--green-700); border-color:var(--green-100)' : 'opacity:.45'}">${icon(b.icon)} ${esc(b.label)}</span>`).join('')}
</div>`;

const statusBadge = profile.status === 'banned'
  ? badge('Restricted', 'red', { dot: true })
  : badge('Active', 'green', { dot: true });

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Profile</h1>
      <p class="sub">Your account information and security settings.</p>
    </div>
  </div>

  <div class="profile-grid">
    <div style="display:flex; flex-direction:column; gap:16px">
      <div class="card">
        <div class="card-pad" style="display:flex; gap:16px; align-items:center">
          <span class="avatar lg">${esc((profile.fullName || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase())}</span>
          <div style="flex:1; min-width:0">
            <h3 style="margin-bottom:2px">${esc(profile.fullName)}</h3>
            <div class="small muted">${esc(profile.email)}</div>
            <div style="margin-top:8px; display:flex; gap:7px; flex-wrap:wrap">
              ${verifiedBadge}${statusBadge}
              ${profile.role === 'admin' ? badge('Administrator', 'gold') : ''}
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Account information</h3></div>
        <div class="card-pad" style="padding-top:6px">
          <div class="info-row"><span class="k">Full name</span><span class="v">${esc(profile.fullName)}</span></div>
          <div class="info-row"><span class="k">Email</span><span class="v">${esc(profile.email)}</span></div>
          <div class="info-row"><span class="k">Phone</span><span class="v num">+977 ${esc(profile.phone || '—')}</span></div>
          <div class="info-row"><span class="k">Account created</span><span class="v">${esc(fmtDateTime(profile.createdAt))}</span></div>
          <div class="info-row"><span class="k">Last active</span><span class="v">${esc(fmtRelative(profile.lastActiveAt))}</span></div>
          <div class="info-row"><span class="k">Security PIN</span><span class="v">${profile.pinSetAt ? 'Set ' + esc(fmtDateTime(profile.pinSetAt)) : 'Not set'}</span></div>
        </div>
        <div class="card-pad" style="padding-top:0">
          <p class="hint">Name and phone changes require contacting support so that financial records stay consistent.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>Performance</h3><div class="sub">Based on your reviewed tasks</div></div></div>
        <div class="card-pad" style="padding-top:6px">
          <div class="kv-grid" style="margin-bottom:0">
            <div class="kv-cell"><div class="k">Tasks completed</div><div class="v">${s.approved || 0}</div></div>
            <div class="kv-cell"><div class="k">Tasks rejected</div><div class="v">${s.rejected || 0}</div></div>
            <div class="kv-cell"><div class="k">Task success rate</div><div class="v">${successRate}%</div></div>
            <div class="kv-cell"><div class="k">Account standing</div><div class="v">${standing}</div></div>
          </div>
          ${badgesHtml}
        </div>
      </div>
    </div>

    <div style="display:flex; flex-direction:column; gap:16px">
      <div class="card">
        <div class="card-head"><div><h3>Change password</h3><div class="sub">Requires your current password</div></div></div>
        <div class="card-pad">
          <form id="pw-form" novalidate>
            <div class="field">
              <label class="label" for="pw-current">Current password</label>
              <input class="input" type="password" id="pw-current" autocomplete="current-password">
            </div>
            <div class="field">
              <label class="label" for="pw-new">New password</label>
              <input class="input" type="password" id="pw-new" autocomplete="new-password">
              <p class="hint">At least 8 characters with mixed letters, numbers and symbols.</p>
            </div>
            <p class="hint error" id="pw-error" hidden></p>
            <button class="btn primary" type="submit" id="pw-btn">${icon('lock')} Update password</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>Security PIN</h3><div class="sub">Used to authorize withdrawals</div></div></div>
        <div class="card-pad">
          <p class="small muted" style="margin-bottom:12px">Your PIN is stored only as a secure hash — it cannot be recovered or displayed. Changing it requires your current PIN.</p>
          <button class="btn ghost" id="pin-btn">${icon('edit')} Change security PIN</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>Session</h3><div class="sub">Your active login on this device</div></div></div>
        <div class="card-pad" style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">
          <div class="chip">${icon('check')} Signed in as ${esc(profile.email)}</div>
          <span style="flex:1"></span>
          <button class="btn outline-danger" id="logout-btn">${icon('logout')} Log out</button>
        </div>
        <div class="card-pad" style="padding-top:0">
          <p class="hint">AfnoKamai keeps you signed in on this device only. Logging out clears locally cached financial data.</p>
        </div>
      </div>
    </div>
  </div>`;

// ── password change ──
content.querySelector('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = content.querySelector('#pw-error');
  errEl.hidden = true;
  const current = content.querySelector('#pw-current').value;
  const next = content.querySelector('#pw-new').value;
  if (!current) { errEl.textContent = 'Please enter your current password.'; errEl.hidden = false; return; }
  if (passwordStrength(next) < 2 || next.length < 8) { errEl.textContent = 'Please choose a stronger password (8+ characters, mixed characters).'; errEl.hidden = false; return; }

  const btn = content.querySelector('#pw-btn');
  btnBusy(btn, true, 'Updating…');
  try {
    const cred = EmailAuthProvider.credential(user.email, current);
    await reauthenticateWithCredential(user, cred);
    await updatePassword(user, next);
    toast('Your password has been updated.', { type: 'success', title: 'Password changed' });
    e.target.reset();
  } catch (err) {
    errEl.textContent = err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential'
      ? 'Your current password is incorrect.'
      : (err.message || 'Could not update password. Please try again.');
    errEl.hidden = false;
  }
  btnBusy(btn, false);
});

// ── PIN change ──
content.querySelector('#pin-btn').addEventListener('click', () => {
  const m = modal({
    title: 'Change security PIN',
    width: 440,
    body: `
      <div class="field">
        <label class="label">Your account password (to confirm it's you)</label>
        <input class="input" type="password" id="pin-confirm-pw" autocomplete="current-password">
      </div>
      <div class="field">
        <label class="label">New PIN</label>
        <div class="pin-row secure" id="new-pin">${'<input class="pin-box" type="text" inputmode="numeric" maxlength="1">'.repeat(4)}</div>
      </div>
      <div class="field">
        <label class="label">Confirm new PIN</label>
        <div class="pin-row secure" id="new-pin2">${'<input class="pin-box" type="text" inputmode="numeric" maxlength="1">'.repeat(4)}</div>
      </div>
      <p class="hint error" id="pin-err" hidden></p>`,
    actions: `
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="save">Update PIN</button>`
  });
  m.root.querySelectorAll('.pin-row').forEach(wireRow);
  m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.root.querySelector('[data-act="save"]').addEventListener('click', async (ev) => {
    const val = (id) => Array.from(m.root.querySelectorAll(`#${id} .pin-box`)).map(b => b.value).join('');
    const nw = val('new-pin'), nw2 = val('new-pin2');
    const curPw = m.root.querySelector('#pin-confirm-pw').value;
    const errEl = m.root.querySelector('#pin-err');
    errEl.hidden = true;
    if (!curPw) { errEl.textContent = 'Enter your account password to confirm.'; errEl.hidden = false; return; }
    if (!isPin4(nw)) { errEl.textContent = 'Enter a new 4-digit PIN.'; errEl.hidden = false; return; }
    if (isWeakPin(nw)) { errEl.textContent = 'That PIN is too easy to guess (e.g. 1234 or 1111).'; errEl.hidden = false; return; }
    if (nw !== nw2) { errEl.textContent = 'The new PINs do not match.'; errEl.hidden = false; return; }
    const btn = ev.currentTarget;
    btnBusy(btn, true, 'Verifying…');
    try {
      // The PIN hash is unreadable by design, so we require a fresh
      // Firebase login instead of the current PIN.
      const cred = EmailAuthProvider.credential(user.email, curPw);
      await reauthenticateWithCredential(user, cred);
      btnBusy(btn, true, 'Updating…');
      await changePin({ newPin: nw });
      m.close();
      toast('Your security PIN has been updated.', { type: 'success', title: 'PIN changed' });
    } catch (err) {
      btnBusy(btn, false);
      errEl.textContent = String(err.code).includes('auth/') && String(err.code).includes('credential')
        ? 'Your account password was incorrect.'
        : (err.message || 'Could not change PIN.');
      errEl.hidden = false;
    }
  });
});

function wireRow(row) {
  const boxes = Array.from(row.querySelectorAll('.pin-box'));
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(-1);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus(); });
  });
}

content.querySelector('#logout-btn').addEventListener('click', () => doLogout());
