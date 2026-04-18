'use client';

import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtPrice } from '@/lib/paper/format';
import type { PaperTrade } from '@/lib/paper/types';

interface Props {
  points: { t: number; mid: number }[];
  trades: PaperTrade[];
}

export function MarketChart({ points, trades }: Props) {
  const domain = useMemo<[number, number]>(() => {
    if (points.length === 0) return [0, 1];
    let min = 1;
    let max = 0;
    for (const p of points) {
      if (p.mid < min) min = p.mid;
      if (p.mid > max) max = p.mid;
    }
    const pad = Math.max(0.01, (max - min) * 0.1);
    return [Math.max(0, min - pad), Math.min(1, max + pad)];
  }, [points]);

  if (points.length === 0) {
    return (
      <div className="flex h-[340px] items-center justify-center text-xs text-neutral-500">
        No trade history for this market yet.
      </div>
    );
  }

  return (
    <div className="h-[340px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#262626" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v) =>
              new Date(v).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            }
            stroke="#525252"
            fontSize={10}
          />
          <YAxis
            domain={domain}
            tickFormatter={(v) => (v as number).toFixed(2)}
            stroke="#525252"
            fontSize={10}
            width={44}
          />
          <Tooltip
            contentStyle={{
              background: '#0a0a0a',
              border: '1px solid #262626',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            formatter={(v) => [fmtPrice(typeof v === 'number' ? v : Number(v)), 'mid']}
          />
          <Line
            type="monotone"
            dataKey="mid"
            stroke="#e5e5e5"
            strokeWidth={1.2}
            dot={false}
            isAnimationActive={false}
          />
          {trades.map((t) => {
            const entryTs = new Date(t.entry_ts).getTime();
            return (
              <ReferenceDot
                key={`entry-${t.id}`}
                x={entryTs}
                y={t.entry_price}
                r={5}
                fill="#10b981"
                stroke="#10b981"
                shape={(props: { cx?: number; cy?: number }) => (
                  <polygon
                    points={`${(props.cx ?? 0) - 5},${(props.cy ?? 0) + 4} ${(props.cx ?? 0) + 5},${(props.cy ?? 0) + 4} ${props.cx ?? 0},${(props.cy ?? 0) - 5}`}
                    fill="#10b981"
                    stroke="#064e3b"
                  />
                )}
              />
            );
          })}
          {trades
            .filter((t) => t.exit_ts && t.exit_price !== null)
            .map((t) => {
              const exitTs = new Date(t.exit_ts!).getTime();
              const color =
                (t.pnl_per_share ?? 0) > 0
                  ? '#10b981'
                  : (t.pnl_per_share ?? 0) < 0
                    ? '#ef4444'
                    : '#737373';
              return (
                <ReferenceDot
                  key={`exit-${t.id}`}
                  x={exitTs}
                  y={t.exit_price as number}
                  r={5}
                  shape={(props: { cx?: number; cy?: number }) => (
                    <polygon
                      points={`${(props.cx ?? 0) - 5},${(props.cy ?? 0) - 4} ${(props.cx ?? 0) + 5},${(props.cy ?? 0) - 4} ${props.cx ?? 0},${(props.cy ?? 0) + 5}`}
                      fill={color}
                      stroke="#171717"
                    />
                  )}
                />
              );
            })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
