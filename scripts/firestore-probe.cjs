/**
 * AfnoKamai — Firestore read/write probe.
 *
 * Purpose: two sender runs stalled indefinitely. The instrumented run made
 * the pattern unambiguous — `db.doc().get()` returned in 2 seconds, then
 * `batch.commit()` never returned at all. Reads fine, writes hanging.
 *
 * That is an unusual enough claim to want proof rather than inference, and
 * every CI round-trip to test it costs five minutes. This probes each
 * operation independently under a hard deadline, so one run answers:
 *
 *   - do reads work?              (if no: credentials/project)
 *   - does a plain write work?    (if no: writes are blocked, not slow)
 *   - does a batch commit work?   (if no: batch-specific, not write-specific)
 *   - does writing to `notifications` behave differently from `config`?
 *
 * Probe documents are written to `config/_writeProbe` and
 * `notifications/_writeProbe`, then removed. If cleanup cannot run — exactly
 * the situation this script exists to diagnose — the markers stay put and
 * the log says so rather than leaving invisible litter.
 *
 * Exit codes: 0 = every probe returned; 1 = the script itself failed;
 * 2 = the overall watchdog fired.
 */

const admin = require('firebase-admin');

// Each individual probe gets this long. Generous for a healthy Firestore
// (a write is normally tens of milliseconds) but far short of the 10-minute
// job timeout that was our only diagnostic on the first run.
const CAP_MS = Number(process.env.PROBE_CAP_MS) || 20000;
// Must comfortably exceed CAP_MS × the number of probes, or the watchdog
// would fire while the per-probe deadlines were still doing their job.
const OVERALL_MS = Number(process.env.PROBE_OVERALL_MS) || 180000;

const PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || 'afnokamai';

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

// Independent of per-probe deadlines: if something wedges the event loop
// outright, this still ends the run so the log reaches GitHub.
const overall = setTimeout(() => {
  console.error(`FATAL: probe still running after ${OVERALL_MS}ms — event loop wedged.`);
  process.exit(2);
}, OVERALL_MS);

/**
 * Race a promise against a deadline.
 *
 * The losing promise is deliberately left dangling rather than cancelled —
 * there is no way to cancel an in-flight Firestore call, which is precisely
 * the behaviour under investigation. `process.exit` at the end reaps them.
 */
async function attempt(label, fn) {
  const started = Date.now();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __deadline: true }), CAP_MS);
  });

  let outcome;
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn).then((value) => ({ value })),
      deadline
    ]);
    outcome = result && result.__deadline ? { status: 'HUNG' } : { status: 'OK' };
  } catch (err) {
    outcome = { status: 'ERROR', message: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  const suffix = outcome.message ? ` — ${outcome.message}` : '';
  console.log(`${outcome.status.padEnd(6)} ${label}${suffix}  (${ms}ms)`);
  return outcome;
}

async function main() {
  console.log(`probe start: project=${PROJECT_ID} cap=${CAP_MS}ms/step`);

  await attempt('READ  config/notificationIndex', async () => {
    const snap = await db.doc('config/notificationIndex').get();
    return snap.exists ? 'exists' : 'absent';
  });

  await attempt('READ  query notifications', async () => {
    const snap = await db.collection('notifications').limit(5).get();
    return snap.size;
  });

  await attempt('WRITE config/_writeProbe (plain set)', () =>
    db.doc('config/_writeProbe').set(
      { probe: true, at: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    ));

  await attempt('WRITE notifications/_writeProbe (plain set)', () =>
    db.doc('notifications/_writeProbe').set(
      { probe: true, at: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    ));

  await attempt('BATCH commit -> config/_writeProbe', async () => {
    const batch = db.batch();
    batch.set(
      db.doc('config/_writeProbe'),
      { batched: true, at: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    await batch.commit();
  });

  await attempt('BATCH commit -> notifications/_writeProbe', async () => {
    const batch = db.batch();
    batch.set(
      db.doc('notifications/_writeProbe'),
      { batched: true, at: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    await batch.commit();
  });

  // Cleanup, itself deadline-capped: if writes hang, this will hang too, and
  // saying so is more useful than hanging silently on the way out.
  console.log('--- cleanup (best effort) ---');
  const a = await attempt('DELETE config/_writeProbe',
    () => db.doc('config/_writeProbe').delete());
  const b = await attempt('DELETE notifications/_writeProbe',
    () => db.doc('notifications/_writeProbe').delete());

  if (a.status === 'OK' && b.status === 'OK') {
    console.log('cleanup complete');
  } else {
    console.log('CLEANUP INCOMPLETE — probe documents may remain.');
  }

  clearTimeout(overall);
  console.log('probe done');
  // Forced: a still-pending hung call would otherwise keep the process alive
  // and turn a completed probe into another mysterious job timeout.
  process.exit(0);
}

main().catch((err) => {
  console.error('probe fatal', err);
  process.exit(1);
});
