import 'server-only';

/**
 * Which index a rating's move should be measured against.
 *
 * A +3% five-day move in a rising market is not a good call. Every forward
 * return in this table is raw, which makes them incomparable across dates —
 * two ratings a month apart are being graded against different markets. The
 * sector ETF is the standard control: it strips out both the market move and
 * the sector rotation, leaving what was specific to the name.
 *
 * The sector strings are Unusual Whales' own (Morningstar-style), and they map
 * one-to-one onto the SPDR sector funds. Anything unmapped falls back to SPY,
 * which is a weaker control but never a wrong one.
 */
const SECTOR_ETF: Record<string, string> = {
  'technology': 'XLK',
  'healthcare': 'XLV',
  'financial services': 'XLF',
  'financial': 'XLF',
  'industrials': 'XLI',
  'consumer cyclical': 'XLY',
  'consumer discretionary': 'XLY',
  'consumer defensive': 'XLP',
  'consumer staples': 'XLP',
  'real estate': 'XLRE',
  'energy': 'XLE',
  'basic materials': 'XLB',
  'materials': 'XLB',
  'communication services': 'XLC',
  'utilities': 'XLU',
};

/** The market-wide fallback, and the benchmark of last resort. */
export const MARKET_ETF = 'SPY';

/** Every ticker this module can ask for, so a warm-up can fetch them once. */
export const BENCHMARK_TICKERS = Array.from(
  new Set([...Object.values(SECTOR_ETF), MARKET_ETF])
).sort();

export function benchmarkFor(sector: string | null | undefined): string {
  if (!sector) return MARKET_ETF;
  return SECTOR_ETF[sector.trim().toLowerCase()] ?? MARKET_ETF;
}
