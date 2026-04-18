import { cn } from '@/lib/utils';
import { MIN_N } from '@/lib/paper/format';

interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  n?: number | null;
  valueClassName?: string;
  /** If sampleSize is supplied and below MIN_N, the tile is greyed out with the "too small" note. */
  sampleSize?: number | null;
}

export function StatTile({ label, value, sub, n, valueClassName, sampleSize }: StatTileProps) {
  const untrusted =
    sampleSize !== undefined && sampleSize !== null && sampleSize < MIN_N;

  return (
    <div
      className={cn(
        'rounded-lg border border-neutral-800 bg-neutral-900/60 p-4',
        untrusted && 'opacity-60'
      )}
    >
      <div className="text-xs uppercase tracking-wide text-neutral-400">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-2xl font-semibold tabular-nums',
          untrusted ? 'text-neutral-500' : 'text-neutral-100',
          valueClassName
        )}
      >
        {untrusted ? '—' : value}
      </div>
      {untrusted ? (
        <div className="mt-1 text-xs text-neutral-500">n={sampleSize}, too small to trust</div>
      ) : (
        <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
          {sub ? <span>{sub}</span> : null}
          {n !== undefined && n !== null ? (
            <span className="font-mono">n={n}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
