import { createHash } from 'node:crypto';

/**
 * Stable identity for a rating. Built only from what the rating *is*, never
 * from when or how it was fetched, so the same rating surfacing under a
 * different filter resolves to the same row.
 */
export function ratingEventKey(input: {
  ticker: string;
  analyst_name?: string | null;
  firm?: string | null;
  action?: string | null;
  recommendation?: string | null;
  target?: number | null;
  rated_at: string;
}): string {
  const parts = [
    input.ticker.trim().toUpperCase(),
    (input.analyst_name ?? '').trim().toLowerCase(),
    (input.firm ?? '').trim().toLowerCase(),
    (input.action ?? '').trim().toLowerCase(),
    (input.recommendation ?? '').trim().toLowerCase(),
    input.target === null || input.target === undefined ? '' : String(input.target),
    new Date(input.rated_at).toISOString(),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** Stable hash of a pull's filters, so identical pulls are recognisable. */
export function paramsHash(params: Record<string, unknown>): string {
  const normalized = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
