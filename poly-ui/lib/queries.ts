import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  HaltsData,
  HomeData,
  LiveTrade,
  PaperData,
  PaperRow,
  PaperTrade,
  StrategyRow,
  TradesData,
  Totals,
} from './types';

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 3600 * 1000);
}

function sumTotals(rows: Pick<LiveTrade, 'net_pnl_usd'>[]): Totals {
  let net = 0;
  let wins = 0;
  let trades = 0;
  for (const r of rows) {
    trades++;
    const p = r.net_pnl_usd ?? 0;
    net += p;
    if (p > 0) wins++;
  }
  return {
    net_pnl_usd: net,
    trades,
    wins,
    win_rate_pct: trades > 0 ? (wins / trades) * 100 : null,
  };
}

async function closedLive(
  sb: SupabaseClient,
  gte: Date | null
): Promise<{ net_pnl_usd: number | null }[]> {
  let q = sb
    .from('btc5m_live_trades')
    .select('net_pnl_usd, exit_ts')
    .eq('dry_run', false)
    .eq('status', 'CLOSED');
  if (gte) q = q.gte('exit_ts', gte.toISOString());
  const { data, error } = await q;
  if (error) throw new Error(`closedLive: ${error.message}`);
  return (data ?? []) as { net_pnl_usd: number | null }[];
}

export async function getHomeData(sb: SupabaseClient, dryRun: boolean): Promise<HomeData> {
  const today = startOfUtcDay();
  const d7 = daysAgo(7);
  const d1 = daysAgo(1);

  const selectLive = 'id, strategy, side_token, entry_price, exit_price, entry_ts, exit_ts, pnl_per_share, net_pnl_usd, status, entry_amount_usd, exit_reason, slug, error_message, dry_run';

  const todayQ = sb
    .from('btc5m_live_trades')
    .select('net_pnl_usd, exit_ts')
    .eq('dry_run', dryRun ? true : false)
    .eq('status', 'CLOSED')
    .gte('exit_ts', today.toISOString());

  const weekQ = sb
    .from('btc5m_live_trades')
    .select('net_pnl_usd, exit_ts')
    .eq('dry_run', dryRun ? true : false)
    .eq('status', 'CLOSED')
    .gte('exit_ts', d7.toISOString());

  const allQ = sb
    .from('btc5m_live_trades')
    .select('net_pnl_usd')
    .eq('dry_run', dryRun ? true : false)
    .eq('status', 'CLOSED');

  const last24hQ = sb
    .from('btc5m_live_trades')
    .select('strategy, net_pnl_usd, exit_ts')
    .eq('dry_run', dryRun ? true : false)
    .eq('status', 'CLOSED')
    .gte('exit_ts', d1.toISOString());

  const openQ = sb
    .from('btc5m_live_trades')
    .select(selectLive)
    .in('status', ['OPEN', 'PENDING'])
    .eq('dry_run', dryRun ? true : false)
    .order('entry_ts', { ascending: false });

  // Last 10 closed per strategy, any dry_run filter, used for losing-streak check.
  const recentPerStratQ = sb
    .from('btc5m_live_trades')
    .select('strategy, net_pnl_usd, exit_ts')
    .eq('dry_run', dryRun ? true : false)
    .eq('status', 'CLOSED')
    .order('exit_ts', { ascending: false })
    .limit(500);

  const [todayRes, weekRes, allRes, last24hRes, openRes, recentRes] = await Promise.all([
    todayQ,
    weekQ,
    allQ,
    last24hQ,
    openQ,
    recentPerStratQ,
  ]);

  for (const r of [todayRes, weekRes, allRes, last24hRes, openRes, recentRes]) {
    if (r.error) throw new Error(`home: ${r.error.message}`);
  }

  const today_ = sumTotals((todayRes.data ?? []) as { net_pnl_usd: number | null }[]);
  const last7d = sumTotals((weekRes.data ?? []) as { net_pnl_usd: number | null }[]);
  const allTime = sumTotals((allRes.data ?? []) as { net_pnl_usd: number | null }[]);

  // Per-strategy counters: closed_24h + wins, all-time net pnl, and open counts.
  const byStrat = new Map<string, StrategyRow>();
  const ensure = (s: string): StrategyRow => {
    let row = byStrat.get(s);
    if (!row) {
      row = {
        strategy: s,
        open: 0,
        closed_24h: 0,
        wins_24h: 0,
        win_rate_pct: null,
        net_pnl_usd: 0,
        losing_streak: 0,
      };
      byStrat.set(s, row);
    }
    return row;
  };

  for (const r of (last24hRes.data ?? []) as { strategy: string; net_pnl_usd: number | null }[]) {
    const row = ensure(r.strategy);
    row.closed_24h++;
    const p = r.net_pnl_usd ?? 0;
    if (p > 0) row.wins_24h++;
  }
  for (const r of (openRes.data ?? []) as { strategy: string }[]) {
    ensure(r.strategy).open++;
  }
  // All-time net pnl per strategy (one extra lightweight query).
  const { data: allPnlData, error: allPnlErr } = await sb
    .from('btc5m_live_trades')
    .select('strategy, net_pnl_usd')
    .eq('dry_run', dryRun ? true : false)
    .eq('status', 'CLOSED');
  if (allPnlErr) throw new Error(`home.stratPnl: ${allPnlErr.message}`);
  for (const r of (allPnlData ?? []) as { strategy: string; net_pnl_usd: number | null }[]) {
    ensure(r.strategy).net_pnl_usd += r.net_pnl_usd ?? 0;
  }

  // Losing-streak: walk the most-recent closed trades per strategy.
  const byStratRecent = new Map<string, { net_pnl_usd: number | null; exit_ts: string }[]>();
  for (const r of (recentRes.data ?? []) as {
    strategy: string;
    net_pnl_usd: number | null;
    exit_ts: string;
  }[]) {
    const list = byStratRecent.get(r.strategy) ?? [];
    list.push({ net_pnl_usd: r.net_pnl_usd, exit_ts: r.exit_ts });
    byStratRecent.set(r.strategy, list);
  }
  const losingStreakStrategies: string[] = [];
  for (const [strat, list] of byStratRecent.entries()) {
    let streak = 0;
    for (const t of list) {
      if ((t.net_pnl_usd ?? 0) < 0) streak++;
      else break;
    }
    ensure(strat).losing_streak = streak;
    if (streak >= 3) losingStreakStrategies.push(strat);
  }

  for (const row of byStrat.values()) {
    row.win_rate_pct = row.closed_24h > 0 ? (row.wins_24h / row.closed_24h) * 100 : null;
  }

  const strategies = Array.from(byStrat.values()).sort(
    (a, b) => b.net_pnl_usd - a.net_pnl_usd
  );
  const openPositions = (openRes.data ?? []) as LiveTrade[];

  return {
    today: today_,
    last7d,
    allTime,
    strategies,
    openPositions,
    losingStreakStrategies,
    generatedAt: new Date().toISOString(),
  };
}

export async function getTradesData(
  sb: SupabaseClient,
  opts: { source: 'live' | 'paper'; strategy: string | null; dryRun: boolean }
): Promise<TradesData> {
  const LIMIT = 100;
  const selectLive = 'id, strategy, side_token, entry_price, exit_price, entry_ts, exit_ts, pnl_per_share, net_pnl_usd, status, entry_amount_usd, exit_reason, slug, error_message, dry_run';
  const selectPaper = 'id, strategy, side_token, entry_price, exit_price, entry_ts, exit_ts, pnl_per_share, exit_reason, status, slug';

  let trades: (LiveTrade | PaperTrade)[] = [];
  if (opts.source === 'live') {
    let q = sb
      .from('btc5m_live_trades')
      .select(selectLive)
      .order('entry_ts', { ascending: false, nullsFirst: false })
      .limit(LIMIT);
    if (opts.strategy) q = q.eq('strategy', opts.strategy);
    q = q.eq('dry_run', opts.dryRun);
    const { data, error } = await q;
    if (error) throw new Error(`trades.live: ${error.message}`);
    trades = (data ?? []) as LiveTrade[];
  } else {
    let q = sb
      .from('btc5m_paper_trades')
      .select(selectPaper)
      .order('entry_ts', { ascending: false, nullsFirst: false })
      .limit(LIMIT);
    if (opts.strategy) q = q.eq('strategy', opts.strategy);
    const { data, error } = await q;
    if (error) throw new Error(`trades.paper: ${error.message}`);
    trades = (data ?? []) as PaperTrade[];
  }

  const liveStratsQ = sb.from('btc5m_live_trades').select('strategy').limit(1000);
  const paperStratsQ = sb.from('btc5m_paper_trades').select('strategy').limit(1000);
  const [liveRes, paperRes] = await Promise.all([liveStratsQ, paperStratsQ]);
  const set = new Set<string>();
  for (const r of (liveRes.data ?? []) as { strategy: string }[]) {
    if (r.strategy) set.add(r.strategy);
  }
  for (const r of (paperRes.data ?? []) as { strategy: string }[]) {
    if (r.strategy) set.add(r.strategy);
  }
  const strategies = Array.from(set).sort();

  return { trades, strategies, generatedAt: new Date().toISOString() };
}

export async function getPaperData(sb: SupabaseClient): Promise<PaperData> {
  const d7 = daysAgo(7);
  const { data, error } = await sb
    .from('btc5m_paper_trades')
    .select('strategy, pnl_per_share, exit_ts')
    .eq('status', 'CLOSED')
    .gte('exit_ts', d7.toISOString())
    .limit(5000);
  if (error) throw new Error(`paper: ${error.message}`);

  const byStrat = new Map<string, PaperRow>();
  for (const r of (data ?? []) as { strategy: string; pnl_per_share: number | null }[]) {
    let row = byStrat.get(r.strategy);
    if (!row) {
      row = {
        strategy: r.strategy,
        trades: 0,
        wins: 0,
        win_rate_pct: null,
        total_pnl_per_share: 0,
        avg_pnl_per_share: null,
      };
      byStrat.set(r.strategy, row);
    }
    row.trades++;
    const p = r.pnl_per_share ?? 0;
    row.total_pnl_per_share += p;
    if (p > 0) row.wins++;
  }
  for (const row of byStrat.values()) {
    row.win_rate_pct = row.trades > 0 ? (row.wins / row.trades) * 100 : null;
    row.avg_pnl_per_share = row.trades > 0 ? row.total_pnl_per_share / row.trades : null;
  }

  const rows = Array.from(byStrat.values()).sort((a, b) => a.strategy.localeCompare(b.strategy));
  return { rows, generatedAt: new Date().toISOString() };
}

export async function getHaltsData(sb: SupabaseClient): Promise<HaltsData> {
  const d7 = daysAgo(7);
  const { data, error } = await sb
    .from('btc5m_live_trades')
    .select('id, strategy, slug, error_message, entry_ts')
    .eq('status', 'FAILED')
    .gte('entry_ts', d7.toISOString())
    .order('entry_ts', { ascending: false })
    .limit(200);
  if (error) throw new Error(`halts: ${error.message}`);
  return {
    rows: (data ?? []) as HaltsData['rows'],
    generatedAt: new Date().toISOString(),
  };
}
