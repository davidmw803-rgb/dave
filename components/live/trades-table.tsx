'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { LiveTrade } from '@/lib/live/types';
import {
  formatCents,
  formatFullTimestamp,
  formatRelativeTime,
  formatUsd,
} from '@/lib/live/format';

interface TradesTableProps {
  trades: LiveTrade[] | undefined;
  loading: boolean;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'OPEN':
      return 'border-blue-700 bg-blue-950/60 text-blue-300';
    case 'CLOSED':
      return 'border-neutral-700 bg-neutral-900 text-neutral-400';
    case 'FAILED':
      return 'border-red-700 bg-red-950/60 text-red-300';
    case 'PENDING':
      return 'border-amber-700 bg-amber-950/60 text-amber-300';
    case 'RESOLVED_AT_EXPIRY':
      return 'border-purple-700 bg-purple-950/60 text-purple-300';
    default:
      return 'border-neutral-700 bg-neutral-900 text-neutral-400';
  }
}

function sideBadgeClass(side: string): string {
  if (side === 'YES') return 'border-emerald-700 bg-emerald-950/40 text-emerald-300';
  if (side === 'NO') return 'border-red-700 bg-red-950/40 text-red-300';
  return 'border-neutral-700 bg-neutral-900 text-neutral-400';
}

function pnlClass(v: number | null): string {
  if (v === null) return 'text-neutral-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-neutral-400';
}

export function TradesTable({ trades, loading }: TradesTableProps) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading && !trades) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-9 w-full animate-pulse rounded bg-neutral-900/60"
          />
        ))}
      </div>
    );
  }

  if (!trades || trades.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-800 p-8 text-center text-xs text-neutral-500">
        No live trades yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-neutral-800">
      <table className="min-w-full divide-y divide-neutral-800 text-sm">
        <thead className="bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Time</th>
            <th className="px-3 py-2 text-left font-medium">Market</th>
            <th className="px-3 py-2 text-left font-medium">Side</th>
            <th className="px-3 py-2 text-right font-medium">Entry</th>
            <th className="px-3 py-2 text-right font-medium">Exit</th>
            <th className="px-3 py-2 text-left font-medium">Reason</th>
            <th className="px-3 py-2 text-right font-medium">P&amp;L</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-900 font-mono tabular-nums">
          {trades.map((t) => (
            <tr key={t.id} className="hover:bg-neutral-900/40">
              <td
                className="whitespace-nowrap px-3 py-2 text-neutral-400"
                title={formatFullTimestamp(t.entry_ts)}
              >
                {formatRelativeTime(t.entry_ts)}
              </td>
              <td className="max-w-[260px] truncate px-3 py-2 text-neutral-300" title={t.slug}>
                {t.slug}
              </td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    'inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold',
                    sideBadgeClass(t.side_token)
                  )}
                >
                  {t.side_token}
                </span>
              </td>
              <td className="px-3 py-2 text-right text-neutral-300">
                {formatCents(t.entry_price)}
              </td>
              <td className="px-3 py-2 text-right text-neutral-300">
                {formatCents(t.exit_price)}
              </td>
              <td className="px-3 py-2 text-xs text-neutral-400">{t.exit_reason ?? '—'}</td>
              <td className={cn('px-3 py-2 text-right font-semibold', pnlClass(t.net_pnl_usd))}>
                {t.net_pnl_usd === null
                  ? '—'
                  : formatUsd(t.net_pnl_usd, { signed: true })}
              </td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    'inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold',
                    statusBadgeClass(t.status)
                  )}
                >
                  {t.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
