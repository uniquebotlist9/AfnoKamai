// ─── Admin: maintenance mode control ─────────────────────────────────
import { db } from '../../firebase.js';
import { doc, getDoc, setDoc, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=2';
import { esc, fmtDateTime } from '../../utils.js';
import { icon } from '../../icons.js';
import { confirmDialog, btnBusy, toast, badge } from '../../ui.js';

let { content } = await mountAdminShell('maintenance');
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Maintenance mode</h1>
      <p class="sub">While enabled, normal users see a maintenance page. Administrators keep full access.</p>
    </div>
    <div id="maint-status"></div>
  </div>

  <div class="card maint-hero" style="margin-bottom:18px">
    <div style="display:flex; justify-content:center; margin-bottom:14px" id="maint-icon"></div>
    <h2 id="maint-preview-title">AfnoKamai is currently undergoing scheduled maintenance.</h2>
    <p class="muted" id="maint-preview-msg">We expect services to return shortly. Thank you for your patience.</p>
    <p class="small muted" id="maint-preview-end" hidden></p>
    <p class="hint" style="margin-top:14px">This is a live preview of what users will see.</p>
  </div>

  <div class="card card-pad" style="max-width:640px">
    <form id="maint-form">
      <div style="display:flex; align-items:center; gap:14px; padding:6px 0 18px">
        <label class="switch">
          <input type="checkbox" id="m-enabled">
          <span class="slider"></span>
        </label>
        <div>
          <div style="font-weight:700" id="m-state-label">Maintenance mode is off</div>
          <div class="small muted">The state is stored in Firebase and applies to every user instantly.</div>
        </div>
      </div>
      <div class="field">
        <label class="label" for="m-title">Maintenance title</label>
        <input class="input" id="m-title" placeholder="AfnoKamai is currently undergoing scheduled maintenance.">
      </div>
      <div class="field">
        <label class="label" for="m-msg">Message</label>
        <textarea class="textarea" id="m-msg" placeholder="We expect services to return shortly. Thank you for your patience."></textarea>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
        <div class="field">
          <label class="label" for="m-start">Start time (optional)</label>
          <input class="input" type="datetime-local" id="m-start">
        </div>
        <div class="field">
          <label class="label" for="m-end">Expected end time (optional)</label>
          <input class="input" type="datetime-local" id="m-end">
        </div>
      </div>
      <button class="btn primary btn-lg" type="submit" id="m-save">${icon('check')} Save maintenance settings</button>
    </form>
  </div>`;

content.querySelector('#maint-icon').innerHTML = icon('wrench');

function loadIntoForm(m) {
  content.querySelector('#m-enabled').checked = !!(m && m.enabled);
  content.querySelector('#m-title').value = m?.title || '';
  content.querySelector('#m-msg').value = m?.message || '';
  const toLocal = (ts) => {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  content.querySelector('#m-start').value = toLocal(m?.startedAt);
  content.querySelector('#m-end').value = toLocal(m?.expectedEndAt);
  content.querySelector('#m-state-label').textContent = m?.enabled ? 'Maintenance mode is ON — users see the maintenance page' : 'Maintenance mode is off';
  content.querySelector('#maint-status').innerHTML = m?.enabled
    ? badge('Maintenance active', 'red', { dot: true })
    : badge('All systems normal', 'green', { dot: true });
  content.querySelector('#maint-preview-title').textContent = m?.title || 'AfnoKamai is currently undergoing scheduled maintenance.';
  content.querySelector('#maint-preview-msg').textContent = m?.message || 'We expect services to return shortly. Thank you for your patience.';
  const endEl = content.querySelector('#maint-preview-end');
  if (m?.expectedEndAt) { endEl.hidden = false; endEl.textContent = `Expected to return: ${fmtDateTime(m.expectedEndAt)}`; }
  else endEl.hidden = true;
}

onSnapshot(doc(db, 'config', 'maintenance'), (snap) => loadIntoForm(snap.data()), () => {});

content.querySelector('#maint-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const enabled = content.querySelector('#m-enabled').checked;
  if (enabled) {
    const ok = await confirmDialog({
      title: 'Enable maintenance mode?',
      message: 'All normal users will be redirected to the maintenance page immediately. Administrators keep access.',
      confirmText: 'Enable maintenance',
      danger: true
    });
    if (!ok) return;
  }
  const btn = content.querySelector('#m-save');
  btnBusy(btn, true, 'Saving…');
  const toTs = (v) => v ? new Date(v) : null;
  try {
    await setDoc(doc(db, 'config', 'maintenance'), {
      enabled,
      title: content.querySelector('#m-title').value.trim(),
      message: content.querySelector('#m-msg').value.trim(),
      startedAt: toTs(content.querySelector('#m-start').value),
      expectedEndAt: toTs(content.querySelector('#m-end').value),
      updatedAt: serverTimestamp()
    }, { merge: true });
    toast(enabled ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.', { type: 'success' });
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
  btnBusy(btn, false);
});
