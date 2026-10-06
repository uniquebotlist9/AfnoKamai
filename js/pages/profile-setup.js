// ─── Profile setup: personal info + security PIN ─────────────────────
import { auth, isConfigured } from '../firebase.js';
import { ensureConfigured, fetchProfile, waitForAuth } from '../guard.js';
import { isValidName, isNepaliPhone, isPin4, isWeakPin } from '../utils.js';
import { showFormError } from '../auth-common.js';
import { btnBusy } from '../ui.js';
import { icon } from '../icons.js';
import { completeProfile, setPin } from '../api.js';

if (isConfigured()) {
  const stepPersonal = document.getElementById('step-personal');
  const stepPin = document.getElementById('step-pin');
  const stepDone = document.getElementById('step-done');

  function setStep(n) {
    stepPersonal.hidden = n !== 1;
    stepPin.hidden = n !== 2;
    stepDone.hidden = n !== 3;
    document.querySelectorAll('.setup-step').forEach((el) => {
      const s = Number(el.dataset.step);
      el.classList.toggle('done', s < n);
      el.classList.toggle('current', s === n);
    });
    window.scrollTo({ top: 0 });
  }
  document.getElementById('done-ic').innerHTML = icon('check');

  // Prefill name if already saved
  (async () => {
    // Wait for Firebase to restore the session before reading the user —
    // a synchronous auth.currentUser read races the IndexedDB restore and
    // bounces freshly logged-in users back to login.html.
    const user = await waitForAuth();
    if (!user) { location.replace('login.html'); return; }
    if (!user.emailVerified) { location.replace('verify-email.html'); return; }
    const profile = await fetchProfile(user.uid);
    if (profile) {
      if (profile.fullName) document.getElementById('fullName').value = profile.fullName;
      if (profile.phone) document.getElementById('phone').value = profile.phone;
    }
    if (profile && profile.profileComplete && profile.pinSetAt) {
      // nothing left to set up
      location.replace('dashboard.html');
      return;
    }
    if (profile && profile.profileComplete) setStep(2); else setStep(1);
  })();

  // ── Step 1: personal info ──
  document.getElementById('personal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showFormError('personal-error', '');
    const fullName = document.getElementById('fullName').value.trim().replace(/\s+/g, ' ');
    const phone = document.getElementById('phone').value.replace(/[\s-]/g, '');
    if (!isValidName(fullName)) { showFormError('personal-error', 'Please enter your full name (letters only, 2–60 characters).'); return; }
    if (!isNepaliPhone(phone)) { showFormError('personal-error', 'Please enter a valid Nepali phone number, e.g. 98XXXXXXXX.'); return; }

    const btn = document.getElementById('personal-btn');
    btnBusy(btn, true, 'Saving…');
    try {
      await completeProfile({ fullName, phone });
      setStep(2);
      document.getElementById('pin1-1').focus();
    } catch (err) {
      showFormError('personal-error', err.message || 'Could not save your details. Please try again.');
    }
    btnBusy(btn, false);
  });

  // ── Step 2: PIN ──
  function pinValue(rowId) {
    return Array.from(document.querySelectorAll(`#${rowId} .pin-box`)).map((b) => b.value).join('');
  }
  function wirePinRow(rowId) {
    const boxes = Array.from(document.querySelectorAll(`#${rowId} .pin-box`));
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(-1);
        if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      });
      box.addEventListener('paste', (e) => {
        e.preventDefault();
        const digits = (e.clipboardData.getData('text').match(/\d/g) || []).slice(0, 4);
        digits.forEach((d, j) => { if (boxes[j]) boxes[j].value = d; });
        boxes[Math.min(digits.length, 3)].focus();
      });
    });
  }
  wirePinRow('pin-row');
  wirePinRow('pin-row-2');

  document.getElementById('pin-back').addEventListener('click', () => setStep(1));

  document.getElementById('pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showFormError('pin-error', '');
    const pin = pinValue('pin-row');
    const confirm = pinValue('pin-row-2');
    if (!isPin4(pin)) { showFormError('pin-error', 'Please enter all 4 digits of your PIN.'); return; }
    if (isWeakPin(pin)) { showFormError('pin-error', 'That PIN is too easy to guess. Avoid repeated digits and sequences like 1234.'); return; }
    if (pin !== confirm) { showFormError('pin-error', 'The two PINs do not match.'); return; }

    const btn = document.getElementById('pin-btn');
    btnBusy(btn, true, 'Securing your account…');
    try {
      const profile = await fetchProfile(auth.currentUser.uid);
      if (!profile || !profile.profileComplete) {
        // personal step not yet persisted — save both steps together
        const fullName = document.getElementById('fullName').value.trim().replace(/\s+/g, ' ');
        const phone = document.getElementById('phone').value.replace(/[\s-]/g, '');
        await completeProfile({ fullName, phone });
      }
      await setPin({ pin });
      setStep(3);
    } catch (err) {
      showFormError('pin-error', err.message || 'Could not set your PIN. Please try again.');
    }
    btnBusy(btn, false);
  });

  document.getElementById('go-dashboard').addEventListener('click', () => {
    location.replace('dashboard.html');
  });

  // Deep link to PIN step when personal info is already complete
  if (location.hash === '#pin') setStep(2);
}
