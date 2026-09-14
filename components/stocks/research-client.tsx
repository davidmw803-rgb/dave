'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  MOVE_WINDOWS,
  RATING_ACTIONS,
  RECOMMENDATIONS,
  type ResearchRow,
} from '@/lib/research/types';
import { fmtPct, fmtPrice, signColor } from '@/lib/stocks/format';
import {
  TIME_PRESETS,
  WEEKDAYS,
  hhmmToMinutes,
  inTimeRange,
  marketMoment,
} from '@/lib/research/market-time';

interface Props {
  initialRows: ResearchRow[];
  loadError: string | null;
  uwConfigured: boolean;
}

type Progress = { label: string; done: number; total: number } | null;

/**
 * Numeric columns can arrive as numbers or as strings depending on the
 * serializer, and a missing column arrives as undefined. Everything numeric
 * goes through here before it is formatted or compared.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtCap(v: unknown): string {
  const n = num(v);
  if (n === null) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

function recVariant(rec: string | null) {
  if (rec === 'buy') return 'success' as const;
  if (rec === 'sell') return 'danger' as const;
  return 'neutral' as const;
}

function actionVariant(action: string | null) {
  if (action === 'upgraded' || action === 'initiated') return 'success' as const;
  if (action === 'downgraded') return 'danger' as const;
  return 'neutral' as const;
}

export function ResearchClient({ initialRows, loadError, uwConfigured }: Props) {
  const [rows, setRows] = useState<ResearchRow[]>(initialRows);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tier 1 — sent to Unusual Whales
  const [tickers, setTickers] = useState('');
  const [action, setAction] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [newerThan, setNewerThan] = useState('');
  const [olderThan, setOlderThan] = useState('');
  const [maxRows, setMaxRows] = useState('1000');

  // Tier 2 + 3 — applied to the rows we hold
  const [firm, setFirm] = useState('');
  const [analyst, setAnalyst] = useState('');
  const [sector, setSector] = useState('');
  const [minCap, setMinCap] = useState('');
  const [maxCap, setMaxCap] = useState('');
  const [minUpside, setMinUpside] = useState('');
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set());
  const [timeFrom, setTimeFrom] = useState('');
  const [timeTo, setTimeTo] = useState('');

  const firms = useMemo(
    () => Array.from(new Set(rows.map((r) => r.firm).filter((f): f is string => !!f))).sort(),
    [rows]
  );
  const sectors = useMemo(
    () => Array.from(new Set(rows.map((r) => r.sector).filter((s): s is string => !!s))).sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const a = analyst.trim().toLowerCase();
    const minC = minCap === '' ? null : Number(minCap);
    const maxC = maxCap === '' ? null : Number(maxCap);
    const minU = minUpside === '' ? null : Number(minUpside);
    const fromMin = timeFrom ? hhmmToMinutes(timeFrom) : null;
    const toMin = timeTo ? hhmmToMinutes(timeTo) : null;
    const needsMoment = weekdays.size > 0 || fromMin !== null || toMin !== null;

    return rows.filter((r) => {
      if (needsMoment) {
        // Weekday and time-of-day are asked in market time, not UTC.
        const moment = marketMoment(r.rated_at);
        if (!moment) return false;
        if (weekdays.size > 0 && !weekdays.has(moment.weekday)) return false;
        if (!inTimeRange(moment.minutes, fromMin, toMin)) return false;
      }
      if (firm && r.firm !== firm) return false;
      if (sector && r.sector !== sector) return false;
      if (a && !`${r.analyst_name ?? ''}`.toLowerCase().includes(a)) return false;
      const cap = num(r.marketcap);
      const up = num(r.upside_pct);
      if (minC !== null && (cap === null || cap < minC)) return false;
      if (maxC !== null && (cap === null || cap > maxC)) return false;
      if (minU !== null && (up === null || up < minU)) return false;
      return true;
    });
  }, [rows, firm, sector, analyst, minCap, maxCap, minUpside, weekdays, timeFrom, timeTo]);

  /** Selected rows, or everything currently filtered when nothing is ticked. */
  const targetRows = useMemo(
    () => (selected.size > 0 ? filtered.filter((r) => selected.has(r.event_key)) : filtered),
    [filtered, selected]
  );

  const refresh = useCallback(async (runId?: string) => {
    const qs = runId ? `?runId=${encodeURIComponent(runId)}` : '';
    const res = await fetch(`/api/research/rows${qs}`);
    const body = await res.json().catch(() => ({}));
    if (Array.isArray(body.rows)) setRows(body.rows as ResearchRow[]);
  }, []);

  const pull = async () => {
    setBusy('pull');
    setError(null);
    setMessage(null);
    setProgress({ label: 'Pulling ratings', done: 0, total: 1 });
    try {
      const res = await fetch('/api/research/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tickers,
          action: action || undefined,
          recommendation: recommendation || undefined,
          newerThan: newerThan || undefined,
          olderThan: olderThan || undefined,
          maxRows: Number(maxRows) || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? 'Pull failed.');
        return;
      }
      setMessage(
        `Pulled ${body.rowsFetched} rows in ${body.apiCalls} API call${body.apiCalls === 1 ? '' : 's'} · ${body.rowsNew} new · ${body.tickers?.length ?? 0} tickers`
      );
      await refreshAnalystsQuietly();
      await refresh();
      setSelected(new Set());
    } catch {
      setError('Network error during the pull.');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  /** Loop the batched enrichment endpoint until it reports nothing remaining. */
  const enrich = async (kind: 'prices' | 'tipranks') => {
    if (targetRows.length === 0) {
      setError('Nothing to enrich — pull some ratings first.');
      return;
    }
    setBusy(kind);
    setError(null);
    setMessage(null);

    const eventKeys = targetRows.map((r) => r.event_key);
    const tickerList = Array.from(new Set(targetRows.map((r) => r.ticker)));
    const total = kind === 'prices' ? eventKeys.length : tickerList.length;

    let fetched = 0;
    let cached = 0;
    let failed = 0;
    let done = 0;
    let firstError: string | null = null;

    try {
      for (let guard = 0; guard < 200; guard++) {
        setProgress({
          label: kind === 'prices' ? 'Pulling price history' : 'Pulling TipRanks',
          done,
          total,
        });

        const res = await fetch('/api/research/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            kind === 'prices'
              ? { kind, eventKeys, batchSize: 20 }
              : { kind, tickers: tickerList, batchSize: 20 }
          ),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(body?.error ?? 'Enrichment failed.');
          break;
        }

        fetched += body.fetched ?? 0;
        cached += body.cached ?? 0;
        failed += body.failed ?? 0;
        if (!firstError && Array.isArray(body.errors) && body.errors.length > 0) {
          firstError = `${body.errors[0].ticker}: ${body.errors[0].error}`;
        }
        done = Math.max(0, total - (body.remaining ?? 0));
        if ((body.remaining ?? 0) <= 0) break;
      }

      // Win rates key off the +1d moves that just landed.
      if (kind === 'prices') await refreshAnalystsQuietly();
      await refresh();
      setMessage(
        `${fetched} fetched · ${cached} already cached · ${failed} failed${firstError ? ` — first error: ${firstError}` : ''}`
      );
    } catch {
      setError('Network error during enrichment.');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  /** One row's worth of enrichment, from the buttons in the row itself. */
  const enrichRow = async (row: ResearchRow, kind: 'prices' | 'tipranks') => {
    setBusy(`${kind}:${row.event_key}`);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/research/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          kind === 'prices'
            ? { kind, eventKeys: [row.event_key], batchSize: 1, force: true }
            : { kind, tickers: [row.ticker], batchSize: 1 }
        ),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? 'Enrichment failed.');
        return;
      }
      if (body.failed > 0 && Array.isArray(body.errors) && body.errors.length > 0) {
        setError(`${body.errors[0].ticker}: ${body.errors[0].error}`);
      } else {
        setMessage(
          `${row.ticker}: ${body.fetched} fetched, ${body.cached} cached`
        );
      }
      await refresh();
    } catch {
      setError('Network error.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Recompute analyst stats. With no keys it refreshes every analyst in the
   * table; with one key it refreshes just that analyst — and because the stats
   * are keyed by analyst, the result lands on every rating they made.
   */
  /** Recompute stats without touching the status line — used after a pull. */
  const refreshAnalystsQuietly = async () => {
    try {
      await fetch('/api/research/analysts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analystKeys: [] }),
      });
    } catch {
      // Stats are a convenience; a failure here shouldn't derail the pull.
    }
  };

  const refreshAnalysts = async (analystKeys?: string[]) => {
    setBusy(analystKeys?.length === 1 ? `analyst:${analystKeys[0]}` : 'analysts');
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/research/analysts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analystKeys: analystKeys ?? [] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? 'Analyst refresh failed.');
        return;
      }
      setMessage(
        `Analyst stats refreshed: ${body.analysts} analyst${body.analysts === 1 ? '' : 's'} · ${body.scoredRatings} scored ratings`
      );
      await refresh();
    } catch {
      setError('Network error.');
    } finally {
      setBusy(null);
    }
  };

  const toggleRow = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map((r) => r.event_key))
    );
  };

  const anyBusy = busy !== null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Analyst rating research</h1>
          <p className="text-xs text-neutral-500">
            Pull ratings from Unusual Whales, then enrich the rows you care about ·{' '}
            {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} rows
            {selected.size > 0 ? ` · ${selected.size} selected` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={pull} disabled={anyBusy || !uwConfigured} size="sm">
            {busy === 'pull' ? 'Pulling…' : 'Pull ratings'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => enrich('prices')}
            disabled={anyBusy || !uwConfigured || filtered.length === 0}
          >
            {busy === 'prices' ? 'Pulling…' : 'Pull price history'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => enrich('tipranks')}
            disabled={anyBusy || filtered.length === 0}
          >
            {busy === 'tipranks' ? 'Pulling…' : 'Pull TipRanks'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshAnalysts()}
            disabled={anyBusy || rows.length === 0}
          >
            {busy === 'analysts' ? 'Refreshing…' : 'Refresh analysts'}
          </Button>
        </div>
      </div>

      {!uwConfigured ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          No Unusual Whales API key yet — add one on <code>/settings</code> and the pull
          buttons switch on.
        </div>
      ) : null}
      {loadError ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          {loadError}
        </div>
      ) : null}
      {error ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
          {message}
        </div>
      ) : null}
      {progress ? (
        <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-300">
          {progress.label}: {progress.done} / {progress.total}
          <div className="mt-2 h-1 w-full overflow-hidden rounded bg-neutral-800">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{
                width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      <Card>
        <CardContent className="space-y-3 p-3">
          <div className="text-[10px] uppercase tracking-wide text-neutral-600">
            Sent to Unusual Whales
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">
                Tickers (blank = whole market)
              </label>
              <Input
                placeholder="AAPL, NVDA, TSLA"
                value={tickers}
                onChange={(e) => setTickers(e.target.value)}
                className="min-w-[14rem]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">Action</label>
              <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-40">
                <option value="">Any</option>
                {RATING_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">Rating</label>
              <Select
                value={recommendation}
                onChange={(e) => setRecommendation(e.target.value)}
                className="w-32"
              >
                <option value="">Any</option>
                {RECOMMENDATIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">From</label>
              <DatePicker
                value={newerThan}
                onChange={setNewerThan}
                max={olderThan || undefined}
                placeholder="Any date"
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">To</label>
              <DatePicker
                value={olderThan}
                onChange={setOlderThan}
                min={newerThan || undefined}
                placeholder="Any date"
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">Max rows</label>
              <Input
                type="number"
                value={maxRows}
                onChange={(e) => setMaxRows(e.target.value)}
                className="w-24"
              />
            </div>
          </div>

          <div className="border-t border-neutral-800 pt-3 text-[10px] uppercase tracking-wide text-neutral-600">
            Filtered here — no API calls
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">Firm</label>
              <Select value={firm} onChange={(e) => setFirm(e.target.value)} className="w-48">
                <option value="">All</option>
                {firms.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">Analyst</label>
              <Input
                placeholder="name contains…"
                value={analyst}
                onChange={(e) => setAnalyst(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">Sector</label>
              <Select value={sector} onChange={(e) => setSector(e.target.value)} className="w-44">
                <option value="">All</option>
                {sectors.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">
                Market cap min / max
              </label>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  placeholder="1000000000"
                  value={minCap}
                  onChange={(e) => setMinCap(e.target.value)}
                  className="w-36"
                />
                <span className="text-neutral-600">–</span>
                <Input
                  type="number"
                  placeholder="3000000000000"
                  value={maxCap}
                  onChange={(e) => setMaxCap(e.target.value)}
                  className="w-40"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">Min upside %</label>
              <Input
                type="number"
                placeholder="0"
                value={minUpside}
                onChange={(e) => setMinUpside(e.target.value)}
                className="w-28"
              />
            </div>
            <p className="text-[10px] text-neutral-600">
              Market cap and upside need price history pulled first.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-4 border-t border-neutral-800 pt-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">
                Day of week{weekdays.size > 0 ? ` · ${weekdays.size} selected` : ' · all'}
              </label>
              <div className="flex items-center gap-1">
                {WEEKDAYS.map((d) => {
                  const on = weekdays.has(d.value);
                  return (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() =>
                        setWeekdays((prev) => {
                          const next = new Set(prev);
                          next.has(d.value) ? next.delete(d.value) : next.add(d.value);
                          return next;
                        })
                      }
                      className={cn(
                        'h-9 w-11 rounded-md border text-xs font-medium transition-colors',
                        on
                          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                          : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
                      )}
                    >
                      {d.label}
                    </button>
                  );
                })}
                {weekdays.size > 0 ? (
                  <button
                    type="button"
                    onClick={() => setWeekdays(new Set())}
                    className="h-9 px-2 text-[11px] text-neutral-500 hover:text-neutral-200"
                  >
                    clear
                  </button>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">
                Time of day (ET)
              </label>
              <div className="flex items-center gap-1">
                <Input
                  type="time"
                  value={timeFrom}
                  onChange={(e) => setTimeFrom(e.target.value)}
                  className="w-28"
                />
                <span className="text-neutral-600">–</span>
                <Input
                  type="time"
                  value={timeTo}
                  onChange={(e) => setTimeTo(e.target.value)}
                  className="w-28"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">Session</label>
              <div className="flex items-center gap-1">
                {TIME_PRESETS.map((preset) => {
                  const active = timeFrom === preset.from && timeTo === preset.to;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => {
                        setTimeFrom(preset.from);
                        setTimeTo(preset.to);
                      }}
                      className={cn(
                        'h-9 rounded-md border px-2.5 text-xs font-medium transition-colors',
                        active
                          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                          : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
                      )}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="self-end"
              onClick={() => {
                setFirm('');
                setAnalyst('');
                setSector('');
                setMinCap('');
                setMaxCap('');
                setMinUpside('');
                setWeekdays(new Set());
                setTimeFrom('');
                setTimeTo('');
              }}
            >
              Reset filters
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-20 w-8 bg-neutral-950">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={filtered.length > 0 && selected.size === filtered.length}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 accent-emerald-500"
                  />
                </TableHead>
                <TableHead className="sticky left-8 z-20 bg-neutral-950">Ticker</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Analyst</TableHead>
                <TableHead>Firm</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead className="text-right">Price @ rating</TableHead>
                <TableHead className="text-right">Current</TableHead>
                <TableHead className="text-right">Upside</TableHead>
                <TableHead className="border-r border-neutral-800 text-right">Since</TableHead>
                {MOVE_WINDOWS.map((w) => (
                  <TableHead key={w} className="whitespace-nowrap text-right">
                    {w.replace('t+', '+')}
                  </TableHead>
                ))}
                <TableHead className="border-l border-neutral-800 text-right">An. n</TableHead>
                <TableHead className="text-right">An. win%</TableHead>
                <TableHead className="border-r border-neutral-800 text-right">An. +1d</TableHead>
                <TableHead>Sector</TableHead>
                <TableHead className="text-right">Mkt cap</TableHead>
                <TableHead>TR</TableHead>
                <TableHead className="text-right">TR PT</TableHead>
                <TableHead className="text-right">Pull</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={30} className="py-8 text-center text-xs text-neutral-500">
                    No ratings yet. Set your filters and hit <strong>Pull ratings</strong>.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.slice(0, 300).map((r) => (
                  <TableRow key={r.event_key} className={cn(selected.has(r.event_key) && 'bg-neutral-900')}>
                    <TableCell className="sticky left-0 z-10 bg-neutral-950">
                      <input
                        type="checkbox"
                        checked={selected.has(r.event_key)}
                        onChange={() => toggleRow(r.event_key)}
                        className="h-3.5 w-3.5 accent-emerald-500"
                      />
                    </TableCell>
                    <TableCell className="sticky left-8 z-10 bg-neutral-950 font-mono text-xs font-semibold text-emerald-400">
                      {r.ticker}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-neutral-400">
                      {new Date(r.rated_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="max-w-[12rem] truncate text-xs text-neutral-300">
                      {r.full_name ?? '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-neutral-300">
                      {r.analyst_name ?? '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-neutral-400">
                      {r.firm ?? '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={actionVariant(r.action)}>{r.action ?? '—'}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={recVariant(r.recommendation)}>
                        {r.recommendation ?? '—'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-neutral-300">
                      {fmtPrice(num(r.target))}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-neutral-300">
                      {fmtPrice(num(r.price_at_rating))}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono tabular-nums text-neutral-100"
                      title={
                        r.current_price_at
                          ? `as of ${new Date(r.current_price_at).toLocaleString()}`
                          : undefined
                      }
                    >
                      {fmtPrice(num(r.current_price))}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono tabular-nums ${signColor(num(r.upside_pct))}`}
                    >
                      {fmtPct(num(r.upside_pct))}
                    </TableCell>
                    <TableCell
                      className={`border-r border-neutral-800 text-right font-mono tabular-nums ${signColor(num(r.move_since_rating_pct))}`}
                    >
                      {fmtPct(num(r.move_since_rating_pct))}
                    </TableCell>
                    {MOVE_WINDOWS.map((w) => {
                      const cell = r.moves?.[w];
                      const pct = num(cell?.pct);
                      const cellPrice = num(cell?.price);
                      return (
                        <TableCell
                          key={w}
                          className={`text-right font-mono tabular-nums ${signColor(pct)}`}
                          title={cellPrice !== null ? `${fmtPrice(cellPrice)} at ${w}` : undefined}
                        >
                          {fmtPct(pct)}
                        </TableCell>
                      );
                    })}
                    <TableCell className="border-l border-neutral-800 text-right font-mono tabular-nums text-neutral-400">
                      {r.analyst_ratings_count ?? '—'}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono tabular-nums text-neutral-300"
                      title={
                        r.analyst_scored_ratings
                          ? `${r.analyst_scored_ratings} scored ratings`
                          : undefined
                      }
                    >
                      {num(r.analyst_win_rate_1d) === null
                        ? '—'
                        : `${num(r.analyst_win_rate_1d)!.toFixed(0)}%`}
                    </TableCell>
                    <TableCell
                      className={`border-r border-neutral-800 text-right font-mono tabular-nums ${signColor(num(r.analyst_avg_move_1d))}`}
                    >
                      {fmtPct(num(r.analyst_avg_move_1d))}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-neutral-400">
                      {r.sector ?? '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-neutral-300">
                      {fmtCap(r.marketcap)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-neutral-400">
                      {r.tr_consensus ?? '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-neutral-300">
                      {fmtPrice(num(r.tr_price_target))}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => enrichRow(r, 'prices')}
                          disabled={anyBusy}
                          title="Pull price history for this rating"
                          className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-40"
                        >
                          {busy === `prices:${r.event_key}` ? '…' : r.has_prices ? '↻ px' : 'px'}
                        </button>
                        <button
                          onClick={() => enrichRow(r, 'tipranks')}
                          disabled={anyBusy}
                          title="Pull TipRanks for this ticker"
                          className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-40"
                        >
                          {busy === `tipranks:${r.event_key}` ? '…' : r.has_tipranks ? '↻ TR' : 'TR'}
                        </button>
                        <button
                          onClick={() => r.analyst_key && refreshAnalysts([r.analyst_key])}
                          disabled={anyBusy || !r.analyst_key}
                          title="Refresh this analyst's stats — updates every rating they made"
                          className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-40"
                        >
                          {busy === `analyst:${r.analyst_key}` ? '…' : r.has_analyst ? '↻ an' : 'an'}
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {filtered.length > 300 ? (
        <p className="text-xs text-neutral-500">
          Showing the first 300 of {filtered.length.toLocaleString()} rows. Narrow the
          filters to see the rest — enrichment still applies to all{' '}
          {targetRows.length.toLocaleString()}.
        </p>
      ) : null}
    </div>
  );
}
