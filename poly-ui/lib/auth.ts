export const SESSION_COOKIE = 'hp_session';
export const SESSION_MAX_AGE_DAYS = 30;

// Hex-SHA256. Used to hash the shared DASHBOARD_TOKEN before stamping it into
// the cookie so the raw secret never lives in the browser. Edge-runtime safe.
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

export async function expectedSessionValue(): Promise<string | null> {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return null;
  return sha256Hex(token);
}
