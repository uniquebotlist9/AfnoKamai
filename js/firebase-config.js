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

export function isConfigured() {
  return !String(firebaseConfig.apiKey).startsWith('PASTE_');
}
