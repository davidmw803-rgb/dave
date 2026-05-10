'use client';

import { useMemo } from 'react';
import { useEquityCurve, useKillSwitch, useLiveTrades } from '@/lib/live/hooks';
import { StatusBar } from '@/components/live/status-bar';
import { MetricCards } from '@/components/live/metric-cards';
import { EquityChart } from '@/components/live/equity-chart';
import { TradesTable } from '@/components/live/trades-table';

export function LiveTradesDashboard() {
  const trades = useLiveTrades();
  const equity = useEquityCurve();
  const kill = useKillSwitch();

  const lastUpdatedAt = useMemo(() => {
    const stamps: number[] = [];
    if (trades.data) stamps.push(Date.now());
    if (equity.data) stamps.push(Date.now());
    if (kill.data !== undefined) stamps.push(Date.now());
    return stamps.length > 0 ? Math.max(...stamps) : null;
  }, [trades.data, equity.data, kill.data]);

  const errorMessage =
    trades.error?.message ?? equity.error?.message ?? kill.error?.message ?? null;

  return (
    <div className="space-y-6">
      <StatusBar
        killSwitch={kill.data ?? null}
        lastUpdatedAt={lastUpdatedAt}
        loading={kill.isLoading || trades.isLoading}
      />

      {errorMessage ? (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          Failed to load live data: {errorMessage}
        </div>
      ) : null}

      <section>
        <MetricCards trades={trades.data} loading={trades.isLoading} />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Equity curve · last 7 days
        </h2>
        <EquityChart trades={equity.data} loading={equity.isLoading} />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Recent trades
        </h2>
        <TradesTable trades={trades.data} loading={trades.isLoading} />
      </section>
    </div>
  );
}
