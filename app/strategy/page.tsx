import { createAdminClient } from '@/lib/supabase/admin';
import { StrategyClient } from '@/components/paper/strategy-client';
import type { PaperTrade, PaperSummary } from '@/lib/paper/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function StrategyPage({
  searchParams,
}: {
  searchParams: { s?: string };
}) {
  const supabase = createAdminClient();

  const summaryRes = await supabase
    .from('btc5m_paper_summary')
    .select('*')
    .order('last_trade', { ascending: false });
  const summaries = (summaryRes.data ?? []) as PaperSummary[];

  const selectedStrategy =
    (searchParams.s && summaries.some((s) => s.strategy === searchParams.s)
      ? searchParams.s
      : summaries[0]?.strategy) ?? '';

  let trades: PaperTrade[] = [];
  if (selectedStrategy) {
    const tradesRes = await supabase
      .from('btc5m_paper_trades')
      .select('*')
      .eq('strategy', selectedStrategy)
      .eq('status', 'CLOSED')
      .order('exit_ts', { ascending: true })
      .limit(5000);
    trades = (tradesRes.data ?? []) as PaperTrade[];
  }

  return (
    <StrategyClient
      strategies={summaries}
      selected={selectedStrategy}
      trades={trades}
    />
  );
}
