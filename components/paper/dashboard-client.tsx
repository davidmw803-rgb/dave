'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { StatTile } from './stat-tile';
import { OpenPositionsTable } from './open-positions-table';
import { EquityCurve, type EquityPoint } from './equity-curve';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PaperTrade } from '@/lib/paper/types';
import { fmtPct, fmtUsd, pnlColor } from '@/lib/paper/format';

interface Props {
  initialOpen: PaperTrade[];
  initialRealizedToday: number;
  initialWinRate7d: { wins: number; trades: number };
  initialClosedTotal: number;
  initialEquityCurve: EquityPoint[];
}

export function DashboardClient({
  initialOpen,
  initialRealizedToday,
  initialWinRate7d,
  initialClosedTotal,
  initialEquityCurve,
}: Props) {
  const [openCount, setOpenCount] = useState(initialOpen.length);
  const [unrealized, setUnrealized] = useState(0);
  const [realizedToday, setRealizedToday] = useState(initialRealizedToday);
  const [winRate7d, setWinRate7d] = useState(initialWinRate7d);
  const [closedTotal, setClosedTotal] = useState(initialClosedTotal);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>(initialEquityCurve);

  const refreshClosedMetrics = useCallback(async () => {
    const supabase = createClient();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const [todayRes, weekRes, curveRes, summaryRes] = await Promise.all([
      supabase
        .from('btc5m_paper_trades')
        .select('pnl_per_share, size_shares')
        .eq('status', 'CLOSED')
        .gte('exit_ts', startOfDay.toISOString()),
      supabase
        .from('btc5m_paper_trades')
        .select('pnl_per_share')
        .eq('status', 'CLOSED')
        .gte('exit_ts', sevenDaysAgo.toISOString()),
      supabase
        .from('btc5m_paper_trades')
        .select('exit_ts, pnl_per_share, size_shares')
        .eq('status', 'CLOSED')
        .order('exit_ts', { ascending: false })
        .limit(500),
      supabase.from('btc5m_paper_summary').select('trades'),
    ]);

    if (todayRes.data) {
      let sum = 0;
      for (const r of todayRes.data as { pnl_per_share: number | null; size_shares: number }[]) {
        if (r.pnl_per_share !== null) sum += r.pnl_per_share * r.size_shares;
      }
      setRealizedToday(sum);
    }
    if (weekRes.data) {
      const rows = weekRes.data as { pnl_per_share: number | null }[];
      const trades = rows.length;
      const wins = rows.filter((r) => (r.pnl_per_share ?? 0) > 0).length;
      setWinRate7d({ wins, trades });
    }
    if (curveRes.data) {
      const rows = (curveRes.data as { exit_ts: string; pnl_per_share: number | null; size_shares: number }[])
        .filter((r) => r.exit_ts && r.pnl_per_share !== null)
        .reverse();
      let cum = 0;
      const points: EquityPoint[] = rows.map((r) => {
        cum += (r.pnl_per_share ?? 0) * r.size_shares;
        return { t: new Date(r.exit_ts).getTime(), cum };
      });
      setEquityCurve(points);
    }
    if (summaryRes.data) {
      let total = 0;
      for (const r of summaryRes.data as { trades: number | null }[]) {
        total += r.trades ?? 0;
      }
      setClosedTotal(total);
    }
  }, []);

  // Refresh closed metrics whenever a trade transitions to CLOSED.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('paper-trades-closed-metrics')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'btc5m_paper_trades' },
        (payload) => {
          const t = payload.new as PaperTrade;
          if (t.status === 'CLOSED') refreshClosedMetrics();
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [refreshClosedMetrics]);

  const winRatePct = winRate7d.trades > 0 ? (winRate7d.wins / winRate7d.trades) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Open positions"
          value={openCount.toString()}
          sub={`${fmtUsd(unrealized)} unrealized`}
          valueClassName={openCount > 0 ? 'text-emerald-400' : undefined}
        />
        <StatTile
          label="Today's realized P&L"
          value={fmtUsd(realizedToday)}
          valueClassName={pnlColor(realizedToday)}
        />
        <StatTile
          label="Win rate (7d)"
          value={fmtPct(winRatePct)}
          sub={`${winRate7d.wins}W / ${winRate7d.trades - winRate7d.wins}L`}
          n={winRate7d.trades}
          sampleSize={winRate7d.trades}
        />
        <StatTile label="Total closed trades" value={closedTotal.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Open positions</CardTitle>
            <span className="text-[10px] text-neutral-500">live · realtime</span>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <OpenPositionsTable
              initialOpen={initialOpen}
              onOpenChange={(trades) => setOpenCount(trades.length)}
              onUnrealizedChange={setUnrealized}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Equity curve (last 500 closed)</CardTitle>
          </CardHeader>
          <CardContent>
            <EquityCurve points={equityCurve} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
