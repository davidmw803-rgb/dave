'use client';

import { useMemo, useState } from 'react';
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
import { cn } from '@/lib/utils';
import {
  CONSENSUS_OPTIONS,
  SIGNALS,
  type CombinedSignal,
  type SortDir,
  type StockSortKey,
  type UwTipranksRow,
} from '@/lib/stocks/types';
import {
  consensusLabel,
  consensusVariant,
  fmtDate,
  fmtNum,
  fmtPct,
  fmtPremium,
  fmtPrice,
  fmtRate,
  scoreColor,
  sentimentLabel,
  sentimentVariant,
  signColor,
  signalLabel,
  signalVariant,
  starsFor,
} from '@/lib/stocks/format';

const PAGE_SIZE = 25;

interface Props {
  rows: UwTipranksRow[];
  /** True when `rows` are the built-in sample rows rather than live DB rows. */
  isSample: boolean;
  error: string | null;
}

export function UwTipranksTable({ rows, isSample, error }: Props) {
  const [search, setSearch] = useState('');
  const [sector, setSector] = useState('');
  const [consensus, setConsensus] = useState('');
  const [signals, setSignals] = useState<CombinedSignal[]>([]);
  const [minScore, setMinScore] = useState('');
  const [sortKey, setSortKey] = useState<StockSortKey>('composite_score');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);

  const sectors = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.sector).filter((s): s is string => !!s))).sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = minScore === '' ? null : Number(minScore);

    const out = rows.filter((r) => {
      if (q && !`${r.ticker} ${r.company ?? ''}`.toLowerCase().includes(q)) return false;
      if (sector && r.sector !== sector) return false;
      if (consensus && r.tr_consensus !== consensus) return false;
      if (signals.length > 0 && (!r.signal || !signals.includes(r.signal))) return false;
      if (min !== null && Number.isFinite(min)) {
        if (r.composite_score === null || r.composite_score < min) return false;
      }
      return true;
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    return out.sort((a, b) => {
      if (sortKey === 'ticker') return a.ticker.localeCompare(b.ticker) * dir;
      if (sortKey === 'as_of')
        return (new Date(a.as_of).getTime() - new Date(b.as_of).getTime()) * dir;
      const av = a[sortKey];
      const bv = b[sortKey];
      // Nulls always sort last, whichever direction is active.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
  }, [rows, search, sector, consensus, signals, minScore, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const toggleSort = (key: StockSortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir(key === 'ticker' ? 'asc' : 'desc');
    }
    setPage(1);
  };

  const toggleSignal = (s: CombinedSignal) => {
    setSignals((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
    setPage(1);
  };

  const reset = () => {
    setSearch('');
    setSector('');
    setConsensus('');
    setSignals([]);
    setMinScore('');
    setSortKey('composite_score');
    setSortDir('desc');
    setPage(1);
  };

  const sortIcon = (key: StockSortKey) =>
    sortKey === key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';

  const sortable = (key: StockSortKey, label: string) => (
    <button
      onClick={() => toggleSort(key)}
      className={cn(
        'transition-colors hover:text-neutral-200',
        sortKey === key && 'text-neutral-100'
      )}
    >
      {label}
      {sortIcon(key)}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Unusual Whales × TipRanks</h1>
          <p className="text-xs text-neutral-500">
            Options flow on the left, analyst consensus on the right, combined read on the
            far right · {filtered.length.toLocaleString()} of {rows.length.toLocaleString()}{' '}
            tickers · page {currentPage} of {totalPages}
          </p>
        </div>
      </div>

      {error ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          {error}
        </div>
      ) : null}

      {isSample ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          Showing built-in sample rows — <code>uw_tipranks_analysis</code> is empty or not
          migrated yet. Apply <code>supabase/migrations/004_uw_tipranks_analysis.sql</code>{' '}
          and load the table to see live data here.
        </div>
      ) : null}

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">Ticker / company</label>
            <Input
              type="text"
              placeholder="NVDA, Apple…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="min-w-[14rem]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">Sector</label>
            <Select
              value={sector}
              onChange={(e) => {
                setSector(e.target.value);
                setPage(1);
              }}
              className="w-48"
            >
              <option value="">All</option>
              {sectors.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">TR consensus</label>
            <Select
              value={consensus}
              onChange={(e) => {
                setConsensus(e.target.value);
                setPage(1);
              }}
              className="w-40"
            >
              <option value="">All</option>
              {CONSENSUS_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {consensusLabel(c)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">Min score</label>
            <Input
              type="number"
              min={0}
              max={100}
              placeholder="0"
              value={minScore}
              onChange={(e) => {
                setMinScore(e.target.value);
                setPage(1);
              }}
              className="w-24"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-neutral-500">Signal</label>
            <div className="flex h-9 items-center gap-3">
              {SIGNALS.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={signals.includes(s)}
                    onChange={() => toggleSignal(s)}
                    className="h-3.5 w-3.5 accent-emerald-500"
                  />
                  <span>{signalLabel(s)}</span>
                </label>
              ))}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={reset} className="self-end">
            Reset
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              {/* Group row — which provider each block of columns comes from. */}
              <TableRow className="hover:bg-transparent">
                <TableHead colSpan={4} className="h-7 border-r border-neutral-800 text-[10px] tracking-wide text-neutral-600">
                  Instrument
                </TableHead>
                <TableHead colSpan={5} className="h-7 border-r border-neutral-800 text-[10px] tracking-wide text-sky-500/80">
                  Unusual Whales
                </TableHead>
                <TableHead colSpan={6} className="h-7 border-r border-neutral-800 text-[10px] tracking-wide text-violet-400/80">
                  TipRanks
                </TableHead>
                <TableHead colSpan={3} className="h-7 text-[10px] tracking-wide text-emerald-500/80">
                  Combined
                </TableHead>
              </TableRow>
              <TableRow>
                <TableHead>{sortable('ticker', 'Ticker')}</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Sector</TableHead>
                <TableHead className="border-r border-neutral-800 text-right">Price</TableHead>

                <TableHead>Flow</TableHead>
                <TableHead className="text-right">
                  {sortable('uw_net_premium', 'Net prem.')}
                </TableHead>
                <TableHead className="text-right">C/P</TableHead>
                <TableHead className="text-right">
                  {sortable('uw_unusual_score', 'Unusual')}
                </TableHead>
                <TableHead className="border-r border-neutral-800 text-right">IV rank</TableHead>

                <TableHead>Consensus</TableHead>
                <TableHead className="text-right">Analysts</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead className="text-right">PT</TableHead>
                <TableHead className="text-right">
                  {sortable('tr_upside_pct', 'Upside')}
                </TableHead>
                <TableHead className="border-r border-neutral-800 text-right">
                  {sortable('tr_success_rate', 'Hit rate')}
                </TableHead>

                <TableHead className="text-right">
                  {sortable('composite_score', 'Score')}
                </TableHead>
                <TableHead>Signal</TableHead>
                <TableHead className="text-right">{sortable('as_of', 'Updated')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={18} className="py-8 text-center text-xs text-neutral-500">
                    No tickers match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs font-semibold text-emerald-400">
                      {r.ticker}
                    </TableCell>
                    <TableCell className="max-w-[14rem] truncate text-xs text-neutral-300">
                      {r.company ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs text-neutral-400">{r.sector ?? '—'}</TableCell>
                    <TableCell className="border-r border-neutral-800 text-right font-mono tabular-nums">
                      {fmtPrice(r.price)}
                    </TableCell>

                    <TableCell className="whitespace-nowrap">
                      <Badge variant={sentimentVariant(r.uw_sentiment)}>
                        {sentimentLabel(r.uw_sentiment)}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono tabular-nums ${signColor(r.uw_net_premium)}`}
                    >
                      {fmtPremium(r.uw_net_premium)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-neutral-300">
                      {fmtNum(r.uw_call_put_ratio, 2)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-neutral-300">
                      {fmtNum(r.uw_unusual_score, 0)}
                    </TableCell>
                    <TableCell className="border-r border-neutral-800 text-right font-mono tabular-nums text-neutral-400">
                      {fmtRate(r.uw_iv_rank)}
                    </TableCell>

                    <TableCell className="whitespace-nowrap">
                      <Badge variant={consensusVariant(r.tr_consensus)}>
                        {consensusLabel(r.tr_consensus)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-neutral-400">
                      {r.tr_analyst_count ?? '—'}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-xs text-amber-400"
                      title={r.tr_star_rating !== null ? `${r.tr_star_rating} / 5` : undefined}
                    >
                      {starsFor(r.tr_star_rating)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-neutral-300">
                      {fmtPrice(r.tr_price_target)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono tabular-nums ${signColor(r.tr_upside_pct)}`}
                    >
                      {fmtPct(r.tr_upside_pct)}
                    </TableCell>
                    <TableCell className="border-r border-neutral-800 text-right font-mono tabular-nums text-neutral-300">
                      {fmtRate(r.tr_success_rate, 1)}
                    </TableCell>

                    <TableCell
                      className={`text-right font-mono font-semibold tabular-nums ${scoreColor(r.composite_score)}`}
                    >
                      {fmtNum(r.composite_score, 0)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={signalVariant(r.signal)}>{signalLabel(r.signal)}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs text-neutral-500">
                      {fmtDate(r.as_of)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>
          Page {currentPage} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
