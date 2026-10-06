// ─── Email verification page ─────────────────────────────────────────
import { auth, db, isConfigured } from '../firebase.js';
import { sendEmailVerification, signOut } from 'firebase/auth';
import { doc, updateDoc } from 'firebase/firestore';
import { ensureConfigured, destinationFor, fetchProfile, doLogout } from '../guard.js';
import { esc } from '../utils.js';
import { toast } from '../ui.js';
import { icon } from '../icons.js';

if (isConfigured()) {
  const statusEl = document.getElementById('verify-status');
  const emailPill = document.getElementById('email-pill');
  const checkBtn = document.getElementById('check-btn');
  const resendBtn = document.getElementById('resend-btn');
  const resendNote = document.getElementById('resend-note');
  const RESEND_COOLDOWN = 60;

  document.getElementById('mail-ic').innerHTML = icon('bell');

  let user = null;
  let pollTimer = null;
  let routed = false;

  // Auth's `emailVerified` is the authority, but the Firestore users doc starts
  // as `false` and nothing ever wrote it back — so the admin panel showed
  // "Email verified: No" forever. Mirror it once, guarded so a repeat call or a
  // permissions failure can never break the verification flow.
  let synced = false;
  function syncVerifiedFlag(u) {
    if (synced || !u || !u.emailVerified || !db) return;
    synced = true;
    updateDoc(doc(db, 'users', u.uid), { emailVerified: true })
      .catch(() => { synced = false; }); // retried on the next successful check
  }

  function setStatus(html, cls = '') {
    statusEl.className = `verify-status ${cls}`;
    statusEl.innerHTML = html;
  }

  function route(user, profile) {
    if (routed) return;
    routed = true;
    clearTimeout(pollTimer);
    const target = destinationFor(user, profile);
    if (target === '/verify-email.html') {
      routed = false; // already here
      setStatus(`${icon('check')} Email verified!`, 'ok');
      location.replace('/profile-setup.html');
      return;
    }
    location.replace(target);
  }

  async function checkNow() {
    if (!auth.currentUser) return;
    try {
      await auth.currentUser.reload();
      if (auth.currentUser.emailVerified) {
        syncVerifiedFlag(auth.currentUser);
        setStatus(`<span class="spin"></span><span>Verified! Taking you to the next step…</span>`);
        const profile = await fetchProfile(auth.currentUser.uid);
        route(auth.currentUser, profile);
        return true;
      }
      setStatus(`${icon('clock')} Waiting for verification… We check automatically every few seconds.`);
      return false;
    } catch (_) {
      setStatus(`${icon('alert')} Couldn't check status right now. Retrying…`);
      return false;
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(checkNow, 5000);
  }

  function setResendCountdown(sec) {
    if (sec <= 0) {
      resendNote.hidden = true;
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend verification email';
      return;
    }
    resendBtn.disabled = true;
    resendNote.hidden = false;
    resendNote.textContent = `You can request another email in ${sec}s.`;
    setTimeout(() => setResendCountdown(sec - 1), 1000);
  }

  onAuthStateChangedProxy();

  async function onAuthStateChangedProxy() {
    const { onAuth } = await import('../guard.js');
    onAuth(async (u) => {
      if (!u) { location.replace('login.html'); return; }
      user = u;
      emailPill.textContent = u.email;
      if (u.emailVerified) {
        syncVerifiedFlag(u);
        const profile = await fetchProfile(u.uid);
        route(u, profile);
        return;
      }
      await checkNow();
      startPolling();
      setResendCountdown(0);
    });
  }

  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    await checkNow();
    checkBtn.disabled = false;
  });

  resendBtn.addEventListener('click', async () => {
    if (!user) return;
    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending…';
    try {
      await sendEmailVerification(user);
      toast('Verification email sent. Please check your inbox and spam folder.', { type: 'success', title: 'Email sent' });
      setResendCountdown(RESEND_COOLDOWN);
    } catch (err) {
      const msg = String(err && err.code || '').includes('too-many-requests')
        ? 'Too many requests. Please wait a minute before trying again.'
        : 'Could not send the email right now. Please try again shortly.';
      toast(msg, { type: 'error', title: 'Couldn\'t send email' });
      setResendCountdown(20);
    }
  });

  document.getElementById('change-email-btn').addEventListener('click', async () => {
    const { confirmDialog } = await import('../ui.js');
    const ok = await confirmDialog({
      title: 'Use a different email?',
      message: 'You will be logged out and can sign up again with a different email address.',
      confirmText: 'Log out & change',
      danger: false
    });
    if (ok) { try { await signOut(auth); } catch (_) {} location.replace('signup.html'); }
  });

  document.getElementById('logout-btn').addEventListener('click', () => doLogout());
}
