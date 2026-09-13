import type { CombinedSignal, TrConsensus, UwSentiment } from './types';

type BadgeVariant = 'default' | 'success' | 'danger' | 'neutral' | 'warning';

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `$${fmtNum(n, 2)}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${fmtNum(n, digits)}%`;
}

/** Unsigned percentage — for rates that are never negative (success rate, IV rank). */
export function fmtRate(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${fmtNum(n, digits)}%`;
}

/** Compact signed USD: -$1.2M, $840K, $12.3K. */
export function fmtPremium(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '+';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${sign}$${fmtNum(abs / 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) return `${sign}$${fmtNum(abs / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${sign}$${fmtNum(abs / 1_000, 1)}K`;
  return `${sign}$${fmtNum(abs, 0)}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function signColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'text-neutral-500';
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-neutral-300';
}

/** Composite score 0-100 → colour band. */
export function scoreColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'text-neutral-500';
  if (n >= 75) return 'text-emerald-400';
  if (n >= 50) return 'text-amber-400';
  if (n >= 25) return 'text-orange-400';
  return 'text-red-400';
}

const SIGNAL_LABEL: Record<CombinedSignal, string> = {
  aligned_bull: 'Aligned bull',
  aligned_bear: 'Aligned bear',
  divergent: 'Divergent',
  neutral: 'Neutral',
};

const SIGNAL_VARIANT: Record<CombinedSignal, BadgeVariant> = {
  aligned_bull: 'success',
  aligned_bear: 'danger',
  divergent: 'warning',
  neutral: 'neutral',
};

export function signalLabel(s: CombinedSignal | null): string {
  return s ? SIGNAL_LABEL[s] : '—';
}

export function signalVariant(s: CombinedSignal | null): BadgeVariant {
  return s ? SIGNAL_VARIANT[s] : 'neutral';
}

const CONSENSUS_LABEL: Record<TrConsensus, string> = {
  strong_buy: 'Strong Buy',
  buy: 'Buy',
  hold: 'Hold',
  sell: 'Sell',
  strong_sell: 'Strong Sell',
};

const CONSENSUS_VARIANT: Record<TrConsensus, BadgeVariant> = {
  strong_buy: 'success',
  buy: 'success',
  hold: 'neutral',
  sell: 'danger',
  strong_sell: 'danger',
};

export function consensusLabel(c: TrConsensus | null): string {
  return c ? CONSENSUS_LABEL[c] : '—';
}

export function consensusVariant(c: TrConsensus | null): BadgeVariant {
  return c ? CONSENSUS_VARIANT[c] : 'neutral';
}

const SENTIMENT_VARIANT: Record<UwSentiment, BadgeVariant> = {
  bullish: 'success',
  bearish: 'danger',
  neutral: 'neutral',
};

export function sentimentLabel(s: UwSentiment | null): string {
  if (!s) return '—';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function sentimentVariant(s: UwSentiment | null): BadgeVariant {
  return s ? SENTIMENT_VARIANT[s] : 'neutral';
}

/** 0-5 stars, half-star aware. */
export function starsFor(rating: number | null | undefined): string {
  if (rating === null || rating === undefined || !Number.isFinite(rating)) return '—';
  const clamped = Math.max(0, Math.min(5, rating));
  const full = Math.floor(clamped);
  const half = clamped - full >= 0.5;
  return '★'.repeat(full) + (half ? '⯨' : '') + '☆'.repeat(5 - full - (half ? 1 : 0));
}
