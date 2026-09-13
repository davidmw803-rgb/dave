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

/** A row of the research table, as `uw_research_rows` returns it. */
export interface ResearchRow {
  event_key: string;
  ticker: string;
  analyst_name: string | null;
  firm: string | null;
  recommendation: string | null;
  action: string | null;
  sector: string | null;
  target: number | null;
  rated_at: string;
  full_name: string | null;
  marketcap: number | null;
  marketcap_size: string | null;
  next_earnings_date: string | null;
  last_price: number | null;
  upside_pct: number | null;
  price_t0: number | null;
  move_1d_pct: number | null;
  move_5d_pct: number | null;
  move_30d_pct: number | null;
  tr_consensus: string | null;
  tr_analyst_count: number | null;
  tr_star_rating: number | null;
  tr_price_target: number | null;
  tr_success_rate: number | null;
  tr_avg_return: number | null;
  has_info: boolean;
  has_prices: boolean;
  has_tipranks: boolean;
}
