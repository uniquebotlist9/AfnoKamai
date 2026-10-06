// ─── Real-time chat engine (user & admin) ────────────────────────────
import { db, isConfigured } from './firebase.js';
import {
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, writeBatch, increment
} from 'firebase/firestore';
import { esc, fmtDateTime, fmtTime, fmtRelative, fmtBytes } from './utils.js';
import { icon } from './icons.js';
import { toast, confirmDialog } from './ui.js';
import { createNotification } from './notify.js';

// Media is stored INLINE in Firestore (base64 in the message document).
// Firestore documents cap at 1 MiB, so attachments must stay small.
const MEDIA_LIMITS = { image: 500 * 1024, file: 400 * 1024 }; // raw bytes
const MSG_PAGE = 60;

export async function mountChat({ root, role, selfUid, selfName }) {
  if (!isConfigured()) {
    root.innerHTML = '<div class="card"><div class="state-block error"><h3>Not configured</h3><p>Firebase is not configured for this deployment.</p></div></div>';
    return;
  }

  if (role === 'user') {
    await ensureConversation(selfUid);
    root.innerHTML = '';
    const threadCard = document.createElement('div');
    threadCard.className = 'card chat-thread';
    root.appendChild(threadCard);
    const cleanup = buildThread(threadCard, { role, cid: selfUid, selfUid, selfName, withBack: false });
    // Detach listeners when the page is torn down (SPA back/forward, tab close).
    window.addEventListener('pagehide', () => cleanup && cleanup(), { once: true });
    return;
  }

  // ── Admin mode: conversation list + thread ──
  root.innerHTML = `
    <div class="chat-layout">
      <div class="card conv-list">
        <div class="card-head">
          <div><h3>Conversations</h3><div class="sub">Users with an open support channel</div></div>
        </div>
        <div style="padding:10px 12px 4px"><input class="input" id="conv-search" placeholder="Search name or email…" aria-label="Search conversations"></div>
        <div class="conv-items" id="conv-items"><div class="state-block loading"><span class="spin dark"></span></div></div>
      </div>
      <div class="card chat-thread hidden-mobile" id="admin-thread">
        <div class="state-block empty" style="margin:auto">
          <div class="state-ic">${icon('message')}</div>
          <h3>Select a conversation</h3>
          <p>Choose a user on the left to open the chat.</p>
        </div>
      </div>
    </div>`;

  const itemsEl = root.querySelector('#conv-items');
  const searchEl = root.querySelector('#conv-search');
  const threadCard = root.querySelector('#admin-thread');
  let allConvs = [];
  let filterText = '';
  let activeCleanup = null;

  const targetUid = new URLSearchParams(location.search).get('uid');

  const qConvs = query(collection(db, 'conversations'), orderBy('lastMessageAt', 'desc'), limit(100));
  onSnapshot(qConvs, (snap) => {
    allConvs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderConvList();
    if (targetUid && allConvs.some((c) => c.id === targetUid) && !activeCleanup) openConversation(targetUid);
  }, () => {
    itemsEl.innerHTML = '<div class="state-block error"><h3>Could not load conversations</h3><p>Check your connection and try again.</p></div>';
  });

  function renderConvList() {
    const list = allConvs.filter((c) => {
      if (!filterText) return true;
      const t = filterText.toLowerCase();
      return (c.userName || '').toLowerCase().includes(t) || (c.userEmail || '').toLowerCase().includes(t);
    });
    if (!list.length) {
      itemsEl.innerHTML = `<div class="state-block empty"><div class="state-ic">${icon('inbox')}</div><h3>No conversations</h3><p>${filterText ? 'No users match your search.' : 'When users request tasks or send messages, they appear here.'}</p></div>`;
      return;
    }
    itemsEl.innerHTML = list.map((c) => `
      <button class="conv-item ${c.unreadForAdmin ? 'unread' : ''} ${c.id === currentCid ? 'active' : ''}" data-cid="${esc(c.id)}">
        <span class="avatar ${c.unreadForAdmin ? 'gold' : ''}">${esc(initialsSafe(c.userName))}</span>
        <span class="cv-body">
          <span class="cv-top"><span class="cv-name">${esc(c.userName || c.userEmail || c.id)}</span>
          <span class="cv-time">${c.lastMessageAt ? esc(fmtRelative(c.lastMessageAt)) : ''}</span></span>
          <span class="cv-bottom">
            <span class="cv-last">${esc(lastPreview(c))}</span>
            ${c.unreadForAdmin ? `<span class="cv-unread">${c.unreadForAdmin}</span>` : ''}
          </span>
          ${convReceiptHtml(c)}
        </span>
      </button>`).join('');
    itemsEl.querySelectorAll('.conv-item').forEach((el) =>
      el.addEventListener('click', () => openConversation(el.dataset.cid)));
  }

  searchEl.addEventListener('input', () => { filterText = searchEl.value; renderConvList(); });

  function lastPreview(c) {
    if (!c.lastMessage) return 'No messages yet';
    const icons = { image: '📷 Photo', file: '📎 Attachment' };
    return (c.lastType && icons[c.lastType]) || c.lastMessage;
  }

  let currentCid = null;
  let openToken = 0;

  async function openConversation(cid) {
    if (activeCleanup) { activeCleanup(); activeCleanup = null; }
    const token = ++openToken;
    currentCid = cid;
    itemsEl.querySelectorAll('.conv-item').forEach((el) => el.classList.toggle('active', el.dataset.cid === cid));

    root.querySelector('.conv-list').classList.add('visible-mobile');
    threadCard.classList.remove('hidden-mobile');

    const convSnap = await getDoc(doc(db, 'conversations', cid));
    if (token !== openToken) return; // a newer conversation was opened meanwhile
    const conv = convSnap.data() || {};
    activeCleanup = buildThread(threadCard, { role: 'admin', cid, selfUid, selfName, conv, withBack: true });
    history.replaceState(null, '', `chats.html?uid=${cid}`);
  }

  threadCard.addEventListener('click', (e) => {
    if (e.target.closest('#chat-back-btn')) {
      root.querySelector('.conv-list').classList.remove('visible-mobile');
      threadCard.classList.add('hidden-mobile');
      if (activeCleanup) { activeCleanup(); activeCleanup = null; }
    }
  });
}

async function ensureConversation(uid) {
  const convRef = doc(db, 'conversations', uid);
  const snap = await getDoc(convRef);
  if (!snap.exists()) {
    const userSnap = await getDoc(doc(db, 'users', uid));
    const u = userSnap.data() || {};
    await setDoc(convRef, {
      participants: [uid],
      userId: uid,
      userName: u.fullName || 'User',
      userEmail: u.email || '',
      createdAt: serverTimestamp(),
      lastMessage: '',
      lastMessageAt: serverTimestamp(),
      lastSenderId: '',
      lastSenderRole: '',
      lastType: 'text',
      unreadForAdmin: 0,
      unreadForUser: 0,
      userTyping: false,
      adminTyping: false
    });
  }
}

function initialsSafe(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

/**
 * Website notification for a message an administrator just sent.
 *
 * Users may NOT create notification documents (firestore.rules restricts
 * `create` to admins), so the write happens in the admin's own session — this
 * is the only place it can happen for a normal chat message. Priority is
 * `high`: only a task assignment outranks it, because the admin chat is where
 * the private instructions for an assigned task are handed over.
 *
 * Never throws: a failed notification must not fail the message send.
 */
async function notifyUserOfAdminMessage(cid, { type, text }) {
  // One key for both attempts. If the first write succeeds but the network
  // drops the acknowledgement, the fallback re-runs against the same
  // document id and the transaction sees it already exists — so a retry can
  // never leave the user with two copies of one message.
  const eventId = `adminmsg_${cid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  try {
    const caption = String(text || '').slice(0, 160);
    const body = type === 'text'
      ? caption
      : `${type === 'image' ? '📷 Sent a photo' : '📎 Sent an attachment'}${caption ? `: ${caption}` : ''}`;
    await createNotification({
      userId: cid,
      type: 'admin_message',
      title: 'Message from admin',
      body: body || 'New message',
      link: 'chat.html',
      tone: 'gold',
      icon: 'message',
      priority: 'high',
      eventId
    });
  } catch (err) {
    console.warn('[notifyUserOfAdminMessage] failed:', err && err.code, err && err.message);
    try {
      // Same id, plainer wording — a genuinely useful second attempt (the
      // first may have failed on something body-specific), and idempotent.
      await createNotification({
        userId: cid,
        type: 'admin_message',
        title: 'New message from admin',
        body: 'You have a new message from admin. Open the chat to read it.',
        link: 'chat.html',
        tone: 'gold',
        icon: 'message',
        priority: 'high',
        eventId
      });
    } catch (err2) {
      console.warn('[notifyUserOfAdminMessage] fallback also failed:', err2 && err2.code, err2 && err2.message);
    }
  }
}

/**
 * Admin-side read receipt on a conversation's last message, so the list
 * answers "did the user actually see it?" without opening the thread.
 * `userLastReadAt` is stamped by the user's client in the same batch that
 * marks the messages read, so comparing it with `lastMessageAt` is enough
 * (5 s of slack absorbs server-clock skew). Only rendered when the last
 * message came from the admin side — a user's own message needs no receipt
 * in the admin's list.
 */
function convReceiptHtml(c) {
  const fromAdmin = c.lastSenderRole === 'admin' || c.lastSenderRole === 'system';
  if (!fromAdmin || !c.lastMessageAt || !c.lastMessageAt.toMillis) return '';
  const seenAt = c.userLastReadAt;
  if (seenAt && seenAt.toMillis && seenAt.toMillis() >= c.lastMessageAt.toMillis() - 5000) {
    return `<span class="cv-receipt seen">Seen ${esc(fmtRelative(seenAt))}</span>`;
  }
  return `<span class="cv-receipt">Delivered</span>`;
}

function buildThread(rootEl, { role, cid, selfUid, selfName, conv = {}, withBack }) {
  const name = role === 'admin' ? (conv.userName || 'User') : 'AfnoKamai Support';
  rootEl.innerHTML = `
    <div class="chat-head">
      ${withBack ? `<button class="btn-icon chat-back" id="chat-back-btn" aria-label="Back">${icon('chevLeft')}</button>` : ''}
      <span class="avatar ${role === 'user' ? 'gold' : ''}">${esc(initialsSafe(name))}</span>
      <div class="ch-body">
        <div class="ch-name">${esc(name)}</div>
        <div class="ch-status" id="chat-presence"><span class="presence-dot away"></span>…</div>
      </div>
    </div>
    <div class="chat-messages" id="chat-messages">
      <div class="load-older" id="load-older" hidden><button class="btn btn-sm ghost" id="load-older-btn">Load earlier messages</button></div>
    </div>
    <div class="chat-composer">
      <div class="attach-group">
        <button class="btn-icon" id="attach-btn" aria-label="Attach a file">${icon('paperclip')}</button>
        <div class="attach-menu" id="attach-menu" hidden>
          <button type="button" id="attach-image">${icon('image')} Photo (max 500 KB)</button>
          <button type="button" id="attach-file">${icon('file')} File (PDF, max 400 KB)</button>
        </div>
      </div>
      <textarea id="chat-input" rows="1" placeholder="Type a message…" aria-label="Type a message"></textarea>
      <button class="send-btn" id="send-btn" aria-label="Send message" disabled>${icon('send')}</button>
    </div>`;

  const messagesEl = rootEl.querySelector('#chat-messages');
  const input = rootEl.querySelector('#chat-input');
  const sendBtn = rootEl.querySelector('#send-btn');
  const attachBtn = rootEl.querySelector('#attach-btn');
  const attachMenu = rootEl.querySelector('#attach-menu');
  const presenceEl = rootEl.querySelector('#chat-presence');
  const loadOlderWrap = rootEl.querySelector('#load-older');

  let pageLimit = MSG_PAGE;
  let hasOlder = false;
  let latestMsgs = [];
  let pending = [];
  const pendingReconcilers = new Set(); // interval ids that retire sent-but-unconfirmed bubbles
  let nearBottom = true;
  let lastTypingSent = 0;
  let typingClearTimer = null;

  // ── presence header ──
  let presenceUnsub = null;
  if (role === 'user') {
    presenceUnsub = onSnapshot(doc(db, 'config', 'availability'), (snap) => {
      presenceEl.innerHTML = presenceHtml(adminPresence(snap.data() || {}));
    }, () => {});
  } else {
    presenceUnsub = onSnapshot(doc(db, 'users', cid), (snap) => {
      const u = snap.data() || {};
      const last = u.lastActiveAt;
      const online = last && (Date.now() - last.toMillis()) < 5 * 60 * 1000;
      presenceEl.innerHTML = online
        ? '<span class="presence-dot online"></span>Active recently'
        : `<span class="presence-dot away"></span>Last seen ${last ? esc(fmtRelative(last)) : '—'}`;
    }, () => {});
  }

  // ── messages stream ──
  let lastAdminMsgId = null;
  function listen() {
    const q = query(
      collection(db, 'conversations', cid, 'messages'),
      orderBy('createdAt', 'desc'),
      limit(pageLimit)
    );
    return onSnapshot(q, (snap) => {
      latestMsgs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
      hasOlder = snap.size === pageLimit;
      // Show a prominent banner for new admin messages while the user is
      // already on the chat page — every admin message is high priority.
      if (role === 'user') {
        const newAdmin = latestMsgs.find(
          (m) => (m.senderRole === 'admin' || m.senderRole === 'system') && m.id !== lastAdminMsgId && !m.readAt
        );
        if (newAdmin) {
          lastAdminMsgId = newAdmin.id;
          showAdminMessageBanner(newAdmin);
        }
      }
      renderAll();
      markRead(latestMsgs);
    }, () => {
      // Drop the render cache: otherwise a later successful snapshot with
      // identical HTML would be skipped and the error panel would stick forever.
      delete messagesEl.dataset.lastRender;
      messagesEl.innerHTML = '<div class="state-block error"><h3>Could not load messages</h3><p>Check your connection and try again.</p></div>';
    });
  }
  let msgUnsub = listen();

  // ── prominent banner for new admin messages on the chat page ──
  function showAdminMessageBanner(msg) {
    // Remove any existing banner first
    const existing = rootEl.querySelector('.admin-msg-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.className = 'admin-msg-banner';
    const preview = msg.type === 'text'
      ? (msg.text || '').slice(0, 120)
      : msg.type === 'image' ? '📷 Sent a photo' : '📎 Sent an attachment';
    banner.innerHTML = `
      <span class="amb-icon">${icon('message')}</span>
      <span class="amb-text"><strong>New message from admin:</strong> ${esc(preview)}</span>
      <button class="amb-close" aria-label="Dismiss">${icon('x')}</button>`;
    banner.querySelector('.amb-close').addEventListener('click', () => banner.remove());
    rootEl.insertBefore(banner, rootEl.firstChild);
    // Auto-dismiss after 12 seconds
    setTimeout(() => banner.remove(), 12000);
  }

  // ── while the user is reading this thread, notifications must clear ──
  // Otherwise the bell stays lit for messages/assignments already on screen.
  // `task_assigned` is included: its whole purpose is "open the chat", so
  // being in the chat means it has been acknowledged. Types are filtered
  // client-side — the query stays on the existing (userId, read) index.
  let notifUnsub = null;
  if (role === 'user') {
    notifUnsub = onSnapshot(
      query(
        collection(db, 'notifications'),
        where('userId', '==', cid),
        where('read', '==', false)
      ),
      (snap) => {
        const ours = snap.docs.filter((d) => {
          const t = d.data().type;
          return t === 'admin_message' || t === 'task_assigned';
        });
        if (!ours.length) return;
        try {
          const batch = writeBatch(db);
          ours.forEach((d) => batch.update(d.ref, { read: true, readAt: serverTimestamp() }));
          batch.commit().catch(() => {});
        } catch (_) { /* non-fatal */ }
      },
      () => {} // permission/offline errors must never break the thread
    );
  }

  // delegation: the button element is re-created on every render
  messagesEl.addEventListener('click', (e) => {
    if (e.target.closest('#load-older-btn')) { pageLimit += MSG_PAGE; msgUnsub(); msgUnsub = listen(); }
  });

  messagesEl.addEventListener('scroll', () => {
    nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
  });

  // image lightbox (zoom on tap)
  messagesEl.addEventListener('click', (e) => {
    const img = e.target.closest('img[data-lightbox]');
    if (!img) return;
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    const clone = document.createElement('img');
    clone.src = img.src;
    lb.appendChild(clone);
    document.body.appendChild(lb);
    lb.addEventListener('click', () => lb.remove(), { once: true });
  });

  function renderAll() {
    const refs = new Set(latestMsgs.map((m) => m.clientRef).filter(Boolean));
    const stillPending = pending.filter((p) => !refs.has(p.clientRef));

    let html = '';
    let lastDay = '';
    for (const m of [...latestMsgs, ...stillPending]) {
      if (m.createdAt) {
        const day = fmtDateKey(m.createdAt);
        if (day !== lastDay) {
          html += `<div class="chat-date-sep">${esc(fmtDayLabel(m.createdAt))}</div>`;
          lastDay = day;
        }
      }
      html += renderMessage(m, role);
    }
    const rendered = loadOlderWrap.outerHTML + html;
    if (rendered === messagesEl.dataset.lastRender) return;
    messagesEl.dataset.lastRender = rendered;
    messagesEl.innerHTML = rendered;
    const low = messagesEl.querySelector('#load-older');
    if (low) low.hidden = !hasOlder;
    if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    // admin message deletion
    messagesEl.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog({
          title: 'Delete this message?',
          message: 'The message is removed for both sides. Use for spam or inappropriate content.',
          confirmText: 'Delete', danger: true
        });
        if (!ok) return;
        try {
          await deleteDoc(doc(db, 'conversations', cid, 'messages', btn.dataset.del));
          toast('Message deleted.', { type: 'success' });
        } catch (err) { toast(err.message, { type: 'error' }); }
      });
    });
    // re-attach retry handlers for failed pending messages
    messagesEl.querySelectorAll('.msg-retry').forEach((btn) => {
      const ref = btn.closest('[data-ref]').dataset.ref;
      const p = stillPending.find((x) => x.clientRef === ref);
      if (p) btn.addEventListener('click', () => {
        pending = pending.filter((x) => x.clientRef !== ref);
        deliver({ type: p.type, text: p.text, file: p.file });
      });
    });
  }

  // ── read receipts ──
  async function markRead(msgs) {
    try {
      const unreadOthers = msgs.filter((m) => m.senderRole !== role && !m.readAt);
      if (!unreadOthers.length) return; // nothing to mark — avoid churning the conversation doc on every snapshot
      const batch = writeBatch(db);
      unreadOthers.forEach((m) => batch.update(doc(db, 'conversations', cid, 'messages', m.id), { readAt: serverTimestamp() }));
      batch.update(doc(db, 'conversations', cid), {
        [role === 'user' ? 'unreadForUser' : 'unreadForAdmin']: 0,
        [role === 'user' ? 'userLastReadAt' : 'adminLastReadAt']: serverTimestamp()
      });
      await batch.commit();
    } catch (_) { /* non-fatal */ }
  }

  // ── typing indicator ──
  let convTypingFresh = false;
  const convUnsub = onSnapshot(doc(db, 'conversations', cid), (snap) => {
    const c = snap.data() || {};
    const otherTyping = role === 'user' ? c.adminTyping : c.userTyping;
    const otherTypingAt = role === 'user' ? c.adminTypingAt : c.userTypingAt;
    convTypingFresh = !!(otherTyping && otherTypingAt && (Date.now() - otherTypingAt.toMillis()) < 6000);
    const row = messagesEl.querySelector('[data-typing]');
    if (row) row.hidden = !convTypingFresh;
    else if (convTypingFresh) {
      messagesEl.insertAdjacentHTML('beforeend',
        '<div class="msg-row typing-row" data-typing><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>');
    }
    if (convTypingFresh && nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  function setTyping(on) {
    const field = role === 'user' ? 'userTyping' : 'adminTyping';
    const at = role === 'user' ? 'userTypingAt' : 'adminTypingAt';
    updateDoc(doc(db, 'conversations', cid), { [field]: on, [at]: serverTimestamp() }).catch(() => {});
  }

  // ── composer ──
  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    const now = Date.now();
    if (now - lastTypingSent > 2500) { lastTypingSent = now; setTyping(true); }
    clearTimeout(typingClearTimer);
    typingClearTimer = setTimeout(() => setTyping(false), 4000);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  sendBtn.addEventListener('click', sendText);

  let sendTimes = [];
  function tooFast() {
    const now = Date.now();
    sendTimes = sendTimes.filter((t) => now - t < 60000);
    return sendTimes.length >= 15;
  }

  // Shared by text AND attachments: one budget, so a burst of either kind is capped.
  function spendQuota() {
    if (tooFast()) {
      toast("You're sending messages too quickly. Please wait a moment.", { type: 'warn' });
      return false;
    }
    sendTimes.push(Date.now());
    return true;
  }

  async function sendText() {
    const text = input.value.trim().slice(0, 4000); // rules cap text at 4000 chars
    if (!text) return;
    if (!spendQuota()) return;
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    setTyping(false);
    await deliver({ type: 'text', text });
  }

  // ── attachments ──
  attachBtn.addEventListener('click', () => { attachMenu.hidden = !attachMenu.hidden; });
  document.addEventListener('click', docClick);
  function docClick(e) {
    if (!rootEl.isConnected) { document.removeEventListener('click', docClick); return; }
    if (!attachMenu.contains(e.target) && !attachBtn.contains(e.target)) attachMenu.hidden = true;
  }
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.hidden = true;
  rootEl.appendChild(fileInput);
  rootEl.querySelector('#attach-image').addEventListener('click', () => pick('image'));
  rootEl.querySelector('#attach-file').addEventListener('click', () => pick('file'));
  function pick(kind) {
    attachMenu.hidden = true;
    fileInput.accept = kind === 'image' ? 'image/*' : 'application/pdf';
    fileInput.value = '';
    fileInput.click();
    fileInput.onchange = () => {
      const f = fileInput.files[0];
      if (!f) return;
      if (f.size > MEDIA_LIMITS[kind]) {
        toast(`That file is too large to send. Maximum size is ${fmtBytes(MEDIA_LIMITS[kind])} because attachments are stored directly in the database.`, { type: 'error' });
        return;
      }
      if (!spendQuota()) return; // attachments share the same send budget as text
      deliver({ type: kind, file: f });
    };
  }

  // ── delivery pipeline ──
  async function deliver({ type, text, file }) {
    const clientRef = `${selfUid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = String(text || '').slice(0, 4000); // rules cap text at 4000 chars
    const pendingMsg = {
      clientRef, senderId: selfUid, senderRole: role, senderName: selfName,
      type, text: body, createdAt: new Date(), pending: true, file
    };
    if (file) {
      pendingMsg.mediaName = file.name;
      pendingMsg.mediaSize = file.size;
      pendingMsg.mediaMime = file.type;
    }
    pending.push(pendingMsg);
    renderAll();

    let committed = false; // true once the message document exists server-side
    try {
      let mediaUrl = '';
      if (file) {
        // Read inline — media lives inside the Firestore message document.
        mediaUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('Could not read the file.'));
          reader.readAsDataURL(file);
        });
        if (mediaUrl.length > 950000) {
          throw new Error('That file is too large to send.');
        }
      }

      const message = {
        senderId: selfUid, senderRole: role, senderName: selfName,
        type, text: body, clientRef, createdAt: serverTimestamp()
      };
      if (mediaUrl) {
        Object.assign(message, {
          mediaUrl, mediaName: pendingMsg.mediaName,
          mediaSize: pendingMsg.mediaSize, mediaMime: pendingMsg.mediaMime
        });
      }
      const previews = { image: '📷 Photo', file: '📎 Attachment' };
      await addDoc(collection(db, 'conversations', cid, 'messages'), message);
      committed = true; // ── from here on the message EXISTS; never offer Retry ──
      await updateDoc(doc(db, 'conversations', cid), {
        lastMessage: previews[type] || body.slice(0, 80),
        lastType: type,
        lastMessageAt: serverTimestamp(),
        lastSenderId: selfUid,
        lastSenderRole: role,
        [role === 'user' ? 'unreadForAdmin' : 'unreadForUser']: increment(1),
        [role === 'user' ? 'userTyping' : 'adminTyping']: false
      });
      // Admin → user: raise the website notification (see helper for why it
      // must be written from this session).
      if (role === 'admin') await notifyUserOfAdminMessage(cid, { type, text: body });
      // snapshot reconciliation removes the pending bubble
      const reconcile = setInterval(() => {
        const stillThere = pending.some((p) => p.clientRef === clientRef);
        const inSnap = latestMsgs.some((m) => m.clientRef === clientRef);
        if (inSnap || !stillThere) { clearInterval(reconcile); pendingReconcilers.delete(reconcile); return; }
        pending = pending.filter((p) => p.clientRef !== clientRef);
        renderAll();
        clearInterval(reconcile);
        pendingReconcilers.delete(reconcile);
      }, 2500);
      pendingReconcilers.add(reconcile);
    } catch (err) {
      if (committed) {
        // The message DID land; only the conversation-preview write failed.
        // Offer no Retry (it would duplicate the message) — just settle the bubble.
        const settle = setInterval(() => {
          const inSnap = latestMsgs.some((m) => m.clientRef === clientRef);
          const stillThere = pending.some((p) => p.clientRef === clientRef);
          if (inSnap || !stillThere) {
            clearInterval(settle); pendingReconcilers.delete(settle); return;
          }
          pending = pending.filter((p) => p.clientRef !== clientRef);
          renderAll();
          clearInterval(settle); pendingReconcilers.delete(settle);
        }, 2500);
        pendingReconcilers.add(settle);
        toast('Message sent, but the conversation preview did not update. It will catch up shortly.', { type: 'warn' });
        return;
      }
      pendingMsg.failed = true;
      pendingMsg.failText = err && err.message ? err.message : '';
      renderAll();
      toast(pendingMsg.failText || 'Message could not be sent. Use Retry on the message.', { type: 'error' });
    }
  }

  // ── teardown ──
  // Called when the admin switches conversations or navigates away. Stops every
  // listener this thread owns so subscriptions don't pile up across the session.
  let tornDown = false;
  return function cleanupThread() {
    if (tornDown) return;
    tornDown = true;
    msgUnsub && msgUnsub();
    notifUnsub && notifUnsub();
    convUnsub && convUnsub();
    presenceUnsub && presenceUnsub();
    clearTimeout(typingClearTimer);
    document.removeEventListener('click', docClick);
    pendingReconcilers.forEach((id) => clearInterval(id));
    pendingReconcilers.clear();
  };
}

// ── rendering helpers ──
function renderMessage(m, role) {
  if (m.type === 'system') {
    // Instructions and decision notices are authored by the admin side, so the
    // admin needs the same receipt on them as on its own messages.
    const receipt = role === 'admin' && m.id
      ? (m.readAt
        ? `<span class="msg-sys-status seen">Seen ${esc(fmtRelative(m.readAt))}</span>`
        : `<span class="msg-sys-status">Delivered</span>`)
      : '';
    return `<div class="msg-system">${esc(m.text)}${receipt}</div>`;
  }
  const mine = m.senderRole === role;
  const ref = m.clientRef || m.id;
  let inner = '';
  if (m.type === 'image' && m.mediaUrl) {
    inner = `<div class="msg-media"><img src="${esc(m.mediaUrl)}" alt="${esc(m.mediaName || 'Image')}" loading="lazy" data-lightbox></div>`;
  } else if (m.type === 'file' && m.mediaUrl) {
    // Data URLs cannot be opened in a new tab — force a download instead.
    inner = `<div class="msg-file"><a href="${esc(m.mediaUrl)}" download="${esc(m.mediaName || 'attachment')}" rel="noopener">
      <span class="mf-ic">${icon('file')}</span>
      <span><span class="mf-name">${esc(m.mediaName || 'Attachment')}</span><br><span class="mf-size">${esc(fmtBytes(m.mediaSize))}</span></span>
    </a></div>`;
  }
  if (m.text) inner += `<div class="msg-text">${esc(m.text)}</div>`;

  if (m.pending) {
    inner += m.failed
      ? `<div class="msg-meta"><button class="msg-retry">${icon('refresh')} Retry</button></div>`
      : `<div class="msg-meta">Sending…</div>`;
  } else {
    const time = m.createdAt && m.createdAt.toDate ? fmtTime(m.createdAt) : '';
    const delBtn = role === 'admin' && m.id
      ? ` <button class="msg-del" data-del="${esc(m.id)}" title="Delete message">${icon('trash')}</button>`
      : '';
    inner += `<div class="msg-meta">${esc(time)}${receiptHtml(m, role)}${delBtn}</div>`;
  }
  return `<div class="msg-row ${mine ? 'me' : ''} ${m.failed ? 'msg-failed' : ''}" data-ref="${esc(ref)}"><div class="msg-bubble">${inner}</div></div>`;
}

/**
 * Read receipt on the sender's own message.
 *
 * `readAt` is stamped by the RECIPIENT's client when they open the thread
 * (`markRead`), so "Seen" really means the other side has read it — and the
 * live listener re-renders the thread the moment they do.
 *
 * The admin gets the explicit wording — "Seen 5 mins ago" / "Delivered" —
 * because it has to decide whether the user actually received the message
 * before private task details are exchanged. The user keeps the compact tick.
 */
function receiptHtml(m, role) {
  if (m.failed || m.senderRole !== role) return '';
  if (role !== 'admin') {
    return ` <span class="tick" title="${m.readAt ? 'Read' : 'Delivered'}">${icon('check')}</span>`;
  }
  return m.readAt
    ? ` <span class="msg-status seen">Seen ${esc(fmtRelative(m.readAt))}</span>`
    : ` <span class="msg-status">Delivered</span>`;
}

function adminPresence(a) {
  if (a.state === 'active' && a.updatedAt && (Date.now() - a.updatedAt.toMillis()) < 5 * 60 * 1000) {
    return { cls: 'online', label: 'Admin is currently active' };
  }
  if (a.state === 'away') {
    return { cls: 'away', label: a.nextAvailableAt ? `Admin expected to be active ${fmtRelative(a.nextAvailableAt)}` : 'Admin is currently away' };
  }
  if (a.updatedAt) return { cls: 'recent', label: `Admin active ${fmtRelative(a.updatedAt)}` };
  return { cls: 'away', label: 'Support team will reply soon' };
}

function presenceHtml({ cls, label }) {
  return `<span class="presence-dot ${cls}"></span>${esc(label)}`;
}

function fmtDateKey(ts) {
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(d);
}
function fmtDayLabel(ts) {
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const key = fmtDateKey(d);
  if (key === fmtDateKey(new Date())) return 'Today';
  if (key === fmtDateKey(new Date(Date.now() - 86400000))) return 'Yesterday';
  return fmtDateTime(d);
}
