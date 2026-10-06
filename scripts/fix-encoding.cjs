// Idempotent repair for UTF-8 text that was previously decoded as Windows-1252
// and written back out (the classic "â€” / Â·" mojibake).
//
// Cause in this repo: the 12 admin page <title> values contained "—" (bytes
// E2 80 94) and "·" (bytes C2 B7). They were read with a single-byte codepage
// so each byte became its own character. seo-inject.cjs then copied that broken
// title into <meta name="description">, og:* and twitter:* on all 12 pages.
//
// Approach: a SLIDING-WINDOW decode rather than a whole-line re-encode. A line
// may legitimately contain correct UTF-8 next to the corruption (line 7 of
// admin/index.html has a real "—" beside "â€”"), and re-encoding the whole line
// would turn that real character into an invalid lone byte. Instead we only
// consume a lead byte plus exactly the continuation bytes UTF-8 expects, and
// accept the result only when the decode is lossless.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = new Set(['.html', '.js', '.css', '.json', '.xml', '.txt', '.cjs', '.md']);

// CP1252 0x80-0x9F is NOT Latin-1: these code points must map back to their
// original single byte, otherwise € (0x80) and — (0x94) never reassemble.
const CP1252_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// Cheap pre-filter so correct files are never rewritten.
const SUSPECT = /[\u00c2-\u00f4][\u0080-\u00bf\u20ac\u2018\u2019\u201c\u201d\u2013\u2014\u2026]/;

function leadLength(cp) {
  if (cp >= 0xc2 && cp <= 0xdf) return 2;
  if (cp >= 0xe0 && cp <= 0xef) return 3;
  if (cp >= 0xf0 && cp <= 0xf4) return 4;
  return 0;
}

function isContinuation(cp) {
  if (cp >= 0x80 && cp <= 0xbf) return true;
  return CP1252_HIGH[cp] !== undefined;
}

function toByte(cp) {
  if (CP1252_HIGH[cp] !== undefined) return CP1252_HIGH[cp];
  return cp; // <= 0xFF by construction of isContinuation
}

function repair(text) {
  if (!SUSPECT.test(text)) return text;
  const chars = [...text];
  let out = '';
  let i = 0;

  while (i < chars.length) {
    const need = leadLength(chars[i].codePointAt(0));
    if (need > 0) {
      const seq = [chars[i]];
      let j = i + 1;
      let complete = true;
      while (seq.length < need) {
        if (j >= chars.length || !isContinuation(chars[j].codePointAt(0))) { complete = false; break; }
        seq.push(chars[j]);
        j++;
      }
      if (complete) {
        const bytes = Buffer.from(seq.map((ch) => toByte(ch.codePointAt(0))));
        const decoded = bytes.toString('utf8');
        // Lossless only when every byte survived UTF-8 decoding.
        if (!decoded.includes('\ufffd') && decoded.length > 0) {
          out += decoded;
          i = j;
          continue;
        }
      }
    }
    out += chars[i];
    i++;
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

const SELF = new Set(['scripts/fix-encoding.cjs', 'scripts/scan-mojibake.cjs']);
let filesChanged = 0;
let linesChanged = 0;

for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (SELF.has(rel)) continue;

  const before = fs.readFileSync(f, 'utf8');
  if (!SUSPECT.test(before)) continue;

  let changed = 0;
  const after = before.split('\n').map((line) => {
    if (!SUSPECT.test(line)) return line;
    const fixed = repair(line);
    if (fixed === line) return line;
    changed++;
    console.log(`  ${rel}\n    - ${line.trim()}\n    + ${fixed.trim()}`);
    return fixed;
  }).join('\n');

  if (after !== before) {
    fs.writeFileSync(f, after, 'utf8');
    filesChanged++;
    linesChanged += changed;
  }
}

console.log(`\nfiles repaired: ${filesChanged}, lines repaired: ${linesChanged}`);
