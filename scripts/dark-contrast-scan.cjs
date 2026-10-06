// Diagnostic (git-ignored): finds colour pairs that collapse in dark mode.
//
// Dark mode re-tints the pale tokens (--*-50 / --*-100) to near-black but leaves
// the accent tokens (--*-600 / --*-700) dark. So every rule painting a dark
// accent onto a pale tint becomes dark-on-dark. Auth pages can't be exercised
// here (they need a signed-in session), so the pairs are computed statically:
// resolve the custom properties under [data-theme="dark"], then apply any
// [data-theme="dark"] override that exists for that selector — otherwise the
// override block itself would be reported as a failure.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS_DIR = path.join(ROOT, 'css');
const FILES = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));

function decls(block) {
  const map = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block))) map[m[1]] = m[2].trim();
  return map;
}
const globalCss = fs.readFileSync(path.join(CSS_DIR, 'global.css'), 'utf8');
const rootBlock = globalCss.match(/:root\s*\{([\s\S]*?)\n\}/);
const darkBlock = globalCss.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
const ROOT_MAP = decls(rootBlock ? rootBlock[1] : '');
const DARK_MAP = Object.assign({}, ROOT_MAP, decls(darkBlock ? darkBlock[1] : ''));

function parseColor(str) {
  if (!str) return null;
  let s = str.trim();
  let m = s.match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/);
  while (m) {
    if (DARK_MAP[m[1]] === undefined) {
      if (!m[2]) return null;
      s = s.replace(m[0], m[2].trim());
    } else {
      s = s.replace(m[0], DARK_MAP[m[1]]);
    }
    m = s.match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/);
  }
  s = s.trim();
  let c = s.match(/^#([0-9a-f]{6})$/i);
  if (c) { const n = parseInt(c[1], 16); return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: 1 }; }
  c = s.match(/^#([0-9a-f]{3})$/i);
  if (c) { const [R, G, B] = c[1].split(''); return { r: +('0x' + R + R), g: +('0x' + G + G), b: +('0x' + B + B), a: 1 }; }
  c = s.match(/rgba?\(([^)]+)\)/);
  if (c) { const p = c[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  return null;
}
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };

// ── pass 1: index every [data-theme="dark"] override's colour per selector ──
const darkColor = {};
const darkBg = {};
const rules = [];
for (const f of FILES) {
  const css = fs.readFileSync(path.join(CSS_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let r;
  while ((r = ruleRe.exec(css))) {
    const sel = r[1].trim().replace(/\s+/g, ' ');
    const body = r[2];
    if (!sel || sel.startsWith('@')) continue;
    const isDark = sel.includes('[data-theme="dark"]');
    const fgM = body.match(/(?:^|[^-])color\s*:\s*([^;]+);/);
    const bgM = body.match(/(?:^|[^-])background(?:-color)?\s*:\s*([^;]+);/);
    rules.push({ file: f, sel, body, isDark, fg: fgM ? fgM[1].trim() : null, bg: bgM ? bgM[1].trim() : null });
    if (isDark) {
      for (const part of sel.split(',')) {
        const bare = part.replace(/\[data-theme="dark"\]\s*/g, '').trim();
        if (!bare) continue;
        if (fgM) darkColor[bare] = fgM[1].trim();
        if (bgM) darkBg[bare] = bgM[1].trim();
      }
    }
  }
}

// ── pass 2: evaluate base rules with their dark overrides applied ──
const problems = [];
for (const r of rules) {
  if (r.isDark) continue;
  const bgM = r.body.match(/(?:^|[^-])background(?:-color)?\s*:\s*([^;]+);/);
  if (!bgM || !r.fg) continue;
  // apply override: the rule's own colour, or the dark override for it
  let fgDecl = r.fg;
  const parts = r.sel.split(',').map((s) => s.trim());
  const hit = parts.map((p) => darkColor[p]).filter(Boolean);
  if (hit.length) fgDecl = hit[0];
  const bgHit = parts.map((p) => darkBg[p]).filter(Boolean);
  const bgDecl = bgHit.length ? bgHit[0] : bgM[1];

  const fg = parseColor(fgDecl);
  const bg = parseColor(bgDecl);
  if (!fg || !bg || fg.a < 1 || bg.a < 1) continue;
  if (bg.r === 255 && bg.g === 255 && bg.b === 255) continue;
  const cr = ratio(fg, bg);
  if (cr < 4.5) {
    problems.push({ file: r.file, selector: r.sel.slice(0, 72), cr: +cr.toFixed(2), fg: fgDecl.slice(0, 44), bg: bgM[1].trim().slice(0, 44), overridden: hit.length > 0 });
  }
}
problems.sort((a, b) => a.cr - b.cr);
for (const p of problems) console.log(`${p.cr.toFixed(2)}:1  ${p.file}  ${p.selector}${p.overridden ? '  [dark override applied]' : ''}`);
console.log(`\npairs below AA in dark mode: ${problems.length}`);
