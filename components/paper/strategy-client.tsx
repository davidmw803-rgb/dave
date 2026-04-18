'use client';

import { useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { StatTile } from '@/components/paper/stat-tile';
import {
  PnlHistogram,
  RollingAvgPnl,
  RollingWinRate,
} from '@/components/paper/strategy-charts';
import type { PaperSummary, PaperTrade } from '@/lib/paper/types';
import {
  fmtPct,
  fmtUsd,
  MIN_N,
  STRATEGY_MIN_N,
} from '@/lib/paper/format';
import {
  pnlHistogram,
  rollingAvgPnl,
  rollingWinRate,
  stcBuckets,
} from '@/lib/paper/analytics';

interface Props {
  strategies: PaperSummary[];
  selected: string;
  trades: PaperTrade[];
}

export function StrategyClient({ strategies, selected, trades }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  const summary = strategies.find((s) => s.strategy === selected) ?? null;

  const rollingWr = useMemo(() => rollingWinRate(trades), [trades]);
  const rollingAvg = useMemo(() => rollingAvgPnl(trades), [trades]);
  const histogram = useMemo(() => pnlHistogram(trades), [trades]);
  const buckets = useMemo(() => stcBuckets(trades), [trades]);

  const totalClosed = summary?.trades ?? 0;
  const belowValidation = totalClosed < STRATEGY_MIN_N;

  return (
    <div className="space-y-4">
      {strategies.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-6 text-center text-sm text-neutral-400">
          No strategies have reported yet.
        </div>
      ) : null}

      {belowValidation && totalClosed > 0 ? (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
          Sample ({totalClosed}/{STRATEGY_MIN_N}) below validation threshold — interpret results
          cautiously.
        </div>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Strategy analytics</h1>
          <p className="text-xs text-neutral-500">
            Rolling 50-trade windows · STC buckets · pnl distribution
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-neutral-500">Strategy</label>
          <Select
            value={selected}
            onChange={(e) => {
              const v = e.target.value;
              router.push(v ? `${pathname}?s=${encodeURIComponent(v)}` : pathname);
            }}
            className="min-w-[16rem]"
          >
            {strategies.map((s) => (
              <option key={s.strategy} value={s.strategy}>
                {s.strategy} · {s.trades}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total closed" value={totalClosed.toLocaleString()} />
        <StatTile
          label="Win rate"
          value={fmtPct(summary?.win_rate_pct ?? 0)}
          n={totalClosed}
          sampleSize={totalClosed}
        />
        <StatTile
          label="Avg P&L/share"
          value={
            summary?.avg_pnl_per_share !== null && summary?.avg_pnl_per_share !== undefined
              ? summary.avg_pnl_per_share.toFixed(3)
              : '—'
          }
          n={totalClosed}
          sampleSize={totalClosed}
        />
        <StatTile
          label="Total P&L"
          value={fmtUsd(summary?.total_pnl_dollars ?? 0)}
          sub={`${summary?.open_now ?? 0} open now`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Rolling 50-trade win rate</CardTitle>
          </CardHeader>
          <CardContent>
            <RollingWinRate data={rollingWr} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Rolling 50-trade avg P&L/share</CardTitle>
          </CardHeader>
          <CardContent>
            <RollingAvgPnl data={rollingAvg} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>P&L distribution (2¢ bins)</CardTitle>
          </CardHeader>
          <CardContent>
            <PnlHistogram data={histogram} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Win rate by entry STC bucket</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-800 text-xs uppercase text-neutral-400">
                <tr>
                  <th className="px-3 py-2 text-left">Bucket</th>
                  <th className="px-3 py-2 text-right">Trades</th>
                  <th className="px-3 py-2 text-right">Win rate</th>
                  <th className="px-3 py-2 text-right">Avg P&L/share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-900">
                {buckets.map((b) => {
                  const untrusted = b.trades < MIN_N;
                  return (
                    <tr key={b.label} className={untrusted ? 'text-neutral-500' : ''}>
                      <td className="px-3 py-2 font-mono">{b.label}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {b.trades}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {untrusted
                          ? `n=${b.trades}, too small`
                          : b.winRatePct !== null
                            ? fmtPct(b.winRatePct)
                            : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {untrusted
                          ? '—'
                          : b.avgPnl !== null
                            ? b.avgPnl.toFixed(3)
                            : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
