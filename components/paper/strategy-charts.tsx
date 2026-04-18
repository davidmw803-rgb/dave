'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from 'recharts';
import { fmtPct } from '@/lib/paper/format';

const gridColor = '#262626';
const axisColor = '#525252';

export function RollingWinRate({ data }: { data: { idx: number; rate: number }[] }) {
  if (data.length === 0) {
    return <EmptyChart label="Not enough trades for rolling 50 window." />;
  }
  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={gridColor} vertical={false} />
          <XAxis dataKey="idx" stroke={axisColor} fontSize={10} />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            stroke={axisColor}
            fontSize={10}
            width={36}
          />
          <Tooltip
            contentStyle={{
              background: '#0a0a0a',
              border: `1px solid ${gridColor}`,
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v) => [fmtPct(typeof v === 'number' ? v : Number(v)), 'win rate']}
            labelFormatter={(v) => `trade #${v}`}
          />
          <ReferenceLine y={50} stroke="#404040" strokeDasharray="4 4" />
          <Line
            type="monotone"
            dataKey="rate"
            stroke="#10b981"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RollingAvgPnl({ data }: { data: { idx: number; avg: number }[] }) {
  if (data.length === 0) {
    return <EmptyChart label="Not enough trades for rolling 50 window." />;
  }
  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={gridColor} vertical={false} />
          <XAxis dataKey="idx" stroke={axisColor} fontSize={10} />
          <YAxis
            tickFormatter={(v) => (v as number).toFixed(2)}
            stroke={axisColor}
            fontSize={10}
            width={44}
          />
          <Tooltip
            contentStyle={{
              background: '#0a0a0a',
              border: `1px solid ${gridColor}`,
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v) => [(typeof v === 'number' ? v : Number(v)).toFixed(3), 'avg P&L/share']}
            labelFormatter={(v) => `trade #${v}`}
          />
          <ReferenceLine y={0} stroke="#404040" strokeDasharray="4 4" />
          <Line
            type="monotone"
            dataKey="avg"
            stroke="#f59e0b"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PnlHistogram({ data }: { data: { bin: number; count: number }[] }) {
  if (data.length === 0) {
    return <EmptyChart label="No closed trades." />;
  }
  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={gridColor} vertical={false} />
          <XAxis
            dataKey="bin"
            stroke={axisColor}
            fontSize={10}
            tickFormatter={(v) => (v as number).toFixed(2)}
          />
          <YAxis stroke={axisColor} fontSize={10} width={36} />
          <Tooltip
            contentStyle={{
              background: '#0a0a0a',
              border: `1px solid ${gridColor}`,
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v) => [String(v), 'trades']}
            labelFormatter={(v) => `bin ${(v as number).toFixed(2)}`}
          />
          <ReferenceLine x={0} stroke="#737373" />
          <Bar
            dataKey="count"
            fill="#10b981"
            shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { bin: number } }) => {
              const { x = 0, y = 0, width = 0, height = 0, payload } = props;
              const color = (payload?.bin ?? 0) < 0 ? '#ef4444' : '#10b981';
              return <rect x={x} y={y} width={width} height={height} fill={color} />;
            }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center text-xs text-neutral-500">
      {label}
    </div>
  );
}
