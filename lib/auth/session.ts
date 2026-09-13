/**
 * Shared-password gate.
 *
 * The cookie holds sha256(APP_PASSWORD), never the password itself. That means
 * changing APP_PASSWORD invalidates every existing session for free, and the
 * middleware can verify a session on the edge without a database round trip.
 */
export const SESSION_COOKIE = 'dave_session';
export const SESSION_MAX_AGE_DAYS = 30;

/** Edge-runtime safe SHA-256 (Web Crypto, not node:crypto). */
export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function appPassword(): string | null {
  const p = process.env.APP_PASSWORD;
  return p && p.length > 0 ? p : null;
}

/** The value a valid session cookie must hold, or null when no password is set. */
export async function expectedSessionValue(): Promise<string | null> {
  const password = appPassword();
  if (!password) return null;
  return sha256Hex(password);
}

/**
 * With no APP_PASSWORD set, local development stays open but a real deployment
 * stays shut — an unset password in production locks the app rather than
 * silently publishing the data.
 */
export function devBypassAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}
