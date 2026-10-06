// ─── Shared utilities: money, dates, validation, formatting ──────────

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Inline-only markup: everything is escaped first, then a small whitelist of
// tags and **bold** markers is re-enabled — so descriptions can carry <strong>
// (or **bold**) without ever allowing scripts or attributes through.
const RICH_TAGS = 'strong|b|em|i|u|s|code|br';
const RICH_TAG_RE = new RegExp(`&lt;(\\/?)(${RICH_TAGS})(?:\\s+[\\s\\S]*?)?&gt;`, 'gi');
const MD_BOLD_RE = /\*\*([^*]+?)\*\*/g;

export function rich(s) {
  return esc(s)
    .replace(MD_BOLD_RE, '<strong>$1</strong>')
    .replace(RICH_TAG_RE, (_, close, tag) => `<${close}${tag.toLowerCase()}>`);
}

// ── Money (all Firestore amounts are integer paisa) ──
const nprFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

/** Format integer paisa as "रु 1,250". sign: 0 auto, 1 force +, -1 force − */
export function fmtNPR(paisa, { sign = 0, space = '\u2009' } = {}) {
  const n = Number(paisa) || 0;
  const abs = nprFmt.format(Math.abs(n) / 100);
  const prefix = n < 0 ? '−' : sign === 1 ? '+' : '';
  return `${prefix}रु${space}${abs}`;
}

/** NPR (number) → integer paisa */
export function toPaisa(npr) {
  return Math.round(Number(npr) * 100);
}

// ── Dates (Asia/Kathmandu) ──
const TZ = 'Asia/Kathmandu';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ktmParts(date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
  const out = {};
  for (const p of f.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** "5 Oct 2026" */
export function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const p = ktmParts(d);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
}

/** "5 Oct 2026, 1:45 PM" */
export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const p = ktmParts(d);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod.toUpperCase()}`;
}

/** "1:45 PM" */
export function fmtTime(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const p = ktmParts(d);
  return `${p.hour}:${p.minute} ${p.dayPeriod.toUpperCase()}`;
}

export function fmtRelative(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 45 * 1000) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return fmtDate(ts);
}

/** Normalise a Firestore Timestamp / Date / ms value to a Date, or null. */
function asDate(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Stable day bucket in Asia/Kathmandu (e.g. "06/10/2026") — for grouping rows by day. */
export function dayKey(ts) {
  const d = asDate(ts);
  return d ? dayFmt.format(d) : '';
}

/** Group heading for a notification row: "Today" / "Yesterday" / "5 Oct 2026". */
export function dayLabel(ts) {
  const k = dayKey(ts);
  if (!k) return '';
  if (k === dayKey(new Date())) return 'Today';
  if (k === dayKey(new Date(Date.now() - 864e5))) return 'Yesterday';
  return fmtDate(ts);
}

/** Time remaining until timestamp → "1d 8h 42m" or "Released"/"Overdue" */
export function countdownUntil(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  let s = Math.floor((d.getTime() - Date.now()) / 1000);
  if (s <= 0) return 'Ready';
  const days = Math.floor(s / 86400); s %= 86400;
  const hrs = Math.floor(s / 3600); s %= 3600;
  const mins = Math.floor(s / 60);
  if (days > 0) return `${days}d ${hrs}h ${mins}m`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

export function greeting() {
  const p = ktmParts(new Date());
  const h = Number(p.hour) % 12 + (p.dayPeriod.toLowerCase() === 'pm' ? 12 : 0);
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ── Validation ──
export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim());
/** Nepali mobile (98XXXXXXXX / 96… / 97…) or landline (01XXXXXXX) */
export const isNepaliPhone = (v) => /^(9[678]\d{8}|0?1\d{7}|0?[2-7]\d{7})$/.test(String(v).replace(/[\s-]/g, ''));
export const isPin4 = (v) => /^\d{4}$/.test(String(v));
/** PINs that should never be accepted */
export const isWeakPin = (v) => /^(?:([0-9])\1{3}|0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321)$/.test(String(v));
export const isValidName = (v) => /^[A-Za-z][A-Za-z\s.'-]{1,59}$/.test(String(v).trim());

export function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(score, 4); // 0-4
}

// ── Helpers ──
export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

export function fmtBytes(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

export function qsParam(name) {
  return new URLSearchParams(location.search).get(name);
}

// ── Friendly error text (never leak raw Firebase errors) ──
const AUTH_ERRORS = {
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/user-disabled': 'This account has been disabled. Contact support for help.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/email-already-in-use': 'An account with this email already exists. Try logging in instead.',
  'auth/weak-password': 'Your password is too weak. Use at least 8 characters with a mix of letters and numbers.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': "You're currently offline. Check your connection and try again.",
  'auth/requires-recent-login': 'For security, please log in again before performing this action.',
  'auth/invalid-verification-code': 'The code you entered is incorrect.',
  'auth/missing-password': 'Please enter your password.'
};

export function authErrorText(err) {
  const code = err && err.code ? String(err.code) : '';
  if (AUTH_ERRORS[code]) return AUTH_ERRORS[code];
  if (err && err.message && err.message.includes('password')) return 'Incorrect email or password.';
  return 'Something went wrong. Please try again.';
}

export function callableErrorText(err) {
  const msg = err && err.message ? String(err.message) : '';
  if (msg) return msg.replace(/^Firebase:\s*/i, '').replace(/\s*\(auth\/.*\)\.?$/i, '');
  return 'Something went wrong. Please try again.';
}

// ── Status labels ──
export const ASSIGNMENT_STATUS = {
  requested: { label: 'Waiting for approval', tone: 'amber' },
  assigned: { label: 'In progress', tone: 'blue' },
  submitted: { label: 'Submitted for review', tone: 'blue' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  clarification: { label: 'Clarification needed', tone: 'amber' },
  cancelled: { label: 'Cancelled', tone: 'gray' }
};

export const WITHDRAWAL_STATUS = {
  pending: { label: 'Pending', tone: 'amber' },
  under_review: { label: 'Under review', tone: 'blue' },
  approved: { label: 'Approved', tone: 'blue' },
  processing: { label: 'Processing', tone: 'blue' },
  completed: { label: 'Completed', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' }
};

export const TX_TYPE = {
  task_reward: { label: 'Task reward', icon: 'coins' },
  referral_reward: { label: 'Referral reward', icon: 'users' },
  referral_task_reward: { label: 'Referral task reward', icon: 'coins' },
  hold: { label: 'Hold', icon: 'clock' },
  hold_release: { label: 'Hold released', icon: 'unlock' },
  penalty: { label: 'Penalty', icon: 'alert' },
  withdrawal: { label: 'Withdrawal', icon: 'bank' },
  withdrawal_reversal: { label: 'Withdrawal refund', icon: 'refresh' },
  adjustment: { label: 'Adjustment', icon: 'edit' }
};

export const TX_STATUS = {
  pending: { label: 'Pending', tone: 'amber' },
  hold: { label: 'On hold', tone: 'amber' },
  available: { label: 'Available', tone: 'green' },
  completed: { label: 'Completed', tone: 'green' },
  reversed: { label: 'Reversed', tone: 'gray' }
};

export const DIFFICULTY = {
  easy: { label: 'Easy', tone: 'green' },
  medium: { label: 'Medium', tone: 'amber' },
  hard: { label: 'Hard', tone: 'red' }
};

export const TASK_CATEGORIES = [
  'Survey', 'Data Entry', 'Content Verification', 'Website Testing', 'App Testing',
  'Research', 'Digital Assistance', 'Promotional', 'Data Categorization', 'Other'
];
