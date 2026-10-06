// ─── Boot router (index.html): send every visitor where they belong ──
import { logo } from '../icons.js';
import { ensureConfigured, routeOnBoot } from '../guard.js';

const mark = document.getElementById('boot-logo');
if (mark) mark.innerHTML = logo({});

if (ensureConfigured()) {
  const status = document.getElementById('boot-status');

  // The boot chain waits on Firebase Auth (accounts:lookup) and then on the
  // user's Firestore profile — both are network round trips. If the network
  // is slow we say so and offer a retry instead of spinning forever.
  const showSlowState = () => {
    const screen = document.getElementById('boot-screen');
    if (!screen || screen.dataset.slow) return;
    screen.dataset.slow = '1';
    screen.innerHTML = `
      ${logo({})}
      <h1 style="font-size:18px; margin-top:14px">This is taking longer than usual</h1>
      <p class="muted" style="max-width:340px">AfnoKamai could not reach the server in time. Check your connection and try again.</p>
      <div style="display:flex; gap:10px; justify-content:center; margin-top:16px; flex-wrap:wrap">
        <button class="btn primary" id="boot-retry">Try again</button>
        <a class="btn ghost" href="login.html">Go to login</a>
      </div>`;
    screen.querySelector('#boot-retry').addEventListener('click', () => location.reload());
  };

  const slowTimer = setTimeout(showSlowState, 12000);

  routeOnBoot({
    onStage: (text) => { if (status && !document.getElementById('boot-screen')?.dataset.slow) status.textContent = text; }
  })
    .catch(() => showSlowState()) // network/auth failure → offer retry instead of spinning forever
    .finally(() => clearTimeout(slowTimer));
}
