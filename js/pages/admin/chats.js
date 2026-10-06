// ─── Admin: chat center (list + thread + task request actions) ───────
import { db } from '../../firebase.js';
import { collection, query, where, limit, getDocs, onSnapshot } from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=2';
import { esc, fmtNPR } from '../../utils.js';
import { icon } from '../../icons.js';
import { toast, btnBusy, modal } from '../../ui.js';
import { mountChat } from '../../chat.js';
import { reviewTask } from '../../admin-actions.js';

let { user, profile, content } = await mountAdminShell('chats');
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head" style="margin-bottom:14px">
    <div>
      <h1 style="font-size:22px">Chats</h1>
      <p class="sub">Assign tasks, review evidence, and answer user questions.</p>
    </div>
  </div>`;

const chatRoot = document.createElement('div');
content.appendChild(chatRoot);

const targetUid = new URLSearchParams(location.search).get('uid');

await mountChat({ root: chatRoot, role: 'admin', selfUid: user.uid, selfName: profile.fullName });

// ── Prompt dialog (window.prompt is blocked in many mobile WebViews) ──
function promptDialog({ title, message, placeholder = '' }) {
  return new Promise((resolve) => {
    const m = modal({
      title, width: 460,
      body: `${message ? `<p class="confirm-msg">${esc(message)}</p>` : ''}
        <textarea class="input" id="pd-text" rows="3" placeholder="${esc(placeholder)}" maxlength="500"></textarea>`,
      actions: `
        <button class="btn ghost" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="ok">Confirm</button>`,
      onClose: () => resolve(null)
    });
    const ta = m.root.querySelector('#pd-text');
    m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
    m.root.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const v = ta.value.trim();
      if (v.length < 5) { ta.classList.add('invalid'); return; }
      resolve(v);
      m.close();
    });
    setTimeout(() => ta.focus(), 140);
  });
}

// ── Pending task-request banner ──────────────────────────────────────
// The thread re-renders as messages stream in, so the banner is (re)inserted
// on a short interval and removed once nothing is pending.
let bannerFor = null;

async function maybeShowRequestBanner(uid) {
  if (!uid || !document.body.contains(content)) return;
  try {
    const snap = await getDocs(query(
      collection(db, 'taskAssignments'),
      where('userId', '==', uid),
      where('status', '==', 'requested'),
      limit(5)
    ));
    const pending = snap.empty ? null : snap.docs[0];
    const existing = content.querySelector('.chat-req-banner');
    if (!pending) {
      if (existing) existing.remove();
      bannerFor = null;
      return;
    }
    if (!content.querySelector('#admin-thread')) return;
    if (existing && bannerFor === pending.id) return;
    if (existing) existing.remove();
    bannerFor = pending.id;

    const assignmentId = pending.id;
    const a = pending.data();
    const banner = document.createElement('div');
    banner.className = 'chat-req-banner';
    banner.dataset.asg = assignmentId;
    banner.innerHTML = `
      <span class="ic">${icon('briefcase')}</span>
      <div class="crb-body">
        <strong>Task request: ${esc(a.title)}</strong>
        Reward ${esc(fmtNPR(a.rewardPaisa))} · the user is waiting to be assigned.
      </div>
      <button class="btn primary btn-sm" id="assign-req">${icon('check')} Assign task</button>
      <button class="btn ghost btn-sm" id="decline-req">Decline</button>`;
    content.insertBefore(banner, content.firstChild);

    banner.querySelector('#assign-req').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btnBusy(btn, true, 'Assigning…');
      try {
        await reviewTask({ assignmentId, action: 'assign' });
        banner.remove();
        bannerFor = null;
        toast('Task assigned — instructions were sent to the chat.', { type: 'success' });
      } catch (err) {
        toast((err && err.message) || 'Could not assign the task.', { type: 'error' });
        btnBusy(btn, false); // keep the button usable so the admin can retry
      }
    });

    banner.querySelector('#decline-req').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      const reason = await promptDialog({
        title: 'Decline this request',
        message: 'The reason is shown to the user.',
        placeholder: 'e.g. This task is no longer available.'
      });
      if (!reason) return;
      btnBusy(btn, true, 'Declining…');
      try {
        await reviewTask({ assignmentId, action: 'cancel', reason });
        banner.remove();
        bannerFor = null;
        toast('Request declined.', { type: 'success' });
      } catch (err) {
        toast((err && err.message) || 'Could not decline the request.', { type: 'error' });
        btnBusy(btn, false); // keep the button usable so the admin can retry
      }
    });
  } catch (_) { /* non-fatal: banner is advisory */ }
}

// One snapshot listener per conversation instead of a 5-second poll: the poll
// cost up to 5 reads every 5 s (≈3,600 reads/hour) while a request was pending.
// A listener costs 1 read on attach and then only fires on real changes.
let bannerUnsub = null;
function watchRequests(uid) {
  if (bannerUnsub) { bannerUnsub(); bannerUnsub = null; }
  if (!uid) return;
  bannerUnsub = onSnapshot(
    query(collection(db, 'taskAssignments'),
      where('userId', '==', uid), where('status', '==', 'requested'), limit(5)),
    () => maybeShowRequestBanner(uid)
  );
  maybeShowRequestBanner(uid);
}

if (targetUid) {
  watchRequests(targetUid);
  // Refresh the banner when a conversation is opened from the list.
  chatRoot.addEventListener('click', () => {
    const uid = new URLSearchParams(location.search).get('uid');
    if (uid && uid !== targetUid) {
      watchRequests(uid);
    } else {
      setTimeout(() => maybeShowRequestBanner(uid || targetUid), 600);
    }
  });
  window.addEventListener('pagehide', () => {
    if (bannerUnsub) { bannerUnsub(); bannerUnsub = null; }
  });
}
