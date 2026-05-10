export type LiveTradeStatus =
  | 'OPEN'
  | 'CLOSED'
  | 'PENDING'
  | 'FAILED'
  | 'RESOLVED_AT_EXPIRY';

export type LiveExitReason = 'TP' | 'STOP' | 'EXPIRY' | 'CLOSE' | 'MANUAL';

export interface LiveTrade {
  id: number;
  strategy: string;
  side_token: 'YES' | 'NO' | string;
  entry_price: number | null;
  entry_ts: string;
  entry_amount_usd: number;
  exit_price: number | null;
  exit_ts: string | null;
  exit_reason: LiveExitReason | string | null;
  net_pnl_usd: number | null;
  status: LiveTradeStatus | string;
  slug: string;
}

export interface KillSwitch {
  scope: string;
  halted: boolean;
  reason: string | null;
  updated_at: string;
}

export const STRATEGY = 'momentum_55_live_v1';
