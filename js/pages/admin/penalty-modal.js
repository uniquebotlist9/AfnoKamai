// ─── Admin: shared penalty modal (users drawer + penalties page) ─────
// Kept separate so importing it doesn't execute an entire page module.
import { fmtNPR } from '../../utils.js';
import { modal, confirmDialog, btnBusy, toast } from '../../ui.js';
import { applyPenalty } from '../../admin-actions.js';

export function penaltyModal(u, closeDrawer) {
  const m = modal({
    title: `Apply penalty — ${u.fullName}`,
    width: 460,
    body: `
      <div class="field">
        <label class="label">Penalty amount (NPR) <span class="req">*</span></label>
        <input class="input" type="number" id="pen-amt" min="1" step="1" placeholder="e.g. 20">
        <p class="hint">Deducted from withdrawable balance first, then hold. Cannot make balances negative.</p>
      </div>
      <div class="field">
        <label class="label">Reason <span class="req">*</span></label>
        <textarea class="textarea" id="pen-reason" placeholder="e.g. Duplicate task submission."></textarea>
      </div>
      <p class="hint error" id="pen-err" hidden></p>`,
    actions: `
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn danger" data-act="apply">Apply penalty</button>`
  });
  m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.root.querySelector('[data-act="apply"]').addEventListener('click', async (ev) => {
    const amt = Number(m.root.querySelector('#pen-amt').value);
    const reason = m.root.querySelector('#pen-reason').value.trim();
    const errEl = m.root.querySelector('#pen-err');
    errEl.hidden = true;
    if (!amt || amt <= 0) { errEl.textContent = 'Enter a valid penalty amount.'; errEl.hidden = false; return; }
    if (reason.length < 5) { errEl.textContent = 'A clear reason is required.'; errEl.hidden = false; return; }
    const ok = await confirmDialog({
      title: 'Confirm penalty',
      message: `${fmtNPR(Math.round(amt * 100))} will be deducted from ${u.fullName}'s balance. The user will be notified with your reason.`,
      confirmText: 'Apply penalty', danger: true
    });
    if (!ok) return;
    const btn = ev.currentTarget;
    btnBusy(btn, true, 'Applying…');
    try {
      await applyPenalty({ userId: u.id, amountPaisa: Math.round(amt * 100), reason });
      m.close(); closeDrawer && closeDrawer();
      toast('Penalty applied and user notified.', { type: 'success' });
    } catch (err) { btnBusy(btn, false); errEl.textContent = err.message; errEl.hidden = false; }
  });
}
