// ─── Admin-side operations (free-plan architecture) ──────────────────
// The admin's authenticated client (authorized by the `admin` custom
// claim + firestore.rules) performs every financial write as an atomic
// Firestore transaction. Includes the idempotent hold-release sweep.

import { auth, db } from './firebase.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, collection,
  query, where, orderBy, limit, runTransaction, serverTimestamp,
  Timestamp, increment
} from 'firebase/firestore';

const nprFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const npr = (paisa) => `रु ${nprFmt.format(Math.abs(paisa) / 100)}`;

async function requireAdmin() {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be logged in.');
  const token = await user.getIdTokenResult();
  if (!token.claims || token.claims.admin !== true) {
    throw new Error('Administrator access is required for this action.');
  }
  const meSnap = await getDoc(doc(db, 'users', user.uid));
  return { uid: user.uid, email: user.email, name: meSnap.data()?.fullName || user.email };
}

function ruleError(e, fallback) {
  const code = e && e.code;
  if (code === 'permission-denied') return new Error(fallback || "You don't have permission to perform this action.");
  if (code === 'failed-precondition') return new Error('A database index is still building. Try again in a few minutes.');
  return new Error((e && e.message) || fallback || 'Something went wrong. Please try again.');
}

async function getConfig() {
  const snap = await getDoc(doc(db, 'config', 'platform'));
  const d = snap.data() || {};
  return {
    holdDays: Number.isFinite(d.holdDays) ? d.holdDays : 3,
    minWithdrawalPaisa: Number.isFinite(d.minWithdrawalPaisa) ? d.minWithdrawalPaisa : 50000
  };
}

/**
 * Website notification. `priority` drives the surfacing rules in `shell.js`:
 *  - 'urgent' → modal popup with an "Open chat" button (task assignments)
 *  - 'high'   → live toast + badge (admin messages, clarification requests)
 *  - omitted  → badge only
 */
async function notify(userId, { type, title, body, link, tone, icon: ic, amountPaisa, priority }) {
  try {
    await addDoc(collection(db, 'notifications'), {
      userId,
      audience: userId === '__admins__' ? 'admin' : 'user',
      type, title, body: body || '', link: link || '',
      tone: tone || 'gray', icon: ic || 'info',
      ...(amountPaisa !== undefined ? { amountPaisa } : {}),
      ...(priority ? { priority } : {}),
      read: false, createdAt: serverTimestamp()
    });
  } catch (_) { /* non-fatal */ }
}

async function audit(admin, action, targetType, targetId, metadata = {}) {
  try {
    await addDoc(collection(db, 'adminLogs'), {
      adminId: admin.uid, adminEmail: admin.email,
      action, targetType: targetType || '', targetId: targetId || '',
      metadata, createdAt: serverTimestamp()
    });
  } catch (_) { /* non-fatal */ }
}

/** System notice inside the user's support conversation (admin-authored). */
async function systemMsg(uid, text) {
  try {
    const convRef = doc(db, 'conversations', uid);
    await addDoc(collection(convRef, 'messages'), {
      senderId: 'system', senderRole: 'system', senderName: 'AfnoKamai',
      type: 'system', clientRef: '', text, createdAt: serverTimestamp()
    });
    await updateDoc(convRef, {
      lastMessage: text.slice(0, 80), lastType: 'system',
      lastSenderId: 'system', lastSenderRole: 'system',
      lastMessageAt: serverTimestamp(), unreadForUser: increment(1)
    });
  } catch (_) { /* conversation may not exist yet */ }
}

// ═══════════════ Hold release sweep (idempotent) ═════════════════════

/**
 * Releases every matured hold transaction (availableAt <= now) into the
 * user's available balance. Safe to run repeatedly — the transaction
 * guard re-checks the status. Pass a userId to sweep one user.
 */
export async function sweepHolds(userId = null) {
  const parts = [collection(db, 'transactions'), where('status', '==', 'hold'), where('availableAt', '<=', Timestamp.now())];
  if (userId) parts.push(where('userId', '==', userId));
  parts.push(orderBy('availableAt', 'asc'), limit(200));
  const snap = await getDocs(query(...parts));
  let released = 0;
  for (const docSnap of snap.docs) {
    try {
      const data = docSnap.data();
      // The transaction reports whether it actually moved money. A concurrent
      // sweep (every admin page load triggers one) can win the race and leave
      // this one as a no-op — notifying in that case would send a duplicate
      // "funds released" alert, or one for a wallet that was never updated.
      const didRelease = await runTransaction(db, async (tx) => {
        const fresh = await tx.get(docSnap.ref);
        if (!fresh.exists() || fresh.data().status !== 'hold') return false;
        const walletRef = doc(db, 'wallets', data.userId);
        const w = await tx.get(walletRef);
        if (!w.exists()) return false;
        tx.update(docSnap.ref, { status: 'available', releasedAt: serverTimestamp() });
        tx.update(walletRef, {
          holdPaisa: increment(-data.amountPaisa),
          availablePaisa: increment(data.amountPaisa),
          updatedAt: serverTimestamp()
        });
        return true;
      });
      if (!didRelease) continue;
      released++;
      const isReferral = String(data.type || '').startsWith('referral');
      await notify(data.userId, {
        type: 'reward_released', tone: 'green', icon: 'unlock',
        link: isReferral ? 'referral.html' : 'withdraw.html',
        title: isReferral ? 'Referral reward released 🎉' : 'Funds released 🎉',
        body: isReferral
          ? `${npr(data.amountPaisa)} referral reward has left the hold period and is now withdrawable.`
          : `${npr(data.amountPaisa)} has left the hold period and is now withdrawable.`,
        amountPaisa: data.amountPaisa
      });
    } catch (e) {
      console.warn('sweep failed for', docSnap.id, e);
    }
  }
  return released;
}

// ═══════════════════════ Task review ═════════════════════════════════

/**
 * action: assign | cancel | approve | reject | clarify
 * The ACTIVE assignment document always has id `${userId}_${taskId}`;
 * final decisions move it to a history document (freeing the active id).
 */
export async function reviewTask({ assignmentId, action, reason }) {
  const admin = await requireAdmin();
  const cleanReason = String(reason || '').slice(0, 500).trim();
  if (['cancel', 'reject', 'clarify'].includes(action) && cleanReason.length < 5) {
    throw new Error('A clear reason is required.');
  }

  const ref = doc(db, 'taskAssignments', assignmentId);
  const asgSnap = await getDoc(ref);
  if (!asgSnap.exists()) throw new Error('Task assignment not found.');
  const asg = asgSnap.data();

  let result = { ok: true };

  if (action === 'assign') {
    if (asg.status !== 'requested') throw new Error('This request was already handled.');
    await runTransaction(db, async (tx) => {
      // All reads MUST happen before the first write — Firestore rejects a
      // transaction that mixes them in the other order.
      const fresh = await tx.get(ref);
      if (fresh.data().status !== 'requested') throw new Error('This request was already handled.');
      const taskRef = doc(db, 'tasks', asg.taskId);
      const taskSnap = await tx.get(taskRef);
      const t = taskSnap.exists() ? taskSnap.data() : null;

      // Reads done — from here on, only writes.
      tx.update(ref, {
        status: 'assigned', assignedAt: serverTimestamp(),
        reviewedBy: admin.uid, reviewedByName: admin.name
      });
      tx.update(doc(db, 'users', asg.userId), { 'stats.assigned': increment(1) });
      if (t) {
        const taken = (t.slotsTaken || 0) + 1;
        tx.update(taskRef, {
          slotsTaken: taken,
          ...(t.slotsTotal > 0 && taken >= t.slotsTotal ? { status: 'full' } : {})
        });
      }
    });
    await systemMsg(asg.userId, `📋 Task assigned: “${asg.title}” — reward ${npr(asg.rewardPaisa)}.\n\nInstructions:\n${asg.instructions || 'See the task details in the Earn page.'}${asg.evidenceRequired ? '\n\nEvidence is required: send a screenshot/photo in this chat before submitting.' : ''}`);
    // Highest priority in the app: the acceptance is what unlocks the private
    // instructions, and those live in the chat — so deep-link straight to it.
    await notify(asg.userId, {
      type: 'task_assigned', tone: 'blue', icon: 'briefcase', link: 'chat.html',
      priority: 'urgent',
      title: 'Task assigned — open chat',
      body: `“${asg.title}” was accepted for you. Your instructions and further private details are waiting in the chat.`
    });
    await audit(admin, 'task_assigned', 'taskAssignment', assignmentId, { userId: asg.userId });
    return result;
  }

  if (action === 'clarify') {
    if (asg.status !== 'submitted') throw new Error('Only submitted tasks can be clarified.');
    await updateDoc(ref, {
      status: 'clarification', clarificationReason: cleanReason,
      reviewedAt: serverTimestamp(), reviewedBy: admin.uid, reviewedByName: admin.name
    });
    await systemMsg(asg.userId, `⚠️ Clarification needed for “${asg.title}”:\n${cleanReason}`);
    await notify(asg.userId, {
      type: 'task_rejected', tone: 'amber', icon: 'alert', link: 'chat.html',
      priority: 'high',
      title: 'Clarification needed — reply in chat',
      body: `“${asg.title}”: ${cleanReason}`
    });
    await audit(admin, 'task_clarification', 'taskAssignment', assignmentId, { userId: asg.userId, reason: cleanReason });
    return result;
  }

  // Final decisions (cancel / reject / approve) — move to history.
  const isFinal = ['cancel', 'reject', 'approve'].includes(action);
  if (!isFinal) throw new Error('Unknown action.');

  const config = await getConfig();
  const holdUntil = Timestamp.fromMillis(Date.now() + config.holdDays * 86400000);
  const historyRef = doc(db, 'taskAssignments', `${assignmentId}__h${Date.now()}`);

  if (action === 'approve') {
    const reward = asg.rewardPaisa;
    if (!Number.isInteger(reward) || reward <= 0) throw new Error('Invalid reward on assignment.');
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists() || fresh.data().status !== 'submitted') throw new Error('This task was already reviewed.');
      const walletRef = doc(db, 'wallets', asg.userId);
      const w = await tx.get(walletRef);
      if (!w.exists()) throw new Error('User wallet not found.');
      tx.update(walletRef, {
        holdPaisa: increment(reward),
        earnedPaisa: increment(reward),
        updatedAt: serverTimestamp()
      });
      const txRef = doc(collection(db, 'transactions'));
      tx.set(txRef, {
        transactionId: txRef.id, userId: asg.userId,
        type: 'task_reward', amountPaisa: reward, status: 'hold',
        source: 'task_approval', referenceId: assignmentId,
        description: `Task reward: ${asg.title}`,
        availableAt: holdUntil, balanceAfterPaisa: null,
        createdAt: serverTimestamp(), createdBy: admin.uid
      });
      tx.update(doc(db, 'users', asg.userId), { 'stats.approved': increment(1) });
      // Archive the finished assignment, then remove the active document.
      // (No update on `ref` first: one mutation per document per transaction.)
      tx.set(historyRef, { ...fresh.data(), status: 'approved', holdUntil, reviewedAt: serverTimestamp(), reviewedBy: admin.uid, reviewedByName: admin.name, isHistory: true });
      tx.delete(ref);
    });
    await systemMsg(asg.userId, `✅ Task approved: “${asg.title}”. ${npr(reward)} was added to your hold balance and becomes withdrawable after the hold period.`);
    await notify(asg.userId, {
      type: 'reward_hold', tone: 'green', icon: 'coins', link: 'dashboard.html',
      title: 'Reward approved 🎉',
      body: `${npr(reward)} for “${asg.title}” is on hold and becomes withdrawable after the hold period.`,
      amountPaisa: reward
    });
    await audit(admin, 'task_approved', 'taskAssignment', assignmentId, { userId: asg.userId, rewardPaisa: reward });
    // ── Referral rewards ──────────────────────────────────────────────
    // The AUTHORITATIVE event for referral rewards is this approval.
    // processReferralReward is admin-authorized, idempotent (deterministic
    // reward IDs + count guard) and uses config/referral for amounts — the
    // client can never ask for a reward value. A failure here never breaks
    // the task approval itself; reconcileReferral backfills anything missed.
    try {
      await processReferralReward({
        admin,
        referredUserId: asg.userId,
        taskId: asg.taskId,
        assignmentId,
        title: asg.title
      });
    } catch (refErr) {
      console.warn('[reviewTask] referral reward processing failed (will reconcile):', refErr && refErr.code, refErr && refErr.message);
    }
    return result;
  }

  if (action === 'reject') {
    // Atomic: the status guard, the stat increment, the history archive and
    // the delete of the active document must all land together. Running them
    // separately let a crash between writes double-count `stats.rejected`, and
    // let a concurrent approve/reject both pass the guard.
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists() || fresh.data().status !== 'submitted') throw new Error('This task was already reviewed.');
      tx.update(doc(db, 'users', asg.userId), { 'stats.rejected': increment(1) });
      tx.set(historyRef, {
        ...fresh.data(), status: 'rejected', rejectionReason: cleanReason,
        reviewedAt: serverTimestamp(), reviewedBy: admin.uid, reviewedByName: admin.name, isHistory: true
      });
      tx.delete(ref);
    });
    await systemMsg(asg.userId, `❌ Task rejected: “${asg.title}”.\nReason: ${cleanReason}\nNo reward was added for this task.`);
    await notify(asg.userId, {
      type: 'task_rejected', tone: 'red', icon: 'x', link: 'earn.html',
      title: 'Task rejected',
      body: `“${asg.title}” was rejected: ${cleanReason}`
    });
    await audit(admin, 'task_rejected', 'taskAssignment', assignmentId, { userId: asg.userId, reason: cleanReason });
    return result;
  }

  // cancel (decline a request that was never assigned)
  await runTransaction(db, async (tx) => {
    const fresh = await tx.get(ref);
    // Only an unassigned request may be declined here: an `assigned` task has
    // already consumed a slot and needs a different (reject) path.
    if (!fresh.exists() || fresh.data().status !== 'requested') throw new Error('This request was already handled.');
    tx.set(historyRef, {
      ...fresh.data(), status: 'cancelled', rejectionReason: cleanReason,
      reviewedAt: serverTimestamp(), reviewedBy: admin.uid, reviewedByName: admin.name, isHistory: true
    });
    tx.delete(ref);
  });
  await systemMsg(asg.userId, `Your request for “${asg.title}” was declined.\nReason: ${cleanReason}`);
  await notify(asg.userId, {
    type: 'task_request_update', tone: 'gray', icon: 'x', link: 'earn.html',
    title: 'Task request declined',
    body: `“${asg.title}”: ${cleanReason}`
  });
  await audit(admin, 'task_request_cancelled', 'taskAssignment', assignmentId, { userId: asg.userId, reason: cleanReason });
  return result;
}

// ═══════════════════════ Withdrawal review ═══════════════════════════

export async function reviewWithdrawal({ withdrawalId, action, reason }) {
  if (!withdrawalId) throw new Error('Missing withdrawal id — refresh the page and try again.');
  const admin = await requireAdmin();
  const cleanReason = String(reason || '').slice(0, 500).trim();
  const wRef = doc(db, 'withdrawals', withdrawalId);
  const wSnap = await getDoc(wRef);
  if (!wSnap.exists()) throw new Error('Withdrawal not found.');
  const w = wSnap.data();
  const amount = w.amountPaisa;
  const lockRef = doc(db, 'activeWithdrawals', w.userId);

  if (action === 'under_review' || action === 'processing') {
    if (!['pending', 'under_review'].includes(w.status)) {
      throw new Error(`Cannot move a ${w.status} withdrawal to ${action}.`);
    }
    await updateDoc(wRef, { status: action, reviewedAt: serverTimestamp(), reviewedBy: admin.uid, reviewedByName: admin.name });
    await notify(w.userId, {
      type: 'withdrawal', tone: 'blue', icon: 'bank', link: 'withdraw.html',
      title: action === 'processing' ? 'Withdrawal is being processed' : 'Withdrawal under review',
      body: `${npr(amount)} to eSewa ${w.esewaName} is now ${action === 'processing' ? 'being processed' : 'under review'}.`
    });
    await audit(admin, `withdrawal_${action}`, 'withdrawal', withdrawalId, { userId: w.userId, amountPaisa: amount });
    return { ok: true };
  }

  if (action === 'completed') {
    if (['completed', 'rejected'].includes(w.status)) throw new Error('Withdrawal already finalized.');
    // Make sure matured holds are in the available balance first.
    await sweepHolds(w.userId);

    const walletRef = doc(db, 'wallets', w.userId);
    let afterBalance = 0;
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(wRef);
      if (['completed', 'rejected'].includes(fresh.data().status)) {
        throw new Error('Withdrawal already finalized.');
      }
      const walletSnap = await tx.get(walletRef);
      const available = walletSnap.data().availablePaisa || 0;
      if (available < amount) {
        throw new Error(`Insufficient available balance (${npr(available)}) — reject this withdrawal or wait for holds to mature.`);
      }
      afterBalance = available - amount;
      tx.update(wRef, {
        status: 'completed', reviewedAt: serverTimestamp(),
        reviewedBy: admin.uid, reviewedByName: admin.name,
        txId: withdrawalId
      });
      tx.update(walletRef, {
        availablePaisa: increment(-amount),
        withdrawnPaisa: increment(amount),
        updatedAt: serverTimestamp()
      });
      const txRef = doc(collection(db, 'transactions'));
      tx.set(txRef, {
        transactionId: txRef.id, userId: w.userId,
        type: 'withdrawal', amountPaisa: -amount, status: 'completed',
        source: 'esewa_withdrawal', referenceId: withdrawalId,
        description: `eSewa withdrawal to +977 ${w.esewaNumber}`,
        availableAt: null, balanceAfterPaisa: afterBalance,
        createdAt: serverTimestamp(), createdBy: admin.uid
      });
      tx.update(doc(db, 'users', w.userId), { 'stats.withdrawnPaisa': increment(amount) });
      tx.delete(lockRef);
    });
    await notify(w.userId, {
      type: 'withdrawal_completed', tone: 'green', icon: 'check', link: 'transactions.html',
      title: 'Withdrawal completed ✅',
      body: `${npr(amount)} has been sent to your eSewa account (${w.esewaName}, +977 ${w.esewaNumber}).`,
      amountPaisa: -amount
    });
    await audit(admin, 'withdrawal_completed', 'withdrawal', withdrawalId, { userId: w.userId, amountPaisa: amount });
    return { ok: true };
  }

  if (action === 'rejected') {
    if (cleanReason.length < 5) throw new Error('A rejection reason is required.');
    if (['completed', 'rejected'].includes(w.status)) throw new Error('Withdrawal already finalized.');
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(wRef);
      if (['completed', 'rejected'].includes(fresh.data().status)) {
        throw new Error('Withdrawal already finalized.');
      }
      tx.update(wRef, {
        status: 'rejected', reason: cleanReason,
        reviewedAt: serverTimestamp(), reviewedBy: admin.uid, reviewedByName: admin.name
      });
      tx.delete(lockRef);
    });
    await notify(w.userId, {
      type: 'withdrawal_rejected', tone: 'red', icon: 'x', link: 'withdraw.html',
      title: 'Withdrawal rejected',
      body: `${npr(amount)} was not sent. Reason: ${cleanReason} (Your balance was never debited for this request.)`
    });
    await audit(admin, 'withdrawal_rejected', 'withdrawal', withdrawalId, { userId: w.userId, reason: cleanReason });
    return { ok: true };
  }

  throw new Error('Unknown action.');
}

// ═════════════ Penalties / adjustments / bans / notes ════════════════

// ═══════════════ Referral rewards (admin-authoritative) ══════════════
// The referral reward pipeline follows the same trust model as the wallet:
// rules deny every user write to financial documents; this module runs in
// the admin's custom-claim-authorized client as an atomic, status-guarded,
// idempotent Firestore transaction around the one authoritative event —
// Task → Submitted → Reviewed → APPROVED.
//
// Reward amounts come from config/referral ONLY (never from the caller).
// Every reward has a deterministic document ID, so refreshes, retries,
// double-approvals and concurrent sweeps can never pay twice:
//   milestone: REFERRAL_MILESTONE_{referrerId}_{referredUserId}
//   recurring: REFERRAL_TASK_{referrerId}_{referredUserId}_{taskId}
// The ledger transaction uses the SAME id as its document id, so a
// duplicate ledger row is impossible at the database level.
// Referral rewards flow through the EXISTING wallet: they enter hold
// (status 'hold' + availableAt from platform holdDays) and are released by
// the existing idempotent sweepHolds — no second balance, no bypass.

const msOf = (ts) => (ts && typeof ts.toMillis === 'function' ? ts.toMillis() : (ts ? (new Date(ts).getTime() || 0) : 0));

async function getReferralConfig() {
  const snap = await getDoc(doc(db, 'config', 'referral'));
  const d = snap.exists() ? (snap.data() || {}) : {};
  const int = (v, fb) => (Number.isInteger(v) && v > 0 ? v : fb);
  return {
    enabled: d.enabled !== false,
    milestoneTasks: int(d.milestoneTasks, 2),
    milestoneRewardPaisa: int(d.milestoneRewardPaisa, 1500),
    recurringRewardPaisa: int(d.recurringRewardPaisa, 500),
    maxReferralsPerDevice: int(d.maxReferralsPerDevice, 5),
    maxReferralsPerWeek: int(d.maxReferralsPerWeek, 10),
    inactiveDays: int(d.inactiveDays, 14)
  };
}

/**
 * Process the referral reward for ONE newly-approved task of a referred
 * user. Idempotent by construction:
 *   • the referral doc's approvedTaskCount must be exactly N-1 (guard),
 *   • the deterministic reward doc must not exist (guard).
 * Called from reviewTask's approve branch; safe to call repeatedly for
 * reconciliation.
 */
export async function processReferralReward({ admin = null, referredUserId, taskId, assignmentId = '', title = '' }) {
  if (!referredUserId || !taskId) return { ok: true, skipped: 'missing-ids' };
  const a = admin || await requireAdmin();

  const referredSnap = await getDoc(doc(db, 'users', referredUserId));
  if (!referredSnap.exists()) return { ok: true, skipped: 'no-user' };
  const referredBy = referredSnap.data().referredBy || '';
  if (!referredBy) return { ok: true, skipped: 'not-referred' };

  const referralId = `${referredBy}_${referredUserId}`;
  const referralRef = doc(db, 'referrals', referralId);
  const referralSnap = await getDoc(referralRef);
  if (!referralSnap.exists()) return { ok: true, skipped: 'no-referral' };
  const referral = referralSnap.data() || {};
  if (referral.referrerId !== referredBy || referral.referredUserId !== referredUserId) {
    return { ok: true, skipped: 'mismatch' };
  }

  const cfg = await getReferralConfig();
  if (!cfg.enabled) return { ok: true, skipped: 'disabled' };
  const platform = await getConfig(); // existing platform config (hold days)
  const holdUntil = Timestamp.fromMillis(Date.now() + platform.holdDays * 86400000);

  const newCount = (referral.approvedTaskCount || 0) + 1;
  const isMilestone = newCount === cfg.milestoneTasks;
  const isRecurring = newCount > cfg.milestoneTasks;
  const amountPaisa = isMilestone ? cfg.milestoneRewardPaisa : isRecurring ? cfg.recurringRewardPaisa : 0;
  // Deterministic reward id — the ledger document uses the SAME id.
  const rewardId = isMilestone
    ? `REFERRAL_MILESTONE_${referredBy}_${referredUserId}`
    : isRecurring
      ? `REFERRAL_TASK_${referredBy}_${referredUserId}_${taskId}`
      : '';
  const rewardRef = rewardId ? doc(db, 'referralRewards', rewardId) : null;
  const walletRef = doc(db, 'wallets', referredBy);
  const eventRef = doc(db, 'referrals', referralId, 'events', `task_${taskId}`);
  const referredName = String(referral.referredName || '').slice(0, 60) || 'Your referral';

  let outcome = { ok: true, newCount };
  await runTransaction(db, async (tx) => {
    const reads = [tx.get(referralRef), tx.get(walletRef)];
    if (rewardRef) reads.push(tx.get(rewardRef));
    const results = await Promise.all(reads);
    const freshReferralSnap = results[0];
    const walletSnap = results[1];
    const freshRewardSnap = rewardRef ? results[2] : null;
    if (!freshReferralSnap.exists()) { outcome = { ok: true, skipped: 'no-referral' }; return; }
    const cur = freshReferralSnap.data() || {};
    const currentCount = cur.approvedTaskCount || 0;

    // Idempotency guard #1: this approval was already counted.
    if (newCount !== currentCount + 1) {
      outcome = { ok: true, duplicate: true, newCount: currentCount };
      return;
    }
    // Idempotency guard #2: this exact reward already exists.
    if (rewardRef && freshRewardSnap.exists()) {
      outcome = { ok: true, duplicate: true, newCount: currentCount };
      return;
    }
    if (!walletSnap.exists()) throw new Error('The referrer wallet could not be found.');

    // Rewards suspended for investigation: the count still advances (so a
    // later restore/reconcile pays exactly the missing rewards), but no
    // money moves now. Financial corrections go through the standard admin
    // workflows — historical transactions are never edited here.
    if (cur.rewardsSuspended === true) {
      tx.update(referralRef, {
        approvedTaskCount: newCount,
        ...(newCount === 1 ? { status: 'started' } : {}),
        lastCountedAt: serverTimestamp()
      });
      tx.set(eventRef, {
        referrerId: referredBy, referredUserId,
        type: 'task_approved', title: `${referredName} completed an approved task`,
        amountPaisa: 0, taskId, createdAt: serverTimestamp()
      });
      outcome = { ok: true, suspended: true, newCount, referredName };
      return;
    }

    if (amountPaisa > 0) {
      // Ledger + wallet + counters, atomically. Money never touches the
      // browser: these writes are allowed only for the admin claim.
      const txDocRef = doc(db, 'transactions', rewardId);
      tx.set(rewardRef, {
        rewardId,
        referrerId: referredBy,
        referredUserId,
        taskId,
        assignmentId,
        type: isMilestone ? 'referral_milestone' : 'referral_task',
        amountPaisa,
        currency: 'NPR',
        transactionId: rewardId,
        status: 'credited',
        createdAt: serverTimestamp(),
        createdBy: a.uid
      });
      tx.set(txDocRef, {
        transactionId: rewardId,
        userId: referredBy,
        type: isMilestone ? 'referral_reward' : 'referral_task_reward',
        amountPaisa,
        status: 'hold',
        source: 'referral',
        referenceId: referredUserId,
        description: isMilestone
          ? `Referral milestone: ${referredName} completed their first ${cfg.milestoneTasks} approved tasks`
          : `Referral task reward: ${referredName} completed an approved task`,
        availableAt: holdUntil,
        balanceAfterPaisa: null,
        createdAt: serverTimestamp(),
        createdBy: a.uid
      });
      tx.update(walletRef, {
        holdPaisa: increment(amountPaisa),
        earnedPaisa: increment(amountPaisa),
        updatedAt: serverTimestamp()
      });
      tx.update(referralRef, {
        approvedTaskCount: newCount,
        totalEarnedPaisa: increment(amountPaisa),
        ...(isMilestone ? { milestoneReached: true, milestoneRewardTransactionId: rewardId } : {}),
        ...(newCount === 1 ? { status: 'started' } : {}),
        lastRewardAt: serverTimestamp(),
        lastCountedAt: serverTimestamp()
      });
      // Inviter-side aggregate (server-maintained, admin-written only).
      tx.update(doc(db, 'users', referredBy), {
        'referralStats.totalEarnedPaisa': increment(amountPaisa),
        ...(newCount === 1 ? { 'referralStats.started': increment(1) } : {}),
        ...(isMilestone ? { 'referralStats.milestoneReached': increment(1) } : {})
      });
      tx.set(doc(db, 'stats', 'referralTotals'), {
        totalRewardPaisa: increment(amountPaisa),
        totalRewardCount: increment(1),
        milestoneCount: isMilestone ? increment(1) : increment(0),
        taskRewardCount: isRecurring ? increment(1) : increment(0),
        updatedAt: serverTimestamp()
      }, { merge: true });
      outcome = {
        ok: true, rewardId, amountPaisa, newCount, isMilestone, referredName,
        referrerId: referredBy
      };
    } else {
      // Task #1: counted, no milestone money yet — the रु15 milestone is
      // paid when task #2 is approved (the first two tasks are milestone-only).
      tx.update(referralRef, {
        approvedTaskCount: newCount,
        ...(newCount === 1 ? { status: 'started' } : {}),
        lastCountedAt: serverTimestamp()
      });
      if (newCount === 1) {
        tx.update(doc(db, 'users', referredBy), { 'referralStats.started': increment(1) });
      }
      outcome = { ok: true, newCount, referredName };
    }
    tx.set(eventRef, {
      referrerId: referredBy, referredUserId,
      type: 'task_approved', title: `${referredName} completed an approved task`,
      amountPaisa: 0, taskId, createdAt: serverTimestamp()
    });
  });

  if (outcome.duplicate || outcome.suspended || outcome.skipped) return outcome;

  // ── Notifications (admin-authored, exactly like task rewards) ──────
  if (outcome.rewardId && outcome.amountPaisa > 0) {
    if (outcome.isMilestone) {
      await notify(referredBy, {
        type: 'referral_milestone', tone: 'green', icon: 'users', link: 'referral.html',
        title: '🎉 Referral milestone reached',
        body: `Your referral ${outcome.referredName} completed their first ${cfg.milestoneTasks} approved tasks. You earned ${npr(outcome.amountPaisa)}!`,
        amountPaisa: outcome.amountPaisa
      });
      await systemMsg(referredBy, `🎉 Referral milestone: ${outcome.referredName} completed their first ${cfg.milestoneTasks} approved tasks. ${npr(outcome.amountPaisa)} was added to your referral earnings (on hold per platform rules).`);
    } else {
      await notify(referredBy, {
        type: 'referral_reward', tone: 'green', icon: 'coins', link: 'referral.html',
        title: '💰 Referral reward',
        body: `Your referral ${outcome.referredName} successfully completed another approved task. You earned ${npr(outcome.amountPaisa)}!`,
        amountPaisa: outcome.amountPaisa
      });
    }
  }
  await audit(a, 'referral_reward_processed', 'referral', referralId, {
    referredUserId, taskId, rewardId: outcome.rewardId || '',
    amountPaisa: outcome.amountPaisa || 0, approvedTaskCount: outcome.newCount
  });
  return outcome;
}

/**
 * Backfill: catch a referral up to the referred user's REAL approved-task
 * history (counted from immutable task_reward ledger entries — the same
 * records the wallet page shows). Idempotent per reward, so it can run any
 * number of times, including after a crash between the task approval and
 * the inline reward processing.
 */
export async function reconcileReferral(referralId) {
  const admin = await requireAdmin();
  const snap = await getDoc(doc(db, 'referrals', referralId));
  if (!snap.exists()) throw new Error('Referral not found.');
  const r = snap.data() || {};

  // One ledger entry per approved task (referenceId = the assignment id).
  // Chronological order matters: reward ids are positional (index i ↔ task i),
  // so the sort must be stable. Served by the (userId, type, createdAt ASC)
  // composite index.
  const approved = await getDocs(query(
    collection(db, 'transactions'),
    where('userId', '==', r.referredUserId),
    where('type', '==', 'task_reward'),
    orderBy('createdAt', 'asc'),
    limit(500)
  ));
  const expected = approved.docs.length;
  const current = r.approvedTaskCount || 0;
  if (expected <= current) return { ok: true, caughtUp: true, expected, current };

  let processed = 0;
  for (let i = current; i < expected; i++) {
    const t = approved.docs[i].data();
    // The assignment reference doubles as the taskId surrogate — unique per
    // approval, so the deterministic reward id stays collision-free.
    const taskId = t.referenceId || `reconcile_${approved.docs[i].id}`;
    const res = await processReferralReward({
      admin,
      referredUserId: r.referredUserId,
      taskId,
      assignmentId: t.referenceId || '',
      title: t.description || 'approved task'
    });
    if (res && res.ok && !res.duplicate && res.rewardId) processed++;
  }
  await audit(admin, 'referral_reconciled', 'referral', referralId, {
    expected, previous: current, rewardsProcessed: processed
  });
  return { ok: true, expected, previous: current, processed };
}

/** Reconcile the most recent referrals (admin panel bulk action). */
export async function reconcileAllReferrals({ limit = 100 } = {}) {
  const admin = await requireAdmin();
  const snap = await getDocs(query(collection(db, 'referrals'), orderBy('createdAt', 'desc'), limit(limit)));
  let reconciled = 0, caughtUp = 0, failed = 0;
  for (const d of snap.docs) {
    try {
      const res = await reconcileReferral(d.id);
      if (res.caughtUp) caughtUp++; else reconciled++;
    } catch (_) { failed++; }
  }
  await audit(admin, 'referral_reconcile_all', 'referral', '', { scanned: snap.size, reconciled, caughtUp, failed });
  return { ok: true, scanned: snap.size, reconciled, caughtUp, failed };
}

// ═══════════════ Referral risk flags (advisory) ══════════════════════
// Flags say "Review recommended" — never "guilty". Shared Wi-Fi, school,
// office or family networks alone are never proof of fraud; the signals
// below are coarse patterns that deserve a human look.

async function upsertReferralRiskFlag({ riskType, referrerId, referredUserId = '', severity = 'medium', reason, signals = {} }) {
  const flagId = `RF_${riskType}_${referrerId}_${referredUserId}`.slice(0, 120);
  const ref = doc(db, 'referralRiskFlags', flagId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) {
      const cur = snap.data() || {};
      if (cur.status === 'open') {
        tx.update(ref, { lastSeenAt: serverTimestamp(), signals: { ...(cur.signals || {}), ...signals } });
        return;
      }
      // Resolved before — reopen only when the pattern reappears.
      tx.update(ref, {
        status: 'open', severity, reason,
        resolvedAt: null, resolvedBy: null, resolutionNote: '',
        lastSeenAt: serverTimestamp(), reopenedAt: serverTimestamp()
      });
      return;
    }
    tx.set(ref, {
      flagId, riskType, referrerId, referredUserId, severity,
      status: 'open', reason, signals,
      createdAt: serverTimestamp(), lastSeenAt: serverTimestamp(),
      resolvedAt: null, resolvedBy: null, resolutionNote: ''
    });
  });
}

/**
 * Advisory scan over recent referrals. Thresholds come from
 * config/referral (admin-configurable — no aggressive hardcoding that
 * could flag legitimate schools, families or offices).
 */
export async function computeReferralRiskFlags({ windowDays = 30 } = {}) {
  const admin = await requireAdmin();
  const cfg = await getReferralConfig();
  const since = Timestamp.fromMillis(Date.now() - windowDays * 86400000);
  const snap = await getDocs(query(
    collection(db, 'referrals'),
    where('createdAt', '>=', since),
    orderBy('createdAt', 'desc'),
    limit(400)
  ));

  const byDevice = new Map();
  const byReferrer = new Map();
  for (const d of snap.docs) {
    const r = d.data() || {};
    const entry = { id: d.id, ...r };
    if (r.deviceSig) {
      if (!byDevice.has(r.deviceSig)) byDevice.set(r.deviceSig, []);
      byDevice.get(r.deviceSig).push(entry);
    }
    if (r.referrerId) {
      if (!byReferrer.has(r.referrerId)) byReferrer.set(r.referrerId, []);
      byReferrer.get(r.referrerId).push(entry);
    }
  }

  let touched = 0;
  // 1) Same device signature → unusually many accounts.
  for (const [sig, list] of byDevice) {
    if (list.length <= cfg.maxReferralsPerDevice) continue;
    const names = list.map((x) => x.referredName || x.referredUserId).slice(0, 6).join(', ');
    for (const x of list) {
      await upsertReferralRiskFlag({
        riskType: 'shared_device',
        referrerId: x.referrerId,
        referredUserId: x.referredUserId,
        severity: list.length > cfg.maxReferralsPerDevice * 2 ? 'high' : 'medium',
        reason: `Review recommended: ${list.length} accounts joined through referral links from the same device signature within ${windowDays} days (e.g. ${names}). Shared devices or networks alone are not proof of abuse.`,
        signals: { deviceSig: sig, accountCount: list.length, windowDays }
      });
      touched++;
    }
  }

  // 2) One referral code → unusually high signup velocity.
  //    3) Many referred accounts with zero normal activity.
  for (const [referrerId, list] of byReferrer) {
    if (list.length > cfg.maxReferralsPerWeek) {
      await upsertReferralRiskFlag({
        riskType: 'referral_velocity',
        referrerId,
        severity: 'medium',
        reason: `Review recommended: ${list.length} referral signups from one referral code within ${windowDays} days.`,
        signals: { referralCount: list.length, windowDays }
      });
      touched++;
    }
    const cutoff = Date.now() - cfg.inactiveDays * 86400000;
    const inactive = list.filter((x) => (x.approvedTaskCount || 0) === 0 && msOf(x.createdAt) > 0 && msOf(x.createdAt) < cutoff);
    if (inactive.length >= 3 && inactive.length >= Math.ceil(list.length * 0.6)) {
      await upsertReferralRiskFlag({
        riskType: 'inactive_referrals',
        referrerId,
        severity: 'low',
        reason: `Review recommended: ${inactive.length} of ${list.length} recent referrals have no approved tasks after ${cfg.inactiveDays}+ days.`,
        signals: { inactiveCount: inactive.length, total: list.length, inactiveDays: cfg.inactiveDays }
      });
      touched++;
    }
  }

  await audit(admin, 'referral_risk_scan', 'referral', '', {
    windowDays, referralsScanned: snap.size, flagsTouched: touched
  });
  return { ok: true, scanned: snap.size, flagsTouched: touched };
}

// ═══════════════ Admin referral actions ══════════════════════════════

/** Suspend/resume future referral rewards for one referral (investigation). */
export async function setReferralRewardsSuspended({ referralId, suspended, reason }) {
  const admin = await requireAdmin();
  const cleanReason = String(reason || '').slice(0, 500).trim();
  if (cleanReason.length < 5) throw new Error('A clear reason is required.');
  const ref = doc(db, 'referrals', referralId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Referral not found.');
  const r = snap.data();
  await runTransaction(db, async (tx) => {
    const fresh = await tx.get(ref);
    const cur = fresh.data() || {};
    if (!!cur.rewardsSuspended === !!suspended) return; // no-op
    tx.update(ref, {
      rewardsSuspended: !!suspended,
      underReview: suspended ? true : cur.underReview,
      suspensionReason: suspended ? cleanReason : '',
      ...(suspended ? {} : { restoredAt: serverTimestamp(), restoredBy: admin.uid })
    });
  });
  await notify(r.referrerId, {
    type: suspended ? 'referral_review' : 'system',
    tone: suspended ? 'amber' : 'green',
    icon: suspended ? 'shield' : 'check',
    link: 'referral.html',
    title: suspended ? 'Referral rewards under review' : 'Referral rewards restored',
    body: suspended
      ? `Referral rewards for one of your referrals are temporarily paused while we complete a routine review. Your referral link still works. Reason: ${cleanReason}`
      : 'The review of your referral rewards is complete. Future rewards will be credited normally.'
  });
  await audit(admin, suspended ? 'referral_rewards_suspended' : 'referral_rewards_restored', 'referral', referralId, { reason: cleanReason });
  return { ok: true };
}

/** Mark a referral under review (or clear the mark). */
export async function setReferralUnderReview({ referralId, underReview, note }) {
  const admin = await requireAdmin();
  const cleanNote = String(note || '').slice(0, 1000).trim();
  const ref = doc(db, 'referrals', referralId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Referral not found.');
  const r = snap.data();
  await updateDoc(ref, {
    underReview: !!underReview,
    reviewNote: underReview ? cleanNote : '',
    ...(underReview ? {} : { reviewClearedAt: serverTimestamp(), reviewClearedBy: admin.uid })
  });
  if (underReview && cleanNote) {
    try {
      await addDoc(collection(db, 'users', r.referrerId, 'notes'), {
        text: `Referral review (${referralId}): ${cleanNote}`,
        createdAt: serverTimestamp(), createdBy: admin.uid, createdByName: admin.name
      });
    } catch (_) { /* notes are best-effort */ }
  }
  await audit(admin, underReview ? 'referral_marked_under_review' : 'referral_review_cleared', 'referral', referralId, { note: cleanNote });
  return { ok: true };
}

export async function resolveReferralRiskFlag({ flagId, note }) {
  const admin = await requireAdmin();
  const cleanNote = String(note || '').slice(0, 1000).trim();
  if (cleanNote.length < 3) throw new Error('A short resolution note is required.');
  const ref = doc(db, 'referralRiskFlags', flagId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Risk flag not found.');
  const f = snap.data();
  await updateDoc(ref, {
    status: 'resolved',
    resolvedAt: serverTimestamp(),
    resolvedBy: admin.uid,
    resolvedByName: admin.name,
    resolutionNote: cleanNote
  });
  await audit(admin, 'referral_risk_flag_resolved', 'referralRiskFlag', flagId, {
    riskType: f.riskType, referrerId: f.referrerId || '', referredUserId: f.referredUserId || '', note: cleanNote
  });
  return { ok: true };
}

/** Save referral program configuration (affects FUTURE rewards only). */
export async function saveReferralConfig({ cfg = {}, reason = '' }) {
  const admin = await requireAdmin();
  const cleanReason = String(reason || '').slice(0, 300).trim();
  const int = (v, min, max, fb) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : fb;
  };
  const payload = {
    enabled: cfg.enabled !== false,
    milestoneTasks: int(cfg.milestoneTasks, 1, 10, 2),
    milestoneRewardPaisa: int(cfg.milestoneRewardPaisa, 100, 100000, 1500),
    recurringRewardPaisa: int(cfg.recurringRewardPaisa, 100, 100000, 500),
    maxReferralsPerDevice: int(cfg.maxReferralsPerDevice, 2, 100, 5),
    maxReferralsPerWeek: int(cfg.maxReferralsPerWeek, 2, 200, 10),
    inactiveDays: int(cfg.inactiveDays, 1, 365, 14),
    updatedAt: serverTimestamp(),
    updatedBy: admin.uid
  };
  await setDoc(doc(db, 'config', 'referral'), payload, { merge: true });
  await audit(admin, 'referral_config_updated', 'config', 'referral', { ...payload, reason: cleanReason });
  return { ok: true, cfg: payload };
}

export async function applyPenalty({ userId, amountPaisa, reason }) {
  const admin = await requireAdmin();
  const amount = Number(amountPaisa);
  const cleanReason = String(reason || '').slice(0, 500).trim();
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid penalty amount.');
  if (cleanReason.length < 5) throw new Error('A clear reason is required.');

  const uSnap = await getDoc(doc(db, 'users', userId));
  if (!uSnap.exists()) throw new Error('User not found.');

  const walletRef = doc(db, 'wallets', userId);
  let applied = 0;
  await runTransaction(db, async (tx) => {
    const w = await tx.get(walletRef);
    const available = w.exists() ? (w.data().availablePaisa || 0) : 0;
    applied = Math.min(available, amount);
    if (applied <= 0) {
      throw new Error('The user has no available (withdrawable) balance right now. Wait for holds to mature, then apply the penalty.');
    }
    const after = available - applied;
    tx.update(walletRef, { availablePaisa: increment(-applied), updatedAt: serverTimestamp() });
    const txRef = doc(collection(db, 'transactions'));
    tx.set(txRef, {
      transactionId: txRef.id, userId,
      type: 'penalty', amountPaisa: -applied, status: 'available',
      source: 'admin_penalty', referenceId: '',
      description: `Penalty: ${cleanReason.slice(0, 140)}`,
      availableAt: null, balanceAfterPaisa: after,
      createdAt: serverTimestamp(), createdBy: admin.uid
    });
    tx.set(doc(collection(db, 'penalties')), {
      userId,
      userName: uSnap.data().fullName || '',
      userEmail: uSnap.data().email || '',
      amountPaisa: applied,
      requestedPaisa: amount,
      reason: cleanReason,
      type: 'amount',
      taskId: '',
      appliedBy: admin.uid,
      appliedByName: admin.name,
      appliedAt: serverTimestamp()
    });
    tx.update(doc(db, 'users', userId), { 'stats.penaltiesPaisa': increment(applied) });
  });

  await notify(userId, {
    type: 'penalty', tone: 'red', icon: 'alert', link: 'transactions.html',
    title: 'Penalty applied',
    body: `A penalty of ${npr(applied)} has been applied to your account.${applied < amount ? ` (Requested ${npr(amount)} — only the available balance could be deducted.)` : ''}\nReason: ${cleanReason}`,
    amountPaisa: -applied
  });
  await audit(admin, 'penalty_applied', 'user', userId, { amountPaisa: applied, reason: cleanReason });
  return { ok: true, appliedPaisa: applied };
}

export async function adjustBalance({ userId, amountPaisa, reason }) {
  const admin = await requireAdmin();
  const delta = Number(amountPaisa);
  const cleanReason = String(reason || '').slice(0, 500).trim();
  if (!Number.isInteger(delta) || delta === 0) throw new Error('Invalid adjustment amount.');
  if (cleanReason.length < 5) throw new Error('A clear reason is required.');
  const uSnap = await getDoc(doc(db, 'users', userId));
  if (!uSnap.exists()) throw new Error('User not found.');

  const walletRef = doc(db, 'wallets', userId);
  let applied = delta;
  await runTransaction(db, async (tx) => {
    const w = await tx.get(walletRef);
    const available = w.exists() ? (w.data().availablePaisa || 0) : 0;
    if (delta < 0) {
      applied = -Math.min(available, -delta);
      if (applied === 0) throw new Error('The user has no available balance to debit.');
    }
    const after = available + applied;
    tx.update(walletRef, { availablePaisa: increment(applied), updatedAt: serverTimestamp() });
    const txRef = doc(collection(db, 'transactions'));
    tx.set(txRef, {
      transactionId: txRef.id, userId,
      type: 'adjustment', amountPaisa: applied, status: 'available',
      source: 'admin_adjustment', referenceId: '',
      description: `Adjustment: ${cleanReason.slice(0, 140)}`,
      availableAt: null, balanceAfterPaisa: after,
      createdAt: serverTimestamp(), createdBy: admin.uid
    });
  });

  await notify(userId, {
    type: 'system', tone: applied > 0 ? 'green' : 'red', icon: 'edit', link: 'transactions.html',
    title: 'Balance adjustment',
    body: `An adjustment of ${npr(applied)} was applied to your account.\nReason: ${cleanReason}`,
    amountPaisa: applied
  });
  await audit(admin, 'financial_adjustment', 'user', userId, { amountPaisa: applied, reason: cleanReason });
  return { ok: true, appliedPaisa: applied };
}

export async function banUser({ userId, action, type, reason, until }) {
  const admin = await requireAdmin();
  const uSnap = await getDoc(doc(db, 'users', userId));
  if (!uSnap.exists()) throw new Error('User not found.');
  const u = uSnap.data();
  if (u.role === 'admin') throw new Error('Administrators cannot be banned here.');

  if (action === 'ban') {
    const cleanReason = String(reason || '').slice(0, 500).trim();
    if (cleanReason.length < 5) throw new Error('A ban reason is required.');
    const isPermanent = type !== 'temporary';
    let untilTs = null;
    if (!isPermanent) {
      untilTs = until ? Timestamp.fromDate(new Date(until)) : Timestamp.fromMillis(Date.now() + 7 * 86400000);
    }
    await updateDoc(doc(db, 'users', userId), {
      status: 'banned',
      ban: {
        type: isPermanent ? 'permanent' : 'temporary',
        reason: cleanReason, until: untilTs,
        at: serverTimestamp(), by: admin.uid
      }
    });
    await notify(userId, {
      type: 'security', tone: 'red', icon: 'ban', link: '',
      title: 'Account restricted',
      body: `Your AfnoKamai account has been ${isPermanent ? 'permanently' : 'temporarily'} restricted.\nReason: ${cleanReason}`
    });
    await audit(admin, 'user_banned', 'user', userId, { type: isPermanent ? 'permanent' : 'temporary', reason: cleanReason });
    return { ok: true };
  }

  if (action === 'unban') {
    await updateDoc(doc(db, 'users', userId), { status: 'active', ban: null });
    await notify(userId, {
      type: 'system', tone: 'green', icon: 'check', link: 'dashboard.html',
      title: 'Account restored',
      body: 'The restriction on your account has been lifted. Welcome back!'
    });
    await audit(admin, 'user_unbanned', 'user', userId, {});
    return { ok: true };
  }

  throw new Error('Unknown action.');
}

export async function addAdminNote(userId, text) {
  const admin = await requireAdmin();
  const clean = String(text || '').slice(0, 2000).trim();
  if (!clean) throw new Error('Note text is required.');
  await addDoc(collection(db, 'users', userId, 'notes'), {
    text: clean, createdAt: serverTimestamp(), createdBy: admin.uid, createdByName: admin.name
  });
  await audit(admin, 'note_added', 'user', userId, {});
  return { ok: true };
}

// ═══════════════════ Risk monitoring (client-computed) ═══════════════

/** Derives advisory flags — never a verdict. Displayed as "Review recommended". */
export function computeRiskFlags(u = {}) {
  const flags = [];
  const s = u.stats || {};
  const approved = s.approved || 0;
  const rejected = s.rejected || 0;
  if (approved + rejected >= 5 && rejected / (approved + rejected) >= 0.6) {
    flags.push(`${rejected}/${approved + rejected} tasks rejected — review submissions carefully before paying out`);
  }
  if ((s.penaltiesPaisa || 0) >= 3000) {
    flags.push(`Penalties total ${npr(s.penaltiesPaisa)}`);
  }
  return flags;
}
