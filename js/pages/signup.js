// ─── Signup page ─────────────────────────────────────────────────────
import { auth, isConfigured } from '../firebase.js';
import { createUserWithEmailAndPassword, sendEmailVerification } from 'firebase/auth';
import { ensureConfigured, redirectIfAuthed } from '../guard.js';
import { isEmail, authErrorText, passwordStrength } from '../utils.js';
import { mountAside, mountVisibilityToggle, showFormError, legalModal } from '../auth-common.js';
import { btnBusy } from '../ui.js';
import { normalizeCode, isValidCode, readCapturedCode, storeCapturedCode, storePendingCode } from '../referral.js';


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

// ── Referral code (optional, never blocks signup) ────────────────────
// Prefilled from ?ref= or the code captured on /ref/. Validated live
// against the public referralCodes doc; a rejected or unknown code is
// simply not stored — account creation is never held hostage to it.
const refInput = document.getElementById('referral-code');
const refHint = document.getElementById('ref-code-hint');
const REF_HINT_DEFAULT = refHint ? refHint.textContent : '';
// Tones use the same inline colour pattern as the referral page (no new CSS).
const REF_TONE = { ok: 'var(--green-600)', error: 'var(--red-600)', warn: 'var(--amber-700)' };

function setRefHint(text, tone) {
  if (!refHint) return;
  refHint.textContent = text;
  refHint.style.color = REF_TONE[tone] || '';
  refHint.style.fontWeight = tone ? '600' : '';
}

(function prefillReferral() {
  if (!refInput) return;
  let code = '';
  try {
    const fromUrl = new URLSearchParams(location.search).get('ref') || '';
    code = normalizeCode(fromUrl) || normalizeCode(readCapturedCode());
  } catch (_) { code = normalizeCode(readCapturedCode()); }
  if (code) {
    refInput.value = code;
    storeCapturedCode(code);
  }
})();

async function validateReferralCode() {
  if (!refInput) return;
  const code = normalizeCode(refInput.value);
  refInput.value = code || refInput.value.trim().toUpperCase();
  if (!refInput.value.trim()) { setRefHint(REF_HINT_DEFAULT, ''); return; }
  if (!isValidCode(code)) {
    setRefHint('That code doesn’t look right. It should look like AFK-AB12CD34.', 'error');
    return;
  }
  setRefHint('Checking code…');
  try {
    const { getDoc, doc } = await import('firebase/firestore');
    const { db } = await import('../firebase.js');
    const snap = await getDoc(doc(db, 'referralCodes', code));
    if (!snap.exists()) {
      setRefHint('We couldn’t find that code. You can still create your account.', 'error');
      return;
    }
    storeCapturedCode(code);
    setRefHint('✓ Code applied — your inviter will be credited after you complete setup.', 'ok');
  } catch (_) {
    // Offline / rules unavailable: don't block signup, don't claim success.
    setRefHint('Couldn’t verify the code right now — you can add it later from your profile.', 'warn');
  }
}

if (refInput) {
  let t;
  refInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(validateReferralCode, 450); });
  refInput.addEventListener('blur', validateReferralCode);
  if (refInput.value.trim()) validateReferralCode();
}

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
    // Queue the referral code for the end of onboarding. Invalid codes are
    // dropped here — they never block account creation.
    const refCode = refInput ? normalizeCode(refInput.value) : '';
    storePendingCode(isValidCode(refCode) ? refCode : '');
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
