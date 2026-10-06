// ─── Support: availability, FAQ, chat entry ──────────────────────────
import { db } from '../firebase.js';
import { doc, getDoc } from 'firebase/firestore';
import { mountShell } from '../shell.js';
import { esc, fmtRelative, fmtNPR } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState } from '../ui.js';

let { content } = await mountShell('support');
document.getElementById('page-skeleton')?.remove();

const FAQ_GROUPS = [
  ['Account', [
    ['How do I open an AfnoKamai account?', 'Sign up with your email, verify your email address, then complete your profile (full name and Nepali phone number) and set a 4-digit security PIN. You cannot request tasks or withdraw until all steps are done.'],
    ['Can I have more than one account?', 'No. One account per person. Multiple accounts to farm rewards are treated as fraud and lead to penalties or a permanent ban.'],
    ['How do I change my name or phone number?', 'Contact support in the chat. These fields are locked after setup so that your task records and withdrawals stay consistent.']
  ]],
  ['Tasks', [
    ['How do tasks work?', 'Browse available tasks in the Earn page and tap "Request Task". An administrator reviews your request, assigns the task with exact instructions, and you complete it and submit for review. Approved tasks pay the stated reward.'],
    ['What if the instructions are unclear?', 'Ask in the support chat BEFORE submitting. Admins can answer questions and request clarification. Submitting work that does not match the instructions leads to rejection.'],
    ['Why do some tasks require evidence?', 'Evidence (a screenshot or photo sent in chat) proves the work was really done. The task card marks these tasks. Always describe your evidence when submitting.'],
    ['Why was my task rejected?', 'Common reasons: incomplete work, instructions not followed exactly, duplicate work, or evidence that does not match. The exact reason is always shown on your task.']
  ]],
  ['Earnings & Hold', [
    ['What is the hold period?', 'When your task is approved, the reward moves to your hold balance for the hold period (usually 3 days — shown on each reward). It then becomes withdrawable automatically. This protects everyone from fraud and reversals.'],
    ['When exactly does my money release?', 'The release time is written on your reward when it is approved (server timestamp). The countdown on your dashboard is a visual indicator — the recorded time is the authority.'],
    ['What are penalties?', 'Admins can apply penalties for rule violations (e.g. duplicate submissions, false completion claims). Every penalty has a mandatory written reason shown to you, and is permanently recorded.']
  ]],
  ['Withdrawals', [
    ['How do I withdraw?', 'On the Withdraw page, enter your eSewa account name, your eSewa mobile number, the amount, and your security PIN. An administrator verifies and processes the payout. Track progress from your withdrawal history.'],
    ['Why can’t I withdraw my whole balance?', 'Only funds that have finished the hold period are withdrawable. Money still on hold cannot be used for withdrawals.'],
    ['How long does a withdrawal take?', 'Requests are reviewed by administrators. The tracker in your withdrawal history shows each step: Requested → Under review → Approved → Processing → Completed.'],
    ['What happens if my withdrawal is rejected?', 'You see the exact reason in the tracker and in a notification. Your balance was never debited for the request, so nothing is lost.']
  ]],
  ['Security', [
    ['Who can see my security PIN?', 'Nobody — not even AfnoKamai staff. Your PIN is stored only as a salted PBKDF2 hash that you cannot read back. Withdrawal requests carry a proof-of-PIN that administrators verify before paying out.'],
    ['What if someone asks for my password or PIN?', 'Never share them. AfnoKamai never asks for credentials outside the app. Report anyone who does, immediately.'],
    ['What was that security notification?', 'Security events (password change, PIN change, failed PIN attempts, account restriction) always generate a notification. If you did not cause one, contact support immediately.']
  ]],
  ['Rules', [
    ['Where are the full platform rules?', 'Open Task Rules in the sidebar. Read them before requesting your first task — violations can lead to rejection, penalties, suspension, or a permanent ban.'],
    ['Can I use bots or automation?', 'No. Bots, automation, or any manipulation of task completion is prohibited and detectable — it leads to a permanent ban.']
  ]]
];

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Help & Support</h1>
      <p class="sub">Questions about tasks, rewards or withdrawals — we're here to help.</p>
    </div>
    <div class="page-head-actions">
      <a class="btn primary" href="chat.html">${icon('message')} Open chat</a>
    </div>
  </div>

  <div class="grid grid-2" style="margin-bottom:20px">
    <div class="card avail-card">
      <span class="presence-dot away" id="avail-dot"></span>
      <div style="flex:1">
        <div style="font-weight:700">Administrator availability</div>
        <div class="small muted" id="avail-text">Checking…</div>
      </div>
    </div>
    <div class="card avail-card">
      ${icon('shield')}
      <div style="flex:1">
        <div style="font-weight:700">Stay safe</div>
        <div class="small muted">AfnoKamai never asks for your password or PIN outside this app. All official communication happens in this chat.</div>
      </div>
    </div>
  </div>

  ${FAQ_GROUPS.map(([group, items]) => `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>${esc(group)}</h3></div>
      <div>
        ${items.map(([q, a]) => `
          <div class="faq-item">
            <button class="faq-q" aria-expanded="false">${esc(q)} ${icon('chevDown')}</button>
            <div class="faq-a">${esc(a)}</div>
          </div>`).join('')}
      </div>
    </div>`).join('')}`;

content.querySelectorAll('.faq-q').forEach((q) => q.addEventListener('click', () => {
  const item = q.parentElement;
  const open = item.classList.toggle('open');
  q.setAttribute('aria-expanded', open);
}));

(async () => {
  try {
    const snap = await getDoc(doc(db, 'config', 'availability'));
    const a = snap.data() || {};
    const dot = content.querySelector('#avail-dot');
    const text = content.querySelector('#avail-text');
    if (a.state === 'active' && a.updatedAt && (Date.now() - a.updatedAt.toMillis()) < 5 * 60 * 1000) {
      dot.className = 'presence-dot online';
      text.textContent = 'Admin is currently active — chat replies are usually quick.';
    } else if (a.state === 'away') {
      dot.className = 'presence-dot away';
      text.textContent = a.nextAvailableAt
        ? `Admin is away — expected back ${fmtRelative(a.nextAvailableAt)}.`
        : 'Admin is currently away. Leave a message and it will be answered soon.';
    } else if (a.updatedAt) {
      dot.className = 'presence-dot recent';
      text.textContent = `Admin was active ${fmtRelative(a.updatedAt)}.`;
    } else {
      text.textContent = 'Availability information is not set — messages are answered as soon as possible.';
    }
  } catch (_) {
    content.querySelector('#avail-text').textContent = 'Availability information is not set — messages are answered as soon as possible.';
  }
})();
