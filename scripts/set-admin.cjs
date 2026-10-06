#!/usr/bin/env node
// ─── Bootstrap an AfnoKamai administrator ────────────────────────────
// Works on the FREE plan — uses only the Admin SDK from your machine.
//
// One-time setup:
//   cd scripts && npm install
//   # download a service-account key: Firebase console → Project settings →
//   # Service accounts → Generate new private key → save as serviceAccount.json here
//
// Grant admin:
//   node set-admin.mjs admin@example.com
// Revoke:
//   node set-admin.mjs admin@example.com --remove
//
// The user must have signed up once (so the Auth account exists). Sets the
// `admin` custom claim (source of truth for Firestore rules) and mirrors
// role: "admin" on the users document.

const fs = require('fs');
const path = require('path');

const email = process.argv[2];
const remove = process.argv.includes('--remove');
if (!email) {
  console.error('Usage: node set-admin.mjs <email> [--remove]');
  process.exit(1);
}

let serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!serviceAccountPath) {
  const local = path.join(__dirname, 'serviceAccount.json');
  if (fs.existsSync(local)) serviceAccountPath = local;
  else {
    console.error('Save your service-account key as scripts/serviceAccount.json (or set GOOGLE_APPLICATION_CREDENTIALS).');
    process.exit(1);
  }
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
const admin = require(path.join(__dirname, 'node_modules', 'firebase-admin'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const auth = admin.auth();
const db = admin.firestore();

(async () => {
  const user = await auth.getUserByEmail(email.toLowerCase());
  if (remove) {
    await auth.setCustomUserClaims(user.uid, { admin: false });
    await db.doc(`users/${user.uid}`).set({ role: 'user' }, { merge: true });
    console.log(`✓ ${email} is no longer an administrator.`);
  } else {
    await auth.setCustomUserClaims(user.uid, { admin: true });
    await db.doc(`users/${user.uid}`).set(
      { role: 'admin', uid: user.uid, email: email.toLowerCase() },
      { merge: true }
    );
    await db.collection('adminLogs').add({
      adminId: 'cli',
      adminEmail: 'cli-bootstrap',
      action: 'admin_role_granted',
      targetType: 'user',
      targetId: user.uid,
      metadata: { email: email.toLowerCase() },
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`✓ ${email} (${user.uid}) is now an administrator.`);
    console.log('  Note: the user must log out and back in for the claim to take effect.');
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
