// ─── AfnoKamai Firebase configuration ────────────────────────────────
// Live project: afnokamai (https://afnokamai.web.app)
// These values are safe to expose publicly (Firebase web keys are not
// secrets; access is controlled by Security Rules + Cloud Functions).
//
// NEVER place Brevo API keys, service-account JSON or any other
// privileged credential in this file.

export const firebaseConfig = {
  apiKey: 'AIzaSyC5HA_uzKb6YkeoKLh45Ap8vpJNlS-oMjU',
  authDomain: 'afnokamai.firebaseapp.com',
  projectId: 'afnokamai',
  storageBucket: 'afnokamai.firebasestorage.app',
  messagingSenderId: '415477728',
  appId: '1:415477728:web:ac8f71ac34fa178a020585',
  measurementId: 'G-9ECK7BK73S'
};

// Must match the region set on Cloud Functions (functions/index.js).
export const FUNCTIONS_REGION = 'asia-south1';

// ─── Web Push (VAPID) ────────────────────────────────────────────────
// PUBLIC half of the VAPID keypair (RFC 8292). Publishing this is
// mandatory — PushManager.subscribe() refuses to run without it, so it is
// not a secret.
//
// The matching PRIVATE key exists only as the GitHub Actions secret
// VAPID_PRIVATE_KEY consumed by scripts/push-sender.cjs. It must never be
// written into this repository, a bundle, or a page. A browser holding it
// could forge pushes to every user.
export const VAPID_PUBLIC_KEY =
  'BAlZc5BOauiuRe1C5-KGq7162RG7W1qtSxxiov7IHXk6CO1dLUY2EoKHpWWEP24OdBS8M6QU4UToWajz7z6qA-U';

// How many devices one account may register at once. Enforced here as a
// soft limit and again by the sender's per-user query cap — a runaway
// script should not be able to attach a thousand endpoints to one account.
export const MAX_PUSH_DEVICES = 8;

export function isConfigured() {
  return !String(firebaseConfig.apiKey).startsWith('PASTE_');
}
