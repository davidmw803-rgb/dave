'use client';

import { PageHeader } from './page-header';
import { usePoll } from './use-poll';
import type { HaltsData } from '@/lib/types';
import { fmtShortTs, truncSlug } from '@/lib/format';

export function HaltsView({ initial }: { initial: HaltsData }) {
  const { data, refresh, refreshing, error } = usePoll<HaltsData>(
    '/api/refresh/halts',
    initial
  );

  return (
    <div>
      <PageHeader
        title="Halts · failed trades"
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
            No failed trades in the last 7 days.
          </div>
        ) : (
          <div className="space-y-2">
            {data.rows.map((r) => (
              <div
                key={r.id}
                className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-2 text-neutral-400">
                  <span className="font-mono">{fmtShortTs(r.entry_ts)}</span>
                  <span className="font-mono text-neutral-300">{r.strategy}</span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-neutral-500">
                  {truncSlug(r.slug, 40)}
                </div>
                <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-red-300">
                  {r.error_message ?? '(no error message)'}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
