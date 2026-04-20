'use client';

import { PageHeader } from './page-header';
import { usePoll } from './use-poll';
import type { HomeData, LiveTrade, StrategyRow, Totals } from '@/lib/types';
import {
  fmtPct,
  fmtPrice,
  fmtUsd,
  minutesSince,
  pnlColor,
  truncSlug,
} from '@/lib/format';

function TotalCard({ label, totals }: { label: string; totals: Totals }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 font-mono text-3xl font-semibold tabular-nums ${pnlColor(totals.net_pnl_usd)}`}>
        {fmtUsd(totals.net_pnl_usd)}
      </div>
      <div className="mt-1 flex gap-4 text-xs text-neutral-400">
        <span>
          <span className="text-neutral-500">trades </span>
          {totals.trades}
        </span>
        <span>
          <span className="text-neutral-500">WR </span>
          {fmtPct(totals.win_rate_pct)}
        </span>
      </div>
    </div>
  );
}

function StrategyTable({ rows }: { rows: StrategyRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-900/40 p-4 text-center text-xs text-neutral-500">
        No strategy activity yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-sm">
        <thead className="bg-neutral-900/80 text-[10px] uppercase text-neutral-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Strategy</th>
            <th className="px-2 py-2 text-right font-medium">Open</th>
            <th className="px-2 py-2 text-right font-medium">24h</th>
            <th className="px-2 py-2 text-right font-medium">WR</th>
            <th className="px-3 py-2 text-right font-medium">Net P&amp;L</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-900">
          {rows.map((r) => (
            <tr key={r.strategy}>
              <td className="px-3 py-2 font-mono text-[11px] break-all text-neutral-200">
                {r.strategy}
                {r.losing_streak >= 3 ? (
                  <span className="ml-2 rounded bg-red-500/20 px-1 py-px text-[10px] text-red-300">
                    L{r.losing_streak}
                  </span>
                ) : null}
              </td>
              <td className="px-2 py-2 text-right font-mono tabular-nums text-neutral-300">{r.open}</td>
              <td className="px-2 py-2 text-right font-mono tabular-nums text-neutral-300">
                {r.closed_24h}
              </td>
              <td className="px-2 py-2 text-right font-mono tabular-nums text-neutral-300">
                {fmtPct(r.win_rate_pct)}
              </td>
              <td className={`px-3 py-2 text-right font-mono tabular-nums ${pnlColor(r.net_pnl_usd)}`}>
                {fmtUsd(r.net_pnl_usd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpenPosition({ t }: { t: LiveTrade }) {
  const mins = minutesSince(t.entry_ts);
  const href = t.slug ? `https://polymarket.com/event/${t.slug}` : null;
  const row = (
    <div className="flex flex-col gap-0.5 border-b border-neutral-900 px-3 py-2 active:bg-neutral-900">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-xs text-neutral-200">{truncSlug(t.slug)}</div>
        <div className="flex items-center gap-1.5">
          {t.entry_amount_usd !== null ? (
            <span className="rounded bg-neutral-800 px-1.5 py-px font-mono text-[10px] text-neutral-200">
              {fmtUsd(t.entry_amount_usd, 0)}
            </span>
          ) : null}
          <span
            className={`rounded px-1.5 py-px text-[10px] font-medium ${
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
      </div>
      <div className="flex items-center justify-between text-[11px] text-neutral-500">
        <span className="font-mono">{t.strategy}</span>
        <span className="font-mono">
          @ {fmtPrice(t.entry_price)} · {mins === null ? '—' : `${mins}m`}
        </span>
      </div>
    </div>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="block">
      {row}
    </a>
  ) : (
    row
  );
}

export function HomeView({ initial }: { initial: HomeData }) {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const dryRun = (params?.get('mode') ?? 'live') === 'dry';
  const { data, refresh, refreshing, error } = usePoll<HomeData>(
    `/api/refresh/home?mode=${dryRun ? 'dry' : 'live'}`,
    initial
  );

  return (
    <div>
      <PageHeader
        title={dryRun ? 'Poly UI · DRY' : 'Poly UI · LIVE'}
        generatedAt={data.generatedAt}
        onRefresh={refresh}
        refreshing={refreshing}
        showDryToggle
        dryRun={dryRun}
      />

      <main className="mx-auto max-w-screen-sm space-y-4 px-3 pb-10 pt-3">
        {error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            Refresh failed: {error}
          </div>
        ) : null}

        {data.losingStreakStrategies.length > 0 ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            <span className="font-medium">Warning:</span>{' '}
            {data.losingStreakStrategies.join(', ')} on ≥3 consecutive losses.
          </div>
        ) : null}

        <div className="space-y-3">
          <TotalCard label="Today (UTC)" totals={data.today} />
          <TotalCard label="Last 7 days" totals={data.last7d} />
          <TotalCard label="All-time live" totals={data.allTime} />
        </div>

        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
            Per strategy
          </h2>
          <StrategyTable rows={data.strategies} />
        </section>

        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Open positions ({data.openPositions.length})
            </h2>
            {data.openPositions.length > 0 ? (
              <span className="font-mono text-[11px] text-neutral-500">
                {fmtUsd(
                  data.openPositions.reduce(
                    (s, t) => s + (t.entry_amount_usd ?? 0),
                    0
                  ),
                  0
                )}{' '}
                deployed
              </span>
            ) : null}
          </div>
          {data.openPositions.length === 0 ? (
            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-4 text-center text-xs text-neutral-500">
              None.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40">
              {data.openPositions.map((t) => (
                <OpenPosition key={t.id} t={t} />
              ))}
            </div>
          )}
        </section>

        <p className="pt-4 text-center text-[10px] text-neutral-600">
          Auto-refreshes every 30s. Read-only.
        </p>
      </main>
    </div>
  );
}
