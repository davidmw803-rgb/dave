import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { UnusualWhalesClient, type OhlcBarRaw } from '@/lib/uw/client';
import { TTL, callKey, getOrFetch } from './cache';
import type { EnrichResult } from './types';

/**
 * Price enrichment, in two parts:
 *   - per ticker: company info + last quote (drives market cap and upside)
 *   - per rating: where the price went afterwards, as windows off t0
 *
 * Everything goes through the call cache, so a ticker that appears in twenty
 * ratings is fetched once, and a rating already priced is skipped entirely.
 */

const WINDOWS: { label: string; minutes: number }[] = [
  { label: 't+1m', minutes: 1 },
  { label: 't+5m', minutes: 5 },
  { label: 't+30m', minutes: 30 },
  { label: 't+1h', minutes: 60 },
];

const DAY_WINDOWS: { label: string; days: number }[] = [
  { label: 't+1d', days: 1 },
  { label: 't+5d', days: 5 },
  { label: 't+30d', days: 30 },
];

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function barTime(bar: OhlcBarRaw): number {
  const t = bar.end_time ?? bar.start_time;
  return t ? new Date(t).getTime() : NaN;
}

/** Closing price of the last bar at or before `at`. */
function priceAt(bars: OhlcBarRaw[], at: number): { price: number; barAt: string } | null {
  let best: OhlcBarRaw | null = null;
  let bestTime = -Infinity;
  for (const bar of bars) {
    const t = barTime(bar);
    if (!Number.isFinite(t) || t > at) continue;
    if (t > bestTime) {
      bestTime = t;
      best = bar;
    }
  }
  const price = best ? num(best.close) : null;
  if (price === null || !Number.isFinite(bestTime)) return null;
  return { price, barAt: new Date(bestTime).toISOString() };
}

async function enrichTickerInfo(
  client: UnusualWhalesClient,
  ticker: string,
  counters: { fetched: number; cached: number }
): Promise<void> {
  const info = await getOrFetch(
    callKey('uw', 'info', ticker),
    { provider: 'uw', endpoint: '/api/stock/{ticker}/info', args: { ticker }, ttlMs: TTL.info },
    () => client.stockInfo(ticker)
  );
  info.cached ? counters.cached++ : counters.fetched++;

  const quote = await getOrFetch(
    callKey('uw', 'quote', ticker),
    { provider: 'uw', endpoint: '/api/stock/{ticker}/quote', args: { ticker }, ttlMs: TTL.quote },
    () => client.stockQuote(ticker)
  );
  quote.cached ? counters.cached++ : counters.fetched++;

  const d = info.value as Record<string, unknown>;
  const lastTrade = (quote.value as { last_trade?: { price?: unknown; time?: unknown } })
    ?.last_trade;
  const lastPrice = num(lastTrade?.price);
  const lastTime = num(lastTrade?.time);

  const supabase = createAdminClient();
  const { error } = await supabase.from('uw_ticker_info').upsert(
    {
      ticker,
      full_name: (d.full_name as string) ?? null,
      sector: (d.sector as string) ?? null,
      issue_type: (d.issue_type as string) ?? null,
      marketcap: num(d.marketcap),
      marketcap_size: (d.marketcap_size as string) ?? null,
      beta: num(d.beta),
      avg30_volume: num(d.avg30_volume),
      next_earnings_date: (d.next_earnings_date as string) ?? null,
      has_options: typeof d.has_options === 'boolean' ? d.has_options : null,
      last_price: lastPrice,
      last_price_at: lastTime ? new Date(lastTime).toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'ticker' }
  );
  if (error) throw new Error(error.message);
}

async function enrichEventWindows(
  client: UnusualWhalesClient,
  event: { event_key: string; ticker: string; rated_at: string },
  counters: { fetched: number; cached: number }
): Promise<void> {
  const ratedAt = new Date(event.rated_at);
  const ratedMs = ratedAt.getTime();
  const day = ratedAt.toISOString().slice(0, 10);

  // Intraday bars for the rating's own session, then daily bars for the drift.
  const minuteBars = await getOrFetch<OhlcBarRaw[]>(
    callKey('uw', 'ohlc', event.ticker, '1m', day),
    {
      provider: 'uw',
      endpoint: '/api/stock/{ticker}/ohlc/1m',
      args: { ticker: event.ticker, date: day },
      // A past session's bars never change.
      ttlMs: TTL.settled,
    },
    () => client.ohlc(event.ticker, '1m', { date: day, limit: 500 })
  );
  minuteBars.cached ? counters.cached++ : counters.fetched++;

  const dailyBars = await getOrFetch<OhlcBarRaw[]>(
    callKey('uw', 'ohlc', event.ticker, '1d', day),
    {
      provider: 'uw',
      endpoint: '/api/stock/{ticker}/ohlc/1d',
      args: { ticker: event.ticker, end_date: day, timeframe: '3M' },
      // Trailing daily bars keep arriving, so this one ages out.
      ttlMs: TTL.info,
    },
    () => client.ohlc(event.ticker, '1d', { timeframe: '3M', limit: 90 })
  );
  dailyBars.cached ? counters.cached++ : counters.fetched++;

  const t0 = priceAt(minuteBars.value, ratedMs) ?? priceAt(dailyBars.value, ratedMs);
  if (!t0) return; // No bar at or before the rating — nothing to anchor to.

  const rows: {
    event_key: string;
    window_label: string;
    price: number;
    bar_at: string;
    pct_from_t0: number | null;
  }[] = [
    {
      event_key: event.event_key,
      window_label: 't0',
      price: t0.price,
      bar_at: t0.barAt,
      pct_from_t0: 0,
    },
  ];

  const push = (label: string, hit: { price: number; barAt: string } | null) => {
    if (!hit) return;
    rows.push({
      event_key: event.event_key,
      window_label: label,
      price: hit.price,
      bar_at: hit.barAt,
      pct_from_t0: t0.price > 0 ? ((hit.price - t0.price) / t0.price) * 100 : null,
    });
  };

  const now = Date.now();
  for (const w of WINDOWS) {
    const at = ratedMs + w.minutes * 60_000;
    if (at > now) continue; // Not yet in the past — leave it for a later run.
    push(w.label, priceAt(minuteBars.value, at));
  }

  // Session close: the last minute bar of the rating's own day.
  const eod = priceAt(minuteBars.value, ratedMs + 24 * 3600_000 - 1);
  push('eod', eod);

  for (const w of DAY_WINDOWS) {
    const at = ratedMs + w.days * 24 * 3600_000;
    if (at > now) continue;
    push(w.label, priceAt(dailyBars.value, at));
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from('uw_event_price_windows')
    .upsert(rows, { onConflict: 'event_key,window_label' });
  if (error) throw new Error(error.message);
}

/**
 * Enrich a bounded batch. The caller loops until `remaining` is 0, which keeps
 * every request short enough for a serverless function and gives the UI
 * something to show progress with.
 */
export async function enrichPrices(
  eventKeys: string[],
  batchSize = 20
): Promise<EnrichResult> {
  const supabase = createAdminClient();
  const client = await UnusualWhalesClient.create();

  const { data: events, error } = await supabase
    .from('uw_analyst_ratings')
    .select('event_key, ticker, rated_at')
    .in('event_key', eventKeys.slice(0, 1000));
  if (error) throw new Error(error.message);

  // Skip ratings that already have a t0 — they're done.
  const { data: priced } = await supabase
    .from('uw_event_price_windows')
    .select('event_key')
    .eq('window_label', 't0')
    .in('event_key', eventKeys.slice(0, 1000));
  const done = new Set((priced ?? []).map((r) => r.event_key as string));

  const todo = (events ?? []).filter((e) => !done.has(e.event_key as string));
  const batch = todo.slice(0, batchSize);

  const counters = { fetched: 0, cached: 0 };
  const errors: { ticker: string; error: string }[] = [];
  let failed = 0;

  const tickers = Array.from(new Set(batch.map((e) => e.ticker as string)));
  for (const ticker of tickers) {
    try {
      await enrichTickerInfo(client, ticker, counters);
    } catch (e) {
      failed++;
      errors.push({ ticker, error: e instanceof Error ? e.message : 'info failed' });
    }
  }

  for (const e of batch) {
    try {
      await enrichEventWindows(
        client,
        {
          event_key: e.event_key as string,
          ticker: e.ticker as string,
          rated_at: e.rated_at as string,
        },
        counters
      );
    } catch (err) {
      failed++;
      errors.push({
        ticker: e.ticker as string,
        error: err instanceof Error ? err.message : 'prices failed',
      });
    }
  }

  return {
    fetched: counters.fetched,
    cached: counters.cached,
    failed,
    remaining: Math.max(0, todo.length - batch.length),
    errors: errors.slice(0, 10),
  };
}
