// ─── Inline SVG icon set (24px, stroke-based) ────────────────────────
// Built from primitives so no icon font/CDN is needed.

const P = {
  dashboard: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/>',
  wallet: '<path d="M20 8H5a2 2 0 0 1 0-4h13v4"/><path d="M3 6v12a2 2 0 0 0 2 2h15v-4"/><path d="M20 12v4h-4a2 2 0 0 1 0-4h4z"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 3-5.5 6.5-5.5s6.5 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.7c2.1.7 3.5 2.3 3.5 5.3"/>',
  shield: '<path d="M12 2 4 5.5V11c0 5.2 3.4 8.9 8 11 4.6-2.1 8-5.8 8-11V5.5L12 2z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/>',
  lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.8"/><path d="m5.7 5.7 3.8 3.8M18.3 5.7l-3.8 3.8M18.3 18.3l-3.8-3.8M5.7 18.3l3.8-3.8"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L7 20"/>',
  video: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="m16 10 6-3.5v11L16 14"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 2v6h6"/>',
  check: '<path d="m4 12.5 5.5 5.5L20 6.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  alert: '<path d="M12 3 1.8 20.2h20.4L12 3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.6" r=".6" fill="currentColor" stroke="none"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  coins: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="M14.5 6.2a5.5 5.5 0 1 1-7.9 7.4"/><path d="M8.5 6v5M6.8 7h3.4M6.8 10h3.4" transform="translate(0,-.5)"/>',
  trendUp: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  trendDown: '<path d="m3 7 6 6 4-4 8 8"/><path d="M15 17h6v-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.4 17.4 0 0 1-3 3.9M6.1 6.1A16.6 16.6 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 6 6 6-6 6"/>',
  chevLeft: '<path d="m15 6-6 6 6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  more: '<circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  bank: '<path d="M3 9.5 12 4l9 5.5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  megaphone: '<path d="M3 11v3a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M14 7c1.5 1 1.5 9 0 10M17 5c2.5 2 2.5 12 0 14"/>',
  wrench: '<path d="M14.7 6.3a4.5 4.5 0 0 0 6 6L17 16l-4.5 4.5a2.1 2.1 0 0 1-3-3L14 13l-3.7-3.7a4.5 4.5 0 0 0-6-6L7.6 6l-1 3.4-3.4 1-3.3-3.3"/>',
  scroll: '<path d="M8 21h11a2 2 0 0 0 2-2v-1H10"/><path d="M9 21a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h1"/><path d="M8 3h9a2 2 0 0 1 2 2v13"/><path d="M10 8h6M10 12h6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  smartphone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M12 18.5h.01"/>',
  message: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.6 0-3.1-.4-4.4-1.2L3 20l1.2-5.1A8.5 8.5 0 1 1 21 11.5z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4c4-2.5 7 2.5 11 0v9c-4 2.5-7-2.5-11 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor" stroke="none"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.07 4.2l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10.1 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  paperclip: '<path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  wifiOff: '<path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 3-2M2 8.8A15 15 0 0 1 7 5.8M16.9 7.4a15 15 0 0 1 5.1 3.4"/><path d="M12 20h.01"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  zap: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
  home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9z"/><path d="M9 21v-7h6v7"/>',
  rupee: '<path d="M7 4h10M7 9h10M7 4c0 6 4 5 8 5l-7 11" transform="translate(0,0)"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 12.8 4.7a3.8 3.8 0 0 1 5.4 5.4l-1.8 1.8"/><path d="M13 17.5l-1.8 1.8a3.8 3.8 0 0 1-5.4-5.4l1.8-1.8"/>',
  share: '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
};

export function icon(name, cls = '') {
  const body = P[name] || P.info;
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Brand logo (mark + optional wordmark) */
export function logo({ wordmark = true, size = 34, light = false } = {}) {
  const mark = `<svg width="${size}" height="${size}" viewBox="0 0 96 96" aria-hidden="true">
    <defs><linearGradient id="lg${size}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12996B"/><stop offset="1" stop-color="#0A3D2C"/>
    </linearGradient></defs>
    <rect x="4" y="4" width="88" height="88" rx="22" fill="url(#lg${size})"/>
    <path d="M24 22 L24 50 L34 44 L24 38 Z" fill="#D9A62E" opacity="0.92"/>
    <path d="M24 38 L24 66 L38 58 L24 50 Z" fill="#FFFFFF" opacity="0.85"/>
    <path d="M42 66 L53 53 L61 59 L75 39" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="75" cy="39" r="6" fill="#D9A62E"/>
  </svg>`;
  if (!wordmark) return mark;
  // `light: true` is for surfaces that are deep green in BOTH themes (sidebar,
  // auth aside). Everywhere else the wordmark must follow the theme, otherwise
  // "Afno" renders near-black on dark backgrounds and disappears entirely.
  const c1 = light ? '#FFFFFF' : 'var(--wordmark-1, #12201A)';
  return `<span class="brand" style="--mark:${size}px">${mark}<span class="brand-name"><span style="color:${c1}">Afno</span><span style="color:#3DBD8B">Kamai</span></span></span>`;
}
