/**
 * Whether a failed call is worth remembering.
 *
 * The only honest "no" from an upstream is 404: that ticker has no data, and
 * asking again in a minute will not change it. Everything else is either a
 * statement about right now (429, 5xx, a dropped connection) or a statement
 * about OUR request (400, 422) — and caching either one turns a passing
 * problem into a stuck one.
 *
 * This is not hypothetical. A UW `end_date` built from the UTC clock 422'd
 * every evening between 8pm ET and midnight; those 422s were cached, so the
 * passes that followed replayed the stored error instead of retrying and
 * reported `fetched: 0, failed: 110` without making a single call. The bug
 * was in the request, and the cache was hiding it.
 */
export function shouldCacheFailure(e: unknown): boolean {
  const err = e as { retryable?: boolean; status?: number } | null;
  if (!err) return false;
  if (err.retryable === true) return false;
  return err.status === 404;
}

/** How long a remembered failure stays remembered. */
export const NEGATIVE_TTL_MS = 5 * 60 * 1000;
