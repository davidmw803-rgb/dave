export type Side = 'YES' | 'NO';
export type ExitReason = 'TP' | 'STOP' | 'CLOSE';
export type Status = 'OPEN' | 'CLOSED';

export interface PaperTrade {
  id: number;
  strategy: string;
  condition_id: string;
  slug: string;
  asset_id: string;
  side_token: Side;
  entry_price: number;
  entry_ts: string;
  entry_stc: number | null;
  stop_price: number | null;
  target_price: number | null;
  size_shares: number;
  exit_price: number | null;
  exit_reason: ExitReason | null;
  exit_ts: string | null;
  exit_stc: number | null;
  pnl_per_share: number | null;
  status: Status;
}

export interface PaperSummary {
  strategy: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate_pct: number | null;
  avg_pnl_per_share: number | null;
  total_pnl_dollars: number | null;
  open_now: number;
  first_trade: string | null;
  last_trade: string | null;
}

export interface TradeDetailed {
  asset_id: string;
  slug: string | null;
  mid_before: number | null;
  price: number | null;
  seconds_to_close: number | null;
  event_ts: string;
}

export interface LiveMid {
  asset_id: string;
  mid_before: number | null;
  price: number | null;
  event_ts: string | null;
}
