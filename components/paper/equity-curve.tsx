'use client';

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtUsd } from '@/lib/paper/format';

export interface EquityPoint {
  t: number; // epoch ms
  cum: number; // cumulative $ PnL
}

export function EquityCurve({ points }: { points: EquityPoint[] }) {
  const { data, domain } = useMemo(() => {
    if (points.length === 0) return { data: [] as EquityPoint[], domain: [0, 0] as [number, number] };
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      if (p.cum < min) min = p.cum;
      if (p.cum > max) max = p.cum;
    }
    const pad = Math.max(1, (max - min) * 0.1);
    return { data: points, domain: [min - pad, max + pad] as [number, number] };
  }, [points]);

  if (data.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-xs text-neutral-500">
        No closed trades yet.
      </div>
    );
  }

  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#262626" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v) => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            stroke="#525252"
            fontSize={10}
          />
          <YAxis
            domain={domain}
            tickFormatter={(v) => fmtUsd(v as number, 0)}
            stroke="#525252"
            fontSize={10}
            width={52}
          />
          <Tooltip
            contentStyle={{
              background: '#0a0a0a',
              border: '1px solid #262626',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            formatter={(v) => [fmtUsd(typeof v === 'number' ? v : Number(v)), 'Cumulative P&L']}
          />
          <Area
            type="monotone"
            dataKey="cum"
            stroke="#10b981"
            strokeWidth={1.5}
            fill="url(#equity-fill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
