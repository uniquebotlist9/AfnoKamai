// ─── Notification settings ───────────────────────────────────────────
// Two halves: what gets pushed, and where.
//
// Everything here is a real, implemented preference. There is deliberately
// no email channel and no "in-app" channel — see firestore.rules for why
// those two were left out rather than shipped as switches that do nothing.

import { mountShell } from '../shell.js';
import { esc, fmtRelative, fmtDateTime } from '../utils.js';
import { icon } from '../icons.js';
import { toast, confirmDialog, btnBusy, emptyState } from '../ui.js';
import { CATEGORIES, LOCKED_CATEGORIES } from '../notify.js';
import {
  permissionState, pushSupported, enablePush, disablePush,
  listDevices, getPrefs, savePrefs, syncSubscription
} from '../push.js';

let { content } = await mountShell('notifications');
document.getElementById('page-skeleton')?.remove();

// ─── Shell ───────────────────────────────────────────────────────────

content.innerHTML = `
  <div class="page-head">
    <div>
      <h1 style="font-size:22px">Notification settings</h1>
      <p class="sub">Choose what is pushed to your devices, and manage the devices themselves.</p>
    </div>
    <div class="page-head-actions">
      <a class="btn ghost btn-sm" href="notifications.html">${icon('bell')} All notifications</a>
    </div>
  </div>

  <div class="card ns-card">
    <div class="card-head"><h3>Device notifications</h3></div>
    <div class="card-pad">
      <div id="perm-block" class="ns-perm"></div>
    </div>
  </div>

  <div class="card ns-card">
    <div class="card-head"><h3>What to push</h3></div>
    <div class="card-pad">
      <label class="ns-master">
        <div>
          <strong>Push notifications</strong>
          <div class="ns-help">Master switch for every device. Turning this off stops all push without removing your devices.</div>
        </div>
        <span class="switch"><input type="checkbox" id="master-push"><span class="slider"></span></span>
      </label>
      <div class="ns-divider"></div>
      <div class="ns-cat-title">By category</div>
      <div id="cat-list" class="ns-cats"></div>
    </div>
  </div>

  <div class="card ns-card">
    <div class="card-head"><h3>Devices</h3></div>
    <div class="card-pad">
      <div id="device-list" class="ns-devices"></div>
    </div>
  </div>`;

const permBlock = content.querySelector('#perm-block');
const catList = content.querySelector('#cat-list');
const deviceList = content.querySelector('#device-list');
const masterInput = content.querySelector('#master-push');

// ─── Permission state ────────────────────────────────────────────────

function renderPermission() {
  const state = pushSupported() ? permissionState() : 'unsupported';

  if (state === 'unsupported') {
    permBlock.innerHTML = `
      <div class="ns-perm-row tone-gray">
        <span class="ns-perm-ic">${icon('ban')}</span>
        <div>
          <strong>Not supported by this browser</strong>
          <div class="ns-help">Push notifications need a browser with Service Worker and Push API support. Your in-app notifications still work normally.</div>
        </div>
      </div>`;
    return;
  }

  if (state === 'granted') {
    permBlock.innerHTML = `
      <div class="ns-perm-row tone-green">
        <span class="ns-perm-ic">${icon('bell')}</span>
        <div>
          <strong>Allowed</strong>
          <div class="ns-help">This browser has granted permission. Alerts arrive even when AfnoKamai is closed.</div>
        </div>
        <button class="btn ghost btn-sm" id="disable-push" type="button">Turn off on this device</button>
      </div>`;
    permBlock.querySelector('#disable-push').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btnBusy(btn, true, 'Turning off…');
      const res = await disablePush();
      btnBusy(btn, false);
      if (res.ok) {
        toast('Push turned off on this device.');
        renderPermission();
        renderDevices();
      } else {
        toast('Could not turn push off.', { type: 'error' });
      }
    });
    return;
  }

  if (state === 'denied') {
    permBlock.innerHTML = `
      <div class="ns-perm-row tone-amber">
        <span class="ns-perm-ic">${icon('alert')}</span>
        <div>
          <strong>Blocked by your browser</strong>
          <div class="ns-help">
            The browser is refusing notifications for this site, so AfnoKamai cannot ask again — browsers ignore any further
            request once blocked. To allow them, open the lock or bell icon in the address bar, set
            <em>Notifications</em> to <em>Allow</em>, then reload this page. On iOS, use
            <em>Share → Add to Home Screen</em> first.
          </div>
        </div>
      </div>`;
    return;
  }

  permBlock.innerHTML = `
    <div class="ns-perm-row">
      <span class="ns-perm-ic">${icon('bell')}</span>
      <div>
        <strong>Not turned on yet</strong>
        <div class="ns-help">Your browser will ask for permission once, when you press the button below. Nothing is requested just for visiting this page.</div>
      </div>
      <button class="btn primary btn-sm" id="enable-push" type="button">Turn on notifications</button>
    </div>`;

  permBlock.querySelector('#enable-push').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    // btnBusy disables the button, which is what stops a second click from
    // firing a second permission prompt mid-flight.
    btnBusy(btn, true, 'Waiting for your browser…');
    const res = await enablePush();
    btnBusy(btn, false);

    if (res.ok) {
      toast('Notifications are on for this device.', { type: 'success' });
      renderPermission();
      renderDevices();
      return;
    }
    // Re-render either way: a dismissal leaves the same state, a denial
    // moves to the blocked card, and both need to be visible.
    renderPermission();
    if (res.reason === 'denied') {
      toast('Notifications are blocked for this site.', { type: 'warn' });
    } else if (res.reason === 'device_limit') {
      toast(`You have reached the ${8}-device limit. Remove one below, then try again.`, { type: 'warn' });
    } else if (res.reason === 'dismissed') {
      toast('No problem — you can turn them on any time.');
    } else {
      toast('Could not turn on notifications.', { type: 'error' });
    }
  });
}

// ─── Preferences ─────────────────────────────────────────────────────

let prefs = { push: true, categories: {} };

function renderCategories() {
  const rows = Object.entries(CATEGORIES).map(([id, meta]) => {
    const locked = LOCKED_CATEGORIES.includes(id);
    const on = locked ? true : (prefs.categories[id] !== false);
    const help = {
      security: 'Login, password and new-device warnings. Always on — this is the one category you cannot switch off.',
      task: 'Assignments, submissions and review decisions.',
      reward: 'Held and released earnings.',
      referral: 'Joins and referral rewards.',
      payment: 'Withdrawals, deposits and penalties.',
      account: 'Replies from the admin team in your support chat.',
      announcement: 'Platform-wide announcements.',
      promotion: 'Offers and campaigns.',
      maintenance: 'Scheduled maintenance and downtime.',
      system: 'Everything else.'
    }[id] || '';

    return `
      <label class="ns-cat${locked ? ' is-locked' : ''}">
        <span class="ns-cat-ic tone-${esc(meta.tint)}">${icon(meta.icon)}</span>
        <span class="ns-cat-body">
          <strong>${esc(meta.label)}${locked ? ' <span class="ns-lock">Always on</span>' : ''}</strong>
          <span class="ns-help">${esc(help)}</span>
        </span>
        <span class="switch">
          <input type="checkbox" data-cat="${esc(id)}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          <span class="slider"></span>
        </span>
      </label>`;
  });

  catList.innerHTML = rows.join('');
}

async function persistPrefs() {
  try {
    prefs = await savePrefs(prefs);
    renderCategories();
    masterInput.checked = prefs.push;
    toast('Notification preferences saved.', { type: 'success' });
  } catch (err) {
    console.error('[settings] savePrefs failed', err);
    toast('Could not save your preferences.', { type: 'error' });
    renderCategories();
    masterInput.checked = prefs.push;
  }
}

masterInput.addEventListener('change', () => {
  prefs.push = masterInput.checked;
  persistPrefs();
});

catList.addEventListener('change', (e) => {
  const input = e.target.closest('[data-cat]');
  if (!input) return;
  const id = input.dataset.cat;
  if (LOCKED_CATEGORIES.includes(id)) { input.checked = true; return; }
  prefs.categories = { ...prefs.categories, [id]: input.checked };
  persistPrefs();
});

// ─── Devices ─────────────────────────────────────────────────────────

async function renderDevices() {
  deviceList.innerHTML = `<div class="state-block loading"><span class="spin dark"></span></div>`;
  const devices = await listDevices();

  if (!devices.length) {
    deviceList.innerHTML = emptyState({
      icon: 'smartphone',
      title: 'No devices registered',
      message: 'Turn on device notifications above and this device will be listed here.'
    });
    return;
  }

  deviceList.innerHTML = devices.map((d) => {
    const stateTone = d.isActive ? (d.failCount > 0 ? toneAmber() : toneGreen()) : 'gray';
    const stateLabel = d.isActive ? (d.failCount > 0 ? 'Retrying' : 'Active') : 'Off';
    return `
      <div class="ns-device${d.isThisDevice ? ' is-this' : ''}" data-id="${esc(d.id)}">
        <span class="ns-device-ic">${icon('smartphone')}</span>
        <div class="ns-device-body">
          <strong>${esc(d.deviceName)}${d.isThisDevice ? ' <span class="ns-here">This device</span>' : ''}</strong>
          <span class="ns-help">
            Added ${esc(fmtDateTime(d.createdAt))}
            ${d.lastUsedAt ? ` · last used ${esc(fmtRelative(d.lastUsedAt))}` : ''}
          </span>
        </div>
        <span class="badge tone-${stateTone}">${stateLabel}</span>
        <button class="btn ghost btn-xs" data-remove type="button">Remove</button>
      </div>`;
  }).join('');
}

const toneGreen = () => 'green';
const toneAmber = () => 'amber';

deviceList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const row = btn.closest('.ns-device');
  const id = row.dataset.id;
  const name = row.querySelector('strong').textContent.trim();

  const ok = await confirmDialog({
    title: 'Remove this device?',
    message: `AfnoKamai will stop sending push notifications to “${name}”. It will reappear if that browser turns notifications back on.`,
    confirmText: 'Remove device',
    danger: true
  });
  if (!ok) return;

  btnBusy(btn, true, 'Removing…');
  try {
    const res = await disablePush(id);
    btnBusy(btn, false);
    if (!res.ok) throw new Error(res.reason || 'failed');
    toast('Device removed.');
    renderDevices();
  } catch (err) {
    btnBusy(btn, false);
    console.error('[settings] remove device failed', err);
    toast('Could not remove that device.', { type: 'error' });
  }
});

// ─── Boot ────────────────────────────────────────────────────────────

renderPermission();

(async () => {
  prefs = await getPrefs();
  masterInput.checked = prefs.push;
  renderCategories();
})();

renderDevices();

// Re-sync the subscription for this browser if permission was already
// granted — never prompts, just keeps the endpoint record honest.
if (pushSupported() && permissionState() === 'granted') {
  syncSubscription({ prompt: false }).catch(() => {});
}

// The permission can change outside the page (browser site settings, OS
// level). Reflect it without a reload.
if (pushSupported() && 'permissions' in navigator) {
  try {
    const status = await navigator.permissions.query({ name: 'notifications' });
    status.onchange = () => { renderPermission(); renderDevices(); };
  } catch (_) { /* Firefox has not always implemented this */ }
}
