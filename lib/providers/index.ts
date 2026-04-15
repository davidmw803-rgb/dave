import type { PriceProvider } from './price-provider';
import { MockPriceProvider } from './mock-provider';

let cached: PriceProvider | null = null;

/**
 * Returns the configured PriceProvider based on PRICE_PROVIDER env var.
 * Cached per process. Session 1 only supports 'mock'.
 */
export function getPriceProvider(): PriceProvider {
  if (cached) return cached;

  const which = (process.env.PRICE_PROVIDER ?? 'mock').toLowerCase();

  switch (which) {
    case 'mock':
      cached = new MockPriceProvider();
      return cached;
    case 'polygon':
      throw new Error('PolygonPriceProvider not implemented yet (Session 5).');
    case 'databento':
      throw new Error('DatabentoPriceProvider not implemented yet (Session 5+).');
    default:
      throw new Error(`Unknown PRICE_PROVIDER: ${which}`);
  }
}

export type { PriceProvider, Bar, PricePoint, Granularity } from './price-provider';
