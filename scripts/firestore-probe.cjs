/**
 * AfnoKamai — Firestore write-probe v3 (read-after-write).
 *
 * v2 left exactly one question open. It showed that every set(), update() and
 * batch.commit() never returns, while delete() — also a Commit — returns in
 * ~260ms. Two very different realities produce that signature:
 *
 *   (a) WRITE BLOCKED  — the mutation never commits. Reads work, writes do
 *       nothing. Root cause is server-side (index build, quota, policy) and
 *       nothing in this repo can fix it.
 *
 *   (b) RESPONSE LOST  — the mutation commits fine but its reply never
 *       arrives, so the promise never settles. The database IS being written,
 *       and the sender is simply waiting for an acknowledgement that will
 *       not come.
 *
 * They look identical from the client. They differ on read-after-write: after
 * a set() that "hangs", does the document exist?
 *
 * This is the whole point of the probe, so each set is followed
 * immediately by a read of the same document, then a second read after a
 * grace period in case the write is merely delayed rather than lost.
 *
 * v2's cleanup results are re-examined here: v2's five deletes all succeeded,
 * but four of their target documents had been created by set() calls that
 * hung — so they may well have been deletes of documents that were never
 * created, which proves nothing. V7/V8 fix that by deleting a document this
 * probe has positively confirmed exists, then reading it back.
 *
 * Exit: 0 = all probes returned; 1 = script failed; 2 = watchdog.
 */

const admin = require('firebase-admin');

const CAP_MS = Number(process.env.PROBE_CAP_MS) || 15000;
const GRACE_MS = Number(process.env.PROBE_GRACE_MS) || 4000;
const OVERALL_MS = Number(process.env.PROBE_OVERALL_MS) || 240000;
const PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || 'afnokamai';
const DOC = 'config/_q_readback';

let SERVICE_ACCOUNT;
try {
  SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error(`FATAL: service account is not valid JSON: ${err.message}`);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(SERVICE_ACCOUNT),
  projectId: PROJECT_ID
});
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const overall = setTimeout(() => {
  console.error(`FATAL: probe still running after ${OVERALL_MS}ms.`);
  process.exit(2);
}, OVERALL_MS);

async function attempt(label, fn) {
  const started = Date.now();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ d: true }), CAP_MS); });

  let outcome;
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn).then(() => ({ ok: true })),
      deadline
    ]);
    outcome = result.d ? { status: 'HUNG' } : { status: 'OK' };
  } catch (err) {
    outcome = { status: 'ERROR', message: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  console.log(`${outcome.status.padEnd(6)} ${label}${outcome.message ? ' — ' + outcome.message : ''}  (${ms}ms)`);
  return outcome;
}

/** @returns {Promise<boolean|null>} true = exists, false = absent, null = could not tell */
async function exists(label) {
  try {
    const snap = await db.doc(DOC).get();
    const present = snap.exists;
    console.log(`${'OK'.padEnd(6)} ${label} -> ${present ? 'DOCUMENT EXISTS' : 'document absent'}  (${snap.readTime ? '' : ''}read ok)`);
    return present;
  } catch (err) {
    console.log(`${'ERROR'.padEnd(6)} ${label} — ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`probe v3 start: project=${PROJECT_ID} doc=${DOC}`);
  console.log('question: after a set() that never returns, does the document exist?');

  await attempt('V1 READ baseline (should be absent)', () => db.doc(DOC).get());
  const before = await exists('V2 READ baseline detail');

  const write = await attempt('V3 SET  plain set', () =>
    db.doc(DOC).set({ probe: 'v3', at: Date.now() }));
  const afterSet = await exists('V4 READ immediately after hung set');

  await sleep(GRACE_MS);
  const afterGrace = await exists(`V5 READ after ${GRACE_MS}ms grace`);

  await attempt('V6 SET  same doc again', () =>
    db.doc(DOC).set({ probe: 'v3-retry', at: Date.now() }));
  const afterRetry = await exists('V7 READ after second hung set');

  await attempt('V8 DEL  document', () => db.doc(DOC).delete());
  const afterDelete = await exists('V9 READ after delete');

  console.log('--- verdict ---');
  console.log(`write status            : ${write.status}`);
  console.log(`present before write    : ${before}`);
  console.log(`present after write     : ${afterSet}`);
  console.log(`present after grace     : ${afterGrace}`);
  console.log(`present after retry     : ${afterRetry}`);
  console.log(`present after delete    : ${afterDelete}`);

  if (afterSet === true || afterGrace === true || afterRetry === true) {
    console.log('VERDICT: WRITES COMMIT — the response never arrives. The database');
    console.log('         is being written; the client waits for an ack that will not come.');
  } else if (afterSet === false && afterGrace === false) {
    console.log('VERDICT: WRITES DO NOT COMMIT — blocked before they reach storage.');
    console.log('         Root cause is server-side (index build / quota / policy).');
  } else {
    console.log('VERDICT: INCONCLUSIVE — reads could not confirm state.');
  }

  if (afterGrace === true && afterDelete === false) {
    console.log('NOTE: delete() verifiably removed a confirmed-existing document.');
  }

  clearTimeout(overall);
  console.log('probe v3 done');
  process.exit(0);
}

main().catch((err) => {
  console.error('probe fatal', err);
  process.exit(1);
});
