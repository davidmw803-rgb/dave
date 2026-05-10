'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { KillSwitch } from '@/lib/live/types';
import { formatRelativeTime } from '@/lib/live/format';

interface StatusBarProps {
  killSwitch: KillSwitch | null | undefined;
  lastUpdatedAt: number | null;
  loading: boolean;
}

export function StatusBar({ killSwitch, lastUpdatedAt, loading }: StatusBarProps) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const halted = killSwitch?.halted === true;
  const reason = killSwitch?.reason ?? '';

  return (
    <div className="sticky top-0 z-10 -mx-4 mb-4 border-b border-neutral-800 bg-neutral-950/90 px-4 py-2 backdrop-blur">
      <div className="flex items-center justify-between gap-4 text-sm">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold',
              halted
                ? 'border-red-700 bg-red-950/60 text-red-300'
                : 'border-emerald-700 bg-emerald-950/60 text-emerald-300'
            )}
            title={halted && reason ? reason : undefined}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                halted ? 'bg-red-400' : 'bg-emerald-400 animate-pulse'
              )}
            />
            {halted ? 'HALTED' : 'LIVE'}
          </span>
          {halted && reason ? (
            <span className="text-xs text-neutral-400" title={reason}>
              {reason}
            </span>
          ) : null}
        </div>
        <div className="text-xs text-neutral-500">
          {loading && lastUpdatedAt === null
            ? 'loading…'
            : lastUpdatedAt
            ? `updated ${formatRelativeTime(new Date(lastUpdatedAt).toISOString())}`
            : '—'}
        </div>
      </div>
    </div>
  );
}
