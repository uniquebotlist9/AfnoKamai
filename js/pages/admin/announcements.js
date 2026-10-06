// ─── Admin: announcements CRUD ───────────────────────────────────────
import { db } from '../../firebase.js';
import {
  collection, query, orderBy, limit, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, startAfter
} from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=3';
import { esc, fmtDateTime } from '../../utils.js';
import { icon } from '../../icons.js';
import { emptyState, skeletonRows, badge, modal, confirmDialog, btnBusy, toast, autoPager } from '../../ui.js';

let { profile, content } = await mountAdminShell('announcements');
document.getElementById('page-skeleton')?.remove();

const TYPES = ['General', 'Important', 'Update', 'Warning', 'Maintenance'];
const TONE = { General: 'blue', Important: 'red', Update: 'green', Warning: 'amber', Maintenance: 'gold' };

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Announcements</h1>
      <p class="sub">Published announcements appear on the user dashboard and in notifications.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn primary" id="new-ann">${icon('plus')} New announcement</button>
    </div>
  </div>
  <div id="ann-list" style="display:flex; flex-direction:column; gap:14px">${skeletonRows(3, 90)}</div>`;

const listEl = content.querySelector('#ann-list');
let cursor = null;

// One page of the list. `run` comes from autoPager: when a newer run starts
// (publish/delete/create refresh) this one stops instead of appending stale rows.
async function load(reset, run) {
  if (reset) { cursor = null; listEl.innerHTML = skeletonRows(3, 90); }
  try {
    const parts = [collection(db, 'announcements'), orderBy('createdAt', 'desc'), limit(15)];
    if (cursor) parts.push(startAfter(cursor));
    const snap = await getDocs(query(...parts));
    if (run.stale) return null;
    if (reset && snap.empty) {
      listEl.innerHTML = emptyState({ icon: 'megaphone', title: 'No announcements', message: 'Create one to inform users about updates, maintenance or warnings.', actionHTML: '<button class="btn primary" id="empty-new">Create announcement</button>' });
      listEl.querySelector('#empty-new').addEventListener('click', annModal);
      return null;
    }
    if (reset) listEl.innerHTML = '';
    listEl.insertAdjacentHTML('beforeend', snap.docs.map((d) => {
      const a = d.data();
      const tone = TONE[a.type] || 'gray';
      return `
        <div class="card card-pad ann-card">
          <div class="ann-type" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
            ${badge(a.type || 'General', tone)}
            ${a.priority ? badge('High priority', 'red') : ''}
            ${a.published ? badge('Published', 'green', { dot: true }) : badge('Draft', 'gray', { dot: true })}
          </div>
          <h3 style="margin:8px 0 4px">${esc(a.title)}</h3>
          <p style="color:var(--ink-2); margin-bottom:10px">${esc(a.message)}</p>
          <div class="small muted" style="display:flex; gap:12px; flex-wrap:wrap; align-items:center">
            <span>${esc(fmtDateTime(a.publishedAt || a.createdAt))}</span>
            <span style="flex:1"></span>
            <button class="btn ghost btn-sm" data-publish="${esc(d.id)}" data-pub="${a.published ? '1' : ''}">${a.published ? 'Unpublish' : 'Publish'}</button>
            <button class="btn ghost btn-sm" data-del="${esc(d.id)}">${icon('trash')}</button>
          </div>
        </div>`;
    }).join(''));
    // Bind only cards added by THIS page — re-binding the whole list after
    // "Load more" would fire two confirm dialogs / two writes per click.
    listEl.querySelectorAll('.ann-card:not([data-wired])').forEach((card) => {
      card.dataset.wired = '1';
      const pubBtn = card.querySelector('[data-publish]');
      const delBtn = card.querySelector('[data-del]');

      if (pubBtn) pubBtn.addEventListener('click', async () => {
        if (pubBtn.disabled) return;
        const publish = !pubBtn.dataset.pub;
        btnBusy(pubBtn, true, publish ? 'Publishing…' : 'Unpublishing…');
        try {
          await updateDoc(doc(db, 'announcements', pubBtn.dataset.publish), {
            published: publish,
            publishedAt: publish ? serverTimestamp() : null
          });
          toast(publish ? 'Announcement published.' : 'Announcement unpublished.', { type: 'success' });
          loadAll(true);
        } catch (err) {
          btnBusy(pubBtn, false);
          toast((err && err.message) || 'Could not update the announcement.', { type: 'error' });
        }
      });

      if (delBtn) delBtn.addEventListener('click', async () => {
        if (delBtn.disabled) return;
        const ok = await confirmDialog({ title: 'Delete announcement?', message: 'This cannot be undone.', confirmText: 'Delete', danger: true });
        if (!ok) return;
        btnBusy(delBtn, true, 'Deleting…');
        try {
          await deleteDoc(doc(db, 'announcements', delBtn.dataset.del));
          toast('Announcement deleted.', { type: 'success' });
          loadAll(true);
        } catch (err) {
          btnBusy(delBtn, false);
          toast((err && err.message) || 'Could not delete the announcement.', { type: 'error' });
        }
      });
    });
    cursor = snap.docs[snap.docs.length - 1] || null;
    return cursor;
  } catch (_) {
    if (reset) listEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load announcements', message: 'Please refresh.' });
    return null;
  }
}

// No "Load more": keep fetching pages until everything is loaded.
const loadAll = autoPager(load);
loadAll(true);
content.querySelector('#new-ann').addEventListener('click', () => annModal());

function annModal() {
  const m = modal({
    title: 'New announcement',
    width: 560,
    body: `
      <div class="field">
        <label class="label">Title <span class="req">*</span></label>
        <input class="input" id="a-title" placeholder="e.g. Scheduled maintenance this Saturday">
      </div>
      <div class="field">
        <label class="label">Message <span class="req">*</span></label>
        <textarea class="textarea" id="a-msg" placeholder="What should users know?"></textarea>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
        <div class="field">
          <label class="label">Type</label>
          <select class="select" id="a-type">${TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label class="label">Priority</label>
          <select class="select" id="a-priority"><option value="">Normal</option><option value="high">High</option></select>
        </div>
      </div>`,
    actions: `
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="save">Create & publish</button>`
  });
  m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.root.querySelector('[data-act="save"]').addEventListener('click', async (ev) => {
    const title = m.root.querySelector('#a-title').value.trim();
    const message = m.root.querySelector('#a-msg').value.trim();
    if (title.length < 3 || message.length < 5) { toast('Title and message are required.', { type: 'error' }); return; }
    const btn = ev.currentTarget;
    btnBusy(btn, true, 'Publishing…');
    try {
      const ref = await addDoc(collection(db, 'announcements'), {
        title, message,
        type: m.root.querySelector('#a-type').value,
        priority: m.root.querySelector('#a-priority').value,
        published: true,
        publishedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        createdBy: profile.id,
        createdByName: profile.fullName
      });
      // notify all users is expensive; notify via announcements feed only (dashboard banner)
      m.close();
      toast('Announcement published. It will appear on user dashboards.', { type: 'success' });
      loadAll(true);
    } catch (err) { btnBusy(btn, false); toast(err.message, { type: 'error' }); }
  });
}
