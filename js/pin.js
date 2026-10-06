// ─── PIN security (free-plan architecture, Web Crypto PBKDF2) ────────
// The PIN is hashed with PBKDF2-SHA256 (120k iterations, random salt).
// The HASH lives in users/{uid}/private/pin which the owner can write
// but NEVER read (enforced by Firestore rules) — a stolen session cannot
// brute-force it offline. Admins read the hash to verify withdrawal
// proofs before paying out.

const PIN_ITERATIONS = 120000;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function pbkdf2(pin, saltHex, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']
  );
  const saltBytes = new Uint8Array(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    256
  );
  return toHex(bits);
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

export function isPin4(v) {
  return /^\d{4}$/.test(String(v));
}

export function isWeakPin(v) {
  return /^(?:([0-9])\1{3}|0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321)$/.test(String(v));
}

/** Create { pinHash, pinAlgo, pinIterations } for a new/changed PIN. */
export async function hashPin(pin) {
  const salt = randomSalt();
  const hash = await pbkdf2(pin, salt, PIN_ITERATIONS);
  return { salt, hash };
}

/** Compute the verification proof for a withdrawal request. */
export async function pinProof(pin, saltHex) {
  return pbkdf2(pin, saltHex, PIN_ITERATIONS);
}

export const PIN_META = { algo: 'PBKDF2-SHA256', iterations: PIN_ITERATIONS };
