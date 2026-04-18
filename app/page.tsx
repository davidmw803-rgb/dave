import { createAdminClient } from '@/lib/supabase/admin';
import { DashboardClient } from '@/components/paper/dashboard-client';
import type { PaperTrade } from '@/lib/paper/types';
import type { EquityPoint } from '@/components/paper/equity-curve';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function loadInitialData() {
  const supabase = createAdminClient();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const [openRes, todayRes, weekRes, curveRes, summaryRes] = await Promise.all([
    supabase
      .from('btc5m_paper_trades')
      .select('*')
      .eq('status', 'OPEN')
      .order('entry_ts', { ascending: false }),
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

  const initialOpen = (openRes.data ?? []) as PaperTrade[];

  let realizedToday = 0;
  for (const r of (todayRes.data ?? []) as {
    pnl_per_share: number | null;
    size_shares: number;
  }[]) {
    if (r.pnl_per_share !== null) realizedToday += r.pnl_per_share * r.size_shares;
  }

  const weekRows = (weekRes.data ?? []) as { pnl_per_share: number | null }[];
  const winRate7d = {
    trades: weekRows.length,
    wins: weekRows.filter((r) => (r.pnl_per_share ?? 0) > 0).length,
  };

  const curveRowsDesc = (curveRes.data ?? []) as {
    exit_ts: string;
    pnl_per_share: number | null;
    size_shares: number;
  }[];
  const curveRows = curveRowsDesc
    .filter((r) => r.exit_ts && r.pnl_per_share !== null)
    .slice()
    .reverse();
  let cum = 0;
  const initialEquityCurve: EquityPoint[] = curveRows.map((r) => {
    cum += (r.pnl_per_share ?? 0) * r.size_shares;
    return { t: new Date(r.exit_ts).getTime(), cum };
  });

  let closedTotal = 0;
  for (const r of (summaryRes.data ?? []) as { trades: number | null }[]) {
    closedTotal += r.trades ?? 0;
  }

  return {
    initialOpen,
    initialRealizedToday: realizedToday,
    initialWinRate7d: winRate7d,
    initialClosedTotal: closedTotal,
    initialEquityCurve,
  };
}

export default async function HomePage() {
  const data = await loadInitialData();
  return <DashboardClient {...data} />;
}
