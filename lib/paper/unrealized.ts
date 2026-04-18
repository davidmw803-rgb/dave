import type { PaperTrade, LiveMid, Side } from './types';

export function unrealizedPerShare(
  side: Side,
  entryPrice: number,
  currentMid: number | null | undefined
): number | null {
  if (currentMid === null || currentMid === undefined || !Number.isFinite(currentMid)) return null;
  // YES: profit = current - entry. NO (held as 1 - price): profit = entry - current.
  return side === 'YES' ? currentMid - entryPrice : entryPrice - currentMid;
}

export function unrealizedDollars(trade: PaperTrade, mid: number | null | undefined): number | null {
  const perShare = unrealizedPerShare(trade.side_token, trade.entry_price, mid);
  if (perShare === null) return null;
  return perShare * trade.size_shares;
}

export function combinedUnrealized(
  trades: PaperTrade[],
  mids: Record<string, LiveMid | undefined>
): number {
  let total = 0;
  for (const t of trades) {
    if (t.status !== 'OPEN') continue;
    const mid = mids[t.asset_id]?.mid_before ?? mids[t.asset_id]?.price ?? null;
    const d = unrealizedDollars(t, mid);
    if (d !== null) total += d;
  }
  return total;
}
