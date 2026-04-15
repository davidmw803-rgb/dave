/**
 * MockPriceProvider — deterministic synthetic price data for development and testing.
 * Generates a sine wave + small noise component, seeded by ticker symbol so the same
 * ticker always returns the same prices. Useful for building strategy math and chart
 * UI before wiring a real provider.
 */

import type { Bar, Granularity, PricePoint, PriceProvider } from './price-provider';

const MS_PER_MIN = 60_000;
const MS_PER_SEC = 1_000;
const MS_PER_DAY = 86_400_000;

function hashTicker(ticker: string): number {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) {
    h = (h * 31 + ticker.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function syntheticPrice(ticker: string, timestamp: Date): number {
  const seed = hashTicker(ticker);
  const base = 50 + (seed % 400); // base price between $50 and $450
  const t = timestamp.getTime() / MS_PER_DAY;
  const slowWave = Math.sin(t / 30) * (base * 0.15); // ~30-day cycle
  const fastWave = Math.sin(t * 6) * (base * 0.02);  // intraday wiggle
  const noise = (Math.sin(seed + t * 1000) * 0.5) * (base * 0.005);
  return Math.max(1, base + slowWave + fastWave + noise);
}

function granularityMs(g: Granularity): number {
  switch (g) {
    case 'second': return MS_PER_SEC;
    case 'minute': return MS_PER_MIN;
    case 'daily':  return MS_PER_DAY;
  }
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

export class MockPriceProvider implements PriceProvider {
  name(): string {
    return 'mock';
  }

  async getPriceAt(ticker: string, timestamp: Date): Promise<PricePoint> {
    return {
      timestamp,
      price: syntheticPrice(ticker, timestamp),
      volume: 1000 + (hashTicker(ticker) % 10_000),
    };
  }

  async getBars(
    ticker: string,
    from: Date,
    to: Date,
    granularity: Granularity
  ): Promise<Bar[]> {
    const step = granularityMs(granularity);
    const bars: Bar[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += step) {
      const ts = new Date(t);
      if (granularity === 'daily' && isWeekend(ts)) continue;
      const p = syntheticPrice(ticker, ts);
      const wiggle = p * 0.003;
      bars.push({
        timestamp: ts,
        open: p - wiggle,
        high: p + wiggle,
        low: p - wiggle * 1.2,
        close: p,
        volume: 1000 + (hashTicker(ticker + ts.toISOString()) % 50_000),
      });
    }
    return bars;
  }

  async getDailyClose(ticker: string, date: Date): Promise<number> {
    if (isWeekend(date)) {
      throw new Error(`MockPriceProvider: ${date.toISOString()} is a weekend`);
    }
    return syntheticPrice(ticker, date);
  }

  async getTradingDayClose(
    ticker: string,
    fromDate: Date,
    nTradingDaysAfter: number
  ): Promise<PricePoint> {
    let d = new Date(fromDate);
    let added = 0;
    while (added < nTradingDaysAfter) {
      d = new Date(d.getTime() + MS_PER_DAY);
      if (!isWeekend(d)) added++;
    }
    return {
      timestamp: d,
      price: syntheticPrice(ticker, d),
    };
  }
}
