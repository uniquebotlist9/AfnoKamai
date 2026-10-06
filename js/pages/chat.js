// ─── Support chat page (user role) ───────────────────────────────────
import { mountShell } from '../shell.js';
import { mountChat } from '../chat.js';

let { user, profile, content } = await mountShell('chat');
document.getElementById('page-skeleton')?.remove();

content.innerHTML = `
  <div class="page-head" style="margin-bottom:14px">
    <div>
      <h1 style="font-size:22px">Support Chat</h1>
      <p class="sub">Task instructions, clarifications and official communication happen here.</p>
    </div>
  </div>`;

const chatRoot = document.createElement('div');
content.appendChild(chatRoot);

await mountChat({ root: chatRoot, role: 'user', selfUid: user.uid, selfName: profile.fullName });
