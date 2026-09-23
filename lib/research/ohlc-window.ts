import { marketToday } from './market-time';

/**
 * The shared daily-bar request for a rating dated `iso`: one six-month series
 * per ticker-month, anchored 45 days past the end of that month so it reaches
 * the +30d window of a rating made on its last day.
 *
 * Kept free of server-only imports so the date arithmetic — the part that has
 * actually broken in production — can be exercised directly in a test.
 */
export function dailyWindowFor(
  iso: string,
  now: Date = new Date()
): { key: string; endDate: string } {
  const month = iso.slice(0, 7);
  const monthEnd = new Date(`${month}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  const reach = new Date(monthEnd.getTime() + 45 * 24 * 3600_000)
    .toISOString()
    .slice(0, 10);

  // Clamped in MARKET time, not UTC. UW rejects an end_date later than the
  // current US/Eastern date ("Input date may not be a future EST date") with a
  // 422, and between 8pm ET and midnight the UTC date is already tomorrow — so
  // a UTC clamp made every OHLC call fail for those four hours every evening.
  // ISO dates compare correctly as strings, so min() is a plain comparison.
  const today = marketToday(now);
  return { key: month, endDate: reach < today ? reach : today };
}
