import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptSecret, encryptSecret, hintFor } from './crypto';

export type SettingKey =
  | 'uw_api_key'
  | 'uw_api_base_url'
  | 'tipranks_api_key'
  | 'tipranks_api_base_url'
  | 'mcp_token';

export interface SettingDefinition {
  key: SettingKey;
  label: string;
  description: string;
  secret: boolean;
  placeholder: string;
  /** Env var consulted when nothing is stored in the database. */
  envVar: string;
  envDefault?: string;
}

export const SETTING_DEFS: SettingDefinition[] = [
  {
    key: 'uw_api_key',
    label: 'Unusual Whales API key',
    description: 'Options flow half of the UW × TipRanks table.',
    secret: true,
    placeholder: 'uw_live_…',
    envVar: 'UW_API_KEY',
  },
  {
    key: 'uw_api_base_url',
    label: 'Unusual Whales base URL',
    description: 'Only change this if you are pointed at a proxy.',
    secret: false,
    placeholder: 'https://api.unusualwhales.com',
    envVar: 'UW_API_BASE_URL',
    envDefault: 'https://api.unusualwhales.com',
  },
  {
    key: 'tipranks_api_key',
    label: 'TipRanks API key',
    description: 'Analyst-consensus half of the table.',
    secret: true,
    placeholder: 'tr_…',
    envVar: 'TIPRANKS_API_KEY',
  },
  {
    key: 'mcp_token',
    label: 'MCP access token',
    description:
      'Lets Claude run pulls and query this data through /api/mcp. Its own secret, revocable on its own — not the dashboard password. Stored hashed, so it can never be read back: save a new one to rotate.',
    // Hashed on the way in, like the dashboard password, so what lands in the
    // database is not the token and there is nothing to decrypt.
    secret: false,
    placeholder: 'a long random string',
    envVar: 'MCP_TOKEN',
  },
  {
    key: 'tipranks_api_base_url',
    label: 'TipRanks base URL',
    description: 'Depends on which TipRanks product the key belongs to.',
    secret: false,
    placeholder: 'https://api.tipranks.com',
    envVar: 'TIPRANKS_API_BASE_URL',
    envDefault: 'https://api.tipranks.com',
  },
];

/** What the browser is allowed to know about a setting: never the secret itself. */
export interface SettingStatus {
  key: SettingKey;
  source: 'database' | 'env' | 'unset';
  /** Masked for secrets, the literal value for non-secrets. */
  display: string | null;
  updatedAt: string | null;
}

interface SettingRow {
  key: string;
  value: string | null;
  is_secret: boolean;
  hint: string | null;
  updated_at: string;
}

async function loadRows(): Promise<{ rows: SettingRow[]; error: string | null }> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.from('app_settings').select('*');
    if (error) return { rows: [], error: error.message };
    return { rows: (data ?? []) as SettingRow[], error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : 'Supabase unavailable' };
  }
}

export async function getSettingStatuses(): Promise<{
  statuses: SettingStatus[];
  error: string | null;
}> {
  const { rows, error } = await loadRows();
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const statuses = SETTING_DEFS.map((def): SettingStatus => {
    const row = byKey.get(def.key);
    if (row?.value) {
      return {
        key: def.key,
        source: 'database',
        display: def.secret ? row.hint ?? '••••' : row.value,
        updatedAt: row.updated_at,
      };
    }
    const envValue = process.env[def.envVar];
    if (envValue) {
      return {
        key: def.key,
        source: 'env',
        display: def.secret ? hintFor(envValue) : envValue,
        updatedAt: null,
      };
    }
    return { key: def.key, source: 'unset', display: null, updatedAt: null };
  });

  return { statuses, error };
}

/**
 * Resolve a setting for server-side use: database first, environment variable
 * second, hard-coded default last. Never call this from client code.
 */
export async function getSetting(key: SettingKey): Promise<string | null> {
  const def = SETTING_DEFS.find((d) => d.key === key);
  if (!def) return null;

  const { rows } = await loadRows();
  const row = rows.find((r) => r.key === key);
  if (row?.value) {
    const value = def.secret ? decryptSecret(row.value) : row.value;
    if (value) return value;
    // Ciphertext that won't decrypt (key rotated) falls through to the env var.
  }

  return process.env[def.envVar] || def.envDefault || null;
}

export async function setSetting(key: SettingKey, rawValue: string): Promise<void> {
  const def = SETTING_DEFS.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown setting: ${key}`);

  const value = rawValue.trim();
  if (!value) throw new Error('Value is empty.');

  const supabase = createAdminClient();
  const { error } = await supabase.from('app_settings').upsert(
    {
      key,
      value: def.secret ? encryptSecret(value) : value,
      is_secret: def.secret,
      hint: def.secret ? hintFor(value) : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );
  if (error) throw new Error(error.message);
}

export async function clearSetting(key: SettingKey): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from('app_settings').delete().eq('key', key);
  if (error) throw new Error(error.message);
}
