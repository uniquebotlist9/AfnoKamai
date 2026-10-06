// Normalises the icon links in every HTML page.
// Run: node scripts/fix-icons.cjs   (idempotent)
//
//  * favicon: adds a raster /favicon.ico alongside the SVG (browsers that
//    can't render SVG icons had no fallback at all)
//  * apple-touch-icon: iOS ignores SVG, so ship the 180px PNG
//  * all paths root-absolute so nested routes (/admin/…) resolve correctly
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const ICON_BLOCK = [
  '<link rel="icon" href="/favicon.ico" sizes="48x48">',
  '<link rel="icon" type="image/svg+xml" href="/assets/icon.svg">',
  '<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">'
].join('\n  ');

let n = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'optional-cloud-functions', 'scripts'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) {
      let html = fs.readFileSync(p, 'utf8');
      const before = html;
      html = html
        .replace(/[ \t]*<link\s+rel="apple-touch-icon"[^>]*>\r?\n?/g, '')
        .replace(/[ \t]*<link\s+rel="icon"[^>]*>\r?\n?/g, '')
        .replace(/(<meta name="theme-color"[^>]*>)/, `$1\n  ${ICON_BLOCK}`);
      if (html === before) continue;
      fs.writeFileSync(p, html, 'utf8');
      n++;
    }
  }
})(ROOT);
console.log(`icon links normalised: ${n}`);

// PWA manifest: absolute paths + raster icons for stores that skip SVG.
const manifestPath = path.join(ROOT, 'manifest.json');
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
m.icons = [
  { src: '/assets/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  { src: '/assets/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
];
m.start_url = '/index.html';
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8');
console.log('manifest.json updated');
