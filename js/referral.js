// ─── Referral system: shared client helpers ──────────────────────────
// FREE-PLAN TRUST MODEL (same as the rest of AfnoKamai):
//  • This module handles CODES, LINKS, CAPTURE and ATTRIBUTION writes that
//    are validated server-side by firestore.rules (format checks, uniqueness,
//    self-referral block, one-time ownership, deterministic document IDs).
//  • REFERRAL REWARD AMOUNTS are NEVER calculated here. Rewards are created
//    exclusively by the admin-authoritative path in js/admin-actions.js
//    (processReferralReward) around the Task → Approved event, using
//    config/referral as the single source of truth for reward values.
//  • Nothing in this file writes money, wallets or transactions.

import { auth, db } from './firebase.js';
import {
  doc, getDoc, setDoc, updateDoc, runTransaction, writeBatch, serverTimestamp
} from 'firebase/firestore';

export const CODE_PREFIX = 'AFK-';
// Unambiguous alphabet — no 0/O/1/I, so codes survive being read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_REGEX = /^AFK-[A-HJ-NP-Z2-9]{8}$/;
export const HANDLE_REGEX = /^[a-z0-9][a-z0-9._-]{2,29}$/;

// Mirrors the reserved-handle list in firestore.rules — keep both in sync.
export const RESERVED_HANDLES = [
  'admin', 'administrator', 'admins', 'support', 'help', 'helpcenter', 'contact',
  'login', 'signin', 'signup', 'register', 'dashboard', 'settings', 'profile',
  'referral', 'referrals', 'invite', 'invites', 'reward', 'rewards', 'promo', 'promos',
  'api', 'system', 'official', 'afnokamai', 'www', 'mail', 'email', 'root',
  'staff', 'moderator', 'mod', 'superuser', 'billing', 'payments', 'pay', 'wallet',
  'withdraw', 'earn', 'tasks', 'task', 'chat', 'security', 'auth', 'account', 'accounts',
  'me', 'about', 'blog', 'news', 'legal', 'privacy', 'terms', 'status',
  'dev', 'debug', 'test', 'staging', 'index', 'home', 'static', 'assets', 'public',
  'files', 'docs', 'guide', 'faq', 'press', 'careers', 'jobs', 'partners', 'affiliates'
];

// localStorage keys. The CAPTURED code survives navigation so the signup
// form can prefill; the PENDING code is consumed exactly once at the end of
// the registration chain (profile setup), when attribution is finalized.
export const REF_STORAGE = { captured: 'ak_ref_code', pending: 'ak_ref_pending' };

// Display defaults — the authoritative values live in config/referral
// (admin-managed). These mirror the published program so the page never
// shows fake data when the config document has not been written yet.
export const DEFAULT_REFERRAL_CONFIG = {
  enabled: true,
  milestoneTasks: 2,
  milestoneRewardPaisa: 1500,
  recurringRewardPaisa: 500,
  maxReferralsPerDevice: 5,
  maxReferralsPerWeek: 10,
  inactiveDays: 14
};

// ── Codes & handles ──────────────────────────────────────────────────

function randomChars(len, alphabet) {
  const out = [];
  const buf = new Uint32Array(len);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 4294967296);
  for (let i = 0; i < len; i++) out.push(alphabet[buf[i] % alphabet.length]);
  return out.join('');
}

/** AFK-XXXXXXXX — unique, stable, case-normalized, safe to share. */
export function generateCode() {
  return CODE_PREFIX + randomChars(8, CODE_ALPHABET);
}

/**
 * Case-normalized code. Accepts "afk-ab12cd34", "AB12CD34" and the full
 * "AFK-AB12CD34" forms; anything else returns ''.
 */
export function normalizeCode(raw) {
  let v = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!v) return '';
  if (!v.startsWith(CODE_PREFIX)) v = CODE_PREFIX + v.replace(/[^A-Z0-9]/g, '');
  v = v.replace(/[^A-Z0-9-]/g, '');
  return CODE_REGEX.test(v) ? v : '';
}

export const isValidCode = (c) => CODE_REGEX.test(String(c || ''));

export function normalizeHandle(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
}

export function isValidHandle(h) {
  return HANDLE_REGEX.test(String(h || '')) && !RESERVED_HANDLES.includes(String(h || ''));
}

/** Cleanest public URL compatible with the hosting rewrite /ref/** → ref.html */
export function referralLink(code) {
  return `https://afnokamai.web.app/ref/${encodeURIComponent(String(code || '').toUpperCase())}`;
}

// ── Code capture (link → signup → profile setup) ─────────────────────

export function storeCapturedCode(code) {
  try { if (code) localStorage.setItem(REF_STORAGE.captured, String(code)); } catch (_) { /* private mode */ }
}
export function readCapturedCode() {
  try { return localStorage.getItem(REF_STORAGE.captured) || ''; } catch (_) { return ''; }
}
export function storePendingCode(code) {
  try { if (code) localStorage.setItem(REF_STORAGE.pending, String(code)); else localStorage.removeItem(REF_STORAGE.pending); } catch (_) { /* private mode */ }
}
export function readPendingCode() {
  try { return localStorage.getItem(REF_STORAGE.pending) || ''; } catch (_) { return ''; }
}
export function clearReferralStorage() {
  try {
    localStorage.removeItem(REF_STORAGE.captured);
    localStorage.removeItem(REF_STORAGE.pending);
  } catch (_) { /* private mode */ }
}

// ── Clipboard (honest: never claims success when the copy failed) ────

export async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) { return false; }
}

// ── Privacy-conscious device signature (anti-abuse signal) ───────────
// Coarse browser attributes, hashed with SHA-256 to 128 bits. The raw
// values are never stored, never shown to users, and live only on the
// referral record for admin "Review recommended" checks. Shared Wi-Fi,
// school or family networks alone are NEVER treated as proof of abuse.

export async function deviceSignature() {
  try {
    const raw = [
      navigator.userAgent || '',
      (typeof screen !== 'undefined' && screen) ? `${screen.width}x${screen.height}x${screen.colorDepth || ''}` : '',
      (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '',
      navigator.language || '',
      navigator.platform || '',
      (navigator.hardwareConcurrency || '') + ':' + (navigator.deviceMemory || '')
    ].join('|');
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 5381;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
    return 'f' + h.toString(16).padStart(8, '0') + Date.now().toString(16).slice(-4);
  } catch (_) { return ''; }
}

// ── Referral program configuration (admin-managed, read-only here) ───

export async function fetchReferralConfig() {
  try {
    const snap = await getDoc(doc(db, 'config', 'referral'));
    const d = snap.exists() ? (snap.data() || {}) : {};
    const int = (v, fb) => (Number.isInteger(v) && v > 0 ? v : fb);
    return {
      enabled: d.enabled !== false,
      milestoneTasks: int(d.milestoneTasks, DEFAULT_REFERRAL_CONFIG.milestoneTasks),
      milestoneRewardPaisa: int(d.milestoneRewardPaisa, DEFAULT_REFERRAL_CONFIG.milestoneRewardPaisa),
      recurringRewardPaisa: int(d.recurringRewardPaisa, DEFAULT_REFERRAL_CONFIG.recurringRewardPaisa),
      maxReferralsPerDevice: int(d.maxReferralsPerDevice, DEFAULT_REFERRAL_CONFIG.maxReferralsPerDevice),
      maxReferralsPerWeek: int(d.maxReferralsPerWeek, DEFAULT_REFERRAL_CONFIG.maxReferralsPerWeek),
      inactiveDays: int(d.inactiveDays, DEFAULT_REFERRAL_CONFIG.inactiveDays)
    };
  } catch (_) {
    return { ...DEFAULT_REFERRAL_CONFIG };
  }
}

// ── Referral identity: claim code + optional vanity handle ───────────
// One-time claim, transactional. Rules enforce: the code doc maps to this
// uid, the handle is unique/unreserved, and the user doc carries no code
// yet — so ownership can never be transferred or re-assigned by a client.

export async function claimReferralIdentity({ handle = '' } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be logged in.');
  const cleanHandle = normalizeHandle(handle);
  if (cleanHandle && !isValidHandle(cleanHandle)) {
    throw new Error('That referral handle is not valid. Use 3–30 letters, numbers, dots, dashes or underscores.');
  }
  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) throw new Error('Account profile not found. Please refresh the page and try again.');
  const existing = snap.data() || {};
  if (existing.referralCode) {
    // Already claimed — adopt the stored code (the handle claim below still
    // applies when one was requested and none exists yet).
    if (cleanHandle && !existing.referralHandle) {
      await tryClaimHandle(user.uid, cleanHandle, existing.referralCode);
      return { code: existing.referralCode, handle: cleanHandle };
    }
    return { code: existing.referralCode, handle: existing.referralHandle || '' };
  }

  let code = generateCode();
  let guard = 0;
  // Best-effort uniqueness pre-check; rules + the transaction are authoritative.
  while ((await getDoc(doc(db, 'referralCodes', code))).exists() && guard++ < 6) {
    code = generateCode();
  }

  try {
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(userRef);
      const f = fresh.data() || {};
      if (f.referralCode) {
        code = f.referralCode;
        return; // claimed in another tab — nothing to do
      }
      const codeRef = doc(db, 'referralCodes', code);
      const codeSnap = await tx.get(codeRef);
      if (codeSnap.exists()) throw new Error('collision');
      if (cleanHandle) {
        const hRef = doc(db, 'referralHandles', cleanHandle);
        const hSnap = await tx.get(hRef);
        if (hSnap.exists()) throw new Error('That referral handle was just taken by someone else. Please try another.');
        tx.set(hRef, { handle: cleanHandle, userId: user.uid, code, createdAt: serverTimestamp() });
      }
      tx.set(codeRef, { code, userId: user.uid, createdAt: serverTimestamp() });
      tx.update(userRef, {
        referralCode: code,
        referralHandle: cleanHandle,
        referralCodeSetAt: serverTimestamp()
      });
    });
  } catch (e) {
    if (e && e.message === 'collision') {
      // Extremely unlikely (32^8 space) — regenerate once and retry.
      return claimReferralIdentity({ handle });
    }
    const msg = String(e && e.message || '');
    if (msg && !String(e.code)) throw e;
    if (e && e.code === 'permission-denied') {
      throw new Error('Your referral code could not be created right now. Please try again in a moment.');
    }
    throw new Error('Could not create your referral code. Please try again.');
  }
  return { code, handle: cleanHandle };
}

async function tryClaimHandle(uid, handle, code) {
  try {
    await runTransaction(db, async (tx) => {
      const hRef = doc(db, 'referralHandles', handle);
      const hSnap = await tx.get(hRef);
      if (hSnap.exists()) throw new Error('taken');
      const userRef = doc(db, 'users', uid);
      const uSnap = await tx.get(userRef);
      if ((uSnap.data() || {}).referralHandle) throw new Error('has-handle');
      tx.set(hRef, { handle, userId: uid, code, createdAt: serverTimestamp() });
      tx.update(userRef, { referralHandle: handle });
    });
  } catch (e) {
    if (e && e.message === 'taken') throw new Error('That referral handle was just taken by someone else. Please try another.');
    if (e && e.message === 'has-handle') return; // another tab set one first
  }
}

/** Change the vanity handle. Ownership (referrerId) never changes with it. */
export async function setReferralHandle(rawHandle) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be logged in.');
  const handle = normalizeHandle(rawHandle);
  if (!isValidHandle(handle)) {
    throw new Error('That referral handle is not valid. Use 3–30 letters, numbers, dots, dashes or underscores.');
  }
  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);
  const p = snap.exists() ? (snap.data() || {}) : {};
  if (!p.referralCode) throw new Error('Create your referral code first.');
  if ((p.referralHandle || '') === handle) return { ok: true, handle };
  try {
    await runTransaction(db, async (tx) => {
      const hRef = doc(db, 'referralHandles', handle);
      const hSnap = await tx.get(hRef);
      if (hSnap.exists()) throw new Error('taken');
      const old = p.referralHandle ? doc(db, 'referralHandles', p.referralHandle) : null;
      tx.set(hRef, { handle, userId: user.uid, code: p.referralCode, createdAt: serverTimestamp() });
      if (old) tx.delete(old);
      tx.update(userRef, { referralHandle: handle });
    });
  } catch (e) {
    if (e && e.message === 'taken') throw new Error('That referral handle was just taken by someone else. Please try another.');
    if (e && e.code === 'permission-denied') throw new Error('Your referral handle could not be changed right now. Please try again in a moment.');
    throw new Error('Could not change your referral handle. Please try again.');
  }
  return { ok: true, handle };
}

// ── Referral attribution (finalize) ──────────────────────────────────
// Called ONCE, at the end of the registration chain (profile setup done,
// email verified). Creates the permanent relationship, the joined event
// and the inviter's join notification — all validated by firestore.rules:
//   • code → referrer mapping must be real
//   • self-referral is rejected server-side
//   • deterministic referral doc id = referrerId_uid (one-time ownership)
//   • the user doc's referredBy branch only fires when it is still empty
// Rewards are NOT touched here — they are processed later, server-side,
// around the referred user's task approvals.

export async function finalizeReferral(rawCode) {
  const user = auth.currentUser;
  const code = normalizeCode(rawCode);
  if (!user || !code || !isValidCode(code)) {
    clearReferralStorage();
    return { ok: true, skipped: true, reason: 'no-code' };
  }
  if (!user.emailVerified) {
    return { ok: true, skipped: true, reason: 'unverified' }; // keep the pending code
  }
  try {
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    const profile = userSnap.exists() ? (userSnap.data() || {}) : {};
    if (profile.referredBy) {
      clearReferralStorage();
      return { ok: true, skipped: true, reason: 'already-attributed' };
    }
    const codeSnap = await getDoc(doc(db, 'referralCodes', code));
    if (!codeSnap.exists()) {
      clearReferralStorage();
      return { ok: true, skipped: true, reason: 'invalid-code' };
    }
    const referrerId = codeSnap.data().userId || '';
    if (!referrerId || referrerId === user.uid) {
      // Self-referral: record nothing. Rules would reject it as well.
      clearReferralStorage();
      return { ok: true, skipped: true, reason: 'self-referral' };
    }
    const referralId = `${referrerId}_${user.uid}`;
    if ((await getDoc(doc(db, 'referrals', referralId))).exists()) {
      clearReferralStorage();
      return { ok: true, skipped: true, reason: 'already-attributed' };
    }

    const referredName = String(profile.fullName || '').slice(0, 60);
    const deviceSig = await deviceSignature();
    // firestore.rules gate attribution on `request.auth.token.email_verified`.
    // `reload()` updates the USER object but reuses the cached access token, so
    // a token minted before the user clicked the verification link still carries
    // email_verified=false. Mint a fresh token so the client and the rules agree.
    try {
      await user.getIdToken(true);
    } catch (_) {
      return { ok: false, reason: 'network' }; // keep the pending code, retry later
    }
    const batch = writeBatch(db);
    batch.set(doc(db, 'referrals', referralId), {
      referrerId,
      referredUserId: user.uid,
      referredName,
      referralCode: code,
      status: 'joined',
      approvedTaskCount: 0,
      totalEarnedPaisa: 0,
      milestoneReached: false,
      milestoneRewardTransactionId: null,
      rewardsSuspended: false,
      underReview: false,
      deviceSig,
      createdAt: serverTimestamp(),
      lastRewardAt: null,
      lastCountedAt: null
    });
    batch.set(doc(db, 'referrals', referralId, 'events', 'joined'), {
      referrerId,
      referredUserId: user.uid,
      type: 'joined',
      title: `${referredName || 'A new member'} joined using your referral`,
      amountPaisa: 0,
      taskId: '',
      createdAt: serverTimestamp()
    });
    batch.update(doc(db, 'users', user.uid), {
      referredBy: referrerId,
      referredByCode: code,
      referralJoinedAt: serverTimestamp()
    });
    // Exactly-once join notification for the inviter (deterministic id).
    batch.set(doc(db, 'notifications', `referral_joined_${referrerId}_${user.uid}`), {
      userId: referrerId,
      audience: 'user',
      type: 'referral_joined',
      title: 'New referral joined 🎉',
      body: `${referredName || 'Someone'} joined AfnoKamai using your referral link. When they complete their first 2 approved tasks, you'll earn your first referral reward.`,
      link: 'referral.html',
      tone: 'green',
      icon: 'users',
      read: false,
      createdAt: serverTimestamp()
    });
    await batch.commit();
    clearReferralStorage();
    return { ok: true, referrerId, code };
  } catch (e) {
    const code2 = e && e.code;
    if (code2 === 'permission-denied') {
      // Rules rejected the attribution (self-referral, already attributed,
      // code mismatch…) — never retry blindly, never fake success.
      clearReferralStorage();
      return { ok: true, skipped: true, reason: 'rejected' };
    }
    if (code2 === 'failed-precondition') {
      // Index still building — keep the pending code so a later visit retries.
      return { ok: false, reason: 'index' };
    }
    return { ok: false, reason: 'network' };
  }
}

// ── Status labels (display-only) ─────────────────────────────────────
// Document `status` stays 'joined'/'started' for queries; the richer labels
// below are derived from the approved task count so users always see the
// truth: 0 → Joined, 1 → Getting Started, 2 → Milestone Reached, 3+ → Active.
export function referralMemberStatus(r = {}) {
  const tasks = r.approvedTaskCount || 0;
  if (r.underReview) return { label: 'Under review', tone: 'amber' };
  if (r.rewardsSuspended) return { label: 'Rewards on hold', tone: 'red' };
  if (r.milestoneReached || tasks >= 2) return tasks >= 3
    ? { label: 'Active', tone: 'blue' }
    : { label: 'Milestone Reached', tone: 'green' };
  if (tasks === 1) return { label: 'Getting Started', tone: 'amber' };
  return { label: 'Joined', tone: 'gray' };
}
