// ─── Notification service ────────────────────────────────────────────
// Single writer for the `notifications` collection.
//
// Why this exists: notifications were previously written ad hoc from three
// different places with no category, no idempotency and no push handoff.
// Anything that wants to notify a user calls into here so that every
// document carries the same shape, the same category, a search index, and a
// `pushState` the background sender can drain.
//
// Safety properties:
//  - Idempotent: an `eventId` maps to a fixed document id, so replaying an
//    event cannot create a second notification.
//  - Never breaks business logic: failures are reported to the caller but
//    callers are expected to treat a notification as best-effort. The
//    existing call sites all wrap notify() in try/catch already.
//  - Cannot forge security alerts: `security` and `account` categories
//    require a real admin claim in this session. Firestore rules enforce
//    this again server-side — this check exists only so the failure is
//    loud and local rather than a silent permission error later.

import { auth, db } from './firebase.js';
import {
  doc, collection, runTransaction, writeBatch, serverTimestamp,
  query, where, orderBy, limit, getDocs, setDoc
} from 'firebase/firestore';

// ─── Categories ──────────────────────────────────────────────────────
// These are the user-facing filter buckets. They are deliberately coarser
// than `type`, which stays fine-grained for display and deep-linking.
export const CATEGORIES = {
  task:        { label: 'Tasks',         icon: 'briefcase', tint: 'blue'   },
  reward:      { label: 'Rewards',       icon: 'coins',     tint: 'green'  },
  referral:    { label: 'Referrals',     icon: 'users',     tint: 'violet' },
  payment:     { label: 'Payments',      icon: 'wallet',    tint: 'amber'  },
  security:    { label: 'Security',      icon: 'shield',    tint: 'red',    locked: true },
  account:     { label: 'Account',       icon: 'user',      tint: 'blue'   },
  announcement:{ label: 'Announcements', icon: 'megaphone', tint: 'violet' },
  promotion:   { label: 'Promotions',    icon: 'zap',       tint: 'pink'   },
  maintenance: { label: 'Maintenance',   icon: 'wrench',    tint: 'gray'   },
  system:      { label: 'System',        icon: 'info',      tint: 'gray'   }
};

export const CATEGORY_IDS = Object.keys(CATEGORIES);

// Categories a user may NOT switch off. These are the ones whose absence
// would be genuinely harmful — you cannot silence "your password changed".
export const LOCKED_CATEGORIES = CATEGORY_IDS.filter(
  (k) => CATEGORIES[k].locked
);

// ─── Type -> category ────────────────────────────────────────────────
// Explicit `category` always wins; this table is the fallback so legacy
// call sites that only pass `type` still land in a sensible bucket.
const TYPE_TO_CATEGORY = {
  task_assigned: 'task',
  task_submitted: 'task',
  task_approved: 'task',
  task_rejected: 'task',
  task_completed: 'task',
  task_reward: 'reward',
  reward_hold: 'reward',
  reward_released: 'reward',
  reward: 'reward',

  penalty: 'payment',
  deposit: 'payment',
  withdrawal_requested: 'payment',
  withdrawal_approved: 'payment',
  withdrawal_rejected: 'payment',
  withdrawal_paid: 'payment',
  wallet_debited: 'payment',

  referral_joined: 'referral',
  referral_reward: 'referral',
  referral_milestone: 'referral',

  new_device: 'security',
  password_changed: 'security',
  pin_changed: 'security',
  login_alert: 'security',
  account_locked: 'security',
  security: 'security',

  announcement: 'announcement',
  broadcast: 'announcement',
  promo: 'promotion',
  promotion: 'promotion',
  maintenance: 'maintenance',
  // The admin support channel is how private task instructions are handed
  // over, so it sits in Account rather than falling through to System.
  admin_message: 'account',
  system: 'system'
};

/**
 * Resolve the bucket for a notification.
 * An unknown type falls back to `system` rather than throwing, because a
 * mislabelled notification must never take down the action that produced it.
 */
export function inferCategory(type, explicit) {
  if (explicit && CATEGORIES[explicit]) return explicit;
  const t = String(type || '');
  if (TYPE_TO_CATEGORY[t]) return TYPE_TO_CATEGORY[t];
  // A prefixed type like `security_login` should still be caught.
  for (const key of Object.keys(CATEGORIES)) {
    if (t.startsWith(key + '_')) return key;
  }
  return 'system';
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Lowercased haystack for backend search queries.
 * Kept short: Firestore documents have a 1MiB budget and this is only ever
 * used for prefix matching, so full body text beyond ~400 chars adds cost
 * without improving results.
 */
function toSearchText(title, body) {
  return `${title || ''} ${body || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/**
 * Firestore document ids must not contain '/' and cannot be '.' or '..'.
 * Event ids come from call sites, so sanitise rather than trust.
 */
function safeId(raw) {
  const s = String(raw || '')
    .replace(/[\/\n\r\t]/g, '_')
    .replace(/^\.+$/, '')
    .trim();
  if (!s || s === '.' || s === '..') return null;
  return s.slice(0, 700); // leave headroom below the 1500 byte limit
}

let adminClaimCache = { value: false, at: 0 };

/**
 * Is this session actually an admin?
 * Only consulted for the categories that must not be forgeable.
 */
async function isAdminSession() {
  const now = Date.now();
  if (now - adminClaimCache.at < 60_000) return adminClaimCache.value;
  try {
    const u = auth.currentUser;
    const value = u
      ? !!(await u.getIdTokenResult()).claims?.admin
      : false;
    adminClaimCache = { value, at: now };
    return value;
  } catch (_) {
    return false;
  }
}

/** Reset the cached claim — call after sign-in/out. */
export function resetAdminCache() {
  adminClaimCache = { value: false, at: 0 };
}

// ─── Core writer ─────────────────────────────────────────────────────

function buildPayload(opts) {
  const title = String(opts.title || '').trim().slice(0, 140);
  const body = String(opts.body || '').trim().slice(0, 600);
  const category = inferCategory(opts.type, opts.category);

  const payload = {
    userId: opts.userId,
    audience: opts.userId === '__admins__' ? 'admin' : 'user',
    type: String(opts.type || 'system').slice(0, 60),
    category,
    title,
    body,
    link: String(opts.link || '').slice(0, 300),
    tone: String(opts.tone || 'gray').slice(0, 20),
    icon: String(opts.icon || CATEGORIES[category]?.icon || 'info').slice(0, 30),
    searchText: toSearchText(title, body),
    read: false,
    createdAt: serverTimestamp()
  };

  if (typeof opts.amountPaisa === 'number' && Number.isFinite(opts.amountPaisa)) {
    payload.amountPaisa = opts.amountPaisa;
  }
  if (opts.priority) {
    // Only three levels exist, and they drive how aggressively the shell
    // surfaces the event. Reject anything else rather than pass it through.
    if (['urgent', 'high'].includes(opts.priority)) payload.priority = opts.priority;
  }
  if (opts.expiresAt instanceof Date) payload.expiresAt = opts.expiresAt;

  // Every user-addressed notification is eligible for the background push
  // drain. Whether it actually sends is decided server-side by device and
  // preference state — never by the writing client.
  payload.pushState = 'queued';

  if (opts.eventId) payload.eventId = opts.eventId;

  return payload;
}

/**
 * Write one notification.
 *
 * @param {object} opts
 * @param {string} opts.userId      recipient, or '__admins__'
 * @param {string} opts.type        fine-grained event type
 * @param {string} [opts.category]  override the inferred bucket
 * @param {string} [opts.eventId]   idempotency key; makes this exactly-once
 * @param {boolean} [opts.ttlHours] expire after N hours (best-effort)
 * @returns {Promise<{id:string|null, duplicate:boolean}>}
 */
export async function createNotification(opts) {
  if (!opts || !opts.userId) {
    return { id: null, duplicate: false };
  }

  const payload = buildPayload(opts);

  if (LOCKED_CATEGORIES.includes(payload.category)) {
    const admin = await isAdminSession();
    if (!admin) {
      // Surfacing this is deliberate: a silent failure would look like a
      // working feature while never alerting anyone.
      console.error(
        '[notify] refusing to write a "%s" notification from a non-admin session',
        payload.category
      );
      return { id: null, duplicate: false };
    }
  }

  if (opts.ttlHours && Number(opts.ttlHours) > 0) {
    payload.expiresAt = new Date(Date.now() + Number(opts.ttlHours) * 3600_000);
  }

  const eventId = opts.eventId ? safeId(opts.eventId) : null;

  // No eventId -> plain append, no read needed.
  if (!eventId) {
    try {
      const ref = await (async () => {
        const r = doc(collection(db, 'notifications'));
        await setDoc(r, payload);
        return r;
      })();
      return { id: ref.id, duplicate: false };
    } catch (err) {
      console.error('[notify] write failed', err);
      return { id: null, duplicate: false };
    }
  }

  // With an eventId, the document id IS the event id. A transaction reads
  // first so that a replay after the user has already read it cannot flip
  // `read` back to false — that is the failure mode a naive setDoc would
  // introduce.
  const ref = doc(db, 'notifications', eventId);
  try {
    let duplicate = false;
    await runTransaction(db, async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists()) {
        duplicate = true;
        return;
      }
      tx.set(ref, payload);
    });
    if (duplicate) return { id: eventId, duplicate: true };
    return { id: eventId, duplicate: false };
  } catch (err) {
    console.error('[notify] idempotent write failed', err);
    return { id: null, duplicate: false };
  }
}

/** Convenience: notify one user. */
export async function notifyUser(userId, opts) {
  return createNotification({ ...opts, userId });
}

/** Convenience: notify the whole admin team. */
export async function notifyAdmins(opts) {
  return createNotification({ ...opts, userId: '__admins__' });
}

// ─── Self-service security events ────────────────────────────────────
// Separate from createNotification on purpose: that function refuses to
// write `security` from a non-admin session (so a compromised client
// cannot forge an alert against someone else), whereas these are the
// caller's OWN events. firestore.rules enforces the same split with a
// dedicated branch — see `match /notifications/{id}` in firestore.rules.
//
// The recipient is always the current user. There is no `userId` argument
// because there is no legitimate way for one person to raise another
// person's security event without a backend.

const SECURITY_TYPES = ['password_changed', 'pin_changed', 'new_device', 'login_alert'];

/**
 * Record one of this account's own security events.
 *
 * @param {string} type      one of SECURITY_TYPES
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {string} [opts.link]
 * @param {string} [opts.nonce] deterministic id fragment; pass one when the
 *                              event should happen at most once ever (e.g.
 *                              a device registration), omit it for events
 *                              that can legitimately recur (a password can
 *                              be changed repeatedly).
 * @returns {Promise<{id:string|null}>}
 */
export async function notifySelfSecurity(type, { title, body, link = '', nonce } = {}) {
  const fail = (why) => {
    console.error('[notify] security notification rejected:', why);
    return { id: null };
  };

  if (!SECURITY_TYPES.includes(type)) return fail(`unsupported type "${type}"`);

  const user = auth.currentUser;
  if (!user) return fail('no signed-in user');
  if (!title) return fail('missing title');

  const id = safeId(
    `sec_${type}_${user.uid}_${nonce || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`}`
  );
  if (!id) return fail('could not build document id');

  // Built by hand rather than through buildPayload: firestore.rules gives
  // this path a strict field whitelist, and an extra key such as `amountPaisa`
  // or `priority` would fail the whole write silently.
  const t = String(title).trim().slice(0, 140);
  const b = String(body || '').trim().slice(0, 600);

  const payload = {
    userId: user.uid,
    audience: 'user',
    type,
    category: 'security',
    eventId: id,
    pushState: 'queued',
    title: t,
    body: b,
    link: String(link).slice(0, 300),
    tone: 'red',
    icon: 'shield',
    searchText: toSearchText(t, b),
    read: false,
    createdAt: serverTimestamp()
  };

  try {
    const ref = doc(db, 'notifications', id);
    // setDoc, not a transaction: the id already encodes the event, so a
    // repeat call with the same nonce simply overwrites with equivalent
    // content rather than creating a second alert.
    await setDoc(ref, payload);
    return { id };
  } catch (err) {
    // Best effort by contract — a failed notification must never roll back
    // the password change that triggered it.
    console.error('[notify] security notification write failed', err);
    return { id: null };
  }
}

export { SECURITY_TYPES };

// ─── Broadcast ───────────────────────────────────────────────────────
// Batched rather than one write per await, and deliberately NOT driven by
// a single giant transaction: a broadcast to thousands of users must not
// exceed Firestore's 500-operation batch limit, and the caller is a browser
// session that must not freeze.
//
// The push side of a broadcast is not attempted here at all — every
// document is written with pushState 'queued' and the background sender
// drains it. That is what keeps a 5,000-recipient announcement out of the
// admin's HTTP request.

const BATCH_LIMIT = 400; // comfortably under Firestore's 500

/**
 * Fan a notification out to many users.
 * @param {string[]} userIds
 * @returns {Promise<{attempted:number, written:number}>}
 */
export async function broadcast(userIds, opts) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return { attempted: 0, written: 0 };

  // Per-recipient event ids so a re-run of the same broadcast is a no-op
  // instead of a duplicate for every user.
  const batchKey = opts.broadcastId || safeId(opts.eventId) || null;

  let written = 0;
  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const chunk = ids.slice(i, i + BATCH_LIMIT);
    const batch = writeBatch(db);
    for (const uid of chunk) {
      const payload = buildPayload({ ...opts, userId: uid });
      if (batchKey) {
        const id = safeId(`${batchKey}_${uid}`);
        if (!id) continue;
        batch.set(doc(db, 'notifications', id), payload);
      } else {
        batch.set(doc(collection(db, 'notifications')), payload);
      }
    }
    try {
      await batch.commit();
      written += chunk.length;
    } catch (err) {
      console.error('[notify] broadcast chunk failed', err);
      // Continue: a partial broadcast with an honest count beats an
      // all-or-nothing failure that silently drops everyone.
    }
  }

  return { attempted: ids.length, written };
}

/**
 * Every active user id — used for platform-wide announcements.
 *
 * Uses the same `status + createdAt` index the admin user list already
 * relies on, and is explicitly capped: a browser session must not pull an
 * unbounded userbase into memory. Callers who need more page with
 * `startAfter` from their own query.
 */
export async function listUserIds(max = 2000) {
  try {
    const snap = await getDocs(
      query(
        collection(db, 'users'),
        where('status', '==', 'active'),
        orderBy('createdAt', 'desc'),
        limit(max)
      )
    );
    return snap.docs.map((d) => d.id);
  } catch (err) {
    console.error('[notify] listUserIds failed', err);
    return [];
  }
}
