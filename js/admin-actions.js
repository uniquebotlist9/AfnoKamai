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
      await notify(data.userId, {
        type: 'reward_released', tone: 'green', icon: 'unlock', link: 'withdraw.html',
        title: 'Funds released 🎉',
        body: `${npr(data.amountPaisa)} has left the hold period and is now withdrawable.`,
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
