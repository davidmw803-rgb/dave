'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { PaperTrade } from '@/lib/paper/types';
import {
  exitBadgeVariant,
  fmtPrice,
  fmtSeconds,
  fmtUsd,
  pnlColor,
} from '@/lib/paper/format';

export interface TradesSearchParams {
  page?: string;
  strategy?: string;
  reasons?: string;
  slug?: string;
  from?: string;
  to?: string;
  sort?: string;
}

type SortKey = 'entry_ts' | 'exit_ts' | 'pnl_per_share';
type SortDir = 'asc' | 'desc';

interface Props {
  trades: PaperTrade[];
  total: number;
  pageSize: number;
  page: number;
  strategies: string[];
  filters: {
    strategy: string;
    reasons: ('TP' | 'STOP' | 'CLOSE')[];
    slug: string;
    from: string;
    to: string;
    sort: { key: SortKey; dir: SortDir };
  };
  error: string | null;
}

const REASONS: ('TP' | 'STOP' | 'CLOSE')[] = ['TP', 'STOP', 'CLOSE'];

export function TradesClient({
  trades,
  total,
  pageSize,
  page,
  strategies,
  filters,
  error,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      if (!('page' in updates)) next.delete('page');
      const qs = next.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [params, pathname, router]
  );

  const toggleReason = (r: 'TP' | 'STOP' | 'CLOSE') => {
    const current = new Set(filters.reasons);
    if (current.has(r)) current.delete(r);
    else current.add(r);
    setParam({ reasons: current.size === 0 ? null : Array.from(current).join(',') });
  };

  const toggleSort = (key: SortKey) => {
    const next: SortDir =
      filters.sort.key === key && filters.sort.dir === 'desc' ? 'asc' : 'desc';
    setParam({ sort: `${key}:${next}` });
  };

  const sortIcon = (key: SortKey) =>
    filters.sort.key === key ? (filters.sort.dir === 'desc' ? ' ↓' : ' ↑') : '';

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Closed trades</h1>
        <p className="text-xs text-neutral-500">
          Showing {trades.length.toLocaleString()} of {total.toLocaleString()} · page {page} of {totalPages}
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">Strategy</label>
            <Select
              value={filters.strategy}
              onChange={(e) => setParam({ strategy: e.target.value || null })}
              className="w-48"
            >
              <option value="">All</option>
              {strategies.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">Exit reason</label>
            <div className="flex h-9 items-center gap-3">
              {REASONS.map((r) => (
                <label key={r} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={filters.reasons.includes(r)}
                    onChange={() => toggleReason(r)}
                    className="h-3.5 w-3.5 accent-emerald-500"
                  />
                  <span>{r}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">From</label>
            <Input
              type="date"
              defaultValue={filters.from}
              onChange={(e) => setParam({ from: e.target.value || null })}
              className="w-40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">To</label>
            <Input
              type="date"
              defaultValue={filters.to}
              onChange={(e) => setParam({ to: e.target.value || null })}
              className="w-40"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">Slug search</label>
            <Input
              type="text"
              placeholder="btc-updown-5m-..."
              defaultValue={filters.slug}
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  setParam({ slug: (e.target as HTMLInputElement).value || null });
              }}
              className="min-w-[16rem]"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(pathname)}
            className="self-end"
          >
            Reset
          </Button>
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          {error}
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <button
                    onClick={() => toggleSort('entry_ts')}
                    className="hover:text-neutral-200"
                  >
                    Entry time{sortIcon('entry_ts')}
                  </button>
                </TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Exit</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">
                  <button
                    onClick={() => toggleSort('pnl_per_share')}
                    className="hover:text-neutral-200"
                  >
                    P&L/share{sortIcon('pnl_per_share')}
                  </button>
                </TableHead>
                <TableHead className="text-right">P&L $</TableHead>
                <TableHead className="text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-xs text-neutral-500">
                    No trades match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                trades.map((t) => {
                  const pnlDollars =
                    t.pnl_per_share !== null ? t.pnl_per_share * t.size_shares : null;
                  const dur =
                    t.entry_ts && t.exit_ts
                      ? Math.max(
                          0,
                          Math.floor(
                            (new Date(t.exit_ts).getTime() - new Date(t.entry_ts).getTime()) / 1000
                          )
                        )
                      : null;
                  return (
                    <TableRow key={t.id}>
                      <TableCell className="font-mono text-xs text-neutral-400">
                        {new Date(t.entry_ts).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/markets/${encodeURIComponent(t.slug)}`}
                          className="font-mono text-xs text-emerald-400 hover:underline"
                        >
                          {t.slug}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant={t.side_token === 'YES' ? 'success' : 'danger'}>
                          {t.side_token}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {fmtPrice(t.entry_price)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {fmtPrice(t.exit_price)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={exitBadgeVariant(t.exit_reason)}>
                          {t.exit_reason ?? '—'}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums ${pnlColor(t.pnl_per_share)}`}
                      >
                        {t.pnl_per_share !== null ? t.pnl_per_share.toFixed(3) : '—'}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums ${pnlColor(pnlDollars)}`}
                      >
                        {fmtUsd(pnlDollars)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-neutral-400">
                        {fmtSeconds(dur)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setParam({ page: String(page - 1) })}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setParam({ page: String(page + 1) })}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
