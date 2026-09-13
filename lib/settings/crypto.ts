import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * AES-256-GCM for the API keys held in `app_settings`.
 *
 * The key comes from SETTINGS_SECRET when set, otherwise it is derived from
 * SUPABASE_SERVICE_ROLE_KEY so there's nothing extra to configure. Consequence
 * of the fallback: rotating the service-role key makes stored secrets
 * undecryptable — re-enter them on /settings after a rotation, or set
 * SETTINGS_SECRET to decouple the two.
 */
const SALT = 'dave-desk/app_settings/v1';

function encryptionKey(): Buffer {
  const material = process.env.SETTINGS_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!material) {
    throw new Error(
      'Cannot encrypt settings: set SETTINGS_SECRET or SUPABASE_SERVICE_ROLE_KEY.'
    );
  }
  return scryptSync(material, SALT, 32);
}

/** → "v1.<iv>.<authTag>.<ciphertext>", all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

/** Returns null for anything that doesn't decrypt cleanly (wrong key, tampering). */
export function decryptSecret(payload: string): string | null {
  try {
    const [version, ivB64, tagB64, ctB64] = payload.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(ivB64, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

export function hintFor(secret: string): string {
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
}
