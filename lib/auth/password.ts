import 'server-only';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * The dashboard password. Stored scrypt-hashed in `app_settings` under
 * `app_password_hash` so it can be set from /settings — no environment
 * variable, no redeploy. APP_PASSWORD still works as an override for anyone
 * who prefers config over database.
 *
 * Node runtime only: middleware never touches this, it only checks the signed
 * session token.
 */
export const PASSWORD_SETTING_KEY = 'app_password_hash';

const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  try {
    const [scheme, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export type PasswordSource = 'database' | 'env' | 'none';

async function storedHash(): Promise<string | null> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', PASSWORD_SETTING_KEY)
      .maybeSingle();
    if (error) return null;
    return (data?.value as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Where the active password comes from — drives the login vs. first-run UI. */
export async function passwordSource(): Promise<PasswordSource> {
  if (await storedHash()) return 'database';
  if (process.env.APP_PASSWORD) return 'env';
  return 'none';
}

export async function checkPassword(password: string): Promise<boolean> {
  if (!password) return false;

  const stored = await storedHash();
  if (stored) return verifyPasswordHash(password, stored);

  const envPassword = process.env.APP_PASSWORD;
  if (envPassword) {
    const a = Buffer.from(password);
    const b = Buffer.from(envPassword);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  return false;
}

export async function setPassword(password: string): Promise<void> {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  const supabase = createAdminClient();
  const { error } = await supabase.from('app_settings').upsert(
    {
      key: PASSWORD_SETTING_KEY,
      value: hashPassword(password),
      is_secret: true,
      hint: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );
  if (error) throw new Error(error.message);
}
