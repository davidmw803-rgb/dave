import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * One row per outbound API call, keyed by what the call *is* rather than who
 * asked for it. Two different filter pulls that both need AAPL's info make one
 * request between them; a third next week makes another only once the TTL has
 * passed. Settled history (a price window whose time has passed) is stored with
 * no expiry and never refetched.
 */
export interface CachedCall<T> {
  value: T;
  cached: boolean;
}

export const TTL = {
  /** Company facts drift slowly. */
  info: 24 * 60 * 60 * 1000,
  /** A quote is only worth reusing inside a minute. */
  quote: 60 * 1000,
  /** Analyst consensus — daily is plenty. */
  tipranks: 24 * 60 * 60 * 1000,
  /** Price bars for a window that has already elapsed never change. */
  settled: null as number | null,
} as const;

export function callKey(provider: string, endpoint: string, ...parts: string[]): string {
  return [provider, endpoint, ...parts].join(':');
}

/**
 * Run `fetcher` unless a live cache entry already answers this call.
 * Errors are cached briefly too, so a broken ticker doesn't get hammered.
 */
export async function getOrFetch<T>(
  key: string,
  opts: {
    provider: string;
    endpoint: string;
    args?: Record<string, unknown>;
    ttlMs: number | null;
    /** Skip the cache read and refetch. The write still happens. */
    force?: boolean;
  },
  fetcher: () => Promise<T>
): Promise<CachedCall<T>> {
  const supabase = createAdminClient();

  if (!opts.force) {
    const { data } = await supabase
      .from('api_call_cache')
      .select('response, status, error, expires_at')
      .eq('call_key', key)
      .maybeSingle();

    if (data && (data.expires_at === null || new Date(data.expires_at) > new Date())) {
      if (data.status === 'error') {
        throw new Error(`${data.error ?? 'cached error'} (cached)`);
      }
      return { value: data.response as T, cached: true };
    }
  }

  try {
    const value = await fetcher();
    await supabase.from('api_call_cache').upsert(
      {
        call_key: key,
        provider: opts.provider,
        endpoint: opts.endpoint,
        args: opts.args ?? {},
        status: 'ok',
        response: value as unknown as Record<string, unknown>,
        error: null,
        fetched_at: new Date().toISOString(),
        expires_at:
          opts.ttlMs === null ? null : new Date(Date.now() + opts.ttlMs).toISOString(),
      },
      { onConflict: 'call_key' }
    );
    return { value, cached: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'request failed';

    // A rate limit or a 5xx says "not now", not "no". Caching those would
    // lock the affected calls out for five minutes and make a burst of 429s
    // look like permanent data loss.
    if ((e as { retryable?: boolean }).retryable === true) throw e;

    // Short negative cache: long enough to stop a retry storm, short enough
    // that a transient outage doesn't poison the day.
    await supabase.from('api_call_cache').upsert(
      {
        call_key: key,
        provider: opts.provider,
        endpoint: opts.endpoint,
        args: opts.args ?? {},
        status: 'error',
        response: null,
        error: message,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
      { onConflict: 'call_key' }
    );
    throw e;
  }
}

/** Which of these keys already have a live cache entry. */
export async function liveKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('api_call_cache')
    .select('call_key, expires_at')
    .in('call_key', keys);
  const now = Date.now();
  return new Set(
    (data ?? [])
      .filter((r) => r.expires_at === null || new Date(r.expires_at as string).getTime() > now)
      .map((r) => r.call_key as string)
  );
}
