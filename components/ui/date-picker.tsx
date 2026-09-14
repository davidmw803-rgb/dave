'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Dates are handled as plain YYYY-MM-DD strings — no timezone shifts. */
function toIso(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function todayIso(): string {
  const n = new Date();
  return toIso(n.getFullYear(), n.getMonth(), n.getDate());
}

function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

interface Props {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  /** Dates before this are not selectable. */
  min?: string;
  /** Dates after this are not selectable. */
  max?: string;
  className?: string;
}

export function DatePicker({ value, onChange, placeholder = 'Any date', min, max, className }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const parsed = parseIso(value);
  const [view, setView] = useState(() => {
    const p = parsed ?? parseIso(todayIso())!;
    return { y: p.y, m: p.m };
  });

  // Reopening on a set date should land on that date's month.
  useEffect(() => {
    if (open && parsed) setView({ y: parsed.y, m: parsed.m });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const grid = useMemo(() => {
    const first = new Date(view.y, view.m, 1).getDay();
    const total = daysInMonth(view.y, view.m);
    const cells: (number | null)[] = Array.from({ length: first }, () => null);
    for (let d = 1; d <= total; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [view]);

  const shift = (months: number) => {
    const next = new Date(view.y, view.m + months, 1);
    setView({ y: next.getFullYear(), m: next.getMonth() });
  };

  const today = todayIso();
  const disabled = (iso: string) => (min && iso < min) || (max && iso > max);

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-sm transition-colors hover:border-neutral-700 focus-visible:border-emerald-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500',
          value ? 'text-neutral-100' : 'text-neutral-500'
        )}
      >
        <span className="font-mono">{value || placeholder}</span>
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-none stroke-neutral-500" strokeWidth="1.5">
          <rect x="2" y="3" width="12" height="11" rx="1.5" />
          <path d="M2 6.5h12M5.5 2v2M10.5 2v2" />
        </svg>
      </button>

      {open ? (
        <div className="absolute left-0 top-10 z-50 w-64 rounded-lg border border-neutral-800 bg-neutral-950 p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shift(-1)}
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              aria-label="Previous month"
            >
              ‹
            </button>
            <div className="text-xs font-medium text-neutral-200">
              {MONTHS[view.m]} {view.y}
            </div>
            <button
              type="button"
              onClick={() => shift(1)}
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-0.5">
            {DAY_LABELS.map((d) => (
              <div key={d} className="py-1 text-center text-[10px] uppercase text-neutral-600">
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((day, i) => {
              if (day === null) return <div key={`pad-${i}`} />;
              const iso = toIso(view.y, view.m, day);
              const isSelected = iso === value;
              const isToday = iso === today;
              const off = disabled(iso);
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={!!off}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                  className={cn(
                    'rounded py-1 text-center text-xs transition-colors',
                    isSelected
                      ? 'bg-emerald-500 font-semibold text-neutral-950'
                      : off
                        ? 'cursor-not-allowed text-neutral-700'
                        : 'text-neutral-300 hover:bg-neutral-800',
                    !isSelected && isToday && 'ring-1 ring-inset ring-emerald-500/40'
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-neutral-800 pt-2">
            <button
              type="button"
              onClick={() => {
                onChange(today);
                setOpen(false);
              }}
              className="rounded px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
              className="rounded px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
