/**
 * AfnoKamai — Web Push sender (GitHub Actions cron, every 5 minutes).
 *
 * Runs entirely outside the app on the free GitHub Actions tier, because the
 * app itself is a static Firebase Hosting site with no backend and no billing
 * account. Holding the VAPID private key here keeps it off the client, which
 * is the whole point: a browser must never be able to forge a push to our
 * users.
 *
 * Honesty note: web-push only confirms the *provider accepted* the message.
 * We therefore record `sent`, never `delivered` — an OS that has since
 * revoked permission will still report success at this layer.
 *
 * Flow: queued -> sending (claim) -> sent | skipped | failed
 */

const admin = require('firebase-admin');
const webpush = require('web-push');

const PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || 'afnokamai';
const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// Transient (retry later) vs terminal (never retry) push failures.
const RETRYABLE = new Set([
  429, // provider rate limit
  500, 502, 503, 507, 509
]);
const TERMINAL = new Set([
  404, // endpoint gone — subscription must be retired
  410  // Gone — explicitly expired/revoked by the browser or OS
]);

const MAX_ATTEMPTS = 3;
const BATCH = 100;
const CLAIM_TTL_MS = 10 * 60 * 1000; // a crashed run's claim expires

admin.initializeApp({
  credential: admin.credential.cert(SERVICE_ACCOUNT),
  projectId: PROJECT_ID
});
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const stats = { queued: 0, sent: 0, skipped: 0, failed: 0, retired: 0, errors: 0 };

function log(msg, extra) {
  console.log(`[${new Date().toISOString()}] ${msg}`, extra === undefined ? '' : extra);
}

/**
 * Idempotency guard. A crash between claim and send must not double-send on
 * the next run, and an overlapping run must not either — so the claim itself
 * is a transaction on pushState, not a read-then-write.
 */
async function claim(notification) {
  const ref = notification.ref;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const d = snap.data();
    const stale = d.pushClaimedAt &&
      Date.now() - d.pushClaimedAt.toMillis() > CLAIM_TTL_MS;

    if (d.pushState === 'queued' || (d.pushState === 'sending' && stale)) {
      tx.update(ref, {
        pushState: 'sending',
        pushAttempts: (d.pushAttempts || 0) + 1,
        pushClaimedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    }
    return false;
  });
}

/** Preferences gate. Security alerts bypass every user-facing toggle. */
async function wantsPush(cat, recipientId, notification) {
  // Security is locked: no document, no toggle and no opt-out can silence
  // it. That is a product rule, not an oversight — being unable to be told
  // your password changed is the one failure a notification system must
  // never have.
  if (cat === 'security') return true;

  if (notification.expiresAt && notification.expiresAt.toMillis() < Date.now()) {
    return { skip: 'expired' };
  }

  try {
    const prefSnap = await db.doc(`notificationPrefs/${recipientId}`).get();
    if (!prefSnap.exists) return true; // no prefs written yet => default on
    const p = prefSnap.data();
    if (p.push === false) return { skip: 'master_off' };
    // Absent key = on. Only an explicit false suppresses a bucket.
    if ((p.categories || {})[cat] === false) return { skip: `cat_off:${cat}` };
    return true;
  } catch (e) {
    // Failing open on a *read* error would spam; failing closed would hide
    // money notifications. Read errors here are rare and non-security, so we
    // send — a lost notification is worse than a rare duplicate.
    log('pref read failed, defaulting to send', e.message);
    return true;
  }
}

/**
 * Turn a notification's `userId` into real accounts that can receive push.
 *
 * Admin traffic uses the pseudo-account `__admins__`, which has no push
 * subscriptions of its own. Resolve it to the people who actually hold the
 * admin role, otherwise team alerts would silently never send.
 */
async function resolveRecipients(notification) {
  if (notification.userId !== '__admins__') return [notification.userId];

  try {
    const snap = await db.collection('users')
      .where('role', '==', 'admin')
      .limit(25)
      .get();
    const ids = snap.docs.map((d) => d.id);
    return ids.length ? ids : [];
  } catch (e) {
    log('admin resolution failed', e.message);
    return [];
  }
}

async function activeSubscriptions(userId) {
  const snap = await db
    .collection('pushSubscriptions')
    .where('userId', '==', userId)
    .where('isActive', '==', true)
    .limit(25)
    .get();
  return snap.docs;
}

async function writeLog(fields) {
  // Deterministic id => a retry rewrites the same row instead of piling up
  // duplicate delivery records.
  const id = `${fields.notificationId}_${fields.subscriptionId}`;
  await db.doc(`notificationLog/${id}`).set({
    ...fields,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function sendToOne(notification, subDoc) {
  const sub = subDoc.data();
  const payload = JSON.stringify({
    notificationId: notification.id,
    title: notification.title || 'AfnoKamai',
    body: notification.body || '',
    // Minimal payload on purpose: never put balances, PII or tokens in a
    // push body. The authenticated app fetches detail after the click.
    url: notification.link || '/',
    icon: '/assets/icon-512.png',
    badge: '/assets/icon-512.png',
    tag: notification.id,
    category: notification.category || 'system',
    // Urgent items pin themselves on screen (see requireInteraction in sw.js).
    priority: notification.priority || ''
  });

  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload
    );
    stats.sent++;
    await subDoc.ref.update({
      lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
      failCount: 0
    });
    await writeLog({
      notificationId: notification.id,
      userId: notification.userId,
      subscriptionId: subDoc.id,
      channel: 'push',
      status: 'sent',
      provider: 'webpush',
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return 'sent';
  } catch (err) {
    const status = err.statusCode || 0;
    log('push error', { sub: subDoc.id, status, msg: err.body || err.message });

    if (TERMINAL.has(status)) {
      // Endpoint is permanently dead — stop ever addressing it again.
      await subDoc.ref.update({
        isActive: false,
        deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
        deactivateReason: `http_${status}`
      });
      stats.retired++;
      await writeLog({
        notificationId: notification.id,
        userId: notification.userId,
        subscriptionId: subDoc.id,
        channel: 'push',
        status: 'failed',
        provider: 'webpush',
        error: `http_${status}`
      });
      return 'retired';
    }

    if (RETRYABLE.has(status) || status === 0) {
      await subDoc.ref.update({
        failCount: (sub.failCount || 0) + 1
      });
      await writeLog({
        notificationId: notification.id,
        userId: notification.userId,
        subscriptionId: subDoc.id,
        channel: 'push',
        status: 'retry',
        provider: 'webpush',
        error: `http_${status || 'network'}`
      });
      return 'retry';
    }

    await writeLog({
      notificationId: notification.id,
      userId: notification.userId,
      subscriptionId: subDoc.id,
      channel: 'push',
      status: 'failed',
      provider: 'webpush',
      error: `http_${status}`
    });
    return 'failed';
  }
}

async function processNotification(notification) {
  const n = { id: notification.id, ...notification.data() };
  stats.queued++;
  const ref = notification.ref;

  const claimed = await claim(notification);
  if (!claimed) return; // someone else owns it, or it already advanced

  try {
    const recipients = await resolveRecipients(n);
    if (!recipients.length) {
      await ref.update({
        pushState: 'skipped',
        pushSkipReason: n.userId === '__admins__' ? 'no_admins' : 'no_recipient',
        pushAt: admin.firestore.FieldValue.serverTimestamp()
      });
      stats.skipped++;
      return;
    }

    const allResults = [];
    let totalSubs = 0;
    let anyWant = false;

    for (const recipientId of recipients) {
      const wants = await wantsPush(n.category || 'system', recipientId, n);
      if (wants !== true) continue;
      anyWant = true;

      const subs = await activeSubscriptions(recipientId);
      totalSubs += subs.length;
      if (!subs.length) continue;

      // Hand sendToOne a recipient-scoped copy so the delivery log records
      // which real account the endpoint belonged to, not `__admins__`.
      const scoped = { ...n, userId: recipientId };
      const results = await Promise.all(subs.map((s) => sendToOne(scoped, s)));
      allResults.push(...results);
    }

    if (!anyWant) {
      await ref.update({
        pushState: 'skipped',
        pushSkipReason: 'opted_out',
        pushAt: admin.firestore.FieldValue.serverTimestamp()
      });
      stats.skipped++;
      return;
    }

    if (!allResults.length) {
      await ref.update({
        pushState: 'skipped',
        pushSkipReason: 'no_devices',
        pushAt: admin.firestore.FieldValue.serverTimestamp()
      });
      stats.skipped++;
      return;
    }

    const sent = allResults.filter((r) => r === 'sent').length;
    const retry = allResults.filter((r) => r === 'retry').length;
    const attempts = n.pushAttempts || 1;

    let finalState;
    if (sent > 0) finalState = 'sent';
    // Unsent-and-retryable goes back to `queued`, not `failed`: the next
    // cron tick retries it until MAX_ATTEMPTS, so a provider blip does not
    // drop a payment alert on the floor.
    else if (retry > 0 && attempts < MAX_ATTEMPTS) finalState = 'queued';
    else if (retry > 0) finalState = 'retrying';
    else finalState = 'failed';

    await ref.update({
      pushState: finalState,
      pushAt: admin.firestore.FieldValue.serverTimestamp(),
      pushDeviceCount: totalSubs,
      pushSentCount: sent
    });
    if (finalState === 'failed') stats.failed++;
  } catch (err) {
    stats.errors++;
    log('notification processing error', { id: n.id, err: err.message });
    // Return it to the queue so a transient bug doesn't drop the alert, but
    // bound it via pushAttempts so we can never loop forever.
    const attempts = (n.pushAttempts || 1);
    await ref.update({
      pushState: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
      pushLastError: String(err.message || err).slice(0, 200)
    }).catch(() => {});
  }
}

/** Crashed runs can strand a claim; sweep those back to queued. */
async function reclaimStuck() {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  const snap = await db.collection('notifications')
    .where('pushState', '==', 'sending')
    .limit(BATCH)
    .get();
  let n = 0;
  for (const d of snap.docs) {
    const t = d.data().pushClaimedAt;
    if (t && t.toMillis() < cutoff) {
      await d.ref.update({ pushState: 'queued' }).catch(() => {});
      n++;
    }
  }
  if (n) log('reclaimed stuck claims', n);
}

/**
 * Subscriptions that have failed repeatedly are almost certainly dead but
 * never returned a 410 (e.g. browser data cleared). Retire them so we stop
 * paying for doomed sends.
 */
async function sweepZombieSubscriptions() {
  const snap = await db.collection('pushSubscriptions')
    .where('isActive', '==', true)
    .where('failCount', '>=', 5)
    .limit(50)
    .get();
  for (const d of snap.docs) {
    await d.ref.update({
      isActive: false,
      deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deactivateReason: 'repeated_failure'
    }).catch(() => {});
    stats.retired++;
  }
  if (snap.size) log('retired zombie subscriptions', snap.size);
}

/**
 * One-time migration: backfill `category` and `searchText` on notifications
 * written before the notification centre v2 schema.
 *
 * Why it lives here: only the service account may write these fields, so
 * neither a user session nor an admin browser can do it (firestore.rules
 * pins the owner update path to `read`/`readAt`). Running it from the
 * sender means no one has to remember a manual step.
 *
 * It walks oldest-first behind a cursor and stops for good once it reaches
 * the end, so the steady-state cost is a single document read per run —
 * important on a free-tier quota we are already careful with.
 */
const TYPE_TO_CATEGORY = {
  task_assigned: 'task', task_submitted: 'task', task_approved: 'task',
  task_rejected: 'task', task_completed: 'task', task_reward: 'reward',
  reward_hold: 'reward', reward_released: 'reward', reward: 'reward',
  penalty: 'payment', deposit: 'payment',
  withdrawal: 'payment', withdrawal_requested: 'payment', withdrawal_approved: 'payment',
  withdrawal_rejected: 'payment', withdrawal_paid: 'payment', wallet_debited: 'payment',
  referral_joined: 'referral', referral_reward: 'referral', referral_milestone: 'referral',
  new_device: 'security', password_changed: 'security', pin_changed: 'security',
  login_alert: 'security', account_locked: 'security', security: 'security',
  announcement: 'announcement', broadcast: 'announcement',
  promo: 'promotion', promotion: 'promotion',
  maintenance: 'maintenance', admin_message: 'account', system: 'system'
};

function indexCategory(type) {
  const t = String(type || '');
  if (TYPE_TO_CATEGORY[t]) return TYPE_TO_CATEGORY[t];
  for (const key of ['task', 'reward', 'referral', 'payment', 'security',
                     'account', 'announcement', 'promotion', 'maintenance', 'system']) {
    if (t.startsWith(key + '_')) return key;
  }
  return 'system';
}

const REINDEX_BATCH = 200;
const STATE_DOC = 'config/notificationIndex';

async function reindex() {
  let state;
  try {
    const snap = await db.doc(STATE_DOC).get();
    state = snap.exists ? snap.data() : null;
  } catch (e) {
    log('reindex state read failed', e.message);
    return;
  }

  if (state && state.done) return;

  const cursor = state && state.lastCreatedAt ? state.lastCreatedAt : null;

  let snap;
  try {
    const base = db.collection('notifications');
    const q = cursor
      ? base.where('createdAt', '>', cursor).orderBy('createdAt', 'asc').limit(REINDEX_BATCH)
      : base.orderBy('createdAt', 'asc').limit(REINDEX_BATCH);
    snap = await q.get();
  } catch (e) {
    log('reindex query failed', e.message);
    return;
  }

  if (snap.empty) {
    await db.doc(STATE_DOC).set({
      done: true, completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    log('reindex complete — all notifications carry category + searchText');
    return;
  }

  let patched = 0;
  for (const d of snap.docs) {
    const n = d.data();
    const needsCategory = !n.category;
    const needsText = typeof n.searchText !== 'string' || n.searchText.length === 0;
    // A browser sitting on a cached copy of js/chat.js or js/admin-actions.js
    // can still write the pre-v2 shape for up to an hour after a deploy.
    // Queuing those too means a stale client cannot quietly cost someone a
    // payment alert.
    const needsQueue = !n.pushState
      && (n.audience === 'user' || n.audience === 'admin')
      && !!n.userId;

    if (!needsCategory && !needsText && !needsQueue) continue;

    const patch = {};
    if (needsCategory) patch.category = indexCategory(n.type);
    if (needsText) {
      patch.searchText = `${n.title || ''} ${n.body || ''}`
        .toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400);
    }
    if (needsQueue) patch.pushState = 'queued';
    await d.ref.set(patch, { merge: true });
    patched++;
  }

  const last = snap.docs[snap.docs.length - 1];
  const finished = snap.size < REINDEX_BATCH;

  await db.doc(STATE_DOC).set({
    lastCreatedAt: last.get('createdAt'),
    lastId: last.id,
    ...(finished ? { done: true, completedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  log('reindex batch', {
    scanned: snap.size, patched,
    ...(finished ? { done: true } : {})
  });
}

async function main() {
  log('push sender starting', { project: PROJECT_ID });

  await reindex();
  await reclaimStuck();

  const snap = await db.collection('notifications')
    .where('pushState', '==', 'queued')
    .orderBy('createdAt', 'asc')
    .limit(BATCH)
    .get();

  log('queued notifications', snap.size);

  // Sequential on purpose: parallel fan-out against a free-tier provider just
  // earns us 429s, and a few hundred sends fit comfortably in an Actions job.
  for (const doc of snap.docs) {
    await processNotification(doc);
  }

  await sweepZombieSubscriptions();

  log('finished', stats);
  console.log(JSON.stringify(stats));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('fatal', err);
    process.exit(1);
  });
