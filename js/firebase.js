// ─── Firebase initialisation + shared instances ──────────────────────
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';
import { firebaseConfig, isConfigured, FUNCTIONS_REGION } from './firebase-config.js';

let app = null;
let auth = null;
let db = null;
let functions = null;
let analytics = null;

if (isConfigured()) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  functions = getFunctions(app, FUNCTIONS_REGION);
  // Analytics only runs on https/localhost; load it lazily and never block the app.
  import('firebase/analytics')
    .then(async ({ getAnalytics, isSupported }) => {
      if (await isSupported()) analytics = getAnalytics(app);
    })
    .catch(() => {});
}

export { app, auth, db, functions, analytics, isConfigured };
