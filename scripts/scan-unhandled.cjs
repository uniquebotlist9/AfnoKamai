// Diagnostic only (git-ignored): finds fire-and-forget promises in page modules.
// Anything awaited is fine; the risk is `promise.then(...)` / direct `.write()`
// calls with no `.catch()`, which surface as unhandled rejections in production.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['js', 'js/pages', 'js/pages/admin'];

for (const d of DIRS) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    if (!name.endsWith('.js')) continue;
    const f = path.join(abs, name);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      // promise returned but not awaited and not caught
      const hasCatch = /\.catch\s*\(/.test(t);
      const awaited = /^\s*(await|return await)\b/.test(line);
      const returned = /^\s*return\s+\w+/.test(t);
      const suspicious =
        /\.(then|updateDoc|setDoc|addDoc|deleteDoc|writeBatch|runTransaction)\s*\(/.test(t)
        && !hasCatch && !awaited && !returned;
      if (suspicious) console.log(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${i + 1}: ${t.slice(0, 130)}`);
    });
  }
}
console.log('\n(done)');
