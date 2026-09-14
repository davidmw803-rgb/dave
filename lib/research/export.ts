import { MOVE_WINDOWS, type ResearchRow } from './types';
import { hhmmToMinutes, marketMoment } from './market-time';

/**
 * CSV of the research table for analysis elsewhere.
 *
 * Values are raw, not display-formatted: percentages are numbers without a `%`,
 * prices are numbers without a `$`, and blanks are empty rather than `—`. The
 * point is that whatever reads this can compute with it.
 *
 * Timestamps are carried three ways — the UTC instant, plus the market date,
 * time, weekday and session — because the interesting questions here are about
 * market time, and re-deriving it from UTC downstream is where mistakes happen.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const PRE_OPEN = hhmmToMinutes('04:00')!;
const OPEN = hhmmToMinutes('09:30')!;
const CLOSE = hhmmToMinutes('16:00')!;
const POST_CLOSE = hhmmToMinutes('20:00')!;

function sessionFor(minutes: number): string {
  if (minutes >= OPEN && minutes < CLOSE) return 'regular';
  if (minutes >= PRE_OPEN && minutes < OPEN) return 'pre-market';
  if (minutes >= CLOSE && minutes < POST_CLOSE) return 'after-hours';
  return 'closed';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Numbers stay numbers; nulls and non-finite values become blank. */
function numCell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '';
  // Trim float noise without losing meaningful precision.
  return String(Math.round(n * 1e6) / 1e6);
}

function textCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function escape(value: string): string {
  if (value === '') return '';
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

interface Column {
  header: string;
  value: (r: ResearchRow) => string;
}

function buildColumns(): Column[] {
  const columns: Column[] = [
    { header: 'ticker', value: (r) => textCell(r.ticker) },
    { header: 'company', value: (r) => textCell(r.full_name) },
    { header: 'sector', value: (r) => textCell(r.sector) },
    { header: 'analyst', value: (r) => textCell(r.analyst_name) },
    { header: 'firm', value: (r) => textCell(r.firm) },
    { header: 'action', value: (r) => textCell(r.action) },
    { header: 'rating', value: (r) => textCell(r.recommendation) },

    { header: 'rated_at_utc', value: (r) => textCell(r.rated_at) },
    {
      header: 'rated_date_et',
      value: (r) => {
        const m = marketMoment(r.rated_at);
        if (!m) return '';
        // Derive the ET date from the same conversion used for filtering.
        const d = new Date(r.rated_at);
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(d);
      },
    },
    {
      header: 'rated_time_et',
      value: (r) => {
        const m = marketMoment(r.rated_at);
        return m ? `${pad(Math.floor(m.minutes / 60))}:${pad(m.minutes % 60)}` : '';
      },
    },
    {
      header: 'weekday_et',
      value: (r) => {
        const m = marketMoment(r.rated_at);
        return m ? DAY_NAMES[m.weekday] : '';
      },
    },
    {
      header: 'session_et',
      value: (r) => {
        const m = marketMoment(r.rated_at);
        return m ? sessionFor(m.minutes) : '';
      },
    },

    { header: 'price_target', value: (r) => numCell(r.target) },
    { header: 'price_at_rating', value: (r) => numCell(r.price_at_rating) },
    { header: 'current_price', value: (r) => numCell(r.current_price) },
    { header: 'upside_pct_vs_current', value: (r) => numCell(r.upside_pct) },
    { header: 'move_since_rating_pct', value: (r) => numCell(r.move_since_rating_pct) },
    { header: 'market_cap', value: (r) => numCell(r.marketcap) },
    { header: 'next_earnings_date', value: (r) => textCell(r.next_earnings_date) },
  ];

  // One column per window: the percentage move from the price at the rating.
  for (const w of MOVE_WINDOWS) {
    const key = w.replace('t+', '').replace('eod', 'eod');
    columns.push({
      header: `move_${key}_pct`,
      value: (r) => numCell(r.moves?.[w]?.pct),
    });
  }

  columns.push(
    { header: 'analyst_ratings_count', value: (r) => numCell(r.analyst_ratings_count) },
    { header: 'analyst_win_rate_1d_pct', value: (r) => numCell(r.analyst_win_rate_1d) },
    { header: 'analyst_avg_move_1d_pct', value: (r) => numCell(r.analyst_avg_move_1d) },
    { header: 'analyst_scored_ratings', value: (r) => numCell(r.analyst_scored_ratings) },
    { header: 'tipranks_consensus', value: (r) => textCell(r.tr_consensus) },
    { header: 'tipranks_price_target', value: (r) => numCell(r.tr_price_target) },
    { header: 'tipranks_success_rate_pct', value: (r) => numCell(r.tr_success_rate) },
    { header: 'tipranks_avg_return_pct', value: (r) => numCell(r.tr_avg_return) },
    { header: 'event_key', value: (r) => textCell(r.event_key) }
  );

  return columns;
}

export function toCsv(rows: ResearchRow[]): string {
  const columns = buildColumns();
  const lines = [columns.map((c) => c.header).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(c.value(row))).join(','));
  }
  // Trailing newline so the last row isn't ambiguous to line-based readers.
  return `${lines.join('\n')}\n`;
}

export interface FilterSummary {
  tickers?: string;
  action?: string;
  recommendation?: string;
  from?: string;
  to?: string;
  firm?: string;
  sector?: string;
  analyst?: string;
  weekdays?: string[];
  timeFrom?: string;
  timeTo?: string;
}

/** A filename that says what the file contains, so downloads stay tellable apart. */
export function csvFilename(filters: FilterSummary, rowCount: number): string {
  const parts = ['analyst-ratings'];

  if (filters.tickers?.trim()) {
    parts.push(
      filters.tickers
        .split(/[\s,]+/)
        .filter(Boolean)
        .slice(0, 3)
        .join('-')
        .toLowerCase()
    );
  }
  if (filters.action) parts.push(filters.action);
  if (filters.recommendation) parts.push(filters.recommendation);
  if (filters.firm) parts.push(filters.firm.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  if (filters.weekdays?.length) parts.push(filters.weekdays.join('').toLowerCase());
  if (filters.timeFrom || filters.timeTo) {
    parts.push(`${filters.timeFrom || 'open'}-${filters.timeTo || 'close'}`.replace(/:/g, ''));
  }
  if (filters.from || filters.to) {
    parts.push(`${filters.from || 'start'}_${filters.to || 'now'}`);
  }

  parts.push(`${rowCount}rows`);

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${parts.join('_').replace(/[^a-zA-Z0-9._-]/g, '')}_${stamp}.csv`;
}
