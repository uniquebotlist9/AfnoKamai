// ─── Shared helpers for auth pages ───────────────────────────────────
import { icon, logo } from './icons.js';
import { modal } from './ui.js';

export function mountAside() {
  const brand = document.getElementById('aside-brand');
  if (brand) brand.innerHTML = logo({ light: true, size: 36 });
  const pts = { pt1: 'coins', pt2: 'list', pt3: 'shield' };
  for (const [id, ic] of Object.entries(pts)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = icon(ic);
  }
}

export function mountVisibilityToggle(inputId, btnId) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;
  btn.innerHTML = icon('eye');
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = icon(show ? 'eyeOff' : 'eye');
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
}

export function showFormError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

export function legalModal(kind) {
  const terms = kind === 'terms';
  modal({
    title: terms ? 'Terms of Service' : 'Privacy Policy',
    width: 560,
    body: `<div class="legal-text">${terms ? TERMS_HTML : PRIVACY_HTML}</div>`,
    actions: '<button class="btn primary" data-close>Got it</button>'
  }).root.querySelector('[data-close]').addEventListener('click', (e) => {
    e.target.closest('.modal-overlay').querySelector('.modal-x, .floating')?.click();
  });
}

const TERMS_HTML = `
  <p><em>Draft terms — the platform operator should review with legal counsel before launch.</em></p>
  <h4>1. The service</h4>
  <p>AfnoKamai is a task-and-reward platform where users complete administrator-approved digital tasks in exchange for NPR rewards. Availability of tasks is not guaranteed.</p>
  <h4>2. Your account</h4>
  <ul>
    <li>One account per person. Multiple accounts to farm rewards are prohibited.</li>
    <li>You must provide accurate personal information and keep it current.</li>
    <li>You are responsible for keeping your password and security PIN confidential.</li>
  </ul>
  <h4>3. Tasks and rewards</h4>
  <ul>
    <li>Tasks must be completed exactly as instructed. False completion claims, manipulated evidence, duplicate submissions, or any manipulation of the platform may result in rejection, penalties, suspension or permanent banning.</li>
    <li>Approved rewards enter a hold period before becoming withdrawable. Hold lengths are shown for each reward.</li>
    <li>Never use tasks to violate the terms, policies or security of any third-party service.</li>
  </ul>
  <h4>4. Withdrawals</h4>
  <ul>
    <li>Only withdrawable balance can be withdrawn to your own verified eSewa account.</li>
    <li>Withdrawals are reviewed by administrators before completion. Fraudulent requests are rejected.</li>
  </ul>
  <h4>5. No income guarantee</h4>
  <p>AfnoKamai does not promise any level of income. Rewards depend entirely on the availability and successful completion of tasks.</p>
  <h4>6. Changes</h4>
  <p>We may update these terms; continued use of the platform constitutes acceptance of the updated terms.</p>`;

const PRIVACY_HTML = `
  <p><em>Draft policy — the platform operator should review with legal counsel before launch.</em></p>
  <h4>What we collect</h4>
  <ul>
    <li>Account details: your name, email address and phone number.</li>
    <li>Financial records: task rewards, holds, withdrawals and penalties — kept for audit purposes.</li>
    <li>Communications: messages and media you send through platform chat.</li>
  </ul>
  <h4>How we use it</h4>
  <ul>
    <li>To operate the platform: assigning tasks, verifying completions, processing eSewa withdrawals.</li>
    <li>To secure accounts: verification emails, security PIN checks, fraud prevention.</li>
    <li>To communicate: transactional notifications about your account and rewards.</li>
  </ul>
  <h4>What we never do</h4>
  <ul>
    <li>We never ask for your eSewa password or your AfnoKamai security PIN outside the app.</li>
    <li>We never sell your personal information.</li>
  </ul>
  <h4>Data security</h4>
  <p>Your data is stored on Firebase infrastructure with strict access rules. Financial changes are made exclusively through audited server-side transactions.</p>
  <h4>Your rights</h4>
  <p>You may request correction or deletion of your personal information by contacting support, subject to record-keeping requirements for financial transactions.</p>`;
