/**
 * PriceProvider — source-agnostic interface for historical and current price data.
 *
 * Implementations in this folder:
 *   - mock-provider.ts       (Session 1, deterministic synthetic data for testing)
 *   - polygon-provider.ts    (Session 5, real implementation)
 *   - databento-provider.ts  (Session 5+, optional)
 *
 * Use getPriceProvider() from ./index.ts — never instantiate directly.
 */

export type Bar = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type PricePoint = {
  timestamp: Date;
  price: number;
  volume?: number;
};

export type Granularity = 'second' | 'minute' | 'daily';

export interface PriceProvider {
  /** Identifier for logging and DB attribution. */
  name(): string;

  /** Single price at a specific timestamp (uses nearest bar). */
  getPriceAt(ticker: string, timestamp: Date): Promise<PricePoint>;

  /** Range of bars at the requested granularity. */
  getBars(
    ticker: string,
    from: Date,
    to: Date,
    granularity: Granularity
  ): Promise<Bar[]>;

  /** Daily close on a specific date. Throws if the date wasn't a trading day. */
  getDailyClose(ticker: string, date: Date): Promise<number>;

  /**
   * Close price N trading days after fromDate (skips weekends/holidays).
   * Used for the t+5d drift exit.
   */
  getTradingDayClose(
    ticker: string,
    fromDate: Date,
    nTradingDaysAfter: number
  ): Promise<PricePoint>;
}
