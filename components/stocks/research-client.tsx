'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { csvFilename, toCsv } from '@/lib/research/export';
import {
  TIME_PRESETS,
  WEEKDAYS,
  hhmmToMinutes,
  inTimeRange,
  marketDate,
  marketMoment,
} from '@/lib/research/market-time';

interface Props {
  initialRows: ResearchRow[];
  loadError: string | null;
  uwConfigured: boolean;
}

type Progress = { label: string; done: number; total: number; note?: string } | null;

const REQUEST_TIMEOUT_MS = 90_000;

/** POST JSON with a timeout, retrying a few times on network trouble. */
async function postJson(
  url: string,
  body: unknown,
  attempts = 3
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;

      // A gateway timeout answers with an HTML page, not JSON. That is worth
      // another go; a 4xx is the server saying no, and is not.
      if (!parsed || (res.status >= 500 && attempt < attempts - 1)) {
        if (attempt < attempts - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt * 2 + 1)));
          continue;
        }
        return {
          ok: false,
          status: res.status,
          body: {
            error:
              parsed?.error ??
              `The server returned ${res.status} without a usable response. Progress is saved — click again to carry on.`,
          },
        };
      }

      return { ok: res.ok, status: res.status, body: parsed };
    } catch (e) {
      lastError = e;
      // Back off before trying again: 1s, then 3s.
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt * 2 + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const message =
    lastError instanceof DOMException && lastError.name === 'AbortError'
      ? 'The request timed out. Progress is saved — click again to carry on where it left off.'
      : 'Network error. Progress is saved — click again to carry on where it left off.';
  return { ok: false, status: 0, body: { error: message } };
}

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
  const [stale, setStale] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(300);
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

    // Everything in the pull form doubles as a filter on the rows already
    // loaded, so narrowing the form narrows the table without a refetch.
    const tickerSet = new Set(
      tickers
        .split(/[\s,]+/)
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean)
    );
    const needsDate = Boolean(newerThan || olderThan);

    return rows.filter((r) => {
      if (tickerSet.size > 0 && !tickerSet.has(r.ticker.toUpperCase())) return false;
      if (action && r.action !== action) return false;
      if (recommendation && r.recommendation !== recommendation) return false;

      if (needsDate) {
        // Compared on the market-time date, like the weekday and session filters.
        const day = marketDate(r.rated_at);
        if (!day) return false;
        if (newerThan && day < newerThan) return false;
        if (olderThan && day > olderThan) return false;
      }

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
  }, [
    rows,
    tickers,
    action,
    recommendation,
    newerThan,
    olderThan,
    firm,
    sector,
    analyst,
    minCap,
    maxCap,
    minUpside,
    weekdays,
    timeFrom,
    timeTo,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize]
  );

  // Changing what is filtered can leave you past the end of the results.
  useEffect(() => {
    setPage(1);
  }, [
    rows,
    tickers,
    action,
    recommendation,
    newerThan,
    olderThan,
    firm,
    sector,
    analyst,
    minCap,
    maxCap,
    minUpside,
    weekdays,
    timeFrom,
    timeTo,
    pageSize,
  ]);

  /** Selected rows, or everything currently filtered when nothing is ticked. */
  const targetRows = useMemo(
    () => (selected.size > 0 ? filtered.filter((r) => selected.has(r.event_key)) : filtered),
    [filtered, selected]
  );

  /**
   * Reload the table. A failure here used to be invisible: the fetch would
   * return something unparseable, `rows` kept its old value, and the header
   * quietly showed a stale count with no hint that the table was out of date.
   * Now it retries, and says so when it can't.
   */
  const refresh = useCallback(async (runId?: string): Promise<boolean> => {
    // Send the pull filters along: the table can only filter rows it has, so
    // asking for "the newest N" would hide anything older that was just pulled.
    const base = new URLSearchParams();
    if (runId) base.set('runId', runId);
    if (newerThan) base.set('from', newerThan);
    if (olderThan) base.set('to', olderThan);
    if (tickers.trim()) base.set('tickers', tickers);
    if (action) base.set('action', action);
    if (recommendation) base.set('rating', recommendation);

    const PAGE = 1000;
    const HARD_CAP = 20000;
    const collected: ResearchRow[] = [];

    // Walk every page that matches, so filtering and export see the whole set
    // rather than whatever happened to fit in the first response.
    for (let offset = 0; offset < HARD_CAP; offset += PAGE) {
      const params = new URLSearchParams(base);
      params.set('limit', String(PAGE));
      params.set('offset', String(offset));

      type RowsPage = { rows?: unknown; total?: number; hasMore?: boolean };
      let page: RowsPage | null = null;

      for (let attempt = 0; attempt < 3 && !page; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const res = await fetch(`/api/research/rows?${params.toString()}`, {
            signal: controller.signal,
          });
          const body = (await res.json().catch(() => null)) as RowsPage | null;
          if (res.ok && body && Array.isArray(body.rows)) page = body;
        } catch {
          // Retry below.
        } finally {
          clearTimeout(timer);
        }
        if (!page && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt * 2 + 1)));
        }
      }

      if (!page) {
        // Keep whatever pages did arrive rather than throwing the lot away.
        if (collected.length > 0) {
          setRows(collected);
          setTruncated(true);
          setStale(false);
          return true;
        }
        setStale(true);
        return false;
      }

      collected.push(...(page.rows as ResearchRow[]));
      if (collected.length > PAGE) setProgress({
        label: 'Loading ratings',
        done: collected.length,
        total: page.total ?? collected.length,
      });
      if (!page.hasMore) break;
    }

    setRows(collected);
    setTruncated(collected.length >= HARD_CAP);
    setStale(false);
    setProgress(null);
    return true;
  }, [newerThan, olderThan, tickers, action, recommendation]);

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
      let stalledPasses = 0;
      let consecutiveFailures = 0;

      for (let guard = 0; guard < 400; guard++) {
        setProgress({
          label: kind === 'prices' ? 'Pulling price history' : 'Pulling TipRanks',
          done,
          total,
          note: stalledPasses > 0 ? 'retrying…' : undefined,
        });

        const res = await postJson(
          '/api/research/enrich',
          kind === 'prices'
            ? { kind, eventKeys, batchSize: 10 }
            : { kind, tickers: tickerList, batchSize: 10 }
        );
        const body = res.body as {
          fetched?: number;
          cached?: number;
          failed?: number;
          remaining?: number;
          errors?: { ticker: string; error: string }[];
          error?: string;
        };

        if (!res.ok) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            setError(
              `${body.error ?? 'Enrichment failed.'} Stopped at ${done} of ${total}; progress is saved, so clicking again resumes.`
            );
            break;
          }
          // Give it a moment and try the same slice again.
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        consecutiveFailures = 0;

        fetched += body.fetched ?? 0;
        cached += body.cached ?? 0;
        failed += body.failed ?? 0;
        if (!firstError && body.errors && body.errors.length > 0) {
          firstError = `${body.errors[0].ticker}: ${body.errors[0].error}`;
        }

        const previousDone = done;
        done = Math.max(0, total - (body.remaining ?? 0));
        if ((body.remaining ?? 0) <= 0) break;

        // A pass that moves nothing means the remaining rows can't be
        // satisfied — stop rather than spin, and say so.
        stalledPasses = done > previousDone ? 0 : stalledPasses + 1;
        if (stalledPasses >= 3) {
          setError(
            `Stopped at ${done} of ${total}: the last three passes made no progress, so the rest can't be completed right now. ${failed > 0 ? `${failed} failed${firstError ? ` — first: ${firstError}` : ''}.` : ''}`
          );
          break;
        }
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

  const exportCsv = () => {
    if (targetRows.length === 0) {
      setError('Nothing to export — no rows match these filters.');
      return;
    }
    setError(null);

    const csv = toCsv(targetRows);
    const name = csvFilename(
      {
        tickers,
        action,
        recommendation,
        from: newerThan,
        to: olderThan,
        firm,
        sector,
        analyst,
        weekdays: WEEKDAYS.filter((d) => weekdays.has(d.value)).map((d) => d.label),
        timeFrom,
        timeTo,
      },
      targetRows.length
    );

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the download a tick to start before the blob goes away.
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setMessage(
      `Exported ${targetRows.length.toLocaleString()} row${targetRows.length === 1 ? '' : 's'} to ${name}`
    );
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
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={targetRows.length === 0}
            title="Download every row these filters show - all pages, not just this one"
          >
            Export CSV ({targetRows.length.toLocaleString()})
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
      {truncated ? (
        <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-400">
          Showing the newest {rows.length.toLocaleString()} matching ratings — there are
          more in the database. Narrow the date range to reach older ones.
        </div>
      ) : null}
      {stale ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          <span>
            The table below could not be reloaded, so it may be out of date — the pull
            itself is saved.
          </span>
          <Button variant="outline" size="sm" onClick={() => refresh()}>
            Reload table
          </Button>
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
          {progress.note ? <span className="ml-2 text-amber-400">{progress.note}</span> : null}
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
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-wide text-neutral-600">
              Sent to Unusual Whales
            </span>
            <span className="text-[10px] text-neutral-600">
              — and applied to the table below, so narrowing these filters the rows you
              already have
            </span>
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

          <div className="flex flex-wrap items-baseline gap-2 border-t border-neutral-800 pt-3">
            <span className="text-[10px] uppercase tracking-wide text-neutral-600">
              Table only — no API calls
            </span>
            <span className="text-[10px] text-neutral-600">
              — Unusual Whales can&apos;t filter on these, so they apply to loaded rows
            </span>
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
                setTickers('');
                setAction('');
                setRecommendation('');
                setNewerThan('');
                setOlderThan('');
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
              Clear all filters
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
              {pageRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={30} className="py-8 text-center text-xs text-neutral-500">
                    No ratings yet. Set your filters and hit <strong>Pull ratings</strong>.
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((r) => (
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

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-400">
        <div className="flex items-center gap-2">
          <span>
            {filtered.length === 0
              ? 'No rows'
              : `Rows ${((currentPage - 1) * pageSize + 1).toLocaleString()}-${Math.min(
                  currentPage * pageSize,
                  filtered.length
                ).toLocaleString()} of ${filtered.length.toLocaleString()}`}
          </span>
          <span className="text-neutral-600">|</span>
          <label className="flex items-center gap-1.5">
            <span className="text-neutral-500">Per page</span>
            <Select
              value={String(pageSize)}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-7 w-20 text-xs"
            >
              {[100, 300, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(1)}>
            First
          </Button>
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
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => setPage(totalPages)}
          >
            Last
          </Button>
        </div>
      </div>
    </div>
  );
}
