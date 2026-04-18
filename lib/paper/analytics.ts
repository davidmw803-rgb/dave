import type { PaperTrade } from './types';

export interface RollingWinRatePoint {
  idx: number;
  rate: number;
}

export interface RollingAvgPoint {
  idx: number;
  avg: number;
}

export interface HistogramBin {
  bin: number;
  count: number;
}

export interface StcBucket {
  label: string;
  trades: number;
  wins: number;
  winRatePct: number | null;
  avgPnl: number | null;
}

const ROLLING_WINDOW = 50;

export function rollingWinRate(trades: PaperTrade[]): RollingWinRatePoint[] {
  if (trades.length < ROLLING_WINDOW) return [];
  const out: RollingWinRatePoint[] = [];
  let winsInWindow = 0;
  for (let i = 0; i < trades.length; i++) {
    if ((trades[i].pnl_per_share ?? 0) > 0) winsInWindow++;
    if (i >= ROLLING_WINDOW) {
      if ((trades[i - ROLLING_WINDOW].pnl_per_share ?? 0) > 0) winsInWindow--;
    }
    if (i >= ROLLING_WINDOW - 1) {
      out.push({ idx: i + 1, rate: (winsInWindow / ROLLING_WINDOW) * 100 });
    }
  }
  return out;
}

export function rollingAvgPnl(trades: PaperTrade[]): RollingAvgPoint[] {
  if (trades.length < ROLLING_WINDOW) return [];
  const out: RollingAvgPoint[] = [];
  let sumInWindow = 0;
  for (let i = 0; i < trades.length; i++) {
    sumInWindow += trades[i].pnl_per_share ?? 0;
    if (i >= ROLLING_WINDOW) {
      sumInWindow -= trades[i - ROLLING_WINDOW].pnl_per_share ?? 0;
    }
    if (i >= ROLLING_WINDOW - 1) {
      out.push({ idx: i + 1, avg: sumInWindow / ROLLING_WINDOW });
    }
  }
  return out;
}

export function pnlHistogram(trades: PaperTrade[], binSize = 0.02): HistogramBin[] {
  const bins = new Map<number, number>();
  for (const t of trades) {
    const p = t.pnl_per_share;
    if (p === null || !Number.isFinite(p)) continue;
    const bin = Math.floor(p / binSize) * binSize;
    const key = Number(bin.toFixed(4));
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  return Array.from(bins.entries())
    .map(([bin, count]) => ({ bin, count }))
    .sort((a, b) => a.bin - b.bin);
}

export function stcBuckets(trades: PaperTrade[]): StcBucket[] {
  const buckets: { label: string; min: number; max: number }[] = [
    { label: '120–180s', min: 120, max: 180 },
    { label: '180–240s', min: 180, max: 240 },
    { label: '240+ s', min: 240, max: Infinity },
  ];
  return buckets.map((b) => {
    let count = 0;
    let wins = 0;
    let sum = 0;
    for (const t of trades) {
      const stc = t.entry_stc;
      if (stc === null || stc === undefined) continue;
      if (stc < b.min || stc >= b.max) continue;
      count++;
      if ((t.pnl_per_share ?? 0) > 0) wins++;
      sum += t.pnl_per_share ?? 0;
    }
    return {
      label: b.label,
      trades: count,
      wins,
      winRatePct: count > 0 ? (wins / count) * 100 : null,
      avgPnl: count > 0 ? sum / count : null,
    };
  });
}
