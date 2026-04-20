'use client';

import { PageHeader } from './page-header';
import { usePoll } from './use-poll';
import type { PaperData } from '@/lib/types';
import { fmtPct, pnlColor } from '@/lib/format';

export function PaperView({ initial }: { initial: PaperData }) {
  const { data, refresh, refreshing, error } = usePoll<PaperData>(
    '/api/refresh/paper',
    initial
  );

  return (
    <div>
      <PageHeader
        title="Paper · last 7d"
        generatedAt={data.generatedAt}
        onRefresh={refresh}
        refreshing={refreshing}
      />
      <main className="mx-auto max-w-screen-sm space-y-3 px-3 pb-10 pt-3">
        {error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            Refresh failed: {error}
          </div>
        ) : null}

        {data.rows.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-900/40 p-6 text-center text-xs text-neutral-500">
            No paper trades in the last 7 days.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900/80 text-[10px] uppercase text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Strategy</th>
                  <th className="px-2 py-2 text-right font-medium">Trades</th>
                  <th className="px-2 py-2 text-right font-medium">WR</th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  <th className="px-2 py-2 text-right font-medium">Avg</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-900">
                {data.rows.map((r) => (
                  <tr key={r.strategy}>
                    <td className="px-3 py-2 font-mono text-[11px] break-all text-neutral-200">
                      {r.strategy}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-neutral-300">
                      {r.trades}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-neutral-300">
                      {fmtPct(r.win_rate_pct)}
                    </td>
                    <td className={`px-2 py-2 text-right font-mono tabular-nums ${pnlColor(r.total_pnl_per_share)}`}>
                      {r.total_pnl_per_share.toFixed(3)}
                    </td>
                    <td className={`px-2 py-2 text-right font-mono tabular-nums ${pnlColor(r.avg_pnl_per_share)}`}>
                      {r.avg_pnl_per_share === null ? '—' : r.avg_pnl_per_share.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="pt-2 text-center text-[10px] text-neutral-600">
          Paper totals shown in pnl/share units (not USD).
        </p>
      </main>
    </div>
  );
}
