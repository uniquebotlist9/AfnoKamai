// Dev-time consistency check: verify named imports resolve to real exports.
const fs = require('fs');
const path = require('path');

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(e.name) && !p.includes('node_modules')) files.push(p);
  }
})('js');

const norm = (p) => p.split(path.sep).join('/');
const local = new Map(files.map((f) => [norm(f), fs.readFileSync(f, 'utf8')]));
let bad = 0;

for (const [f, src] of local) {
  const dir = norm(path.dirname(f));
  const re = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const target = norm(path.join(dir, m[2]));
    const tsrc = local.get(target);
    if (!tsrc) continue; // path existence already checked separately
    const exports = new Set();
    for (const em of tsrc.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) exports.add(em[1]);
    for (const em of tsrc.matchAll(/export\s*\{([^}]+)\}/g)) {
      em[1].split(',').forEach((s) => exports.add(s.trim().split(/\s+as\s+/).pop()));
    }
    for (let name of m[1].split(',')) {
      name = name.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!exports.has(name)) {
        console.log(`MISSING EXPORT: ${name} imported in ${f} from ${m[2]}`);
        bad++;
      }
    }
  }
}
console.log(bad === 0 ? 'ALL NAMED IMPORTS RESOLVE' : `${bad} problem(s)`);
