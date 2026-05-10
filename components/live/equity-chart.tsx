'use client';

import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LiveTrade } from '@/lib/live/types';
import { formatUsd } from '@/lib/live/format';

interface EquityChartProps {
  trades: LiveTrade[] | undefined;
  loading: boolean;
}

interface Point {
  t: number;
  cum: number;
}

export function EquityChart({ trades, loading }: EquityChartProps) {
  const points = useMemo<Point[]>(() => {
    if (!trades) return [];
    let cum = 0;
    return trades
      .filter((t) => t.status === 'CLOSED' && typeof t.net_pnl_usd === 'number')
      .map((t) => {
        cum += t.net_pnl_usd as number;
        const stamp = t.exit_ts ?? t.entry_ts;
        return { t: new Date(stamp).getTime(), cum };
      })
      .sort((a, b) => a.t - b.t);
  }, [trades]);

  if (loading && !trades) {
    return (
      <div className="h-[300px] w-full animate-pulse rounded-md bg-neutral-900/60" />
    );
  }

  if (points.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-md border border-dashed border-neutral-800 text-xs text-neutral-500">
        No closed live trades in the last 7 days.
      </div>
    );
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#262626" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v) =>
              new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            }
            stroke="#525252"
            fontSize={10}
          />
          <YAxis
            tickFormatter={(v) => formatUsd(v as number)}
            stroke="#525252"
            fontSize={10}
            width={64}
          />
          <Tooltip
            contentStyle={{
              background: '#0a0a0a',
              border: '1px solid #262626',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            formatter={(v) => [
              formatUsd(typeof v === 'number' ? v : Number(v), { signed: true }),
              'Cumulative P&L',
            ]}
          />
          <Line
            type="monotone"
            dataKey="cum"
            stroke="#10b981"
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
