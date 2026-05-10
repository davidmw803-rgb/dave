'use client';

import useSWR from 'swr';
import { createClient } from '@/lib/supabase/client';
import { STRATEGY, type KillSwitch, type LiveTrade } from '@/lib/live/types';

const REFRESH_MS = 5_000;

const supabase = createClient();

async function fetchLiveTrades(): Promise<LiveTrade[]> {
  const { data, error } = await supabase
    .from('btc5m_live_trades')
    .select(
      'id, strategy, side_token, entry_price, entry_ts, entry_amount_usd, exit_price, exit_ts, exit_reason, net_pnl_usd, status, slug'
    )
    .eq('strategy', STRATEGY)
    .eq('dry_run', false)
    .order('entry_ts', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as LiveTrade[];
}

async function fetchEquityCurve(): Promise<LiveTrade[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('btc5m_live_trades')
    .select('entry_ts, exit_ts, net_pnl_usd, status')
    .eq('strategy', STRATEGY)
    .eq('dry_run', false)
    .eq('status', 'CLOSED')
    .gte('entry_ts', since)
    .order('entry_ts', { ascending: true })
    .limit(5000);
  if (error) throw error;
  return (data ?? []) as LiveTrade[];
}

async function fetchKillSwitch(): Promise<KillSwitch | null> {
  const { data, error } = await supabase
    .from('kill_switch')
    .select('scope, halted, reason, updated_at')
    .eq('scope', STRATEGY)
    .maybeSingle();
  if (error) throw error;
  return (data as KillSwitch | null) ?? null;
}

export function useLiveTrades() {
  return useSWR('live-trades', fetchLiveTrades, {
    refreshInterval: REFRESH_MS,
    revalidateOnFocus: false,
  });
}

export function useEquityCurve() {
  return useSWR('live-trades-equity', fetchEquityCurve, {
    refreshInterval: REFRESH_MS,
    revalidateOnFocus: false,
  });
}

export function useKillSwitch() {
  return useSWR('live-kill-switch', fetchKillSwitch, {
    refreshInterval: REFRESH_MS,
    revalidateOnFocus: false,
  });
}
