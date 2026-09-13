/**
 * Unusual Whales API client.
 *
 * The key and base URL resolve through lib/settings/store: whatever was saved
 * on /settings wins, the UW_API_KEY / UW_API_BASE_URL env vars are the fallback.
 * Server-side only — the key must never reach the browser.
 *
 * Endpoints we'll use:
 *   - GET /api/stock/{ticker}/analyst-ratings
 *   - GET /api/analyst/{analyst_id}/ratings
 *   - GET /api/stock/{ticker}/news
 */
import 'server-only';
import { getSetting } from '@/lib/settings/store';

export const UW_DEFAULT_BASE_URL = 'https://api.unusualwhales.com/api';

export interface UwCredentials {
  apiKey: string;
  baseUrl: string;
}

/** Resolved credentials, or null when no key is configured anywhere. */
export async function getUwCredentials(): Promise<UwCredentials | null> {
  const apiKey = await getSetting('uw_api_key');
  if (!apiKey) return null;
  const baseUrl = (await getSetting('uw_api_base_url')) ?? UW_DEFAULT_BASE_URL;
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, '') };
}

export async function isUwConfigured(): Promise<boolean> {
  return (await getUwCredentials()) !== null;
}

export class UnusualWhalesClient {
  constructor(private readonly creds: UwCredentials) {}

  static async create(): Promise<UnusualWhalesClient> {
    const creds = await getUwCredentials();
    if (!creds) {
      throw new Error(
        'No Unusual Whales API key configured. Add one on /settings or set UW_API_KEY.'
      );
    }
    return new UnusualWhalesClient(creds);
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.creds.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.creds.apiKey}`,
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`UW ${res.status} ${res.statusText} on ${path}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return (await res.json()) as T;
  }

  // Implemented once the ingest job lands.
  async getRecentRatingsByAnalyst(_uwAnalystId: string, _sinceIso: string): Promise<unknown[]> {
    throw new Error('Not implemented yet.');
  }

  async getHistoricalRatingsByAnalyst(
    _uwAnalystId: string,
    _fromIso: string,
    _toIso: string
  ): Promise<unknown[]> {
    throw new Error('Not implemented yet.');
  }
}
