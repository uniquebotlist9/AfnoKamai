/**
 * AfnoKamai — Firestore write-probe v2.
 *
 * v1 proved something genuinely odd: reads returned in milliseconds, batch
 * commits and plain `set()` calls never returned within 20 seconds — yet
 * `delete()`, which is also a Commit, succeeded in 323ms. So writes are not
 * blocked, the credentials are fine, and the RPC itself works. Only `set()`
 * hangs. That narrows it to something `set()` does that `delete()` does not.
 *
 * There are exactly four differences, and this probe separates them:
 *
 *   P2  set, no merge, no transform   — does set() hang at all?
 *   P3  set, with merge               — does the merge path hang?
 *   P4  set, with serverTimestamp     — does a document transform hang?
 *   P5  set, no merge, SECOND app     — does db.settings({ignoreUndefined…})
 *                                       hang it? The secondary app never has
 *                                       that setting applied.
 *
 * Whichever of P2–P5 hangs while its siblings succeed names the culprit. P6
 * then tries update() on whatever P2 managed to create, because update() is
 * what the sender could fall back to if merge is the problem.
 *
 * Probe documents live in `config/` and are removed afterwards; v1
 * demonstrated cleanup succeeds even when the writes that created them did
 * not.
 *
 * Exit: 0 = all probes returned; 1 = script failed; 2 = watchdog.
 */

const admin = require('firebase-admin');

const CAP_MS = Number(process.env.PROBE_CAP_MS) || 15000;
const OVERALL_MS = Number(process.env.PROBE_OVERALL_MS) || 240000;
const PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || 'afnokamai';

let SERVICE_ACCOUNT;
try {
  SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error(`FATAL: service account is not valid JSON: ${err.message}`);
  process.exit(1);
}

const credential = admin.credential.cert(SERVICE_ACCOUNT);

// Primary instance — identical configuration to scripts/push-sender.cjs.
admin.initializeApp({ credential, projectId: PROJECT_ID });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// Secondary instance, deliberately left at SDK defaults, so P5 can tell
// whether the settings line above is what wedges the write path.
const app2 = admin.initializeApp({ credential, projectId: PROJECT_ID }, 'probe-secondary');
const dbRaw = admin.firestore(app2);

const ts = () => admin.firestore.FieldValue.serverTimestamp();

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

async function main() {
  console.log(`probe v2 start: project=${PROJECT_ID} cap=${CAP_MS}ms/step`);

  await attempt('P1 READ   config/notificationIndex', () =>
    db.doc('config/notificationIndex').get());

  await attempt('P2 SET    plain, no merge, no transform', () =>
    db.doc('config/_p_raw').set({ probe: 'raw', at: Date.now() }));

  await attempt('P3 SET    merge:true', () =>
    db.doc('config/_p_mrg').set({ probe: 'mrg', at: Date.now() }, { merge: true }));

  await attempt('P4 SET    serverTimestamp transform', () =>
    db.doc('config/_p_ts').set({ probe: 'ts', at: ts() }));

  await attempt('P5 SET    plain via app WITHOUT ignoreUndefinedProperties', () =>
    dbRaw.doc('config/_p_alt').set({ probe: 'alt', at: Date.now() }));

  await attempt('P6 UPDATE existing doc', () =>
    db.doc('config/_p_raw').update({ probe: 'updated' }));

  await attempt('P7 SET    existing doc, merge:true', () =>
    db.doc('config/_p_raw').set({ probe: 'merged-again', at: Date.now() }, { merge: true }));

  await attempt('P8 BATCH  plain set, no merge', async () => {
    const b = db.batch();
    b.set(db.doc('config/_p_bat'), { probe: 'batch-plain', at: Date.now() });
    await b.commit();
  });

  console.log('--- cleanup ---');
  for (const name of ['_p_raw', '_p_mrg', '_p_ts', '_p_alt', '_p_bat']) {
    await attempt(`DEL    config/${name}`, () => db.doc(`config/${name}`).delete());
  }

  clearTimeout(overall);
  console.log('probe v2 done');
  process.exit(0);
}

main().catch((err) => {
  console.error('probe fatal', err);
  process.exit(1);
});
