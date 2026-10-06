// ═════════════════════════════════════════════════════════════════════
// AfnoKamai — Cloud Functions backend
// All financial state changes, PIN security, notifications, audit log
// and Brevo email live here. The client is never trusted with money.
// ═════════════════════════════════════════════════════════════════════

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params/secret");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

setGlobalOptions({ region: "asia-south1", maxInstances: 10 });

const BREVO_API_KEY = defineSecret("BREVO_API_KEY");

// ── Platform constants (config/platform can override some) ──────────
const DEFAULT_HOLD_DAYS = 3;
const DEFAULT_MIN_WITHDRAWAL_PAISA = 50000; // रु 500
const MAX_WITHDRAWAL_PAISA = 50000000;      // रु 500,000 sanity cap
const MAX_ADJUSTMENT_PAISA = 100000000;     // रु 1,000,000
const MAX_ACTIVE_ASSIGNMENTS = 5;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const CHAT_MSG_LIMIT_PER_MIN = 20;
const PLATFORM_SENDER = { name: "AfnoKamai", email: "no-reply@afnokamai.app" };
const ADMIN_AUDIENCE = "__admins__";

// ═══════════════════════════════ Helpers ═════════════════════════════

function assertAuth(ctx) {
  if (!ctx.auth) throw new HttpsError("unauthenticated", "You must be logged in.");
  return ctx.auth;
}

async function getPlatformConfig() {
  const snap = await db.doc("config/platform").get();
  const d = snap.data() || {};
  return {
    holdDays: Number.isFinite(d.holdDays) ? d.holdDays : DEFAULT_HOLD_DAYS,
    minWithdrawalPaisa: Number.isFinite(d.minWithdrawalPaisa) ? d.minWithdrawalPaisa : DEFAULT_MIN_WITHDRAWAL_PAISA,
    supportEmail: d.supportEmail || null
  };
}

async function getUserDoc(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

function assertNotBanned(u) {
  if (u && u.status === "banned") {
    const until = u.ban && u.ban.until ? ` Restriction ends ${u.ban.until.toDate().toDateString()}.` : "";
    throw new HttpsError("permission-denied", `Your account is restricted.${until} Contact support if you believe this is a mistake.`);
  }
}

function assertVerified(ctx) {
  if (ctx.auth.token.email_verified !== true) {
    throw new HttpsError("permission-denied", "Please verify your email address before performing this action.");
  }
}

function assertAdminCtx(ctx) {
  assertAuth(ctx);
  if (ctx.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access is required for this action.");
  }
}

function assertProfileComplete(u) {
  if (!u || !u.profileComplete || !u.pinSetAt) {
    throw new HttpsError("failed-precondition", "Please complete your profile and security PIN first.");
  }
}

function intPaisa(v, label = "amount") {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_ADJUSTMENT_PAISA * 10) {
    throw new HttpsError("invalid-argument", `Invalid ${label}.`);
  }
  return n;
}

const nprFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const npr = (paisa) => `रु ${nprFmt.format(Math.abs(paisa) / 100)}`;

async function notify(userId, { type, title, body, link, tone, icon, amountPaisa }) {
  try {
    await db.collection("notifications").add({
      userId,
      audience: userId === ADMIN_AUDIENCE ? "admin" : "user",
      type, title, body: body || "",
      link: link || "",
      tone: tone || "gray",
      icon: icon || "info",
      ...(amountPaisa !== undefined ? { amountPaisa } : {}),
      read: false,
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (e) {
    logger.warn("notify failed", { userId, type, error: String(e) });
  }
}

function notifyAdmins(payload) {
  return notify(ADMIN_AUDIENCE, payload);
}

async function audit(adminCtx, action, targetType, targetId, metadata = {}) {
  try {
    await db.collection("adminLogs").add({
      adminId: adminCtx.auth.uid,
      adminEmail: adminCtx.auth.token.email || "",
      action,
      targetType: targetType || "",
      targetId: targetId || "",
      metadata,
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (e) {
    logger.error("audit write failed", { action, error: String(e) });
  }
}

function dayKey(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function dailyBump(field, amount = 1) {
  try {
    await db.doc(`stats/daily_${dayKey()}`).set(
      { date: dayKey(), [field]: FieldValue.increment(amount) },
      { merge: true }
    );
  } catch (e) {
    logger.warn("dailyBump failed", { field, error: String(e) });
  }
}

async function platformBump(field, amount = 1) {
  try {
    await db.doc("stats/platform").set(
      { [field]: FieldValue.increment(amount) },
      { merge: true }
    );
  } catch (e) {
    logger.warn("platformBump failed", { field, error: String(e) });
  }
}

// ── Brevo email (key never leaves the server) ────────────────────────
async function sendEmail(to, toName, subject, html) {
  try {
    const key = BREVO_API_KEY.value();
    if (!key) return;
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: PLATFORM_SENDER,
        to: [{ email: to, name: toName || "" }],
        subject,
        htmlContent: emailShell(subject, html)
      })
    });
    if (!res.ok) logger.warn("brevo email failed", { status: res.status, subject });
  } catch (e) {
    logger.warn("brevo email error", { error: String(e), subject });
  }
}

function emailShell(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#F3F6F4;font-family:Segoe UI,Arial,sans-serif;padding:28px">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #E3EAE6">
      <div style="background:#0E5C41;padding:22px 28px;color:#fff;font-weight:800;font-size:18px">AfnoKamai</div>
      <div style="padding:26px 28px;color:#13201A;font-size:14.5px;line-height:1.6">
        <h2 style="margin:0 0 12px;font-size:18px">${title}</h2>${bodyHtml}
      </div>
      <div style="padding:16px 28px;background:#F8FAF9;color:#71837A;font-size:12px">Your Work. Your Kamai. · AfnoKamai</div>
    </div></body></html>`;
}

// ── PIN helpers ──────────────────────────────────────────────────────
async function verifyPinCore(userRef, u, pin) {
  if (u.pinLockedUntil && u.pinLockedUntil.toMillis() > Date.now()) {
    const mins = Math.ceil((u.pinLockedUntil.toMillis() - Date.now()) / 60000);
    throw new HttpsError("resource-exhausted", `Too many incorrect PIN attempts. Try again in ${mins} minute(s).`);
  }
  const ok = u.pinHash && bcrypt.compareSync(String(pin), u.pinHash);
  if (!ok) {
    const attempts = (u.pinAttempts || 0) + 1;
    const update = { pinAttempts: attempts };
    if (attempts >= PIN_MAX_ATTEMPTS) {
      update.pinLockedUntil = Timestamp.fromMillis(Date.now() + PIN_LOCK_MINUTES * 60000);
      update.pinAttempts = 0;
    }
    await userRef.update(update);
    if (update.pinLockedUntil) {
      await notify(userRef.id, {
        type: "security", tone: "red", icon: "shield",
        title: "Security PIN locked",
        body: `Too many incorrect attempts. Your PIN is locked for ${PIN_LOCK_MINUTES} minutes.`
      });
    }
    throw new HttpsError("permission-denied", "Incorrect security PIN.");
  }
  await userRef.update({ pinAttempts: 0, pinLockedUntil: null }).catch(() => {});
  return true;
}

function validPhone(v) {
  return /^(9[678]\d{8}|0?1\d{7}|0?[2-7]\d{7})$/.test(String(v || "").replace(/[\s-]/g, ""));
}

function validName(v) {
  return /^[A-Za-z][A-Za-z\s.'-]{1,59}$/.test(String(v || "").trim());
}

// ═══════════════════ Account: initialize / profile / PIN ═════════════

exports.initializeUser = onCall({ secrets: [BREVO_API_KEY] }, async (ctx) => {
  const a = assertAuth(ctx);
  const uid = a.uid;
  const userRef = db.doc(`users/${uid}`);
  const snap = await userRef.get();
  if (snap.exists) return { exists: true };

  const email = (a.token.email || "").toLowerCase();
  await userRef.set({
    uid,
    email,
    emailVerified: a.token.email_verified === true,
    fullName: "",
    phone: "",
    role: "user",
    status: "active",
    profileComplete: false,
    pinSetAt: null,
    pinHash: null,
    pinAttempts: 0,
    pinLockedUntil: null,
    createdAt: FieldValue.serverTimestamp(),
    lastActiveAt: FieldValue.serverTimestamp(),
    stats: { assigned: 0, submitted: 0, approved: 0, rejected: 0, earnedPaisa: 0, withdrawnPaisa: 0, penaltiesPaisa: 0 }
  });

  const walletRef = db.doc(`wallets/${uid}`);
  if (!(await walletRef.get()).exists) {
    await walletRef.set({
      availablePaisa: 0, holdPaisa: 0, pendingWithdrawalPaisa: 0,
      earnedPaisa: 0, withdrawnPaisa: 0,
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  await notify(uid, {
    type: "system", tone: "gold", icon: "info", link: "dashboard.html",
    title: "Welcome to AfnoKamai 🎉",
    body: "Complete your profile and security PIN to start earning."
  });
  await notifyAdmins({
    type: "system", tone: "blue", icon: "users", link: "users.html",
    title: "New user registered",
    body: `${email}`
  });
  await dailyBump("usersCreated");
  await platformBump("totalUsers");
  await sendEmail(email, "", "Welcome to AfnoKamai",
    `<p>Hi${a.token.name ? " " + a.token.name : ""},</p>
     <p>Your AfnoKamai account has been created. Verify your email, complete your profile and set your security PIN to get started.</p>
     <p style="color:#71837A">Never share your password or security PIN with anyone.</p>`);
  return { ok: true };
});

exports.completeProfile = onCall({ secrets: [BREVO_API_KEY] }, async (ctx) => {
  const a = assertAuth(ctx);
  assertVerified(ctx);
  const uid = a.uid;
  const userRef = db.doc(`users/${uid}`);
  const snap = await userRef.get();
  const u = snap.exists ? snap.data() : null;

  const { fullName, phone, pin } = ctx.data || {};
  const update = {};

  if (fullName !== undefined) {
    const name = String(fullName).trim().replace(/\s+/g, " ");
    if (!validName(name)) throw new HttpsError("invalid-argument", "Please enter a valid full name (2–60 characters).");
    update.fullName = name;
  }
  if (phone !== undefined) {
    const p = String(phone).replace(/[\s-]/g, "");
    if (!validPhone(p)) throw new HttpsError("invalid-argument", "Please enter a valid Nepali phone number, e.g. 98XXXXXXXX.");
    update.phone = p;
  }
  if (pin !== undefined) {
    const p = String(pin);
    if (!/^\d{4}$/.test(p)) throw new HttpsError("invalid-argument", "The security PIN must be exactly 4 digits.");
    if (/^(?:([0-9])\1{3}|0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321)$/.test(p)) {
      throw new HttpsError("invalid-argument", "That PIN is too easy to guess. Avoid repeated digits and sequences.");
    }
    update.pinHash = bcrypt.hashSync(p, 10);
    update.pinSetAt = FieldValue.serverTimestamp();
    update.pinAttempts = 0;
    update.pinLockedUntil = null;
  }

  if (!Object.keys(update).length) throw new HttpsError("invalid-argument", "Nothing to update.");

  if (!u || !u.profileComplete) {
    if (!update.fullName || !update.phone) {
      throw new HttpsError("failed-precondition", "Full name and phone number are required.");
    }
    update.profileComplete = true;
  }

  if (u && u.pinHash && update.pinHash && !(update.fullName !== undefined && !u.profileComplete)) {
    // Changing the PIN on an existing account must go through changePin (requires current PIN).
    throw new HttpsError("already-exists", "PIN already set — use the change PIN flow in your profile.");
  }

  await userRef.set(update, { merge: true });

  if (update.profileComplete) {
    await notifyAdmins({
      type: "system", tone: "blue", icon: "user", link: `users.html?uid=${uid}`,
      title: "User completed registration",
      body: `${update.fullName} · +977 ${update.phone}`
    });
  }
  return { ok: true };
});

exports.changePin = onCall({}, async (ctx) => {
  const a = assertAuth(ctx);
  const uid = a.uid;
  const userRef = db.doc(`users/${uid}`);
  const snap = await userRef.get();
  const u = snap.data();
  if (!u || !u.pinHash) throw new HttpsError("failed-precondition", "No PIN is set yet.");
  const { currentPin, newPin } = ctx.data || {};
  await verifyPinCore(userRef, u, currentPin);
  const p = String(newPin);
  if (!/^\d{4}$/.test(p)) throw new HttpsError("invalid-argument", "The security PIN must be exactly 4 digits.");
  if (/^(?:([0-9])\1{3}|0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321)$/.test(p)) {
    throw new HttpsError("invalid-argument", "That PIN is too easy to guess.");
  }
  await userRef.update({
    pinHash: bcrypt.hashSync(p, 10),
    pinSetAt: FieldValue.serverTimestamp(),
    pinAttempts: 0,
    pinLockedUntil: null
  });
  await notify(uid, {
    type: "security", tone: "amber", icon: "shield", link: "profile.html",
    title: "Security PIN changed",
    body: "Your security PIN was changed. If this wasn't you, contact support immediately."
  });
  await sendEmail(u.email, u.fullName, "Your security PIN was changed",
    "<p>Your AfnoKamai security PIN was just changed. If this wasn't you, contact support immediately.</p>");
  return { ok: true };
});

exports.verifyPin = onCall({}, async (ctx) => {
  const a = assertAuth(ctx);
  const uid = a.uid;
  const userRef = db.doc(`users/${uid}`);
  const snap = await userRef.get();
  const u = snap.data();
  if (!u || !u.pinHash) throw new HttpsError("failed-precondition", "No PIN is set yet.");
  await verifyPinCore(userRef, u, (ctx.data || {}).pin);
  return { ok: true };
});

exports.logSecurityEvent = onCall({}, async (ctx) => {
  const a = assertAuth(ctx);
  const kind = String((ctx.data || {}).kind || "unknown").slice(0, 40);
  const u = await getUserDoc(a.uid);
  await notify(a.uid, {
    type: "security", tone: "amber", icon: "shield", link: "profile.html",
    title: "Security event",
    body: `Security action on your account: ${kind.replace(/_/g, " ")}. If this wasn't you, contact support immediately.`
  });
  if (u) await sendEmail(u.email, u.fullName, "Security event on your account",
    `<p>A security action was performed on your account: <strong>${kind.replace(/_/g, " ")}</strong>.</p><p>If this wasn't you, contact support immediately.</p>`);
  return { ok: true };
});

// ═══════════════════════════ Tasks ═══════════════════════════════════

exports.requestTask = onCall({}, async (ctx) => {
  const a = assertAuth(ctx);
  assertVerified(ctx);
  const u = await getUserDoc(a.uid);
  assertNotBanned(u);
  assertProfileComplete(u);

  const { taskId } = ctx.data || {};
  if (!taskId) throw new HttpsError("invalid-argument", "Missing task.");

  const taskSnap = await db.doc(`tasks/${taskId}`).get();
  if (!taskSnap.exists || taskSnap.data().status !== "active") {
    throw new HttpsError("failed-precondition", "This task is no longer available.");
  }
  const task = taskSnap.data();

  // no duplicate active request for the same task
  const dup = await db.collection("taskAssignments")
    .where("userId", "==", a.uid)
    .where("taskId", "==", taskId)
    .where("status", "in", ["requested", "assigned", "submitted", "clarification"])
    .get();
  if (!dup.empty) throw new HttpsError("already-exists", "You already have an active request for this task.");

  // cap concurrent active assignments
  const active = await db.collection("taskAssignments")
    .where("userId", "==", a.uid)
    .where("status", "in", ["requested", "assigned", "submitted", "clarification"])
    .get();
  if (active.size >= MAX_ACTIVE_ASSIGNMENTS) {
    throw new HttpsError("resource-exhausted", `You can have at most ${MAX_ACTIVE_ASSIGNMENTS} active tasks at once. Finish or wait for review.`);
  }

  const assignmentRef = db.collection("taskAssignments").doc();
  await assignmentRef.set({
    taskId,
    title: task.title,
    description: task.description || "",
    instructions: task.instructions || "",
    category: task.category || "",
    difficulty: task.difficulty || "easy",
    estimatedMinutes: task.estimatedMinutes || "",
    rewardPaisa: task.rewardPaisa,
    userId: a.uid,
    userName: u.fullName || "",
    userEmail: u.email || "",
    status: "requested",
    note: "",
    requestedAt: FieldValue.serverTimestamp(),
    assignedAt: null, submittedAt: null, reviewedAt: null,
    reviewedBy: null, reviewedByName: null,
    holdUntil: null, rejectionReason: "", clarificationReason: ""
  });

  // ensure support conversation exists + system message
  const convRef = db.doc(`conversations/${a.uid}`);
  if (!(await convRef.get()).exists) {
    await convRef.set({
      participants: [a.uid], userId: a.uid, userName: u.fullName || "", userEmail: u.email || "",
      createdAt: FieldValue.serverTimestamp(), lastMessage: "", lastMessageAt: FieldValue.serverTimestamp(),
      lastSenderId: "", lastSenderRole: "system", lastType: "system",
      unreadForAdmin: 0, unreadForUser: 0, userTyping: false, adminTyping: false
    });
  }
  await convRef.collection("messages").add({
    senderId: "system", senderRole: "system", senderName: "AfnoKamai",
    type: "system", clientRef: "",
    text: `🔔 Task request: ${task.title} — reward ${npr(task.rewardPaisa)}. Waiting for an administrator to assign it.`,
    createdAt: FieldValue.serverTimestamp()
  });
  await convRef.update({
    lastMessage: `Task request: ${task.title}`,
    lastType: "system", lastSenderId: "system", lastSenderRole: "system",
    lastMessageAt: FieldValue.serverTimestamp(),
    unreadForAdmin: FieldValue.increment(1)
  });

  await notifyAdmins({
    type: "task_request_update", tone: "amber", icon: "briefcase", link: `admin/chats.html?uid=${a.uid}`,
    title: "New task request",
    body: `${u.fullName || u.email} requested “${task.title}” (${npr(task.rewardPaisa)}).`
  });

  return { ok: true, assignmentId: assignmentRef.id };
});

exports.submitTask = onCall({}, async (ctx) => {
  const a = assertAuth(ctx);
  const u = await getUserDoc(a.uid);
  assertNotBanned(u);

  const { assignmentId, note } = ctx.data || {};
  if (!assignmentId) throw new HttpsError("invalid-argument", "Missing assignment.");
  const cleanNote = String(note || "").slice(0, 1000).trim();

  const ref = db.doc(`taskAssignments/${assignmentId}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Task assignment not found.");
    const asg = snap.data();
    if (asg.userId !== a.uid) throw new HttpsError("permission-denied", "This is not your task.");
    if (!["assigned", "clarification"].includes(asg.status)) {
      throw new HttpsError("failed-precondition", "This task is not awaiting completion.");
    }
    t.update(ref, {
      status: "submitted",
      note: cleanNote,
      submittedAt: FieldValue.serverTimestamp()
    });
  });

  const asg = (await ref.get()).data();
  const convRef = db.doc(`conversations/${a.uid}`);
  await convRef.collection("messages").add({
    senderId: "system", senderRole: "system", senderName: "AfnoKamai",
    type: "system", clientRef: "",
    text: `✅ ${u.fullName || "User"} submitted “${asg.title}” for review.${cleanNote ? `\nNote: ${cleanNote}` : ""}`,
    createdAt: FieldValue.serverTimestamp()
  }).catch(() => {});
  await convRef.update({
    lastMessage: `Submitted “${asg.title}” for review`,
    lastType: "system", lastSenderId: "system", lastSenderRole: "system",
    lastMessageAt: FieldValue.serverTimestamp(),
    unreadForAdmin: FieldValue.increment(1)
  }).catch(() => {});

  await notifyAdmins({
    type: "task_request_update", tone: "blue", icon: "check", link: `admin/reviews.html`,
    title: "Task submitted for review",
    body: `${u.fullName || a.uid} submitted “${asg.title}” (${npr(asg.rewardPaisa)}).`
  });
  await notify(a.uid, {
    type: "task_assigned", tone: "blue", icon: "clock", link: "earn.html",
    title: "Submitted for review",
    body: `Your submission for “${asg.title}” is now waiting for administrator review.`
  });
  return { ok: true };
});

// Admin: assign / cancel / approve / reject / clarify
exports.reviewTask = onCall({}, async (ctx) => {
  assertAdminCtx(ctx);
  const adminUid = ctx.auth.uid;
  const adminName = (await getUserDoc(adminUid))?.fullName || ctx.auth.token.email || "Admin";

  const { assignmentId, action, reason } = ctx.data || {};
  const cleanReason = String(reason || "").slice(0, 500).trim();
  if (!assignmentId || !action) throw new HttpsError("invalid-argument", "Missing assignment or action.");
  if (["cancel", "reject", "clarify"].includes(action) && cleanReason.length < 5) {
    throw new HttpsError("invalid-argument", "A clear reason is required.");
  }

  const ref = db.doc(`taskAssignments/${assignmentId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Task assignment not found.");
  const asg = snap.data();

  if (action === "assign") {
    if (asg.status !== "requested") throw new HttpsError("failed-precondition", "This request was already handled.");
    await ref.update({
      status: "assigned", assignedAt: FieldValue.serverTimestamp(),
      reviewedBy: adminUid, reviewedByName: adminName
    });
    await db.doc(`users/${asg.userId}`).set({ "stats.assigned": FieldValue.increment(1) }, { merge: true }).catch(() => {});
    await systemMsg(asg.userId, `📋 Task assigned: “${asg.title}” — reward ${npr(asg.rewardPaisa)}.\n\nInstructions:\n${asg.instructions || "See task details in the Earn page."}`);
    await notify(asg.userId, {
      type: "task_assigned", tone: "blue", icon: "briefcase", link: "earn.html",
      title: "Task assigned",
      body: `“${asg.title}” has been assigned to you. Check the chat for instructions.`
    });
    await audit(ctx, "task_assigned", "taskAssignment", assignmentId, { userId: asg.userId, title: asg.title });
    return { ok: true };
  }

  if (action === "cancel") {
    if (asg.status !== "requested") throw new HttpsError("failed-precondition", "This request was already handled.");
    await ref.update({
      status: "cancelled", rejectionReason: cleanReason,
      reviewedAt: FieldValue.serverTimestamp(), reviewedBy: adminUid, reviewedByName: adminName
    });
    await systemMsg(asg.userId, `Your request for “${asg.title}” was declined.\nReason: ${cleanReason}`);
    await notify(asg.userId, {
      type: "task_request_update", tone: "gray", icon: "x", link: "earn.html",
      title: "Task request declined",
      body: `“${asg.title}”: ${cleanReason}`
    });
    await audit(ctx, "task_request_cancelled", "taskAssignment", assignmentId, { userId: asg.userId, reason: cleanReason });
    return { ok: true };
  }

  if (action === "clarify") {
    if (!["submitted"].includes(asg.status)) throw new HttpsError("failed-precondition", "Only submitted tasks can be clarified.");
    await ref.update({
      status: "clarification", clarificationReason: cleanReason,
      reviewedAt: FieldValue.serverTimestamp(), reviewedBy: adminUid, reviewedByName: adminName
    });
    await systemMsg(asg.userId, `⚠️ Clarification needed for “${asg.title}”:\n${cleanReason}`);
    await notify(asg.userId, {
      type: "task_rejected", tone: "amber", icon: "alert", link: "earn.html",
      title: "Clarification needed",
      body: `“${asg.title}”: ${cleanReason}`
    });
    await audit(ctx, "task_clarification", "taskAssignment", assignmentId, { userId: asg.userId, reason: cleanReason });
    return { ok: true };
  }

  if (action === "reject") {
    if (!["submitted"].includes(asg.status)) throw new HttpsError("failed-precondition", "Only submitted tasks can be rejected.");
    await ref.update({
      status: "rejected", rejectionReason: cleanReason,
      reviewedAt: FieldValue.serverTimestamp(), reviewedBy: adminUid, reviewedByName: adminName
    });
    await db.doc(`users/${asg.userId}`).set({ "stats.rejected": FieldValue.increment(1) }, { merge: true }).catch(() => {});
    await dailyBump("tasksRejected");
    await systemMsg(asg.userId, `❌ Task rejected: “${asg.title}”.\nReason: ${cleanReason}\nNo reward was added for this task.`);
    await notify(asg.userId, {
      type: "task_rejected", tone: "red", icon: "x", link: "earn.html",
      title: "Task rejected",
      body: `“${asg.title}” was rejected: ${cleanReason}`
    });
    await audit(ctx, "task_rejected", "taskAssignment", assignmentId, { userId: asg.userId, reason: cleanReason });
    return { ok: true };
  }

  if (action === "approve") {
    if (!["submitted"].includes(asg.status)) throw new HttpsError("failed-precondition", "Only submitted tasks can be approved.");
    const config = await getPlatformConfig();
    const holdMs = config.holdDays * 86400000;
    const holdUntil = Timestamp.fromMillis(Date.now() + holdMs);
    const reward = asg.rewardPaisa;
    if (!Number.isInteger(reward) || reward <= 0) throw new HttpsError("failed-precondition", "Invalid reward on assignment.");

    await db.runTransaction(async (t) => {
      const fresh = await t.get(ref);
      if (fresh.data().status !== "submitted") {
        throw new HttpsError("failed-precondition", "This task was already reviewed.");
      }
      const walletRef = db.doc(`wallets/${asg.userId}`);
      const wSnap = await t.get(walletRef);
      if (!wSnap.exists) throw new HttpsError("failed-precondition", "User wallet not found.");

      t.update(ref, {
        status: "approved", reviewedAt: FieldValue.serverTimestamp(),
        reviewedBy: adminUid, reviewedByName: adminName, holdUntil
      });
      t.update(walletRef, {
        holdPaisa: FieldValue.increment(reward),
        earnedPaisa: FieldValue.increment(reward),
        updatedAt: FieldValue.serverTimestamp()
      });
      t.set(db.collection("transactions").doc(), {
        transactionId: "",
        userId: asg.userId,
        type: "task_reward",
        amountPaisa: reward,
        status: "hold",
        source: "task_approval",
        referenceId: assignmentId,
        description: `Task reward: ${asg.title}`,
        availableAt: holdUntil,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: adminUid
      });
      t.update(db.doc(`users/${asg.userId}`), { "stats.approved": FieldValue.increment(1) });
    });

    // stamp transactionId onto the new transaction (query by reference)
    const txSnap = await db.collection("transactions")
      .where("referenceId", "==", assignmentId).where("type", "==", "task_reward").limit(1).get();
    if (!txSnap.empty) {
      await txSnap.docs[0].ref.update({ transactionId: txSnap.docs[0].id });
    }

    await platformBump("totalRewardsPaisa", reward);
    await platformBump("holdPaisa", reward);
    await dailyBump("tasksApproved");
    await dailyBump("rewardsPaisa", reward);
    await systemMsg(asg.userId, `✅ Task approved: “${asg.title}”. ${npr(reward)} was added to your hold balance and becomes withdrawable after the hold period.`);
    await notify(asg.userId, {
      type: "reward_hold", tone: "green", icon: "coins", link: "dashboard.html",
      title: "Reward approved 🎉",
      body: `${npr(reward)} for “${asg.title}” is on hold and becomes withdrawable after the hold period.`,
      amountPaisa: reward
    });
    await audit(ctx, "task_approved", "taskAssignment", assignmentId, { userId: asg.userId, rewardPaisa: reward });
    return { ok: true };
  }

  throw new HttpsError("invalid-argument", "Unknown action.");
});

async function systemMsg(uid, text) {
  try {
    const convRef = db.doc(`conversations/${uid}`);
    await convRef.collection("messages").add({
      senderId: "system", senderRole: "system", senderName: "AfnoKamai",
      type: "system", clientRef: "", text, createdAt: FieldValue.serverTimestamp()
    });
    await convRef.update({
      lastMessage: text.slice(0, 80), lastType: "system", lastSenderId: "system",
      lastSenderRole: "system", lastMessageAt: FieldValue.serverTimestamp(),
      unreadForUser: FieldValue.increment(1)
    });
  } catch (e) {
    logger.warn("systemMsg failed", { uid, error: String(e) });
  }
}

// ═══════════════════ Hold release (scheduled) ════════════════════════

exports.releaseHolds = onSchedule(
  { schedule: "every 15 minutes", secrets: [BREVO_API_KEY], timeoutSeconds: 540 },
  async () => {
    const q = db.collection("transactions")
      .where("status", "==", "hold")
      .where("availableAt", "<=", Timestamp.now())
      .limit(300);
    const snap = await q.get();
    if (snap.empty) return null;

    let released = 0;
    for (const docSnap of snap.docs) {
      try {
        await db.runTransaction(async (t) => {
          const tx = await t.get(docSnap.ref);
          if (!tx.exists || tx.data().status !== "hold") return;
          const data = tx.data();
          const walletRef = db.doc(`wallets/${data.userId}`);
          const w = await t.get(walletRef);
          if (!w.exists) return;
          t.update(docSnap.ref, { status: "available", releasedAt: FieldValue.serverTimestamp() });
          t.update(walletRef, {
            holdPaisa: FieldValue.increment(-data.amountPaisa),
            availablePaisa: FieldValue.increment(data.amountPaisa),
            updatedAt: FieldValue.serverTimestamp()
          });
        });
        released++;
        await platformBump("holdPaisa", -docSnap.data().amountPaisa);
        await notify(docSnap.data().userId, {
          type: "reward_released", tone: "green", icon: "unlock", link: "withdraw.html",
          title: "Funds released 🎉",
          body: `${npr(docSnap.data().amountPaisa)} has left the hold period and is now withdrawable.`,
          amountPaisa: docSnap.data().amountPaisa
        });
      } catch (e) {
        logger.error("hold release failed", { txId: docSnap.id, error: String(e) });
      }
    }
    logger.info(`releaseHolds: released ${released} transaction(s)`);
    return null;
  }
);

// ═══════════════════════ Withdrawals ═════════════════════════════════

exports.requestWithdrawal = onCall({ secrets: [BREVO_API_KEY] }, async (ctx) => {
  const a = assertAuth(ctx);
  assertVerified(ctx);
  const u = await getUserDoc(a.uid);
  assertNotBanned(u);
  assertProfileComplete(u);

  const { amountPaisa, esewaName, esewaNumber, pin } = ctx.data || {};
  const amount = intPaisa(amountPaisa, "withdrawal amount");
  const name = String(esewaName || "").trim().replace(/\s+/g, " ");
  const number = String(esewaNumber || "").replace(/[\s-]/g, "");
  if (name.length < 3) throw new HttpsError("invalid-argument", "Please enter the eSewa account name.");
  if (!/^(9[678]\d{8})$/.test(number)) throw new HttpsError("invalid-argument", "Please enter a valid eSewa mobile number, e.g. 98XXXXXXXX.");

  const config = await getPlatformConfig();
  if (amount < config.minWithdrawalPaisa) {
    throw new HttpsError("failed-precondition", `The minimum withdrawal is ${npr(config.minWithdrawalPaisa)}.`);
  }
  if (amount > MAX_WITHDRAWAL_PAISA) {
    throw new HttpsError("failed-precondition", `The maximum single withdrawal is ${npr(MAX_WITHDRAWAL_PAISA)}.`);
  }

  const userRef = db.doc(`users/${a.uid}`);
  await verifyPinCore(userRef, await getUserDoc(a.uid), pin);

  const withdrawalRef = db.collection("withdrawals").doc();
  let result;
  await db.runTransaction(async (t) => {
    const walletRef = db.doc(`wallets/${a.uid}`);
    const wSnap = await t.get(walletRef);
    if (!wSnap.exists) throw new HttpsError("failed-precondition", "Wallet not found.");
    const w = wSnap.data();

    if ((w.pendingWithdrawalPaisa || 0) > 0) {
      throw new HttpsError("failed-precondition", "You already have a withdrawal being processed. Wait for it to complete or be rejected.");
    }
    if (amount > (w.availablePaisa || 0)) {
      throw new HttpsError("failed-precondition", "That amount exceeds your withdrawable balance. Hold balance cannot be withdrawn.");
    }

    const txRef = db.collection("transactions").doc();
    t.update(walletRef, {
      availablePaisa: FieldValue.increment(-amount),
      pendingWithdrawalPaisa: FieldValue.increment(amount),
      updatedAt: FieldValue.serverTimestamp()
    });
    t.set(withdrawalRef, {
      withdrawalId: withdrawalRef.id,
      userId: a.uid,
      userName: u.fullName || "",
      userEmail: u.email || "",
      amountPaisa: amount,
      esewaName: name,
      esewaNumber: number,
      status: "pending",
      reason: "",
      txId: txRef.id,
      requestedAt: FieldValue.serverTimestamp(),
      reviewedAt: null, reviewedBy: null
    });
    t.set(txRef, {
      transactionId: txRef.id,
      userId: a.uid,
      type: "withdrawal",
      amountPaisa: -amount,
      status: "pending",
      source: "esewa_withdrawal",
      referenceId: withdrawalRef.id,
      description: `eSewa withdrawal to +977 ${number}`,
      availableAt: null,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: a.uid
    });
    result = { withdrawalId: withdrawalRef.id };
  });

  await notifyAdmins({
    type: "withdrawal", tone: "amber", icon: "bank", link: `admin/withdrawals.html`,
    title: "New withdrawal request",
    body: `${u.fullName || u.email} requested ${npr(amount)} to eSewa +977 ${number}.`
  });
  await notify(a.uid, {
    type: "withdrawal", tone: "blue", icon: "bank", link: "withdraw.html",
    title: "Withdrawal submitted",
    body: `${npr(amount)} to eSewa ${name} is pending admin verification.`,
    amountPaisa: -amount
  });
  await dailyBump("withdrawalsPaisa", amount);
  await dailyBump("withdrawalsCount");
  await sendEmail(u.email, u.fullName, "Withdrawal request received",
    `<p>Your withdrawal of <strong>${npr(amount)}</strong> to eSewa (${name}, +977 ${number}) has been received and is pending verification.</p>`);
  return result;
});

exports.reviewWithdrawal = onCall({ secrets: [BREVO_API_KEY] }, async (ctx) => {
  assertAdminCtx(ctx);
  const adminUid = ctx.auth.uid;

  const { withdrawalId, action, reason } = ctx.data || {};
  const cleanReason = String(reason || "").slice(0, 500).trim();
  if (!withdrawalId || !action) throw new HttpsError("invalid-argument", "Missing withdrawal or action.");

  const wRef = db.doc(`withdrawals/${withdrawalId}`);
  const wSnap = await wRef.get();
  if (!wSnap.exists) throw new HttpsError("not-found", "Withdrawal not found.");
  const w = wSnap.data();
  const amount = w.amountPaisa;
  const walletRef = db.doc(`wallets/${w.userId}`);

  if (action === "under_review" || action === "processing") {
    if (!["pending", "under_review"].includes(w.status)) {
      throw new HttpsError("failed-precondition", `Cannot move a ${w.status} withdrawal to ${action}.`);
    }
    await wRef.update({ status: action, reviewedAt: FieldValue.serverTimestamp(), reviewedBy: adminUid });
    await notify(w.userId, {
      type: "withdrawal", tone: "blue", icon: "bank", link: "withdraw.html",
      title: action === "processing" ? "Withdrawal is being processed" : "Withdrawal under review",
      body: `${npr(amount)} to eSewa ${w.esewaName} is now ${action === "processing" ? "being processed" : "under review"}.`
    });
    await audit(ctx, `withdrawal_${action}`, "withdrawal", withdrawalId, { userId: w.userId, amountPaisa: amount });
    return { ok: true };
  }

  if (action === "completed") {
    if (!["pending", "under_review", "approved", "processing"].includes(w.status)) {
      throw new HttpsError("failed-precondition", `Cannot complete a ${w.status} withdrawal.`);
    }
    await db.runTransaction(async (t) => {
      const fresh = await t.get(wRef);
      if (fresh.data().status === "completed" || fresh.data().status === "rejected") {
        throw new HttpsError("failed-precondition", "Withdrawal already finalized.");
      }
      t.update(wRef, { status: "completed", reviewedAt: FieldValue.serverTimestamp(), reviewedBy: adminUid });
      t.update(walletRef, {
        pendingWithdrawalPaisa: FieldValue.increment(-amount),
        withdrawnPaisa: FieldValue.increment(amount),
        updatedAt: FieldValue.serverTimestamp()
      });
      if (w.txId) {
        t.update(db.doc(`transactions/${w.txId}`), { status: "completed" });
      }
      t.update(db.doc(`users/${w.userId}`), { "stats.withdrawnPaisa": FieldValue.increment(amount) });
    });
    await platformBump("totalWithdrawnPaisa", amount);
    await notify(w.userId, {
      type: "withdrawal_completed", tone: "green", icon: "check", link: "transactions.html",
      title: "Withdrawal completed ✅",
      body: `${npr(amount)} has been sent to your eSewa account (${w.esewaName}, +977 ${w.esewaNumber}).`,
      amountPaisa: -amount
    });
    await sendEmail(w.userEmail, w.userName, "Your withdrawal is complete",
      `<p><strong>${npr(amount)}</strong> has been sent to your eSewa account (${w.esewaName}, +977 ${w.esewaNumber}).</p>`);
    await audit(ctx, "withdrawal_completed", "withdrawal", withdrawalId, { userId: w.userId, amountPaisa: amount });
    return { ok: true };
  }

  if (action === "rejected") {
    if (cleanReason.length < 5) throw new HttpsError("invalid-argument", "A rejection reason is required.");
    if (["completed", "rejected", "cancelled"].includes(w.status)) {
      throw new HttpsError("failed-precondition", "Withdrawal already finalized.");
    }
    await db.runTransaction(async (t) => {
      const fresh = await t.get(wRef);
      if (["completed", "rejected"].includes(fresh.data().status)) {
        throw new HttpsError("failed-precondition", "Withdrawal already finalized.");
      }
      t.update(wRef, { status: "rejected", reason: cleanReason, reviewedAt: FieldValue.serverTimestamp(), reviewedBy: adminUid });
      t.update(walletRef, {
        availablePaisa: FieldValue.increment(amount),
        pendingWithdrawalPaisa: FieldValue.increment(-amount),
        updatedAt: FieldValue.serverTimestamp()
      });
      if (w.txId) {
        t.update(db.doc(`transactions/${w.txId}`), { status: "reversed" });
      }
      const revRef = db.collection("transactions").doc();
      t.set(revRef, {
        transactionId: revRef.id,
        userId: w.userId,
        type: "withdrawal_reversal",
        amountPaisa: amount,
        status: "available",
        source: "withdrawal_rejected",
        referenceId: withdrawalId,
        description: `Withdrawal rejected — refunded. Reason: ${cleanReason.slice(0, 120)}`,
        availableAt: null,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: adminUid
      });
    });
    await notify(w.userId, {
      type: "withdrawal_rejected", tone: "red", icon: "x", link: "withdraw.html",
      title: "Withdrawal rejected",
      body: `${npr(amount)} was returned to your withdrawable balance. Reason: ${cleanReason}`,
      amountPaisa: amount
    });
    await sendEmail(w.userEmail, w.userName, "Your withdrawal was rejected",
      `<p>Your withdrawal of <strong>${npr(amount)}</strong> was rejected and the amount returned to your balance.</p><p><strong>Reason:</strong> ${cleanReason}</p>`);
    await audit(ctx, "withdrawal_rejected", "withdrawal", withdrawalId, { userId: w.userId, reason: cleanReason });
    return { ok: true };
  }

  throw new HttpsError("invalid-argument", "Unknown action.");
});

// ═══════════════ Penalties / adjustments / bans ══════════════════════

exports.applyPenalty = onCall({ secrets: [BREVO_API_KEY] }, async (ctx) => {
  assertAdminCtx(ctx);
  const { userId, amountPaisa, reason, taskId } = ctx.data || {};
  const amount = intPaisa(amountPaisa, "penalty amount");
  const cleanReason = String(reason || "").slice(0, 500).trim();
  if (cleanReason.length < 5) throw new HttpsError("invalid-argument", "A clear reason is required.");

  const u = await getUserDoc(userId);
  if (!u) throw new HttpsError("not-found", "User not found.");

  const walletRef = db.doc(`wallets/${userId}`);
  const applied = { available: 0, hold: 0, total: 0 };

  await db.runTransaction(async (t) => {
    const wSnap = await t.get(walletRef);
    const w = wSnap.exists ? wSnap.data() : { availablePaisa: 0, holdPaisa: 0 };
    const available = w.availablePaisa || 0;
    const hold = w.holdPaisa || 0;
    applied.total = Math.min(amount, available + hold);
    applied.available = Math.min(available, applied.total);
    applied.hold = applied.total - applied.available;

    t.update(walletRef, {
      availablePaisa: FieldValue.increment(-applied.available),
      holdPaisa: FieldValue.increment(-applied.hold),
      updatedAt: FieldValue.serverTimestamp()
    });
    const txRef = db.collection("transactions").doc();
    t.set(txRef, {
      transactionId: txRef.id,
      userId,
      type: "penalty",
      amountPaisa: -applied.total,
      status: "available",
      source: "admin_penalty",
      referenceId: taskId || "",
      description: `Penalty: ${cleanReason.slice(0, 140)}`,
      availableAt: null,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: ctx.auth.uid
    });
    t.set(db.collection("penalties").doc(), {
      userId,
      userName: u.fullName || "",
      userEmail: u.email || "",
      amountPaisa: applied.total,
      requestedPaisa: amount,
      reason: cleanReason,
      type: "amount",
      taskId: taskId || "",
      appliedBy: ctx.auth.uid,
      appliedByName: (await getUserDoc(ctx.auth.uid))?.fullName || "",
      appliedAt: FieldValue.serverTimestamp()
    });
    t.update(db.doc(`users/${userId}`), { "stats.penaltiesPaisa": FieldValue.increment(applied.total) });
  });

  if (applied.hold > 0) await platformBump("holdPaisa", -applied.hold);
  await dailyBump("penaltiesPaisa", applied.total);
  await notify(userId, {
    type: "penalty", tone: "red", icon: "alert", link: "transactions.html",
    title: "Penalty applied",
    body: `A penalty of ${npr(applied.total)} has been applied to your account.\nReason: ${cleanReason}`,
    amountPaisa: -applied.total
  });
  await sendEmail(u.email, u.fullName, "A penalty was applied to your account",
    `<p>A penalty of <strong>${npr(applied.total)}</strong> has been applied to your account.</p><p><strong>Reason:</strong> ${cleanReason}</p>`);
  await audit(ctx, "penalty_applied", "user", userId, { amountPaisa: applied.total, reason: cleanReason });
  return { ok: true, appliedPaisa: applied.total };
});

exports.adjustBalance = onCall({}, async (ctx) => {
  assertAdminCtx(ctx);
  const { userId, amountPaisa, reason } = ctx.data || {};
  const delta = Number(amountPaisa);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ADJUSTMENT_PAISA) {
    throw new HttpsError("invalid-argument", "Invalid adjustment amount.");
  }
  const cleanReason = String(reason || "").slice(0, 500).trim();
  if (cleanReason.length < 5) throw new HttpsError("invalid-argument", "A clear reason is required.");
  const u = await getUserDoc(userId);
  if (!u) throw new HttpsError("not-found", "User not found.");

  let appliedDelta = delta;
  await db.runTransaction(async (t) => {
    const walletRef = db.doc(`wallets/${userId}`);
    const wSnap = await t.get(walletRef);
    const available = wSnap.exists ? (wSnap.data().availablePaisa || 0) : 0;
    if (delta < 0) appliedDelta = -Math.min(available, -delta); // clamp at zero
    t.update(walletRef, {
      availablePaisa: FieldValue.increment(appliedDelta),
      updatedAt: FieldValue.serverTimestamp()
    });
    const txRef = db.collection("transactions").doc();
    t.set(txRef, {
      transactionId: txRef.id,
      userId,
      type: "adjustment",
      amountPaisa: appliedDelta,
      status: "available",
      source: "admin_adjustment",
      referenceId: "",
      description: `Adjustment: ${cleanReason.slice(0, 140)}`,
      availableAt: null,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: ctx.auth.uid
    });
  });

  await notify(userId, {
    type: "system", tone: appliedDelta > 0 ? "green" : "red", icon: "edit", link: "transactions.html",
    title: "Balance adjustment",
    body: `An adjustment of ${npr(appliedDelta)} was applied to your account.\nReason: ${cleanReason}`,
    amountPaisa: appliedDelta
  });
  await audit(ctx, "financial_adjustment", "user", userId, { amountPaisa: appliedDelta, reason: cleanReason });
  return { ok: true, appliedPaisa: appliedDelta };
});

exports.banUser = onCall({ secrets: [BREVO_API_KEY] }, async (ctx) => {
  assertAdminCtx(ctx);
  const { userId, action, type, reason, until } = ctx.data || {};
  const u = await getUserDoc(userId);
  if (!u) throw new HttpsError("not-found", "User not found.");
  if (u.role === "admin") throw new HttpsError("permission-denied", "Administrators cannot be banned here.");

  if (action === "ban") {
    const cleanReason = String(reason || "").slice(0, 500).trim();
    if (cleanReason.length < 5) throw new HttpsError("invalid-argument", "A ban reason is required.");
    const isPermanent = type !== "temporary";
    let untilTs = null;
    if (!isPermanent) {
      untilTs = until ? Timestamp.fromDate(new Date(until)) : Timestamp.fromMillis(Date.now() + 7 * 86400000);
    }
    await db.doc(`users/${userId}`).update({
      status: "banned",
      ban: { type: isPermanent ? "permanent" : "temporary", reason: cleanReason, until: untilTs, at: FieldValue.serverTimestamp(), by: ctx.auth.uid }
    });
    // Permanent bans also block login entirely.
    if (isPermanent) {
      await auth.updateUser(userId, { disabled: true }).catch((e) => logger.warn("disable failed", String(e)));
    }
    await notify(userId, {
      type: "security", tone: "red", icon: "ban", link: "",
      title: "Account restricted",
      body: `Your AfnoKamai account has been ${isPermanent ? "permanently" : "temporarily"} restricted.\nReason: ${cleanReason}`
    });
    await sendEmail(u.email, u.fullName, "Your AfnoKamai account has been restricted",
      `<p>Your account has been ${isPermanent ? "permanently" : "temporarily"} restricted.</p><p><strong>Reason:</strong> ${cleanReason}</p>${!isPermanent && untilTs ? `<p><strong>Restriction ends:</strong> ${untilTs.toDate().toDateString()}</p>` : ""}`);
    await audit(ctx, "user_banned", "user", userId, { type: isPermanent ? "permanent" : "temporary", reason: cleanReason });
    return { ok: true };
  }

  if (action === "unban") {
    await db.doc(`users/${userId}`).update({
      status: "active",
      ban: FieldValue.delete()
    });
    await auth.updateUser(userId, { disabled: false }).catch(() => {});
    await notify(userId, {
      type: "system", tone: "green", icon: "check", link: "dashboard.html",
      title: "Account restored",
      body: "The restriction on your account has been lifted. Welcome back!"
    });
    await audit(ctx, "user_unbanned", "user", userId, {});
    return { ok: true };
  }

  throw new HttpsError("invalid-argument", "Unknown action.");
});

// ═══════════════ Chat spam guard (lightweight) ═══════════════════════

exports.onMessageCreated = onDocumentCreated("conversations/{cid}/messages/{mid}", async (event) => {
  const data = event.data && event.data.data();
  if (!data || data.senderRole !== "user" || !data.senderId) return null;

  const minuteKey = String(Math.floor(Date.now() / 60000));
  const userRef = db.doc(`users/${data.senderId}`);
  let overLimit = false;
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    const u = snap.data() || {};
    const count = u.msgMinuteKey === minuteKey ? (u.msgCount || 0) + 1 : 1;
    overLimit = count > CHAT_MSG_LIMIT_PER_MIN;
    t.set(userRef, { msgMinuteKey: minuteKey, msgCount: count }, { merge: true });
    if (overLimit) t.delete(event.data.ref);
  });
  if (overLimit) {
    await notify(data.senderId, {
      type: "security", tone: "amber", icon: "message", link: "chat.html",
      title: "Slow down",
      body: "You're sending messages too quickly. Please wait a moment before sending more."
    });
  }
  return null;
});
