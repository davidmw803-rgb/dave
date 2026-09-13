export type UwSentiment = 'bullish' | 'bearish' | 'neutral';

export type TrConsensus = 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';

export type CombinedSignal = 'aligned_bull' | 'aligned_bear' | 'divergent' | 'neutral';

/** One row of the Unusual Whales x TipRanks table (`uw_tipranks_analysis`). */
export interface UwTipranksRow {
  id: string;
  ticker: string;
  company: string | null;
  sector: string | null;
  price: number | null;

  // Unusual Whales
  uw_sentiment: UwSentiment | null;
  uw_net_premium: number | null;
  uw_call_put_ratio: number | null;
  uw_unusual_score: number | null;
  uw_iv_rank: number | null;
  uw_dark_pool_pct: number | null;

  // TipRanks
  tr_consensus: TrConsensus | null;
  tr_analyst_count: number | null;
  tr_star_rating: number | null;
  tr_price_target: number | null;
  tr_upside_pct: number | null;
  tr_success_rate: number | null;
  tr_avg_return: number | null;

  // Combined
  composite_score: number | null;
  signal: CombinedSignal | null;
  notes: string | null;
  as_of: string;
}

export type StockSortKey =
  | 'ticker'
  | 'composite_score'
  | 'tr_upside_pct'
  | 'uw_net_premium'
  | 'uw_unusual_score'
  | 'tr_success_rate'
  | 'as_of';

export type SortDir = 'asc' | 'desc';

export interface StockAnalysisFilters {
  search: string;
  sector: string;
  signals: CombinedSignal[];
  consensus: string;
  minScore: string;
  sort: { key: StockSortKey; dir: SortDir };
}

export const SIGNALS: CombinedSignal[] = [
  'aligned_bull',
  'divergent',
  'neutral',
  'aligned_bear',
];

export const CONSENSUS_OPTIONS: TrConsensus[] = [
  'strong_buy',
  'buy',
  'hold',
  'sell',
  'strong_sell',
];
