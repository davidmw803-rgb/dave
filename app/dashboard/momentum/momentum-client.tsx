'use client';

import { useState } from 'react';
import { analyze, parseOhlcCsv, type Candle, type MomentumReport } from '@/lib/momentum/analyze';

type Source = 'live' | 'csv';

const INTERVALS = ['1d', '1h', '30m', '15m', '5m', '1m'] as const;
type Interval = (typeof INTERVALS)[number];

export function MomentumClient() {
  const [source, setSource] = useState<Source>('live');
  const [symbol, setSymbol] = useState('BTC-USD');
  const [interval, setInterval] = useState<Interval>('1d');
  const [limit, setLimit] = useState(365);
  const [keepDojis, setKeepDojis] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<MomentumReport | null>(null);
  const [label, setLabel] = useState<string>('');

  async function runLive() {
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const bars = Math.min(Math.max(limit, 2), 5000);
      const url = `/api/momentum/klines?symbol=${encodeURIComponent(
        symbol.toUpperCase()
      )}&interval=${interval}&bars=${bars}`;
      const res = await fetch(url);
      const body = (await res.json()) as
        | { error: string; attempts?: { provider: string; error: string }[] }
        | { candles: Candle[]; count: number; provider: string };
      if (!res.ok || 'error' in body) {
        const msg = 'error' in body ? body.error : `Request failed: ${res.status}`;
        const details =
          'attempts' in body && body.attempts
            ? ' — ' + body.attempts.map((a) => `${a.provider}: ${a.error}`).join('; ')
            : '';
        throw new Error(msg + details);
      }
      if (body.candles.length === 0) throw new Error('No candles returned.');
      const r = analyze(body.candles, !keepDojis);
      setReport(r);
      setLabel(
        `${symbol.toUpperCase()} (${interval}, ${body.candles.length} bars · ${body.provider})`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleCsv(file: File) {
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const text = await file.text();
      const candles = parseOhlcCsv(text);
      const r = analyze(candles, !keepDojis);
      setReport(r);
      setLabel(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-400">
          <button
            onClick={() => setSource('live')}
            className={`rounded px-2 py-1 ${
              source === 'live' ? 'bg-neutral-800 text-white' : 'text-neutral-500'
            }`}
          >
            Live (Yahoo / Coinbase)
          </button>
          <button
            onClick={() => setSource('csv')}
            className={`rounded px-2 py-1 ${
              source === 'csv' ? 'bg-neutral-800 text-white' : 'text-neutral-500'
            }`}
          >
            CSV Upload
          </button>
        </div>

        {source === 'live' ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <LabeledInput
              label="Symbol"
              value={symbol}
              onChange={(v) => setSymbol(v)}
              placeholder="BTC-USD, SPY, AAPL"
            />
            <LabeledSelect
              label="Interval"
              value={interval}
              onChange={(v) => setInterval(v as Interval)}
              options={INTERVALS as readonly string[]}
            />
            <LabeledInput
              label="Bars"
              value={String(limit)}
              onChange={(v) => setLimit(Math.floor(Number(v) || 0))}
              placeholder="365"
              type="number"
            />
            <div className="flex items-end">
              <button
                onClick={runLive}
                disabled={loading}
                className="w-full rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {loading ? 'Running...' : 'Fetch & analyze'}
              </button>
            </div>
            <label className="col-span-full flex items-center gap-2 text-sm text-neutral-400">
              <input
                type="checkbox"
                checked={keepDojis}
                onChange={(e) => setKeepDojis(e.target.checked)}
              />
              Keep doji candles (zero body)
            </label>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-neutral-400">
              Upload a CSV with <code>open</code> and <code>close</code> columns.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleCsv(f);
              }}
              className="block text-sm text-neutral-300 file:mr-3 file:rounded file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-white hover:file:bg-emerald-500"
            />
            <label className="flex items-center gap-2 text-sm text-neutral-400">
              <input
                type="checkbox"
                checked={keepDojis}
                onChange={(e) => setKeepDojis(e.target.checked)}
              />
              Keep doji candles (zero body)
            </label>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">
            {error}
          </div>
        )}
      </section>

      {report && <Report report={report} label={label} />}
    </div>
  );
}

function Report({ report: r, label }: { report: MomentumReport; label: string }) {
  const edge = r.hitRateFollowPrev - 0.5;
  const verdictPositive = r.strategyExpectancy > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-semibold">{label}</h3>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            verdictPositive
              ? 'bg-emerald-900/40 text-emerald-300'
              : 'bg-red-900/40 text-red-300'
          }`}
        >
          {verdictPositive ? 'POSITIVE expectancy' : 'NEGATIVE expectancy'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="Candles" value={String(r.nCandles)} />
        <Kpi
          label="Hit rate (follow prev)"
          value={formatPct(r.hitRateFollowPrev)}
          sub={`${edge >= 0 ? '+' : ''}${formatPct(edge)} vs coinflip`}
        />
        <Kpi label="Expectancy" value={formatNum(r.strategyExpectancy)} />
        <Kpi label="Avg P&L / bet" value={formatNum(r.strategyAvgPnlPerBet)} />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
          <h4 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
            Conditional probabilities
          </h4>
          <Row label="P(up | prev up)" value={formatPct(r.pUpGivenPrevUp)} />
          <Row label="P(down | prev down)" value={formatPct(r.pDownGivenPrevDown)} />
          <Row label="Base rate up" value={formatPct(r.baseRateUp)} />
          <Row label="Base rate down" value={formatPct(r.baseRateDown)} />
          <Row label="Longest up run" value={String(r.longestUpRun)} />
          <Row label="Longest down run" value={String(r.longestDownRun)} />
        </section>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
          <h4 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
            Transition matrix
          </h4>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-2 text-left"></th>
                <th className="py-2 text-right">Next up</th>
                <th className="py-2 text-right">Next down</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              <tr>
                <td className="py-2 text-neutral-400">Prev up</td>
                <td className="py-2 text-right text-emerald-300">{r.uu}</td>
                <td className="py-2 text-right text-red-300">{r.ud}</td>
              </tr>
              <tr>
                <td className="py-2 text-neutral-400">Prev down</td>
                <td className="py-2 text-right text-emerald-300">{r.du}</td>
                <td className="py-2 text-right text-red-300">{r.dd}</td>
              </tr>
            </tbody>
          </table>
          <h4 className="mb-2 mt-4 text-sm font-semibold uppercase tracking-wide text-neutral-400">
            Strategy P&L
          </h4>
          <Row label="Win rate" value={formatPct(r.strategyWinRate)} />
          <Row label="Avg win" value={formatNum(r.strategyAvgWin)} />
          <Row label="Avg loss" value={formatNum(r.strategyAvgLoss)} />
        </section>
      </div>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
        <h4 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
          Candle direction sequence
        </h4>
        <DirectionStrip directions={r.directions} />
      </section>
    </div>
  );
}

function DirectionStrip({ directions }: { directions: (-1 | 0 | 1)[] }) {
  return (
    <div className="flex h-10 w-full overflow-hidden rounded border border-neutral-800">
      {directions.map((d, i) => (
        <div
          key={i}
          className={`h-full flex-1 ${
            d === 1 ? 'bg-emerald-500' : d === -1 ? 'bg-red-500' : 'bg-neutral-600'
          }`}
          title={`#${i + 1}: ${d === 1 ? 'Up' : d === -1 ? 'Down' : 'Doji'}`}
        />
      ))}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-neutral-400">{label}</span>
      <span className="text-neutral-100">{value}</span>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-emerald-600 focus:outline-none"
      />
    </label>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-emerald-600 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatPct(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(1)}%`;
}

function formatNum(x: number): string {
  if (!Number.isFinite(x)) return '—';
  const sign = x > 0 ? '+' : '';
  return `${sign}${x.toFixed(4)}`;
}
