'use client';

import { useMemo } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { PageHeader } from './page-header';
import { usePoll } from './use-poll';
import type { LiveTrade, PaperTrade, TradesData } from '@/lib/types';
import { fmtPrice, fmtShortTs, fmtUsd, pnlColor, truncSlug } from '@/lib/format';

type Source = 'live' | 'paper';

interface Props {
  initial: TradesData;
  initialSource: Source;
  initialStrategy: string | null;
  initialDryRun: boolean;
}

function isLive(t: LiveTrade | PaperTrade): t is LiveTrade {
  return 'net_pnl_usd' in t;
}

export function TradesView({ initial, initialSource, initialStrategy, initialDryRun }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const source: Source = (params.get('source') as Source) ?? initialSource;
  const strategy = params.get('strategy') ?? initialStrategy ?? '';
  const dryRun = (params.get('mode') ?? (initialDryRun ? 'dry' : 'live')) === 'dry';

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set('source', source);
    if (strategy) sp.set('strategy', strategy);
    sp.set('mode', dryRun ? 'dry' : 'live');
    return sp.toString();
  }, [source, strategy, dryRun]);

  const { data, refresh, refreshing, error } = usePoll<TradesData>(
    `/api/refresh/trades?${query}`,
    initial
  );

  const setParam = (k: string, v: string | null) => {
    const sp = new URLSearchParams(params.toString());
    if (v === null || v === '') sp.delete(k);
    else sp.set(k, v);
    router.replace(`${pathname}?${sp.toString()}`);
  };

  return (
    <div>
      <PageHeader
        title="Trades"
        generatedAt={data.generatedAt}
        onRefresh={refresh}
        refreshing={refreshing}
        showDryToggle={source === 'live'}
        dryRun={dryRun}
      />

      <main className="mx-auto max-w-screen-sm px-3 pb-10 pt-3 space-y-3">
        {error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            Refresh failed: {error}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex overflow-hidden rounded-md border border-neutral-800">
            <button
              onClick={() => setParam('source', 'live')}
              className={`px-3 py-1.5 ${source === 'live' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400'}`}
            >
              Live
            </button>
            <button
              onClick={() => setParam('source', 'paper')}
              className={`px-3 py-1.5 ${source === 'paper' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400'}`}
            >
              Paper
            </button>
          </div>
          <select
            value={strategy}
            onChange={(e) => setParam('strategy', e.target.value)}
            className="h-8 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100"
          >
            <option value="">All strategies</option>
            {data.strategies.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40">
          {data.trades.length === 0 ? (
            <div className="p-6 text-center text-xs text-neutral-500">No trades.</div>
          ) : (
            data.trades.map((t) => {
              const live = isLive(t);
              const pnl = live ? t.net_pnl_usd : t.pnl_per_share;
              const pnlLabel = live ? fmtUsd(t.net_pnl_usd) : fmtPrice(t.pnl_per_share);
              return (
                <div
                  key={`${live ? 'l' : 'p'}-${t.id}`}
                  className="flex items-center justify-between border-b border-neutral-900 px-3 py-2 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11px] text-neutral-400">
                      <span className="font-mono">{fmtShortTs(t.entry_ts)}</span>
                      <span
                        className={`rounded px-1 py-px text-[10px] font-medium ${
                          t.side_token === 'YES'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : t.side_token === 'NO'
                              ? 'bg-red-500/15 text-red-300'
                              : 'bg-neutral-700/50 text-neutral-300'
                        }`}
                      >
                        {t.side_token ?? '—'}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-300">
                      {t.strategy}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-neutral-500">
                      {truncSlug(t.slug, 28)} · {fmtPrice(t.entry_price)}
                      {t.exit_price !== null ? ` → ${fmtPrice(t.exit_price)}` : ' → …'}
                      {t.exit_reason ? ` · ${t.exit_reason}` : ''}
                    </div>
                  </div>
                  <div className="ml-2 flex flex-col items-end">
                    {live && t.entry_amount_usd !== null ? (
                      <span className="font-mono text-[10px] text-neutral-500">
                        {fmtUsd(t.entry_amount_usd, 0)}
                      </span>
                    ) : null}
                    <span
                      className={`font-mono tabular-nums text-sm ${
                        t.status === 'OPEN' || t.status === 'PENDING'
                          ? 'text-neutral-400'
                          : pnlColor(pnl)
                      }`}
                    >
                      {t.status === 'OPEN' || t.status === 'PENDING' ? 'OPEN' : pnlLabel}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <p className="pt-2 text-center text-[10px] text-neutral-600">
          Newest 100 · auto-refreshes every 30s.
        </p>
      </main>
    </div>
  );
}
