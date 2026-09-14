export const RATING_ACTIONS = [
  'initiated',
  'reiterated',
  'downgraded',
  'upgraded',
  'maintained',
] as const;

export const RECOMMENDATIONS = ['buy', 'hold', 'sell'] as const;

export type RatingAction = (typeof RATING_ACTIONS)[number];
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/** What the pull form sends. Tier 1 goes to UW; tier 2 is applied on our rows. */
export interface PullFilters {
  // Tier 1 — sent to UW
  tickers?: string[];            // one call each; empty means market-wide
  action?: RatingAction;
  recommendation?: Recommendation;
  newerThan?: string;            // ISO date
  olderThan?: string;            // ISO date
  maxRows?: number;              // stop after this many (paginates by time)
}

export interface PullResult {
  runId: string;
  apiCalls: number;
  rowsFetched: number;
  rowsNew: number;
  tickers: string[];
}

export interface EnrichResult {
  fetched: number;
  cached: number;
  failed: number;
  remaining: number;
  errors: { ticker: string; error: string }[];
}

/** The intraday windows around a rating, in table order. */
export const INTRADAY_WINDOWS = [
  't+1m',
  't+5m',
  't+15m',
  't+30m',
  't+1h',
  't+4h',
  'eod',
] as const;

/** Every calendar day out to +30. */
export const DAY_WINDOWS = Array.from(
  { length: 30 },
  (_, i) => `t+${i + 1}d`
) as readonly string[];

/** Every window we measure around a rating, in table order. */
export const MOVE_WINDOWS: readonly string[] = [...INTRADAY_WINDOWS, ...DAY_WINDOWS];

export type MoveWindow = string;

export interface MoveCell {
  price: number | null;
  pct: number | null;
}

/** A row of the research table, as `uw_research_rows` returns it. */
export interface ResearchRow {
  event_key: string;
  ticker: string;
  analyst_name: string | null;
  firm: string | null;
  analyst_key: string | null;
  recommendation: string | null;
  action: string | null;
  sector: string | null;
  target: number | null;
  rated_at: string;
  full_name: string | null;
  marketcap: number | null;
  marketcap_size: string | null;
  next_earnings_date: string | null;
  price_at_rating: number | null;
  current_price: number | null;
  current_price_at: string | null;
  upside_pct: number | null;
  move_since_rating_pct: number | null;
  moves: Record<string, MoveCell | undefined> | null;
  analyst_ratings_count: number | null;
  analyst_avg_move_1d: number | null;
  analyst_win_rate_1d: number | null;
  analyst_avg_upside: number | null;
  analyst_scored_ratings: number | null;
  analyst_stats_updated_at: string | null;
  analyst_tr_star_rating: number | null;
  analyst_tr_success_rate: number | null;
  analyst_tr_avg_return: number | null;
  tr_consensus: string | null;
  tr_analyst_count: number | null;
  tr_star_rating: number | null;
  tr_price_target: number | null;
  tr_success_rate: number | null;
  tr_avg_return: number | null;
  has_info: boolean;
  has_prices: boolean;
  has_tipranks: boolean;
  has_analyst: boolean;
}
