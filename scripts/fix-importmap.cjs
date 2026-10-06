// Adds the missing "firebase/analytics" entry to every import map.
// js/firebase.js dynamically imports 'firebase/analytics', but no page declared
// it in the import map, so the specifier never resolved and Analytics silently
// never initialised. Run: node scripts/fix-importmap.cjs  (idempotent)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const NEEDLE = '"firebase/functions": "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js"';
const ADD = NEEDLE + ',\n      "firebase/analytics": "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js"';

let n = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'optional-cloud-functions', 'scripts'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) {
      let html = fs.readFileSync(p, 'utf8');
      if (!html.includes('type="importmap"')) continue;
      if (html.includes('firebase/analytics')) continue;
      if (!html.includes(NEEDLE)) { console.log('!! no anchor in', path.relative(ROOT, p)); continue; }
      html = html.replace(NEEDLE, ADD);
      fs.writeFileSync(p, html, 'utf8');
      n++;
    }
  }
})(ROOT);
console.log(`import maps updated: ${n}`);
