// ─── Admin: task library (create/edit templates) ─────────────────────
import { db } from '../../firebase.js';
import {
  collection, query, orderBy, limit, getDocs, addDoc, updateDoc, doc, serverTimestamp
} from 'firebase/firestore';
import { mountAdminShell } from '../../admin-shell.js?v=2';
import { esc, fmtNPR, fmtDate, toPaisa, TASK_CATEGORIES } from '../../utils.js';
import { icon } from '../../icons.js';
import { emptyState, skeletonRows, badge, modal, btnBusy, toast } from '../../ui.js';

const STATUS_META = {
  draft: { label: 'Draft', tone: 'gray' },
  published: { label: 'Published', tone: 'green' },
  paused: { label: 'Paused', tone: 'amber' },
  full: { label: 'Full', tone: 'blue' },
  archived: { label: 'Archived', tone: 'gray' }
};

let { profile, content } = await mountAdminShell('tasks');
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Task library</h1>
      <p class="sub">Templates users can request. Only published tasks appear in the Earn page.</p>
    </div>
    <div class="page-head-actions">
      <button class="btn primary" id="new-task">${icon('plus')} New task</button>
    </div>
  </div>
  <div class="card"><div id="tasks-table">${skeletonRows(4, 56)}</div></div>`;

const tableEl = content.querySelector('#tasks-table');

async function load() {
  try {
    const snap = await getDocs(query(collection(db, 'tasks'), orderBy('createdAt', 'desc'), limit(100)));
    if (snap.empty) {
      tableEl.innerHTML = emptyState({
        icon: 'briefcase', title: 'No tasks yet',
        message: 'Create your first task template so users can request work.',
        actionHTML: '<button class="btn primary" id="empty-new">Create task</button>'
      });
      tableEl.querySelector('#empty-new')?.addEventListener('click', () => taskModal());
      return;
    }
    tableEl.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Task</th><th>Category</th><th>Reward</th><th>Slots</th><th>Status</th><th></th></tr></thead>
      <tbody>${snap.docs.map((d) => {
        const t = d.data();
        const remaining = t.slotsTotal > 0 ? Math.max(t.slotsTotal - (t.slotsTaken || 0), 0) : null;
        return `<tr>
          <td><div class="cell-strong">${esc(t.title)}</div><div class="small muted" style="max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(t.description || '')}</div></td>
          <td><span class="chip">${esc(t.category || 'Task')}</span></td>
          <td class="cell-strong num">${esc(fmtNPR(t.rewardPaisa))}</td>
          <td class="num small">${t.slotsTotal > 0 ? `${t.slotsTaken || 0}/${t.slotsTotal}` : '∞'}${t.deadline ? `<br><span class="small muted">due ${esc(fmtDate(t.deadline))}</span>` : ''}</td>
          <td>${STATUS_META[t.status] ? badge(STATUS_META[t.status].label, STATUS_META[t.status].tone, { dot: true }) : badge(t.status || 'draft', 'gray')}</td>
          <td style="text-align:right; white-space:nowrap">
            <button class="btn ghost btn-sm" data-edit="${esc(d.id)}" title="Edit">${icon('edit')}</button>
            ${t.status === 'published' ? `<button class="btn ghost btn-sm" data-toggle="${esc(d.id)}" data-to="paused">Pause</button>` : ''}
            ${(t.status === 'paused' || t.status === 'draft') ? `<button class="btn subtle btn-sm" data-toggle="${esc(d.id)}" data-to="published">Publish</button>` : ''}
            ${t.status !== 'archived' ? `<button class="btn ghost btn-sm" data-toggle="${esc(d.id)}" data-to="archived">Archive</button>` : ''}
          </td></tr>`;
      }).join('')}</tbody></table></div>`;

    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const existing = snap.docs.find((d) => d.id === b.dataset.edit);
      if (existing) taskModal(existing);
    }));
    tableEl.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const to = b.dataset.to;
      try {
        await updateDoc(doc(db, 'tasks', b.dataset.toggle), { status: to, updatedAt: serverTimestamp() });
        toast(to === 'published' ? 'Task published — users can request it.' :
          to === 'paused' ? 'Task paused — hidden from users.' :
          'Task archived.', { type: 'success' });
        load();
      } catch (err) { toast(err.message, { type: 'error' }); }
    }));
  } catch (_) {
    tableEl.innerHTML = emptyState({ icon: 'alert', title: 'Could not load tasks', message: 'Please refresh.' });
  }
}
load();

content.querySelector('#new-task').addEventListener('click', () => taskModal());

function taskModal(existingDoc) {
  const t = existingDoc ? existingDoc.data() : {};
  const m = modal({
    title: existingDoc ? 'Edit task' : 'New task',
    width: 640,
    body: `
      <div class="field">
        <label class="label">Title <span class="req">*</span></label>
        <input class="input" id="t-title" value="${esc(t.title || '')}" placeholder="e.g. Website Testing">
      </div>
      <div class="field">
        <label class="label">Short description</label>
        <input class="input" id="t-desc" value="${esc(t.description || '')}" placeholder="One line shown on the task card">
      </div>
      <div class="field">
        <label class="label">Instructions for the user <span class="req">*</span></label>
        <textarea class="textarea" id="t-instr" style="min-height:120px" placeholder="Exact steps the user must follow. Tasks must be legitimate and must not violate third-party terms.">${esc(t.instructions || '')}</textarea>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px">
        <div class="field">
          <label class="label">Category</label>
          <select class="select" id="t-cat">${TASK_CATEGORIES.map((c) => `<option ${t.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label class="label">Difficulty</label>
          <select class="select" id="t-diff">
            <option value="easy" ${t.difficulty === 'easy' ? 'selected' : ''}>Easy</option>
            <option value="medium" ${t.difficulty === 'medium' ? 'selected' : ''}>Medium</option>
            <option value="hard" ${t.difficulty === 'hard' ? 'selected' : ''}>Hard</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Est. minutes</label>
          <input class="input" id="t-mins" type="text" value="${esc(t.estimatedMinutes || '10–15')}" placeholder="10–15">
        </div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px">
        <div class="field">
          <label class="label">Reward (NPR) <span class="req">*</span></label>
          <input class="input" id="t-reward" type="number" min="1" step="1" value="${t.rewardPaisa ? t.rewardPaisa / 100 : 15}">
        </div>
        <div class="field">
          <label class="label">Available slots</label>
          <input class="input" id="t-slots" type="number" min="0" step="1" value="${t.slotsTotal || 0}">
          <p class="hint">0 = unlimited</p>
        </div>
        <div class="field">
          <label class="label">Priority</label>
          <select class="select" id="t-priority">
            <option value="">Normal</option>
            <option value="high" ${t.priority === 'high' ? 'selected' : ''}>High</option>
          </select>
        </div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
        <div class="field">
          <label class="label">Deadline (optional)</label>
          <input class="input" type="date" id="t-deadline" value="${t.deadline ? t.deadline.toDate().toISOString().slice(0, 10) : ''}">
        </div>
        <div class="field">
          <label class="label">Status</label>
          <select class="select" id="t-status">
            ${['draft', 'published', 'paused'].map((s) => `<option value="${s}" ${(existingDoc ? (t.status || 'draft') : 'draft') === s ? 'selected' : ''}>${STATUS_META[s].label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label class="checkbox"><input type="checkbox" id="t-evidence" ${t.evidenceRequired ? 'checked' : ''}> Evidence required (screenshot/photo in chat before submission)</label>
      </div>
      <p class="hint">Tasks marked <strong>Draft</strong> are hidden from users. Publish when ready. Default reward is रु 15 but you set the exact reward per task.</p>`,
    actions: `
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="save">${existingDoc ? 'Save changes' : 'Create task'}</button>`
  });
  m.root.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.root.querySelector('[data-act="save"]').addEventListener('click', async (ev) => {
    const title = m.root.querySelector('#t-title').value.trim();
    const desc = m.root.querySelector('#t-desc').value.trim();
    const instr = m.root.querySelector('#t-instr').value.trim();
    const reward = Number(m.root.querySelector('#t-reward').value);
    if (title.length < 3 || !instr || !reward || reward <= 0) {
      toast('Title, instructions and a positive reward are required.', { type: 'error' });
      return;
    }
    const btn = ev.currentTarget;
    btnBusy(btn, true, 'Saving…');
    const deadlineVal = m.root.querySelector('#t-deadline').value;
    const data = {
      title, description: desc, instructions: instr,
      category: m.root.querySelector('#t-cat').value,
      difficulty: m.root.querySelector('#t-diff').value,
      estimatedMinutes: m.root.querySelector('#t-mins').value.trim() || '10–15',
      rewardPaisa: toPaisa(reward),
      slotsTotal: Math.max(0, Number(m.root.querySelector('#t-slots').value) || 0),
      deadline: deadlineVal ? new Date(deadlineVal + 'T23:59:59+05:45') : null,
      evidenceRequired: m.root.querySelector('#t-evidence').checked,
      priority: m.root.querySelector('#t-priority').value,
      status: m.root.querySelector('#t-status').value
    };
    try {
      if (existingDoc) {
        await updateDoc(doc(db, 'tasks', existingDoc.id), { ...data, updatedAt: serverTimestamp() });
      } else {
        await addDoc(collection(db, 'tasks'), {
          ...data, slotsTaken: 0, createdAt: serverTimestamp(),
          createdBy: profile.id, createdByName: profile.fullName
        });
      }
      m.close();
      toast(existingDoc ? 'Task updated.' : 'Task created.', { type: 'success' });
      load();
    } catch (err) {
      btnBusy(btn, false);
      toast(err.message, { type: 'error' });
    }
  });
}
