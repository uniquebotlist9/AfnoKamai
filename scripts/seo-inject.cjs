// One-shot SEO / metadata injector for the AfnoKamai static site.
// Run: node scripts/seo-inject.cjs   (idempotent — safe to re-run)
//
// For every HTML page it:
//   * normalises the <meta name="robots"> directive
//   * adds a unique <meta name="description">
//   * adds canonical + full Open Graph + Twitter/X card tags
//   * adds a <noscript> fallback to pages whose <body> is script-only
// It also writes robots.txt and sitemap.xml.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://afnokamai.web.app';
const SOCIAL = `${ORIGIN}/assets/social-preview.png`;
const TAGLINE = 'Your Work. Your Kamai.';

// pages that may be indexed (auth-free, real content)
const INDEXABLE = new Set(['index.html', 'login.html', 'signup.html']);

const DESCRIPTIONS = {
  'index.html':
    'AfnoKamai is a transparent task-and-reward platform. Complete tasks, track every rupee in a clear ledger and withdraw to eSewa. ' + TAGLINE,
  'login.html':
    'Log in to AfnoKamai and pick up where you left off — your tasks, earnings and withdrawals in one dashboard.',
  'signup.html':
    'Create a free AfnoKamai account and start earning real money for completed tasks. ' + TAGLINE,
  'rules.html':
    'The rules that keep AfnoKamai fair: how tasks are reviewed, when funds are released on hold, and how withdrawals work.',
  'maintenance.html':
    'AfnoKamai is undergoing scheduled maintenance. Check back shortly — your balance and history are safe.',
  '404.html':
    'This page does not exist on AfnoKamai.',
  'earn.html': 'Browse available tasks, request one and submit your work for review on AfnoKamai.',
  'dashboard.html': 'Your AfnoKamai dashboard: balance, task activity, earnings history and achievements.',
  'withdraw.html': 'Withdraw your AfnoKamai earnings to eSewa with a verified account and your security PIN.',
  'transactions.html': 'A complete, filterable ledger of every earn, hold, release and withdrawal on AfnoKamai.',
  'chat.html': 'Message the AfnoKamai support team and get help with tasks, payments or your account.',
  'support.html': 'Contact AfnoKamai support and follow the status of your open requests.',
  'notifications.html': 'Your AfnoKamai notifications: task reviews, payment releases and announcements.',
  'profile.html': 'Manage your AfnoKamai profile, security PIN and account preferences.',
  'profile-setup.html': 'Complete your AfnoKamai profile so admins can verify and pay you.',
  'verify-email.html': 'Verify your email address to unlock withdrawals on AfnoKamai.'
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pageTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  return m ? m[1].trim().replace(/\s+/g, ' ') : 'AfnoKamai';
}

function metaBlock({ file, title, desc, indexable }) {
  const url = file === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${file.replace(/\\/g, '/')}`;
  const robots = indexable ? 'index, follow' : 'noindex, nofollow';
  // Admin pages carry their own darker brand chrome.
  const themeColor = file.startsWith('admin/') ? '#17110A' : '#0E5C41';
  const lines = [
    `<meta name="description" content="${esc(desc)}">`,
    `<meta name="robots" content="${robots}">`,
    `<meta name="author" content="AfnoKamai">`,
    `<meta name="theme-color" content="${themeColor}">`,
  ];
  // 404.html is served for every unknown URL — a canonical pointing at
  // /404.html from all of them would be wrong, so only real pages get one.
  if (file !== '404.html') lines.push(`<link rel="canonical" href="${url}">`);
  lines.push(
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="AfnoKamai">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${SOCIAL}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc('AfnoKamai — ' + TAGLINE)}">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    `<meta name="twitter:image" content="${SOCIAL}">`,
    `<meta name="twitter:image:alt" content="${esc('AfnoKamai — ' + TAGLINE)}">`
  );
  return lines.map((l) => '  ' + l).join('\n');
}

const NOSCRIPT = `  <noscript>
    <div style="max-width:520px;margin:64px auto;padding:24px;font-family:system-ui,sans-serif;text-align:center">
      <h1 style="font-size:20px">AfnoKamai needs JavaScript</h1>
      <p style="color:#44554C;line-height:1.6">This application runs entirely in your browser and cannot load without
      JavaScript enabled. Please enable JavaScript in your browser settings, then reload this page.</p>
      <p><a href="/" style="color:#0E5C41">Back to AfnoKamai</a></p>
    </div>
  </noscript>`;

function process(file) {
  const abs = path.join(ROOT, file);
  const rel = file.replace(/\\/g, '/');
  let html = fs.readFileSync(abs, 'utf8');
  const before = html;
  const title = pageTitle(html);
  const indexable = INDEXABLE.has(rel);
  // Titles end in "— AfnoKamai", "· AfnoKamai" or "| AfnoKamai" depending on the
  // page; strip whichever separator is present so the description does not read
  // "Admin — Index · AfnoKamai — AfnoKamai. …". Fall back to the tagline alone
  // if nothing survives the strip.
  const stem = title.replace(/\s*[—–\-·|]\s*AfnoKamai\s*$/i, '').trim() || 'AfnoKamai';
  const desc = DESCRIPTIONS[rel] || `${stem} — AfnoKamai. ${TAGLINE}`;

  // 1. drop any pre-existing description/robots/canonical/og/twitter so re-runs stay idempotent
  html = html
    .replace(/[ \t]*<meta\s+name="description"[^>]*>\r?\n?/g, '')
    .replace(/[ \t]*<meta\s+name="robots"[^>]*>\r?\n?/g, '')
    .replace(/[ \t]*<link\s+rel="canonical"[^>]*>\r?\n?/g, '')
    .replace(/[ \t]*<meta\s+(?:property|name)="(?:og:[a-z:_]+|twitter:[a-z:_]+)"[^>]*>\r?\n?/g, '')
    .replace(/[ \t]*<meta\s+name="author"[^>]*>\r?\n?/g, '');

  // 2. insert the block right after </title>
  const block = metaBlock({ file: rel, title, desc, indexable });
  if (!/<\/title>/.test(html)) throw new Error('no <title> in ' + rel);
  html = html.replace(/(<\/title>)/, `$1\n${block}`);

  // 3. theme-color may now be duplicated (some pages already declare it) — keep only the first
  const themeMatches = html.match(/[ \t]*<meta\s+name="theme-color"[^>]*>\r?\n?/g) || [];
  themeMatches.slice(1).forEach((m) => { html = html.replace(m, ''); });

  // 4. noscript fallback for script-only bodies
  html = html.replace(/<body>\s*<\/body>/, `<body>\n${NOSCRIPT}\n</body>`);

  // 5. 404.html is served for arbitrary nested URLs — relative asset paths break there
  if (rel === '404.html') {
    html = html
      .replace(/href="assets\//g, 'href="/assets/')
      .replace(/href="css\//g, 'href="/css/')
      .replace(/href="index\.html"/g, 'href="/"');
  }

  if (html !== before) fs.writeFileSync(abs, html, 'utf8');
  return html !== before;
}

const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'optional-cloud-functions', 'scripts'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) pages.push(path.relative(ROOT, p));
  }
})(ROOT);

let changed = 0;
for (const p of pages.sort()) if (process(p)) changed++;
console.log(`html: ${pages.length} pages, ${changed} updated`);

// ── robots.txt ────────────────────────────────────────────────────────
// One user-agent group only: several crawlers (and the RFC 9309 parser
// bundled with some CDNs) honour just the LAST matching group, so a second
// "User-agent: *" block would silently discard the Allow/Disallow set above.
const robots = `User-agent: *
Allow: /
Disallow: /admin/
Disallow: /profile-setup.html
Disallow: /verify-email.html

Sitemap: ${ORIGIN}/sitemap.xml
`;
fs.writeFileSync(path.join(ROOT, 'robots.txt'), robots, 'utf8');

// ── sitemap.xml ───────────────────────────────────────────────────────
// Only pages that are BOTH reachable without signing in AND marked
// index,follow belong here — rules.html/maintenance.html sit behind the auth
// chain and are noindex, so listing them would contradict the page tags.
const now = new Date().toISOString().slice(0, 10);
const smPages = [...INDEXABLE];
const urls = smPages.map((p) => {
  const loc = p === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${p}`;
  const prio = p === 'index.html' ? '1.0' : p === 'login.html' || p === 'signup.html' ? '0.9' : '0.6';
  return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>${p === 'index.html' ? 'daily' : 'monthly'}</changefreq>\n    <priority>${prio}</priority>\n  </url>`;
}).join('\n');
fs.writeFileSync(
  path.join(ROOT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  'utf8'
);
console.log('wrote robots.txt + sitemap.xml');
