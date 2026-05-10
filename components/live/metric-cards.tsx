'use client';

import { cn } from '@/lib/utils';
import type { LiveTrade } from '@/lib/live/types';
import { formatPct, formatUsd } from '@/lib/live/format';

interface MetricCardsProps {
  trades: LiveTrade[] | undefined;
  loading: boolean;
}

interface Card {
  label: string;
  value: string;
  sub?: string;
  tone?: 'positive' | 'negative' | 'neutral';
}

function startOfUtcToday(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

function computeCards(trades: LiveTrade[]): Card[] {
  const todayMs = startOfUtcToday();
  const todayTrades = trades.filter((t) => new Date(t.entry_ts).getTime() >= todayMs);
  const closedToday = todayTrades.filter((t) => t.status === 'CLOSED');

  const wins = closedToday.filter((t) => t.exit_reason === 'TP').length;
  const losses = closedToday.filter((t) => t.exit_reason === 'STOP').length;
  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : null;

  const pnlToday = closedToday.reduce(
    (acc, t) => acc + (typeof t.net_pnl_usd === 'number' ? t.net_pnl_usd : 0),
    0
  );

  const open = trades.filter((t) => t.status === 'OPEN').length;

  return [
    {
      label: 'Trades today',
      value: String(todayTrades.length),
      sub: `${closedToday.length} closed`,
    },
    {
      label: 'Win rate today',
      value: winRate === null ? '—' : formatPct(winRate, 0),
      sub: decided > 0 ? `${wins}W / ${losses}L` : 'no decisions yet',
    },
    {
      label: 'Net P&L today',
      value: formatUsd(pnlToday, { signed: true }),
      tone: pnlToday > 0 ? 'positive' : pnlToday < 0 ? 'negative' : 'neutral',
      sub: closedToday.length === 0 ? 'no closes yet' : undefined,
    },
    {
      label: 'Open positions',
      value: String(open),
    },
  ];
}

function ToneClass(tone: Card['tone']) {
  if (tone === 'positive') return 'text-emerald-400';
  if (tone === 'negative') return 'text-red-400';
  return 'text-neutral-100';
}

export function MetricCards({ trades, loading }: MetricCardsProps) {
  const cards = trades ? computeCards(trades) : null;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {(cards ?? Array.from({ length: 4 })).map((c, i) => (
        <div
          key={i}
          className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4"
        >
          <div className="text-xs uppercase tracking-wide text-neutral-400">
            {c ? c.label : <span className="inline-block h-3 w-20 animate-pulse rounded bg-neutral-800" />}
          </div>
          <div
            className={cn(
              'mt-1 font-mono text-2xl font-semibold tabular-nums',
              c ? ToneClass(c.tone) : 'text-neutral-700'
            )}
          >
            {c ? (
              c.value
            ) : (
              <span className="inline-block h-7 w-16 animate-pulse rounded bg-neutral-800" />
            )}
          </div>
          <div className="mt-1 h-4 text-xs text-neutral-500">
            {c?.sub ?? (loading && !c ? '…' : '')}
          </div>
        </div>
      ))}
    </div>
  );
}
