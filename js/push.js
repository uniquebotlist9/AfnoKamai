// ─── Push subscription + notification preferences ────────────────────
//
// Three rules this module exists to enforce:
//
//  1. The permission prompt only ever appears after a deliberate click.
//     Nothing in the load path calls Notification.requestPermission().
//     `Notification.permission === 'default'` means "not asked yet" and is
//     left alone; 'denied' is never re-requested, because a second call is
//     both futile and hostile — we show guidance instead.
//
//  2. A subscription document belongs to exactly one (user, browser) pair.
//     The Firestore doc id is `${uid}_${deviceId}` and security rules
//     verify that, so a client cannot register someone else's endpoint or
//     duplicate its own.
//
//  3. The VAPID private key never appears here. Only the public key is
//     used, which is why it is safe to ship in firebase-config.js.

import { auth, db } from './firebase.js';
import { VAPID_PUBLIC_KEY, MAX_PUSH_DEVICES } from './firebase-config.js';
import { notifySelfSecurity } from './notify.js';
import {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, serverTimestamp
} from 'firebase/firestore';

const DEVICE_KEY = 'ak_push_device_id';
const ENDPOINT_CACHE = 'ak_push_last_endpoint';

// ─── Capability detection ────────────────────────────────────────────

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/**
 * One of: 'unsupported' | 'default' | 'granted' | 'denied'.
 * Never prompts.
 */
export function permissionState() {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

// ─── Device identity ─────────────────────────────────────────────────

/**
 * Stable id for this browser profile.
 *
 * localStorage rather than sessionStorage: it must survive a tab close so
 * that returning to the site reuses the same device record instead of
 * minting a new one each visit. If it is cleared, the old record is
 * orphaned and retired by the sender's zombie sweep.
 */
function deviceId() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch (_) { /* private mode */ }
  if (!id) {
    const bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(DEVICE_KEY, id); } catch (_) { /* private mode */ }
  }
  return id;
}

/**
 * Human label so the settings page reads "Chrome on Windows" rather than
 * an opaque endpoint hash.
 */
export function describeDevice(ua = navigator.userAgent) {
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' :
    /SamsungBrowser/.test(ua) ? 'Samsung Internet' : 'Browser';

  const os =
    /Windows/.test(ua) ? 'Windows' :
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /CrOS/.test(ua) ? 'ChromeOS' :
    /Linux/.test(ua) ? 'Linux' : 'this device';

  return `${browser} on ${os}`;
}

// ─── Key conversion ──────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function uint8ArrayToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function registration() {
  // Prefer an existing registration. Awaiting `.ready` when none exists
  // and none will be created — the shell skips registration on localhost
  // (see registerSW in js/shell.js) — would leave a promise pending
  // forever, which shows up as a button that never resolves.
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  if (['localhost', '127.0.0.1'].includes(location.hostname)) return null;
  return navigator.serviceWorker.ready;
}

// ─── Subscription lifecycle ──────────────────────────────────────────

function docIdFor(uid) {
  return `${uid}_${deviceId()}`;
}

/**
 * Ensure this browser has a live subscription in both PushManager and
 * Firestore, and that the two agree.
 *
 * Safe to call on every page load: it only ever *prompts* when the caller
 * passes `{ prompt: true }`, which is reserved for the opt-in button.
 *
 * @returns {Promise<'none'|'granted'|'denied'|'unsupported'|'synced'>}
 */
export async function syncSubscription({ prompt = false } = {}) {
  if (!pushSupported()) return 'unsupported';

  const user = auth.currentUser;
  if (!user) return 'none';

  // Never prompt unless the user just clicked something that promised to.
  if (Notification.permission === 'default' && !prompt) return 'default';

  if (Notification.permission === 'denied') {
    // The browser (or the user, via site settings) has revoked it. Retire
    // the record so the sender stops writing into a dead endpoint.
    await retireLocalRecord('permission_denied');
    return 'denied';
  }

  if (Notification.permission !== 'granted') return 'default';

  try {
    const reg = await registration();
    if (!reg) return 'error'; // no worker on this origin (e.g. localhost)

    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }

    const ref = doc(db, 'pushSubscriptions', docIdFor(user.uid));
    const snapshot = await getDoc(ref);

    const keys = {
      p256dh: uint8ArrayToBase64(sub.getKey('p256dh')),
      auth: uint8ArrayToBase64(sub.getKey('auth'))
    };
    const endpoint = sub.endpoint;

    if (!snapshot.exists()) {
      // Enforce the device ceiling before writing, so a pathological
      // session cannot attach unlimited endpoints to one account.
      const existing = await getDocs(
        query(
          collection(db, 'pushSubscriptions'),
          where('userId', '==', user.uid),
          where('isActive', '==', true),
          limit(MAX_PUSH_DEVICES)
        )
      );
      if (existing.size >= MAX_PUSH_DEVICES) {
        return 'limit';
      }

      await setDoc(ref, {
        userId: user.uid,
        deviceId: deviceId(),
        endpoint,
        keys,
        platform: navigator.platform || 'web',
        browser: describeDevice().split(' on ')[0],
        deviceName: describeDevice(),
        isActive: true,
        permissionStatus: 'granted',
        failCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastUsedAt: serverTimestamp()
      });
      // Exactly once per (user, device) ever — the id is derived from the
      // device id rather than a timestamp, so re-enabling after a removal
      // does not raise a second alert for hardware we already know.
      // Fire-and-forget: a failed security row must not undo the
      // subscription that just succeeded.
      notifySelfSecurity('new_device', {
        title: 'New device enabled',
        body: `${describeDevice()} is now set up to receive AfnoKamai notifications. If you do not recognise this device, remove it from notification settings.`,
        link: 'notification-settings.html',
        nonce: deviceId()
      }).catch(() => {});
      return 'synced';
    }

    const current = snapshot.data();

    // The push service can hand us a brand new endpoint for the same
    // browser (token rotation). Security rules deliberately forbid editing
    // endpoint/keys in place — the old endpoint is dead, so replace the
    // document rather than mutate it.
    if (current.endpoint !== endpoint) {
      await deleteDoc(ref);
      await setDoc(ref, {
        userId: user.uid,
        deviceId: deviceId(),
        endpoint,
        keys,
        platform: navigator.platform || 'web',
        browser: current.browser || describeDevice().split(' on ')[0],
        deviceName: current.deviceName || describeDevice(),
        isActive: true,
        permissionStatus: 'granted',
        failCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastUsedAt: serverTimestamp()
      });
      return 'synced';
    }

    if (current.isActive === false || current.permissionStatus !== 'granted') {
      await updateDoc(ref, {
        isActive: true,
        permissionStatus: 'granted',
        updatedAt: serverTimestamp(),
        lastUsedAt: serverTimestamp()
      });
    }

    try { localStorage.setItem(ENDPOINT_CACHE, endpoint); } catch (_) { /* ok */ }
    return 'synced';
  } catch (err) {
    console.error('[push] sync failed', err);
    return 'error';
  }
}

/**
 * Explicit opt-in. Must be invoked directly from a user gesture — every
 * browser requires this and none of them will forgive a deferred call.
 */
export async function enablePush({ deviceName } = {}) {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };

  // If the user already blocked us at the browser level there is nothing
  // to ask. Calling requestPermission() here would be ignored anyway, and
  // pretending otherwise would be a fake success.
  if (Notification.permission === 'denied') {
    return { ok: false, reason: 'denied' };
  }

  try {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      return { ok: false, reason: result === 'denied' ? 'denied' : 'dismissed' };
    }
  } catch (err) {
    console.error('[push] permission request failed', err);
    return { ok: false, reason: 'error' };
  }

  if (deviceName) {
    try { localStorage.setItem('ak_push_device_name', deviceName); } catch (_) { /* ok */ }
  }

  const status = await syncSubscription({ prompt: true });
  if (status === 'synced') return { ok: true, reason: 'synced' };
  if (status === 'limit') return { ok: false, reason: 'device_limit' };
  return { ok: false, reason: 'error' };
}

/**
 * Turn push off everywhere for this account, or for one device.
 * The subscription is also dropped from PushManager so the browser stops
 * waking the service worker for an endpoint we no longer address.
 */
export async function disablePush(targetDocId = null) {
  const user = auth.currentUser;
  if (!user) return { ok: false, reason: 'signed_out' };

  try {
    if (!targetDocId) {
      const snap = await getDocs(
        query(collection(db, 'pushSubscriptions'), where('userId', '==', user.uid))
      );
      for (const d of snap.docs) await deleteDoc(d.ref).catch(() => {});
    } else {
      // Ownership is re-checked by rules; this is a convenience check so the
      // UI fails loudly rather than silently doing nothing.
      const ref = doc(db, 'pushSubscriptions', targetDocId);
      const snap = await getDoc(ref);
      if (snap.exists() && snap.data().userId === user.uid) {
        await deleteDoc(ref);
      }
    }

    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      await sub?.unsubscribe();
    } catch (_) { /* best effort */ }

    try { localStorage.removeItem(ENDPOINT_CACHE); } catch (_) { /* ok */ }
    return { ok: true };
  } catch (err) {
    console.error('[push] disable failed', err);
    return { ok: false, reason: 'error' };
  }
}

async function retireLocalRecord(reason) {
  const user = auth.currentUser;
  if (!user) return;
  try {
    const ref = doc(db, 'pushSubscriptions', docIdFor(user.uid));
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    await deleteDoc(ref);
    console.info('[push] retired subscription:', reason);
  } catch (_) { /* not fatal */ }
}

/** Devices registered to this account, newest first. */
export async function listDevices() {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(
      query(
        collection(db, 'pushSubscriptions'),
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        limit(MAX_PUSH_DEVICES + 4)
      )
    );
    const localId = deviceId();
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        deviceName: data.deviceName || 'Unknown device',
        platform: data.platform || '',
        browser: data.browser || '',
        isActive: data.isActive !== false,
        permissionStatus: data.permissionStatus || 'unknown',
        failCount: data.failCount || 0,
        createdAt: data.createdAt?.toDate?.() || null,
        lastUsedAt: data.lastUsedAt?.toDate?.() || null,
        isThisDevice: d.id === `${user.uid}_${localId}`
      };
    });
  } catch (err) {
    console.error('[push] listDevices failed', err);
    return [];
  }
}

// ─── Preferences ─────────────────────────────────────────────────────
// Shape: { push: boolean, categories: { [categoryId]: boolean } }
//
// A category key that is ABSENT means "on" — for `security` that also means
// "not user-overridable", because it is never read back. Only an explicit
// `false` suppresses a bucket. Keeping absence = on means an account that
// has never touched these settings behaves exactly like the default.

export const DEFAULT_PREFS = {
  push: true,
  categories: {}
};

const defaults = () => ({ push: true, categories: {} });

/**
 * Read this account's notification preferences, merged over defaults.
 * Fails soft: no document yet must not look like "everything is off".
 */
export async function getPrefs() {
  const user = auth.currentUser;
  if (!user) return defaults();
  try {
    const snap = await getDoc(doc(db, 'notificationPrefs', user.uid));
    if (!snap.exists()) return defaults();
    const d = snap.data();
    return {
      push: d.push !== false,
      categories: sanitizeCategories(d.categories)
    };
  } catch (err) {
    console.error('[push] getPrefs failed', err);
    return defaults();
  }
}

/**
 * Drop anything the caller should not be able to persist.
 *
 * `security` is removed entirely rather than forced to `true`: the absence
 * of a key is what the sender treats as "on and locked", and not storing it
 * at all means a tampered preference document contains no suppression for
 * security in the first place.
 */
function sanitizeCategories(categories) {
  const out = {};
  if (!categories || typeof categories !== 'object') return out;
  for (const [key, value] of Object.entries(categories)) {
    if (!/^[a-z]{3,20}$/.test(key)) continue;   // unknown bucket
    if (typeof value !== 'boolean') continue;   // only an explicit on/off
    if (key === 'security') continue;           // locked
    out[key] = value;
  }
  return out;
}

/**
 * Persist preferences.
 * Returns the saved object so the UI can render exactly what stuck.
 */
export async function savePrefs(prefs) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in to change notification settings.');

  const payload = {
    push: prefs.push !== false,
    categories: sanitizeCategories(prefs.categories),
    updatedAt: serverTimestamp()
  };

  await setDoc(doc(db, 'notificationPrefs', user.uid), payload, { merge: true });

  // Deliberately does NOT delete the device subscriptions. The sender skips
  // everything on `master_off`, so nothing is delivered either way — but
  // keeping the records means switching push back on resumes every device
  // immediately instead of making the user re-enable each one by hand.
  return { push: payload.push, categories: payload.categories };
}

/**
 * Called from the shell on load.
 *
 * Deliberately does nothing unless permission is already granted, so that
 * merely visiting a page can never produce a permission dialog.
 */
export async function autoSyncIfGranted() {
  if (!pushSupported()) return;
  if (Notification.permission === 'default') return; // never prompt here
  if (Notification.permission === 'denied') {
    await retireLocalRecord('permission_denied').catch(() => {});
    return;
  }
  await syncSubscription({ prompt: false }).catch(() => {});
}
