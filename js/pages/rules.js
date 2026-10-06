// ─── Task Rules page (categorized, severity-highlighted) ─────────────
import { db } from '../firebase.js';
import { doc, getDoc } from 'firebase/firestore';
import { mountShell } from '../shell.js';
import { esc, rich, fmtNPR, fmtDateTime } from '../utils.js';
import { icon } from '../icons.js';
import { emptyState, skeletonRows } from '../ui.js';

let { content } = await mountShell('rules');
document.getElementById('page-skeleton')?.remove();

// Fallback rules, grouped. The admin can replace the raw list from
// Settings → Task rules; this page groups whatever is configured.
const DEFAULT_RULES = [
  // [group, icon, severity, title, subtitle, rules[]]
  ['Core conduct', 'check', '', 'Work honestly and follow instructions', 'These keep your rewards safe', [
    'Complete tasks <strong>exactly according to the provided instructions</strong>.',
    'Do not modify task-provided information without authorization.',
    'Do not submit <strong>duplicate work</strong> — one submission per assigned task.',
    'Ask the administrator for clarification in chat <strong>before submitting</strong> whenever instructions are unclear.'
  ]],
  ['Honest evidence', 'paperclip', 'warn', 'Your evidence must be real', 'Fake proof = penalties', [
    'Do not submit <strong>false completion claims</strong>.',
    'Do not <strong>manipulate screenshots or any other evidence</strong>.',
    'For evidence tasks, attach the actual screenshot/photo in chat and describe it when submitting.'
  ]],
  ['Privacy & fairness', 'shield', '', 'Keep the platform fair for everyone', '', [
    'Do not share <strong>confidential task information</strong> with other users.',
    'Do not create <strong>multiple accounts</strong> to abuse rewards.',
    'Do not use tasks for unauthorized personal purposes.'
  ]],
  ['Prohibited activity', 'ban', 'danger', 'Zero tolerance', 'Leads to permanent bans', [
    'Do not use <strong>bots, automation or scripts</strong> to fake or speed up task completion.',
    'Do not attempt to <strong>bypass platform security</strong> in any way.',
    'Do not change passwords or security information of any account <strong>unless the task explicitly permits it</strong>.',
    'Follow all third-party service rules — <strong>never perform a task that violates another service\'s terms or policies</strong>.'
  ]],
  ['Enforcement', 'alert', 'danger', 'What happens on violations', '', [
    '<strong>Fraud, abuse, manipulation or repeated violations</strong> can result in rejection, penalties, suspension, or a <strong>permanent ban</strong>.',
    'Penalties always carry a written reason and are permanently recorded on your account.',
    'Banned accounts cannot request tasks, submit work or withdraw funds.'
  ]]
];

// Position of the withdrawals group: after "Prohibited activity", before "Enforcement".
const WITHDRAWAL_POS = 4;
const MIN_WITHDRAWAL_PAISA = 50000; // रु 500 — same fallback the withdraw page uses

// Strict withdrawal rules. The minimum is read from config/platform so this
// line always matches the limit the withdraw form actually enforces.
const withdrawalGroup = (minPaisa) => ['Withdrawals', 'rupee', 'warn', 'Withdraw within the platform limits', 'Strict rules', [
  `Every withdrawal must be <strong>at least ${fmtNPR(minPaisa)}</strong> — this is a strict minimum and requests below it are rejected automatically.`,
  'Only <strong>withdrawable</strong> funds (rewards whose hold period has finished) count toward that minimum.',
  'Only one withdrawal request can be in progress at a time — wait for it to finish before requesting another.',
  'Requests must be sent from <strong>your own eSewa account</strong> with your correct security PIN.'
]];

const buildGroups = (minPaisa) => [
  ...DEFAULT_RULES.slice(0, WITHDRAWAL_POS),
  withdrawalGroup(minPaisa),
  ...DEFAULT_RULES.slice(WITHDRAWAL_POS)
];

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Task Rules</h1>
      <p class="sub">Read these carefully before requesting tasks — they keep the platform fair and safe for everyone.</p>
    </div>
    <div class="page-head-actions">
      <a class="btn ghost" href="support.html">${icon('lifebuoy')} Ask support</a>
    </div>
  </div>
  <div id="rules-container">${skeletonRows(3, 90)}</div>
  <div class="rules-meta" id="rules-meta">
    <span class="chip">${icon('info')} Administrators can update these rules at any time</span>
    <span class="chip" id="rules-updated" hidden></span>
  </div>
  <div class="withdraw-note" style="margin-top:14px">
    ${icon('info')}
    <span>Unsure whether something is allowed? Open <a href="support.html">Support</a> and ask <strong>before</strong> submitting your work — clarifying first protects your rewards.</span>
  </div>`;

(async () => {
  const container = content.querySelector('#rules-container');

  // Minimum withdrawal lives in config/platform (default रु 500).
  let minWithdrawalPaisa = MIN_WITHDRAWAL_PAISA;
  try {
    const snap = await getDoc(doc(db, 'config', 'platform'));
    const p = snap.data();
    if (p && Number.isFinite(p.minWithdrawalPaisa) && p.minWithdrawalPaisa > 0) minWithdrawalPaisa = p.minWithdrawalPaisa;
  } catch (_) { /* default is fine */ }

  let groups = buildGroups(minWithdrawalPaisa);
  try {
    const snap = await getDoc(doc(db, 'config', 'taskRules'));
    const d = snap.data();
    if (snap.exists() && Array.isArray(d.items) && d.items.length) {
      // Admin-defined flat list → render as one "Platform rules" group,
      // keeping the categorized defaults below it.
      groups = [
        ['Platform rules (set by admin)', 'scroll', '', 'Current official rules', '', d.items],
        ...buildGroups(minWithdrawalPaisa)
      ];
    }
    if (d && d.updatedAt) {
      const chip = content.querySelector('#rules-updated');
      chip.hidden = false;
      chip.innerHTML = `${icon('refresh')} Last updated ${esc(fmtDateTime(d.updatedAt))}`;
    }
  } catch (_) { /* defaults are fine */ }

  container.innerHTML = groups.map(([title, ic, severity, heading, sub, rules]) => `
    <section class="rule-group ${severity ? `severity-${severity}` : ''}">
      <div class="rule-group-head">
        <span class="rg-ic">${icon(ic)}</span>
        <div>
          <h3>${esc(title)}</h3>
          ${heading ? `<div class="rg-sub">${esc(heading)}${sub ? ' · ' + esc(sub) : ''}</div>` : ''}
        </div>
      </div>
      <ul class="rule-list">
        ${rules.map((r) => `<li><span>${rich(r)}</span></li>`).join('')}
      </ul>
    </section>`).join('');
})();
