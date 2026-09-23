import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { UnusualWhalesClient, type OhlcBarRaw } from '@/lib/uw/client';
import { benchmarkFor } from './benchmarks';
import { TTL, callKey, getOrFetch } from './cache';
import { marketDate } from './market-time';
import { dailyWindowFor } from './ohlc-window';
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
  { label: 't+15m', minutes: 15 },
  { label: 't+30m', minutes: 30 },
  { label: 't+1h', minutes: 60 },
  { label: 't+4h', minutes: 240 },
];

/**
 * Every calendar day out to +30. The daily bars for a ticker arrive in a single
 * OHLC call covering three months, so a full daily series costs no more API
 * calls than the three windows this used to record.
 */
const DAY_WINDOWS: { label: string; days: number }[] = Array.from(
  { length: 30 },
  (_, i) => ({ label: `t+${i + 1}d`, days: i + 1 })
);

/**
 * Which windows should exist for a rating by now. Used to decide whether an
 * event still needs work: a rating priced an hour after publication is missing
 * its +1d, and should be picked up again once that day has passed.
 */
export function expectedWindows(ratedAt: string, now = Date.now()): string[] {
  const t = new Date(ratedAt).getTime();
  const labels = ['t0'];
  for (const w of WINDOWS) if (t + w.minutes * 60_000 <= now) labels.push(w.label);
  if (t + 24 * 3600_000 <= now) labels.push('eod');
  for (const w of DAY_WINDOWS) if (t + w.days * 24 * 3600_000 <= now) labels.push(w.label);
  return labels;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function barTime(bar: OhlcBarRaw): number {
  // Intraday bars carry start_time/end_time; daily and weekly bars carry a
  // plain `date` instead. Treat a dated bar as its US close (20:00 UTC).
  const t = bar.end_time ?? bar.start_time;
  if (t) return new Date(t).getTime();
  if (bar.date) return new Date(`${bar.date}T20:00:00Z`).getTime();
  return NaN;
}

/**
 * The daily feed returns a row per market session — pre, regular and post —
 * so a date can appear two or three times with different closes. Keep one row
 * per date, preferring the regular session, so "the close" is the official
 * close rather than whichever session happened to come first in the array.
 */
function oneBarPerDate(bars: OhlcBarRaw[]): OhlcBarRaw[] {
  const best = new Map<string, OhlcBarRaw>();
  for (const bar of bars) {
    const date = bar.date ?? (bar.end_time ?? bar.start_time)?.slice(0, 10);
    if (!date) continue;
    const current = best.get(date);
    if (!current || (bar.market_time === 'r' && current.market_time !== 'r')) {
      best.set(date, bar);
    }
  }
  return Array.from(best.values());
}

/** Trading date of a bar, for day-window matching. */
function barDate(bar: OhlcBarRaw): string | null {
  if (bar.date) return bar.date;
  const t = bar.end_time ?? bar.start_time;
  return t ? new Date(t).toISOString().slice(0, 10) : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}


/**
 * Close of the last session on or before `targetDate` — so a window landing on
 * a weekend or holiday resolves to the prior trading day rather than nothing.
 */
function closeOnOrBefore(
  bars: OhlcBarRaw[],
  targetDate: string
): { price: number; barAt: string } | null {
  let best: { price: number; barAt: string; date: string } | null = null;
  for (const bar of bars) {
    const date = barDate(bar);
    const price = num(bar.close);
    if (!date || price === null || date > targetDate) continue;
    if (!best || date > best.date) {
      best = { price, barAt: new Date(`${date}T20:00:00Z`).toISOString(), date };
    }
  }
  return best ? { price: best.price, barAt: best.barAt } : null;
}

/**
 * Closing price of the last bar at or before `at`. With `after` set, bars at or
 * before that time are ignored — so a window that saw no trading returns null
 * rather than repeating the anchor bar and reading as a flat 0.0% move. That
 * matters for pre- and post-market ratings, where minutes can pass with no
 * print at all.
 */
function priceAt(
  bars: OhlcBarRaw[],
  at: number,
  after?: number
): { price: number; barAt: string } | null {
  let best: OhlcBarRaw | null = null;
  let bestTime = -Infinity;
  for (const bar of bars) {
    const t = barTime(bar);
    if (!Number.isFinite(t) || t > at) continue;
    if (after !== undefined && t <= after) continue;
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
  counters: { fetched: number; cached: number },
  force = false
): Promise<void> {
  const info = await getOrFetch(
    callKey('uw', 'info', ticker),
    {
      provider: 'uw',
      endpoint: '/api/stock/{ticker}/info',
      args: { ticker },
      ttlMs: TTL.info,
      force,
    },
    () => client.stockInfo(ticker)
  );
  info.cached ? counters.cached++ : counters.fetched++;

  const quote = await getOrFetch(
    callKey('uw', 'quote', ticker),
    {
      provider: 'uw',
      endpoint: '/api/stock/{ticker}/quote',
      args: { ticker },
      ttlMs: TTL.quote,
      force,
    },
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
  event: { event_key: string; ticker: string; rated_at: string; sector: string | null },
  counters: { fetched: number; cached: number }
): Promise<void> {
  const ratedAt = new Date(event.rated_at);
  const ratedMs = ratedAt.getTime();

  // The rating's own session, in market time. A rating printed at 11:13pm ET
  // has a UTC date of the NEXT day; asking UW for that day's minute bars
  // fetched the wrong session, and resolving the day windows off it shifted
  // every one of eod/+1d../+30d forward by a session — quietly pricing the
  // rating against a close that had not happened yet when it was published.
  const day = marketDate(event.rated_at) ?? ratedAt.toISOString().slice(0, 10);

  // Intraday bars for the rating's own session, then daily bars for the drift.
  //
  // The whole session, not the last 500 minutes of it. UW returns the NEWEST
  // rows when a request is truncated, and an extended session runs about 960
  // minutes — so `limit: 500` handed back a series starting mid-afternoon, and
  // a rating published in the morning fell before its first bar. Every
  // intraday window on it then priced out blank while the pull reported
  // success. 2500 is the endpoint's documented maximum and covers any session.
  const minuteBars = await getOrFetch<OhlcBarRaw[]>(
    callKey('uw', 'ohlc', event.ticker, '1m', day),
    {
      provider: 'uw',
      endpoint: '/api/stock/{ticker}/ohlc/1m',
      args: { ticker: event.ticker, date: day, limit: 2500 },
      // A past session's bars never change.
      ttlMs: TTL.settled,
      // ...but "no bars at all" is not a past session's bars. Never settle it.
      cacheIf: (bars) => bars.length > 0,
    },
    () => client.ohlc(event.ticker, '1m', { date: day, limit: 2500 })
  );
  minuteBars.cached ? counters.cached++ : counters.fetched++;

  // The window has to reach from before the rating to +30 calendar days after
  // it. Asking for "the last 90 rows" measured from today does neither: at two
  // or three session rows per date that is only ~40 calendar days, so a rating
  // older than that has no bar at or before it and prices out as blank.
  //
  // One series per ticker-MONTH, not per rating date: six months of daily bars
  // anchored past the end of the month covers every rating in it and its +30d
  // tail, so twelve ratings on the same name in the same month cost one call
  // between them instead of twelve. That is the difference between a filter
  // finishing and a filter timing out.
  const { key: monthKey, endDate: dailyEnd } = dailyWindowFor(day);

  const dailyBars = await getOrFetch<OhlcBarRaw[]>(
    callKey('uw', 'ohlc', event.ticker, '1d', monthKey),
    {
      provider: 'uw',
      endpoint: '/api/stock/{ticker}/ohlc/1d',
      args: { ticker: event.ticker, end_date: dailyEnd, timeframe: '6M' },
      // Trailing daily bars keep arriving, so this one ages out.
      ttlMs: TTL.info,
      cacheIf: (bars) => bars.length > 0,
    },
    () =>
      client.ohlc(event.ticker, '1d', {
        end_date: dailyEnd,
        timeframe: '6M',
        limit: 2500,
      })
  );
  dailyBars.cached ? counters.cached++ : counters.fetched++;

  const daily = oneBarPerDate(dailyBars.value);

  /**
   * The benchmark's daily series, keyed exactly like the stock's — so all
   * ~4,600 priced ratings in a month share one call per fund. Twelve ETFs over
   * five months is sixty requests for the whole table, which is why this can be
   * backfilled without touching the rate limiter.
   */
  const benchTicker = benchmarkFor(event.sector);
  let benchDaily: OhlcBarRaw[] = [];
  try {
    const benchBars = await getOrFetch<OhlcBarRaw[]>(
      callKey('uw', 'ohlc', benchTicker, '1d', monthKey),
      {
        provider: 'uw',
        endpoint: '/api/stock/{ticker}/ohlc/1d',
        args: { ticker: benchTicker, end_date: dailyEnd, timeframe: '6M' },
        ttlMs: TTL.info,
        cacheIf: (bars) => bars.length > 0,
      },
      () =>
        client.ohlc(benchTicker, '1d', {
          end_date: dailyEnd,
          timeframe: '6M',
          limit: 2500,
        })
    );
    benchBars.cached ? counters.cached++ : counters.fetched++;
    benchDaily = oneBarPerDate(benchBars.value);
  } catch {
    // The benchmark is an addition, not a prerequisite. If the ETF series
    // can't be had, the rating still gets its own prices and the adjusted
    // columns stay empty — far better than failing the rating and blocking
    // the whole pipeline behind an index fund.
    benchDaily = [];
  }

  const t0 = priceAt(minuteBars.value, ratedMs) ?? priceAt(daily, ratedMs);

  // No anchor price means no row is worth writing, and — more to the point —
  // nothing worth marking as done. Stamping a rating that priced out blank is
  // what turned a transient miss into a permanently empty row: the next pass
  // saw it as current and never looked again. Fail loudly instead, so the run
  // reports it and a later run retries it (off cached bars, so retrying is
  // nearly free).
  if (!t0) {
    throw new Error(
      `no price at ${event.rated_at} — ${minuteBars.value.length} minute bars, ${daily.length} daily bars`
    );
  }

  /**
   * Same rule for the day windows. UW answered a burst of daily requests with
   * an empty series rather than an error, and because t0 had come off the
   * minute feed the rating was written and stamped as done with every one of
   * +1d..+30d blank — 1,549 ratings frozen that way, none of which would ever
   * be looked at again. An empty daily series is an upstream hiccup, not a
   * ticker with no history.
   */
  if (ratedMs + 24 * 3600_000 <= Date.now() && daily.length === 0) {
    throw new Error(
      `no daily bars for ${event.ticker} (${monthKey}) — day windows would all be blank`
    );
  }

  const t0Ms = new Date(t0.barAt).getTime();

  interface WindowRow {
    event_key: string;
    window_label: string;
    price: number | null;
    bar_at: string | null;
    pct_from_t0: number | null;
    bench_pct: number | null;
    abn_pct: number | null;
  }

  /**
   * The anchors for the sector adjustment: the last daily close at or before
   * the rating, for the stock and for its benchmark. Both legs are measured
   * close-to-close from here, which is the only way the difference means
   * anything — the ETF has no intraday bar to match `t0` against, so
   * `abn_pct` is deliberately NOT `pct_from_t0` minus `bench_pct`.
   */
  const stockAnchor = priceAt(daily, ratedMs);
  const benchAnchor = priceAt(benchDaily, ratedMs);

  const adjusted = (
    targetDate: string
  ): { bench: number | null; abn: number | null } => {
    if (!stockAnchor || !benchAnchor || stockAnchor.price <= 0 || benchAnchor.price <= 0) {
      return { bench: null, abn: null };
    }
    const stockAt = closeOnOrBefore(daily, targetDate);
    const benchAt = closeOnOrBefore(benchDaily, targetDate);
    if (!stockAt || !benchAt) return { bench: null, abn: null };
    const benchPct = ((benchAt.price - benchAnchor.price) / benchAnchor.price) * 100;
    const stockPct = ((stockAt.price - stockAnchor.price) / stockAnchor.price) * 100;
    return { bench: benchPct, abn: stockPct - benchPct };
  };

  const rows: WindowRow[] = [
    {
      event_key: event.event_key,
      window_label: 't0',
      price: t0.price,
      bar_at: t0.barAt,
      pct_from_t0: 0,
      bench_pct: 0,
      abn_pct: 0,
    },
  ];

  /**
   * Every elapsed window gets a row, even when nothing traded — a row with a
   * null price records "we looked and there was no print", which reads as `—`
   * in the table exactly like a missing row would. Writing nothing instead
   * leaves the window permanently outstanding, so the enrichment loop keeps
   * picking the rating up and never finishes.
   */
  const push = (
    label: string,
    hit: { price: number; barAt: string } | null,
    adj: { bench: number | null; abn: number | null } = { bench: null, abn: null }
  ) => {
    rows.push({
      event_key: event.event_key,
      window_label: label,
      price: hit?.price ?? null,
      bar_at: hit?.barAt ?? null,
      pct_from_t0:
        hit && t0.price > 0 ? ((hit.price - t0.price) / t0.price) * 100 : null,
      bench_pct: adj.bench,
      abn_pct: adj.abn,
    });
  };

  const now = Date.now();
  for (const w of WINDOWS) {
    const at = ratedMs + w.minutes * 60_000;
    if (at > now) continue; // Not yet in the past — leave it for a later run.
    push(w.label, priceAt(minuteBars.value, at, t0Ms));
  }

  // EOD is the official close of the rating's own session, taken from the daily
  // bar — not the last post-market print, which is what the minute feed ends on.
  const ratedDate = day;
  if (ratedMs + 24 * 3600_000 <= now) {
    push('eod', closeOnOrBefore(daily, ratedDate), adjusted(ratedDate));
  }

  for (const w of DAY_WINDOWS) {
    const at = ratedMs + w.days * 24 * 3600_000;
    if (at > now) continue;
    const at_ = addDays(ratedDate, w.days);
    push(w.label, closeOnOrBefore(daily, at_), adjusted(at_));
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from('uw_event_price_windows')
    .upsert(rows, { onConflict: 'event_key,window_label' });
  if (error) throw new Error(error.message);

  // Stamp the rating so the next pass can tell it is current without reading
  // its window rows back, and keep the anchor price on the rating itself: the
  // table's view reads it from here rather than aggregating the window table,
  // which is what stopped a single page costing a scan of every window row.
  const { error: stampError } = await supabase
    .from('uw_analyst_ratings')
    .update({
      windows_pulled_at: new Date().toISOString(),
      price_t0: t0.price,
      bench_ticker: benchTicker,
    })
    .eq('event_key', event.event_key);
  if (stampError) throw new Error(stampError.message);
}

/**
 * Enrich a bounded slice of work.
 *
 * Bounded by TIME as well as count: each rating needs two OHLC calls plus a
 * write, and when the database is busy a batch of twenty can outlast the
 * serverless function's own ceiling — the request dies mid-batch, the client
 * sees a gateway error with no JSON in it, and the progress bar reports
 * nothing even though work was done. Returning early with an accurate
 * `remaining` keeps every pass short and every number honest.
 *
 * The slice is chosen by the database (`research_outstanding_events`), not
 * here. The previous version read every selected key back a hundred at a time
 * and filtered in JavaScript — twenty round trips per pass for a thousand
 * rows, before a single price was fetched — and then reported progress as a
 * count the caller could only guess against. Now the caller gets the keys that
 * actually finished, so it can shrink its own list and stop for certain.
 */
export async function enrichPrices(
  eventKeys: string[],
  batchSize = 150,
  force = false,
  budgetMs = 45_000
): Promise<EnrichResult> {
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > budgetMs;
  const supabase = createAdminClient();
  const client = await UnusualWhalesClient.create();

  interface EventRow {
    event_key: string;
    ticker: string;
    rated_at: string;
    sector: string | null;
  }

  // `force` re-prices rows that are already current, so it cannot use the
  // outstanding-work query — take the head of the caller's own list instead.
  let batch: EventRow[];
  let outstanding: number;
  if (force) {
    const keys = eventKeys.slice(0, batchSize);
    const { data, error } = await supabase
      .from('uw_analyst_ratings')
      .select('event_key, ticker, rated_at, sector')
      .in('event_key', keys);
    if (error) throw new Error(error.message);
    batch = (data ?? []) as EventRow[];
    outstanding = eventKeys.length;
  } else {
    // Two queries rather than one carrying the total on every row: the
    // correlated count made the batch query materialise every outstanding
    // rating before the limit could take a slice of it, which cost ten seconds
    // of a forty-five second pass before any price was fetched.
    const [batchResult, countResult] = await Promise.all([
      supabase.rpc('research_outstanding_events', {
        p_keys: eventKeys,
        p_limit: batchSize,
      }),
      supabase.rpc('research_outstanding_count', { p_keys: eventKeys }),
    ]);
    if (batchResult.error) throw new Error(batchResult.error.message);
    if (countResult.error) throw new Error(countResult.error.message);
    batch = (batchResult.data ?? []) as EventRow[];
    outstanding = Number(countResult.data ?? 0);
  }

  const counters = { fetched: 0, cached: 0 };
  const errors: { ticker: string; error: string }[] = [];
  const processedKeys: string[] = [];
  const failedKeys: string[] = [];
  let failed = 0;

  /**
   * Company facts and the last quote, at most once per ticker per pass and
   * only when what we already hold has gone stale. The quote's own cache entry
   * lives for a minute, so without this gate every pass refetched a quote for
   * every ticker in the batch — a thousand-row filter spent more of its API
   * budget on quotes it already had than on the prices it was asked for, and
   * spent it into the rate limiter.
   */
  const INFO_MAX_AGE_MS = 15 * 60 * 1000;
  const fresh = new Set<string>();
  if (!force) {
    const tickers = Array.from(new Set(batch.map((e) => e.ticker)));
    for (let i = 0; i < tickers.length; i += 200) {
      const { data } = await supabase
        .from('uw_ticker_info')
        .select('ticker, updated_at')
        .in('ticker', tickers.slice(i, i + 200));
      for (const row of (data ?? []) as { ticker: string; updated_at: string | null }[]) {
        if (row.updated_at && Date.now() - new Date(row.updated_at).getTime() < INFO_MAX_AGE_MS) {
          fresh.add(row.ticker);
        }
      }
    }
  }

  const infoOnce = new Map<string, Promise<void>>();
  const ensureInfo = (ticker: string): Promise<void> => {
    if (fresh.has(ticker)) return Promise.resolve();
    let pending = infoOnce.get(ticker);
    if (!pending) {
      pending = enrichTickerInfo(client, ticker, counters, force).catch((err) => {
        // Missing company facts must not cost the rating its prices — record
        // the problem and carry on into the windows, which is what was asked
        // for.
        errors.push({
          ticker,
          error: err instanceof Error ? err.message : 'info failed',
        });
      });
      infoOnce.set(ticker, pending);
    }
    return pending;
  };

  // A few ratings in flight at once. Each is mostly waiting on the API, so
  // this is where the throughput comes from — but kept low enough to stay
  // polite to the rate limiter, which is the real ceiling.
  const CONCURRENCY = 6;
  const queue = [...batch];

  const worker = async (): Promise<void> => {
    while (queue.length > 0 && !outOfTime()) {
      const e = queue.shift();
      if (!e) return;

      await ensureInfo(e.ticker);

      try {
        await enrichEventWindows(
          client,
          {
            event_key: e.event_key,
            ticker: e.ticker,
            rated_at: e.rated_at,
            sector: e.sector,
          },
          counters
        );
        processedKeys.push(e.event_key);
      } catch (err) {
        failed++;
        failedKeys.push(e.event_key);
        errors.push({
          ticker: e.ticker,
          error: err instanceof Error ? err.message : 'prices failed',
        });
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return {
    fetched: counters.fetched,
    cached: counters.cached,
    failed,
    // Count what actually finished, not what was selected — a pass cut short
    // by the budget must not report the whole batch as done.
    remaining: Math.max(0, outstanding - processedKeys.length),
    processedKeys,
    failedKeys,
    errors: errors.slice(0, 10),
  };
}
