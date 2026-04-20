export type Side = 'YES' | 'NO';
export type Status = 'OPEN' | 'PENDING' | 'CLOSED' | 'FAILED';
export type ExitReason = 'TP' | 'STOP' | 'CLOSE' | null;

export interface LiveTrade {
  id: number | string;
  strategy: string;
  side_token: Side | null;
  entry_price: number | null;
  exit_price: number | null;
  entry_ts: string | null;
  exit_ts: string | null;
  pnl_per_share: number | null;
  net_pnl_usd: number | null;
  status: Status;
  entry_amount_usd: number | null;
  exit_reason: ExitReason;
  slug: string | null;
  error_message: string | null;
  dry_run: boolean;
}

export interface PaperTrade {
  id: number | string;
  strategy: string;
  side_token: Side | null;
  entry_price: number | null;
  exit_price: number | null;
  entry_ts: string | null;
  exit_ts: string | null;
  pnl_per_share: number | null;
  exit_reason: ExitReason;
  status: Status;
  slug: string | null;
}

export interface Totals {
  net_pnl_usd: number;
  trades: number;
  wins: number;
  win_rate_pct: number | null;
}

export interface StrategyRow {
  strategy: string;
  open: number;
  closed_24h: number;
  wins_24h: number;
  win_rate_pct: number | null;
  net_pnl_usd: number;
  losing_streak: number;
}

export interface HomeData {
  today: Totals;
  last7d: Totals;
  allTime: Totals;
  strategies: StrategyRow[];
  openPositions: LiveTrade[];
  losingStreakStrategies: string[];
  generatedAt: string;
}

export interface TradesData {
  trades: (LiveTrade | PaperTrade)[];
  strategies: string[];
  generatedAt: string;
}

export interface PaperRow {
  strategy: string;
  trades: number;
  wins: number;
  win_rate_pct: number | null;
  total_pnl_per_share: number;
  avg_pnl_per_share: number | null;
}

export interface PaperData {
  rows: PaperRow[];
  generatedAt: string;
}

export interface HaltRow {
  id: number | string;
  strategy: string;
  slug: string | null;
  error_message: string | null;
  entry_ts: string | null;
}

export interface HaltsData {
  rows: HaltRow[];
  generatedAt: string;
}
