// ─── Signup page ─────────────────────────────────────────────────────
import { auth, isConfigured } from '../firebase.js';
import { createUserWithEmailAndPassword, sendEmailVerification } from 'firebase/auth';
import { ensureConfigured, redirectIfAuthed } from '../guard.js';
import { isEmail, authErrorText, passwordStrength } from '../utils.js';
import { mountAside, mountVisibilityToggle, showFormError, legalModal } from '../auth-common.js';
import { btnBusy } from '../ui.js';


mountAside();
mountVisibilityToggle('password', 'toggle-vis');
mountVisibilityToggle('confirm', 'toggle-vis-2');

if (isConfigured()) {
  redirectIfAuthed();
}

document.getElementById('open-terms').addEventListener('click', (e) => { e.preventDefault(); legalModal('terms'); });
document.getElementById('open-privacy').addEventListener('click', (e) => { e.preventDefault(); legalModal('privacy'); });

const pwEl = document.getElementById('password');
pwEl.addEventListener('input', () => {
  const s = passwordStrength(pwEl.value);
  const el = document.getElementById('strength');
  el.className = `strength s${pwEl.value ? Math.max(s, 1) : 0}`;
});

if (isConfigured()) {
  const errId = 'form-error';
  document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showFormError(errId, '');
    const email = document.getElementById('email').value.trim().toLowerCase();
    const password = pwEl.value;
    const confirm = document.getElementById('confirm').value;
    const terms = document.getElementById('terms').checked;

    if (!isEmail(email)) { showFormError(errId, 'Please enter a valid email address.'); return; }
    if (password.length < 8) { showFormError(errId, 'Your password must be at least 8 characters long.'); return; }
    if (password !== confirm) { showFormError(errId, 'The two passwords do not match.'); return; }
    if (!terms) { showFormError(errId, 'Please accept the Terms of Service and Privacy Policy.'); return; }

    const btn = document.getElementById('signup-btn');
    btnBusy(btn, true, 'Creating account…');
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const { ensureUserDocs } = await import('../api.js');
      await ensureUserDocs(cred.user).catch(() => { /* healed on next load */ });
      try { await sendEmailVerification(cred.user); } catch (_) { /* resend available on next screen */ }
      location.replace('verify-email.html');
    } catch (err) {
      btnBusy(btn, false);
      showFormError(errId, authErrorText(err));
    }
  });
}
