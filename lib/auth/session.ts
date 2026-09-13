/**
 * Session tokens for the shared-password gate.
 *
 * The cookie is a signed, self-verifying token — `v1.<expiry ms>.<hmac>` — so
 * the edge middleware can check it with no database round trip and no access
 * to the password itself. The password (hashed) lives in `app_settings`; only
 * the Node-side login route ever needs it.
 *
 * Signing key: APP_SESSION_SECRET, else SETTINGS_SECRET, else the
 * service-role key, which every deployment already has. Rotating whichever one
 * is in use invalidates all sessions.
 */
export const SESSION_COOKIE = 'dave_session';
export const SESSION_MAX_AGE_DAYS = 30;

const TOKEN_VERSION = 'v1';

export function sessionKeyMaterial(): string | null {
  return (
    process.env.APP_SESSION_SECRET ||
    process.env.SETTINGS_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.APP_PASSWORD ||
    null
  );
}

function b64url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(message: string, material: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64url(sig);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Issue a token valid for SESSION_MAX_AGE_DAYS. Null when nothing can sign it. */
export async function issueSessionToken(now = Date.now()): Promise<string | null> {
  const material = sessionKeyMaterial();
  if (!material) return null;
  const exp = now + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${TOKEN_VERSION}.${exp}`;
  return `${payload}.${await hmac(payload, material)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  now = Date.now()
): Promise<boolean> {
  if (!token) return false;
  const material = sessionKeyMaterial();
  if (!material) return false;

  const [version, expRaw, sig] = token.split('.');
  if (version !== TOKEN_VERSION || !expRaw || !sig) return false;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return false;

  const expected = await hmac(`${version}.${expRaw}`, material);
  return constantTimeEqual(sig, expected);
}

/**
 * With nothing to sign tokens with, local development stays open but a real
 * deployment stays shut.
 */
export function devBypassAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}
