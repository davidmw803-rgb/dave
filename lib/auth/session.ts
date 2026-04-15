/**
 * Signed-cookie session helper. Edge-runtime compatible (uses Web Crypto, not node:crypto).
 *
 * The session cookie value is `${issuedAt}.${hex(HMAC-SHA256(issuedAt, SESSION_SECRET))}`.
 * Verification checks the HMAC in constant time and enforces a max age.
 *
 * We deliberately keep the payload to a single integer (issuedAt ms) — this app
 * has one user and one role, so there's no identity to encode.
 */

const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
export const MAX_AGE_SECONDS = Math.floor(MAX_AGE_MS / 1000);
export const COOKIE_NAME = 'app_session';

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'SESSION_SECRET is missing or too short (need at least 32 chars of hex). Set it in .env.local and Vercel env.'
    );
  }
  return s;
}

async function hmacHex(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Constant-time hex string comparison.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function signSession(): Promise<string> {
  const issuedAt = Date.now().toString();
  const sig = await hmacHex(issuedAt, getSecret());
  return `${issuedAt}.${sig}`;
}

export async function verifySession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const issuedAt = Number(payload);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
  if (Date.now() - issuedAt > MAX_AGE_MS) return false;

  let expected: string;
  try {
    expected = await hmacHex(payload, getSecret());
  } catch {
    return false;
  }
  return timingSafeEqual(sig, expected);
}
