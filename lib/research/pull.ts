import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  UnusualWhalesClient,
  type AnalystRatingRaw,
  type AnalystScreenerParams,
} from '@/lib/uw/client';
import { paramsHash, ratingEventKey } from './keys';
import type { PullFilters, PullResult } from './types';

const PAGE_SIZE = 500; // UW's maximum
const DEFAULT_MAX_ROWS = 2000;
const MAX_PAGES_PER_TICKER = 20; // hard stop so a bad cursor can't loop forever

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(raw: AnalystRatingRaw) {
  const ticker = (raw.ticker ?? '').trim().toUpperCase();
  const ratedAt = raw.timestamp ? new Date(raw.timestamp) : null;
  if (!ticker || !ratedAt || Number.isNaN(ratedAt.getTime())) return null;

  const row = {
    ticker,
    analyst_name: raw.analyst_name?.trim() || null,
    firm: raw.firm?.trim() || null,
    recommendation: raw.recommendation?.trim().toLowerCase() || null,
    action: raw.action?.trim().toLowerCase() || null,
    sector: raw.sector?.trim() || null,
    target: toNumber(raw.target),
    rated_at: ratedAt.toISOString(),
  };

  return { ...row, event_key: ratingEventKey(row), raw: raw as unknown as Record<string, unknown> };
}

/**
 * Walk one filter combination backwards in time until it runs out of rows or
 * hits the row budget. UW returns newest first and caps at 500 per call, so
 * pagination means moving `older_than` to the oldest row seen.
 */
async function fetchPage(
  client: UnusualWhalesClient,
  params: AnalystScreenerParams
): Promise<AnalystRatingRaw[]> {
  return client.screenerAnalysts({ ...params, limit: PAGE_SIZE });
}

export async function pullRatings(filters: PullFilters): Promise<PullResult> {
  const supabase = createAdminClient();
  const client = await UnusualWhalesClient.create();

  const maxRows = Math.max(1, Math.min(filters.maxRows ?? DEFAULT_MAX_ROWS, 20000));
  const tickers = (filters.tickers ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean);

  const params = {
    tickers: tickers.join(',') || null,
    action: filters.action ?? null,
    recommendation: filters.recommendation ?? null,
    newer_than: filters.newerThan ?? null,
    older_than: filters.olderThan ?? null,
    max_rows: maxRows,
  };

  const { data: runRow, error: runError } = await supabase
    .from('uw_pull_runs')
    .insert({
      source: 'screener_analysts',
      params,
      params_hash: paramsHash(params as Record<string, unknown>),
      status: 'running',
    })
    .select('id')
    .single();

  if (runError || !runRow) {
    throw new Error(`Could not start the pull run: ${runError?.message ?? 'no row'}`);
  }
  const runId = runRow.id as string;

  let apiCalls = 0;
  let rowsFetched = 0;
  const seen = new Map<string, ReturnType<typeof normalizeRow>>();

  try {
    // No ticker filter means one market-wide sweep; otherwise one sweep each.
    const sweeps: (string | undefined)[] = tickers.length > 0 ? tickers : [undefined];

    for (const ticker of sweeps) {
      let cursor = filters.olderThan;
      for (let page = 0; page < MAX_PAGES_PER_TICKER; page++) {
        if (seen.size >= maxRows) break;

        const batch = await fetchPage(client, {
          ticker,
          action: filters.action,
          recommendation: filters.recommendation,
          newer_than: filters.newerThan,
          older_than: cursor,
        });
        apiCalls += 1;
        rowsFetched += batch.length;

        let oldest: string | null = null;
        for (const raw of batch) {
          const row = normalizeRow(raw);
          if (!row) continue;
          seen.set(row.event_key, row);
          if (!oldest || row.rated_at < oldest) oldest = row.rated_at;
        }

        // A short page means the filter is exhausted; no cursor means we can't
        // page further without repeating ourselves.
        if (batch.length < PAGE_SIZE || !oldest) break;
        if (cursor === oldest) break;
        cursor = oldest;
      }
    }

    const rows = Array.from(seen.values()).filter(
      (r): r is NonNullable<typeof r> => r !== null
    );

    // Which of these did we already have? Counted before the upsert so the
    // "new" number means new, not touched.
    let rowsNew = 0;
    if (rows.length > 0) {
      const keys = rows.map((r) => r.event_key);
      const existing = new Set<string>();
      for (let i = 0; i < keys.length; i += 500) {
        const { data } = await supabase
          .from('uw_analyst_ratings')
          .select('event_key')
          .in('event_key', keys.slice(i, i + 500));
        for (const r of data ?? []) existing.add(r.event_key as string);
      }
      rowsNew = keys.filter((k) => !existing.has(k)).length;

      const now = new Date().toISOString();
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, last_seen_at: now }));
        const { error } = await supabase
          .from('uw_analyst_ratings')
          .upsert(chunk, { onConflict: 'event_key' });
        if (error) throw new Error(`Storing ratings failed: ${error.message}`);
      }

      for (let i = 0; i < keys.length; i += 500) {
        const links = keys.slice(i, i + 500).map((event_key) => ({ run_id: runId, event_key }));
        const { error } = await supabase
          .from('uw_pull_run_events')
          .upsert(links, { onConflict: 'run_id,event_key' });
        if (error) throw new Error(`Linking the run failed: ${error.message}`);
      }
    }

    await supabase
      .from('uw_pull_runs')
      .update({
        status: 'done',
        api_calls: apiCalls,
        rows_fetched: rowsFetched,
        rows_new: rowsNew,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);

    return {
      runId,
      apiCalls,
      rowsFetched,
      rowsNew,
      tickers: Array.from(new Set(rows.map((r) => r.ticker))).sort(),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'pull failed';
    await supabase
      .from('uw_pull_runs')
      .update({
        status: 'error',
        error: message,
        api_calls: apiCalls,
        rows_fetched: rowsFetched,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);
    throw e;
  }
}
