/**
 * Unusual Whales API client.
 *
 * Credentials resolve through lib/settings/store: whatever was saved on
 * /settings wins, UW_API_KEY / UW_API_BASE_URL are the fallback. Server-side
 * only — the key must never reach the browser.
 *
 * Endpoints used (paths as written in UW's OpenAPI spec, so they can be pasted
 * straight from the docs):
 *   GET /api/screener/analysts
 *   GET /api/stock/{ticker}/info
 *   GET /api/stock/{ticker}/quote
 *   GET /api/stock/{ticker}/ohlc/{candle_size}
 */
import 'server-only';
import { getSetting } from '@/lib/settings/store';

export const UW_DEFAULT_BASE_URL = 'https://api.unusualwhales.com';

/** The only filters UW's screener accepts server-side. */
export interface AnalystScreenerParams {
  ticker?: string;
  action?: 'initiated' | 'reiterated' | 'downgraded' | 'upgraded' | 'maintained';
  recommendation?: 'buy' | 'hold' | 'sell';
  /** ISO date, RFC3339 datetime, or unix seconds/ms. */
  newer_than?: string;
  older_than?: string;
  limit?: number;
}

export interface AnalystRatingRaw {
  ticker?: string;
  analyst_name?: string;
  firm?: string;
  recommendation?: string;
  action?: string;
  sector?: string;
  target?: string | number;
  timestamp?: string;
}

export type CandleSize = '1m' | '5m' | '10m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export interface OhlcBarRaw {
  /** Daily and weekly bars are dated; intraday bars use start_time/end_time. */
  date?: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: number;
  total_volume?: number;
  start_time?: string;
  end_time?: string;
  market_time?: string;
}

export interface UwCredentials {
  apiKey: string;
  baseUrl: string;
}

export async function getUwCredentials(): Promise<UwCredentials | null> {
  const apiKey = await getSetting('uw_api_key');
  if (!apiKey) return null;
  const baseUrl = (await getSetting('uw_api_base_url')) ?? UW_DEFAULT_BASE_URL;
  return { apiKey: apiKey.trim(), baseUrl: baseUrl.trim().replace(/\/$/, '') };
}

export async function isUwConfigured(): Promise<boolean> {
  return (await getUwCredentials()) !== null;
}

export class UwApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'UwApiError';
  }
}

/**
 * A shared pacer for every outbound UW call in this process.
 *
 * Enrichment runs several ratings at once and each one makes two or three
 * calls, so without pacing a batch arrives as a burst, collects 429s, and the
 * ratings that lost the race end up with no prices at all. UW does not publish
 * a rate in its spec, so the gap adapts: it widens whenever a 429 comes back
 * and narrows again while calls keep succeeding, settling near whatever the
 * account actually allows.
 */
const MIN_GAP_MS = 90;
const MAX_GAP_MS = 1500;
let gapMs = 120;
let nextSlotAt = 0;

async function takeSlot(): Promise<void> {
  const now = Date.now();
  // Single-threaded, so claiming the slot and advancing the cursor is atomic.
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + gapMs;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

function easeOff(): void {
  gapMs = Math.min(MAX_GAP_MS, Math.ceil(gapMs * 1.8));
}

function speedUp(): void {
  if (gapMs > MIN_GAP_MS) gapMs = Math.max(MIN_GAP_MS, gapMs - 2);
}

export class UnusualWhalesClient {
  constructor(private readonly creds: UwCredentials) {}

  static async create(): Promise<UnusualWhalesClient> {
    const creds = await getUwCredentials();
    if (!creds) {
      throw new UwApiError(
        'No Unusual Whales API key configured. Add one on /settings or set UW_API_KEY.',
        0,
        false
      );
    }
    return new UnusualWhalesClient(creds);
  }

  async request<T>(path: string, query: Record<string, unknown> = {}): Promise<T> {
    const url = new URL(
      `${this.creds.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    );
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const send = async (): Promise<Response> => {
      await takeSlot();
      return fetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.creds.apiKey}`,
        },
        cache: 'no-store',
      });
    };

    let res = await send();

    // A rate limit or a 5xx says "not now", not "no" — six ratings enriching at
    // once will hit both. Back off, slow the shared pacer so the rest of the
    // batch stops walking into the same wall, and try again. Giving up here
    // used to cost the rating its prices for good.
    for (let attempt = 0; attempt < 4 && (res.status === 429 || res.status >= 500); attempt++) {
      if (res.status === 429) easeOff();
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 8000)
          : Math.min(500 * 2 ** attempt, 4000);
      await new Promise((r) => setTimeout(r, waitMs));
      res = await send();
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 429 and 5xx are worth another go; 401/403/422 are not.
      const retryable = res.status === 429 || res.status >= 500;
      throw new UwApiError(
        `UW ${res.status} ${res.statusText} on ${path}${body ? `: ${body.slice(0, 200)}` : ''}`,
        res.status,
        retryable
      );
    }

    speedUp();
    return (await res.json()) as T;
  }

  /** One page of analyst ratings, newest first. Max 500 per call. */
  async screenerAnalysts(params: AnalystScreenerParams): Promise<AnalystRatingRaw[]> {
    const body = await this.request<{ data?: AnalystRatingRaw[] }>(
      '/api/screener/analysts',
      { ...params, limit: params.limit ?? 500 }
    );
    return body.data ?? [];
  }

  async stockInfo(ticker: string): Promise<Record<string, unknown>> {
    const body = await this.request<{ data?: Record<string, unknown> }>(
      `/api/stock/${encodeURIComponent(ticker)}/info`
    );
    return body.data ?? {};
  }

  async stockQuote(ticker: string): Promise<Record<string, unknown>> {
    const body = await this.request<{ data?: Record<string, unknown> }>(
      `/api/stock/${encodeURIComponent(ticker)}/quote`
    );
    return body.data ?? {};
  }

  async ohlc(
    ticker: string,
    candleSize: CandleSize,
    opts: { date?: string; end_date?: string; timeframe?: string; limit?: number } = {}
  ): Promise<OhlcBarRaw[]> {
    const body = await this.request<{ data?: OhlcBarRaw[] }>(
      `/api/stock/${encodeURIComponent(ticker)}/ohlc/${candleSize}`,
      opts
    );
    return body.data ?? [];
  }
}
