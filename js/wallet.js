// ─── Wallet + transaction helpers ────────────────────────────────────
import { db } from './firebase.js';
import {
  doc, onSnapshot, collection, query, where, orderBy, limit,
  startAfter, getDocs, getDoc
} from 'firebase/firestore';
import { TX_TYPE, TX_STATUS } from './utils.js';

export function watchWallet(uid, cb) {
  return onSnapshot(doc(db, 'wallets', uid), (snap) => {
    cb(snap.exists() ? snap.data() : {
      availablePaisa: 0, holdPaisa: 0, pendingWithdrawalPaisa: 0,
      earnedPaisa: 0, withdrawnPaisa: 0
    });
  }, () => cb(null));
}

export function watchPlatformConfig(cb) {
  return onSnapshot(doc(db, 'config', 'platform'), (snap) => {
    const d = snap.data() || {};
    cb({
      holdDays: d.holdDays || 3,
      minWithdrawalPaisa: d.minWithdrawalPaisa || 50000,
      supportEmail: d.supportEmail || 'support@afnokamai.web.app'
    });
  }, () => cb({ holdDays: 3, minWithdrawalPaisa: 50000, supportEmail: 'support@afnokamai.web.app' }));
}

/** All of the user's currently-held (locked) reward transactions, soonest release first. */
export async function fetchHoldTransactions(uid) {
  const q = query(
    collection(db, 'transactions'),
    where('userId', '==', uid),
    where('status', '==', 'hold'),
    orderBy('availableAt', 'asc'),
    limit(50)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Computed wallet summary (free-plan architecture).
 * "Withdrawable" = settled availablePaisa + holds whose availableAt has
 * passed (server-written timestamps are the authority; the admin client
 * sweeps matured holds into availablePaisa).
 */
export async function fetchWalletSummary(uid) {
  const wSnap = await getDoc(doc(db, 'wallets', uid));
  const w = wSnap.exists() ? wSnap.data() : {
    availablePaisa: 0, holdPaisa: 0, earnedPaisa: 0, withdrawnPaisa: 0
  };
  const holds = await fetchHoldTransactions(uid);
  const now = Date.now();
  const unmatured = holds.filter((t) => t.availableAt && t.availableAt.toMillis() > now);
  const matured = holds.filter((t) => t.availableAt && t.availableAt.toMillis() <= now);
  const maturedPaisa = matured.reduce((s, t) => s + (t.amountPaisa || 0), 0);
  return {
    availablePaisa: w.availablePaisa || 0,
    holdUnmaturedPaisa: unmatured.reduce((s, t) => s + (t.amountPaisa || 0), 0),
    maturedPaisa,
    withdrawablePaisa: (w.availablePaisa || 0) + maturedPaisa,
    earnedPaisa: w.earnedPaisa || 0,
    withdrawnPaisa: w.withdrawnPaisa || 0,
    unmaturedItems: unmatured,
    maturedItems: matured,
    nextReleaseAt: unmatured.length ? unmatured[0].availableAt : null
  };
}

/**
 * Paginated transaction history.
 * filter: { type, status } — pass '' for all. Returns { items, cursor }.
 */
export async function fetchTransactionsPage(uid, { type = '', status = '', pageSize = 25, cursor = null } = {}) {
  const parts = [collection(db, 'transactions'), where('userId', '==', uid)];
  if (type) parts.push(where('type', '==', type));
  if (status) parts.push(where('status', '==', status));
  parts.push(orderBy('createdAt', 'desc'), limit(pageSize));
  if (cursor) parts.push(startAfter(cursor));
  const snap = await getDocs(query(...parts));
  return { items: snap.docs.map((d) => ({ id: d.id, ...d.data() })), cursor: snap.docs[snap.docs.length - 1] || null };
}

/** Transactions from the last N days (for charts). */
export async function fetchRecentTransactions(uid, days = 30, max = 500) {
  const since = new Date(Date.now() - days * 86400 * 1000);
  const q = query(
    collection(db, 'transactions'),
    where('userId', '==', uid),
    where('createdAt', '>=', since),
    orderBy('createdAt', 'desc'),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function txTypeMeta(t) {
  return TX_TYPE[t] || { label: t || 'Transaction', icon: 'info' };
}
export function txStatusMeta(s) {
  return TX_STATUS[s] || { label: s || '—', tone: 'gray' };
}
