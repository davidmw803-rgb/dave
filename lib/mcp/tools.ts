import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { pullRatings } from '@/lib/research/pull';
import { enrichPrices } from '@/lib/research/enrich-prices';
import { refreshAnalystStats } from '@/lib/research/analysts';
import { RATING_ACTIONS, RECOMMENDATIONS, MOVE_WINDOWS } from '@/lib/research/types';
import type { McpTool } from './protocol';

/**
 * The tools Claude gets over MCP.
 *
 * Read tools answer questions; action tools spend Unusual Whales quota and
 * write to the database. Both kinds are deliberately BOUNDED — `enrich_prices`
 * runs a single pass and reports what is left rather than looping internally,
 * so every call fits inside a serverless function's ceiling and the caller can
 * stop between passes. Nothing here deletes anything.
 */

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function int(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.round(n), min), max);
}
function tickerList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.filter((t): t is string => typeof t === 'string').map((t) => t.toUpperCase());
    return out.length ? out : undefined;
  }
  const s = str(v);
  if (!s) return undefined;
  const out = s.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  return out.length ? out : undefined;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  const s = str(v);
  return allowed.find((a) => a === s);
}

const FILTER_PROPS = {
  from: { type: 'string', description: 'ISO date, inclusive lower bound on the rating timestamp.' },
  to: { type: 'string', description: 'ISO date, exclusive upper bound.' },
  action: { type: 'string', enum: [...RATING_ACTIONS], description: 'Rating action.' },
  rating: { type: 'string', enum: [...RECOMMENDATIONS], description: 'buy / hold / sell.' },
  tickers: {
    type: 'array',
    items: { type: 'string' },
    description: 'Restrict to these tickers.',
  },
} as const;

function filterArgs(a: Record<string, unknown>) {
  return {
    p_from: str(a.from) ? `${str(a.from)}T00:00:00Z` : null,
    p_to: str(a.to) ? `${str(a.to)}T00:00:00Z` : null,
    p_action: oneOf(a.action, RATING_ACTIONS) ?? null,
    p_rating: oneOf(a.rating, RECOMMENDATIONS) ?? null,
    p_tickers: tickerList(a.tickers) ?? null,
  };
}

export function buildTools(): McpTool[] {
  return [
    {
      name: 'get_status',
      title: 'Research table status',
      description:
        'How much data is loaded and how much still needs work: total ratings, how many are priced, how many carry sector-adjusted returns, how many are outstanding, and the date range covered. Call this first — it tells you whether an analysis will have anything to work with.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const db = createAdminClient();
        const [total, priced, benched, outstanding, range] = await Promise.all([
          db.from('uw_analyst_ratings').select('*', { count: 'exact', head: true }),
          db.from('uw_analyst_ratings').select('*', { count: 'exact', head: true })
            .not('price_t0', 'is', null),
          db.from('uw_analyst_ratings').select('*', { count: 'exact', head: true })
            .not('bench_ticker', 'is', null),
          db.from('uw_analyst_ratings').select('*', { count: 'exact', head: true })
            .is('windows_pulled_at', null),
          db.from('uw_analyst_ratings').select('rated_at')
            .order('rated_at', { ascending: true }).limit(1),
        ]);
        const newest = await db.from('uw_analyst_ratings').select('rated_at')
          .order('rated_at', { ascending: false }).limit(1);

        return {
          ratings: total.count ?? 0,
          priced: priced.count ?? 0,
          sector_adjusted: benched.count ?? 0,
          outstanding_for_enrichment: outstanding.count ?? 0,
          earliest_rating: range.data?.[0]?.rated_at ?? null,
          latest_rating: newest.data?.[0]?.rated_at ?? null,
          note:
            'sector_adjusted counts ratings with a benchmark assigned. If it is 0 but priced is not, enrich_prices has not run since the benchmark feature shipped.',
        };
      },
    },

    {
      name: 'summarize_returns',
      title: 'Aggregate forward returns',
      description:
        "Mean and median forward return for one window, grouped by a dimension. This is the main analysis tool — prefer it over pulling raw rows. Returns both the raw move and the sector-adjusted one (`abn`), plus n for each bucket. IMPORTANT when reading the output: the windows overlap heavily and ratings cluster on dates, so treat the spread as indicative, not as a significance test; and `mean_raw_pct` is not comparable across time periods because each was graded against a different market — use `mean_abn_pct` for that.",
      inputSchema: {
        type: 'object',
        properties: {
          window: {
            type: 'string',
            enum: [...MOVE_WINDOWS],
            description: 'Which forward window, e.g. t+1d, t+5d, t+20d, eod.',
          },
          group_by: {
            type: 'string',
            enum: ['none', 'sector', 'action', 'rating', 'firm', 'analyst', 'weekday', 'session', 'mcap'],
            description: 'Dimension to group by. "none" gives one overall row.',
          },
          min_n: {
            type: 'number',
            description: 'Drop buckets with fewer than this many observations. Default 1; raise it to avoid reading noise off thin cells.',
          },
          ...FILTER_PROPS,
        },
      },
      handler: async (a) => {
        const db = createAdminClient();
        const { data, error } = await db.rpc('research_summary', {
          p_window: str(a.window) ?? 't+5d',
          p_group_by: str(a.group_by) ?? 'none',
          p_min_n: int(a.min_n, 1, 1, 100000),
          ...filterArgs(a),
        });
        if (error) throw new Error(error.message);
        return { window: str(a.window) ?? 't+5d', rows: data ?? [] };
      },
    },

    {
      name: 'query_ratings',
      title: 'Fetch rating rows',
      description:
        'Individual rating rows with their forward returns, newest first. Use this to inspect specific names or spot-check something summarize_returns showed; it is capped and not the way to do aggregate analysis.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Rows to return, max 200.' },
          ...FILTER_PROPS,
        },
      },
      handler: async (a) => {
        const db = createAdminClient();
        const f = filterArgs(a);
        const { data, error } = await db.rpc('research_rows_page', {
          ...f,
          p_event_keys: null,
          p_cursor_rated_at: null,
          p_cursor_event_key: null,
          p_limit: int(a.limit, 50, 1, 200),
        });
        if (error) throw new Error(error.message);
        type Row = Record<string, unknown> & { moves?: Record<string, { pct?: number; abn?: number }> };
        // Trim to what is worth reading: the full row carries 38 windows plus
        // analyst and TipRanks columns, which is a lot of tokens per row.
        return {
          rows: ((data ?? []) as Row[]).map((r) => ({
            ticker: r.ticker,
            rated_at: r.rated_at,
            analyst: r.analyst_name,
            firm: r.firm,
            action: r.action,
            rating: r.recommendation,
            sector: r.sector,
            benchmark: r.bench_ticker,
            price_at_rating: r.price_at_rating,
            target: r.target,
            move_1d: r.moves?.['t+1d']?.pct ?? null,
            move_5d: r.moves?.['t+5d']?.pct ?? null,
            move_20d: r.moves?.['t+20d']?.pct ?? null,
            abn_1d: r.moves?.['t+1d']?.abn ?? null,
            abn_5d: r.moves?.['t+5d']?.abn ?? null,
            abn_20d: r.moves?.['t+20d']?.abn ?? null,
          })),
        };
      },
    },

    {
      name: 'pull_ratings',
      title: 'Pull new ratings from Unusual Whales',
      description:
        'Fetch analyst ratings from the Unusual Whales screener and store any that are new. Spends UW API quota. Ratings already held are recognised by content and not duplicated, so re-running an overlapping range is safe.',
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          max_rows: { type: 'number', description: 'Upper bound on rows fetched, default 5000.' },
          ...FILTER_PROPS,
        },
      },
      handler: async (a) => {
        const result = await pullRatings({
          tickers: tickerList(a.tickers)?.slice(0, 25),
          action: oneOf(a.action, RATING_ACTIONS),
          recommendation: oneOf(a.rating, RECOMMENDATIONS),
          newerThan: str(a.from),
          olderThan: str(a.to),
          maxRows: int(a.max_rows, 5000, 1, 50000),
        });
        return result;
      },
    },

    {
      name: 'enrich_prices',
      title: 'Price one batch of ratings',
      description:
        'Fetch prices and sector-adjusted returns for a batch of outstanding ratings. Runs ONE bounded pass and returns `remaining`; call it repeatedly until `remaining` is 0. Each pass is capped at about 45 seconds and spends UW quota. Stop and report if `failed` climbs on consecutive passes rather than looping indefinitely.',
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          batch_size: { type: 'number', description: 'Ratings per pass, 1-500, default 150.' },
          ...FILTER_PROPS,
        },
      },
      handler: async (a) => {
        const db = createAdminClient();
        // Which ratings this pass is allowed to touch: the filter, or the whole
        // table when no filter is given.
        const f = filterArgs(a);
        let q = db.from('uw_analyst_ratings').select('event_key');
        if (f.p_from) q = q.gte('rated_at', f.p_from);
        if (f.p_to) q = q.lt('rated_at', f.p_to);
        if (f.p_action) q = q.eq('action', f.p_action);
        if (f.p_rating) q = q.eq('recommendation', f.p_rating);
        if (f.p_tickers) q = q.in('ticker', f.p_tickers);

        const keys: string[] = [];
        for (let offset = 0; ; offset += 1000) {
          const { data, error } = await q.range(offset, offset + 999);
          if (error) throw new Error(error.message);
          const batch = (data ?? []).map((r) => r.event_key as string);
          keys.push(...batch);
          if (batch.length < 1000) break;
        }
        if (keys.length === 0) return { fetched: 0, cached: 0, failed: 0, remaining: 0, scope: 0 };

        const result = await enrichPrices(keys, int(a.batch_size, 150, 1, 500), false, 45_000);
        return {
          scope: keys.length,
          fetched: result.fetched,
          cached: result.cached,
          failed: result.failed,
          priced_this_pass: result.processedKeys?.length ?? 0,
          remaining: result.remaining,
          errors: result.errors,
        };
      },
    },

    {
      name: 'refresh_analyst_stats',
      title: 'Recompute analyst statistics',
      description:
        'Recompute per-analyst rating counts, win rates and average moves from the prices currently held. No API calls — pure recomputation over data already stored. Worth running after a batch of enrichment.',
      destructive: true,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => refreshAnalystStats(),
    },
  ];
}
