import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { hashPassword, verifyPasswordHash } from '@/lib/auth/password';

/**
 * The MCP access token.
 *
 * Stored the way the dashboard password is — scrypt-HASHED in plain sight in
 * `app_settings` — and deliberately not the way the API keys are. An API key
 * has to be recoverable because it gets sent upstream, so it is encrypted with
 * a key only the running app holds. A token this app merely *checks* never
 * needs recovering, so hashing it is both safer (a database leak yields
 * nothing usable) and more operable (it can be set by anything that can write
 * a row, without holding the app's encryption key).
 *
 * MCP_TOKEN in the environment still overrides, for anyone who prefers config.
 */
export const MCP_TOKEN_SETTING_KEY = 'mcp_token';

/** Hash a token for storage. The plaintext is never written anywhere. */
export function hashMcpToken(token: string): string {
  return hashPassword(token);
}

function constantEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** Whether a presented token is the configured one. Never logs either value. */
export async function checkMcpToken(presented: string): Promise<boolean> {
  if (!presented) return false;

  const fromEnv = process.env.MCP_TOKEN;
  if (fromEnv) return constantEquals(presented, fromEnv);

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', MCP_TOKEN_SETTING_KEY)
      .maybeSingle();
    if (error) return false;
    const stored = (data?.value as string | undefined) ?? null;
    if (!stored) return false;
    return verifyPasswordHash(presented, stored);
  } catch {
    return false;
  }
}

/** Whether a token is configured at all, for the settings page to report. */
export async function mcpTokenConfigured(): Promise<boolean> {
  if (process.env.MCP_TOKEN) return true;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', MCP_TOKEN_SETTING_KEY)
      .maybeSingle();
    return Boolean(data?.value);
  } catch {
    return false;
  }
}
