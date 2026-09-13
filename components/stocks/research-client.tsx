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
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { RATING_ACTIONS, RECOMMENDATIONS, type ResearchRow } from '@/lib/research/types';
import { fmtPct, fmtPrice, signColor } from '@/lib/stocks/format';

interface Props {
  initialRows: ResearchRow[];
  loadError: string | null;
  uwConfigured: boolean;
}

type Progress = { label: string; done: number; total: number } | null;

function fmtCap(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
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

    return rows.filter((r) => {
      if (firm && r.firm !== firm) return false;
      if (sector && r.sector !== sector) return false;
      if (a && !`${r.analyst_name ?? ''}`.toLowerCase().includes(a)) return false;
      if (minC !== null && (r.marketcap === null || r.marketcap < minC)) return false;
      if (maxC !== null && (r.marketcap === null || r.marketcap > maxC)) return false;
      if (minU !== null && (r.upside_pct === null || r.upside_pct < minU)) return false;
      return true;
    });
  }, [rows, firm, sector, analyst, minCap, maxCap, minUpside]);

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
              <Input
                type="date"
                value={newerThan}
                onChange={(e) => setNewerThan(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase text-neutral-500">To</label>
              <Input
                type="date"
                value={olderThan}
                onChange={(e) => setOlderThan(e.target.value)}
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
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={filtered.length > 0 && selected.size === filtered.length}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 accent-emerald-500"
                  />
                </TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Ticker</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Analyst</TableHead>
                <TableHead>Firm</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Upside</TableHead>
                <TableHead className="text-right">+1d</TableHead>
                <TableHead className="text-right">+5d</TableHead>
                <TableHead className="text-right">+30d</TableHead>
                <TableHead>Sector</TableHead>
                <TableHead className="text-right">Mkt cap</TableHead>
                <TableHead>TR</TableHead>
                <TableHead className="text-right">TR PT</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={18} className="py-8 text-center text-xs text-neutral-500">
                    No ratings yet. Set your filters and hit <strong>Pull ratings</strong>.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.slice(0, 300).map((r) => (
                  <TableRow key={r.event_key} className={cn(selected.has(r.event_key) && 'bg-neutral-900')}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(r.event_key)}
                        onChange={() => toggleRow(r.event_key)}
                        className="h-3.5 w-3.5 accent-emerald-500"
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-neutral-400">
                      {new Date(r.rated_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs font-semibold text-emerald-400">
                      {r.ticker}
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
                      {fmtPrice(r.target)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-neutral-300">
                      {fmtPrice(r.last_price)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono tabular-nums ${signColor(r.upside_pct)}`}
                    >
                      {fmtPct(r.upside_pct)}
                    </TableCell>
                    <TableCell className={`text-right font-mono tabular-nums ${signColor(r.move_1d_pct)}`}>
                      {fmtPct(r.move_1d_pct)}
                    </TableCell>
                    <TableCell className={`text-right font-mono tabular-nums ${signColor(r.move_5d_pct)}`}>
                      {fmtPct(r.move_5d_pct)}
                    </TableCell>
                    <TableCell className={`text-right font-mono tabular-nums ${signColor(r.move_30d_pct)}`}>
                      {fmtPct(r.move_30d_pct)}
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
                      {fmtPrice(r.tr_price_target)}
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
