// ─── Route guards: authentication + registration chain ───────────────
// Flow: Login → Signup → Email Verification → Personal Info → PIN → Dashboard
import { auth, db, isConfigured } from './firebase.js';
import {
  onAuthStateChanged, signOut
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { esc } from './utils.js';
import { logo } from './icons.js';


/**
 * Root-absolute route. Every redirect used to be a page-relative string, which
 * meant admin pages (`/admin/…`) resolved `login.html` to `/admin/login.html`
 * — a 404. Anchoring to the site root makes the chain work from any depth.
 */
const R = (page) => `/${page}`;

/**
 * Signal (not an error) for "we are already navigating away".
 *
 * Every page does `let { user, profile, content } = await mountShell(...)` at
 * module top level with no try/catch, so a plain Error thrown here would surface
 * as an unhandled rejection and print a red console error on an otherwise
 * healthy page. This marker is swept up by the listener below, so intentional
 * redirects stay silent while genuine failures still get reported.
 */
export function redirectSignal() {
  const e = new Error('redirect');
  e.name = 'RedirectSignal';
  e.isRedirect = true;
  return e;
}

export function isRedirect(e) {
  return !!e && (e.isRedirect === true || e.message === 'redirect');
}

// Keep the console clean: swallow ONLY our own navigation signal.
//
// Two channels, because a module top-level `await` rejection is reported
// differently from a normal one:
//   • 'unhandledrejection' — covers `promise.catch(...)` and other rejections.
//   • 'error' — a rejected top-level `await` inside a module is reported as an
//     UNCAUGHT EXCEPTION, so preventDefault() on 'unhandledrejection' alone
//     leaves a red console error behind. Caught here too.
window.addEventListener('unhandledrejection', (ev) => {
  if (isRedirect(ev.reason)) ev.preventDefault();
});
window.addEventListener('error', (ev) => {
  if (isRedirect(ev.error)) ev.preventDefault();
});

export function onAuth(cb) {
  if (!isConfigured()) { cb(null); return () => {}; }
  return onAuthStateChanged(auth, cb);
}

export function waitForAuth() {
  return new Promise((resolve) => onAuth(resolve));
}

export async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Decide where an authenticated user belongs in the registration chain. */
export function destinationFor(user, profile) {
  if (!user) return R('login.html');
  if (!user.emailVerified) return R('verify-email.html');
  if (!profile) return R('profile-setup.html');
  if (!profile.profileComplete) return R('profile-setup.html');
  if (!profile.pinSetAt) return R('profile-setup.html#pin');
  return R('dashboard.html');
}

/** For index.html: route whichever way the visitor belongs. */
export async function routeOnBoot({ onStage = () => {} } = {}) {
  onStage('Checking your session…');
  const user = await waitForAuth();
  if (!user) { location.replace(R('login.html')); return; }
  onStage('Loading your account…');
  const profile = await fetchProfile(user.uid);
  location.replace(destinationFor(user, profile));
}

/** For login/signup pages: bounce authenticated users to their destination. */
export async function redirectIfAuthed() {
  const user = await waitForAuth();
  if (!user) return null;
  const profile = await fetchProfile(user.uid);
  location.replace(destinationFor(user, profile));
  return user;
}

/**
 * For authenticated app pages. Enforces the full chain and returns
 * { user, profile }. Throws Redirect signal internally via location.
 */
export async function requireAppAccess() {
  const user = await waitForAuth();
  if (!user) { location.replace(R('login.html')); throw redirectSignal(); }

  let profile = await fetchProfile(user.uid);
  if (!profile) {
    // Auth user exists but Firestore doc missing (interrupted signup) → heal.
    const { ensureUserDocs } = await import('./api.js');
    await ensureUserDocs(user).catch(() => { /* retried on next load */ });
    profile = await fetchProfile(user.uid);
  }
  if (!user.emailVerified) { location.replace(R('verify-email.html')); throw redirectSignal(); }
  if (!profile || !profile.profileComplete || !profile.pinSetAt) {
    location.replace(R('profile-setup.html')); throw redirectSignal();
  }
  return { user, profile };
}

/** Admin pages: require claim + mirror flag. */
export async function requireAdminAccess() {
  const { user, profile } = await requireAppAccess();
  const token = await user.getIdTokenResult();
  const isAdmin = token.claims && token.claims.admin === true;
  if (!isAdmin || profile.role !== 'admin') {
    location.replace(R('index.html'));
    throw redirectSignal();
  }
  return { user, profile };
}

export async function doLogout() {
  try { sessionStorage.clear(); } catch (_) {}
  await signOut(auth);
  // Root-absolute: this is called from /admin/* as well, where a relative
  // "login.html" would 404 on /admin/login.html.
  location.replace(R('login.html'));
}

/** Guard for pages where Firebase has not been configured yet. */
export function ensureConfigured() {
  if (isConfigured()) return true;
  document.body.innerHTML = `
    <div class="setup-screen">
      ${logo({})}
      <h1>Firebase configuration needed</h1>
      <p>This deployment of AfnoKamai is not connected to a Firebase project yet.
         Open <code>js/firebase-config.js</code> and paste the web-app config values
         from your Firebase console (Project settings → Your apps).</p>
      <p class="muted">After configuring, reload this page. Deployment steps are in the project README.</p>
    </div>`;
  return false;
}
