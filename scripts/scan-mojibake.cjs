// Diagnostic only (git-ignored): finds UTF-8 text that was previously decoded
// as Latin-1/Windows-1252 and re-encoded, i.e. the classic "â€” / Â·" mojibake.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = new Set(['.html', '.js', '.css', '.json', '.xml', '.txt', '.cjs', '.rules', '.md']);
// U+00E2/U+00C2/U+00C3 followed by a continuation-looking char is the signal.
const RE = /(?:â€.|Â.|Ã.|ï»¿)/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

const only = process.argv[2];
const SELF = new Set(['scripts/scan-mojibake.cjs', 'scripts/fix-encoding.cjs']);
let total = 0;
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (SELF.has(rel)) continue;
  if (only && !rel.includes(only)) continue;
  const text = fs.readFileSync(f, 'utf8');
  const hits = [...text.matchAll(RE)];
  if (!hits.length) continue;
  total++;
  const uniq = [...new Set(hits.map((m) => m[0]))];
  console.log(`${rel}: ${hits.length}  [${uniq.join(' ')}]`);
  const first = hits[0];
  const line = text.slice(0, first.index).split('\n').length;
  console.log(`   line ${line}: ${text.split('\n')[line - 1].trim().slice(0, 160)}`);
}
console.log(`\nfiles affected: ${total}`);
