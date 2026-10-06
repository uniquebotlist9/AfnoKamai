// ─── Admin: platform settings + task rules editor + availability ─────
import { db } from '../../firebase.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=3';
import { esc, toPaisa, fmtNPR } from '../../utils.js';
import { icon } from '../../icons.js';
import { btnBusy, toast, badge, confirmDialog } from '../../ui.js';

let { content } = await mountAdminShell('settings');
document.getElementById('page-skeleton')?.remove();

const DEFAULT_RULES_TEXT = [
  'Complete tasks exactly according to the provided instructions.',
  'Do not submit duplicate work or false completion claims.',
  'Never manipulate screenshots or evidence.',
  'Ask for clarification in chat when instructions are unclear.'
].join('\n');

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Platform settings</h1>
      <p class="sub">Financial parameters, task rules and administrator availability.</p>
    </div>
  </div>

  <div style="display:flex; flex-direction:column; gap:16px; max-width:760px">
    <div class="card">
      <div class="card-head"><div><h3>Financial parameters</h3><div class="sub">Used by backend validation — clients can never bypass these</div></div></div>
      <form id="fin-form" class="card-pad">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px">
          <div class="field">
            <label class="label" for="s-hold">Hold period (days)</label>
            <input class="input" type="number" id="s-hold" min="0" max="30" step="1">
            <p class="hint">Approved rewards stay locked this long before becoming withdrawable.</p>
          </div>
          <div class="field">
            <label class="label" for="s-min">Minimum withdrawal (NPR)</label>
            <input class="input" type="number" id="s-min" min="1" step="1">
            <p class="hint">Withdrawal requests below this are rejected by the backend.</p>
          </div>
        </div>
        <div class="field">
          <label class="label" for="s-email">Support email</label>
          <input class="input" type="email" id="s-email" placeholder="support@yourdomain.com">
        </div>
        <button class="btn primary" type="submit" id="fin-save">${icon('check')} Save financial settings</button>
      </form>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>Task rules page</h3><div class="sub">One rule per line — shown to all users</div></div></div>
      <form id="rules-form" class="card-pad">
        <textarea class="textarea" id="s-rules" style="min-height:220px" spellcheck="false"></textarea>
        <div style="margin-top:12px">
          <button class="btn primary" type="submit" id="rules-save">${icon('check')} Save task rules</button>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>Availability status</h3><div class="sub">Shown to users on the support page and in chat</div></div></div>
      <form id="avail-form" class="card-pad">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px">
          <div class="field">
            <label class="label" for="a-state">Status</label>
            <select class="select" id="a-state">
              <option value="active">Active — currently responding</option>
              <option value="away">Away — not available right now</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="a-next">Expected back (optional, for Away)</label>
            <input class="input" type="datetime-local" id="a-next">
          </div>
        </div>
        <p class="hint">The panel also keeps this status fresh automatically while any admin is online. Users are never falsely shown "active".</p>
        <button class="btn primary" type="submit" id="avail-save">${icon('check')} Update availability</button>
      </form>
    </div>
  </div>`;

// load current values
(async () => {
  try {
    const [plat, rules] = await Promise.all([
      getDoc(doc(db, 'config', 'platform')),
      getDoc(doc(db, 'config', 'taskRules'))
    ]);
    const p = plat.data() || {};
    content.querySelector('#s-hold').value = p.holdDays ?? 3;
    content.querySelector('#s-min').value = p.minWithdrawalPaisa != null ? p.minWithdrawalPaisa / 100 : 500;
    content.querySelector('#s-email').value = p.supportEmail || '';
    const r = rules.data();
    content.querySelector('#s-rules').value = (r && Array.isArray(r.items) && r.items.length) ? r.items.join('\n') : DEFAULT_RULES_TEXT;
  } catch (_) {
    content.querySelector('#s-hold').value = 3;
    content.querySelector('#s-min').value = 500;
    content.querySelector('#s-rules').value = DEFAULT_RULES_TEXT;
  }
})();

content.querySelector('#fin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hold = Number(content.querySelector('#s-hold').value);
  const min = Number(content.querySelector('#s-min').value);
  if (!(hold >= 0 && hold <= 30) || !(min > 0)) { toast('Enter valid values for hold days and minimum withdrawal.', { type: 'error' }); return; }
  const ok = await confirmDialog({
    title: 'Update financial parameters?',
    message: `Hold period: ${hold} day(s) · Minimum withdrawal: ${fmtNPR(toPaisa(min))}. This affects all future rewards and withdrawals.`,
    confirmText: 'Update settings'
  });
  if (!ok) return;
  const btn = content.querySelector('#fin-save');
  btnBusy(btn, true, 'Saving…');
  try {
    await setDoc(doc(db, 'config', 'platform'), {
      holdDays: hold,
      minWithdrawalPaisa: toPaisa(min),
      supportEmail: content.querySelector('#s-email').value.trim(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    toast('Financial settings updated.', { type: 'success' });
  } catch (err) { toast(err.message, { type: 'error' }); }
  btnBusy(btn, false);
});

content.querySelector('#rules-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const items = content.querySelector('#s-rules').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!items.length) { toast('Add at least one rule.', { type: 'error' }); return; }
  const btn = content.querySelector('#rules-save');
  btnBusy(btn, true, 'Saving…');
  try {
    await setDoc(doc(db, 'config', 'taskRules'), { items, updatedAt: serverTimestamp() }, { merge: true });
    toast('Task rules updated.', { type: 'success' });
  } catch (err) { toast(err.message, { type: 'error' }); }
  btnBusy(btn, false);
});

content.querySelector('#avail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const state = content.querySelector('#a-state').value;
  const next = content.querySelector('#a-next').value;
  const btn = content.querySelector('#avail-save');
  btnBusy(btn, true, 'Updating…');
  try {
    await setDoc(doc(db, 'config', 'availability'), {
      state,
      nextAvailableAt: state === 'away' && next ? new Date(next) : null,
      updatedAt: serverTimestamp()
    }, { merge: true });
    toast('Availability updated.', { type: 'success' });
  } catch (err) { toast(err.message, { type: 'error' }); }
  btnBusy(btn, false);
});
