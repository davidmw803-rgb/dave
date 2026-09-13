import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSetting } from '@/lib/settings/store';
import { TTL, callKey, getOrFetch } from './cache';
import type { EnrichResult } from './types';

/**
 * TipRanks enrichment.
 *
 * TipRanks has no single public API — the request shape depends on which
 * product the key belongs to (Enterprise REST, a partner feed, or the site's
 * own endpoints), so the request itself is the one piece left to fill in.
 * Everything around it is real: the cache key, the TTL, the batching, the
 * upsert into `tipranks_research`, and the parse of the response into columns.
 *
 * To finish it, implement `fetchTipranks` below against your docs. Nothing else
 * needs to change.
 */

export const TIPRANKS_NOT_CONFIGURED =
  'TipRanks is not wired up yet: add the key on /settings and fill in fetchTipranks() in lib/research/tipranks.ts with the request shape from your TipRanks docs.';

export interface TipranksPayload {
  consensus?: string | null;         // strong_buy | buy | hold | sell | strong_sell
  analyst_count?: number | null;
  star_rating?: number | null;       // 0-5
  price_target?: number | null;
  upside_pct?: number | null;
  success_rate?: number | null;      // %
  avg_return?: number | null;        // %
  [k: string]: unknown;
}

async function fetchTipranks(
  ticker: string,
  creds: { apiKey: string; baseUrl: string }
): Promise<TipranksPayload> {
  // Placeholder. Replace the path and the response mapping with the real ones.
  // The client-side plumbing (auth header, cache, error handling) is here so
  // that filling this in is a one-function change.
  throw new Error(
    `${TIPRANKS_NOT_CONFIGURED} (would call ${creds.baseUrl}/… for ${ticker})`
  );
}

function normalizeConsensus(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const allowed = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'];
  return allowed.includes(v) ? v : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function enrichTipranks(
  tickers: string[],
  batchSize = 20
): Promise<EnrichResult> {
  const apiKey = await getSetting('tipranks_api_key');
  if (!apiKey) {
    throw new Error('No TipRanks API key configured. Add one on /settings.');
  }
  const baseUrl = (await getSetting('tipranks_api_base_url')) ?? 'https://api.tipranks.com';
  const creds = { apiKey, baseUrl: baseUrl.replace(/\/$/, '') };

  const supabase = createAdminClient();
  const unique = Array.from(new Set(tickers.map((t) => t.trim().toUpperCase()))).filter(Boolean);

  // Anything fetched inside the TTL is already good.
  const cutoff = new Date(Date.now() - TTL.tipranks).toISOString();
  const { data: fresh } = await supabase
    .from('tipranks_research')
    .select('ticker, fetched_at')
    .in('ticker', unique.slice(0, 1000))
    .gte('fetched_at', cutoff);
  const done = new Set((fresh ?? []).map((r) => r.ticker as string));

  const todo = unique.filter((t) => !done.has(t));
  const batch = todo.slice(0, batchSize);

  let fetched = 0;
  let cached = done.size;
  let failed = 0;
  const errors: { ticker: string; error: string }[] = [];

  for (const ticker of batch) {
    try {
      const res = await getOrFetch<TipranksPayload>(
        callKey('tipranks', 'research', ticker),
        {
          provider: 'tipranks',
          endpoint: 'research',
          args: { ticker },
          ttlMs: TTL.tipranks,
        },
        () => fetchTipranks(ticker, creds)
      );
      res.cached ? cached++ : fetched++;

      const p = res.value;
      const { error } = await supabase.from('tipranks_research').upsert(
        {
          ticker,
          consensus: normalizeConsensus(p.consensus),
          analyst_count: num(p.analyst_count),
          star_rating: num(p.star_rating),
          price_target: num(p.price_target),
          upside_pct: num(p.upside_pct),
          success_rate: num(p.success_rate),
          avg_return: num(p.avg_return),
          payload: p as Record<string, unknown>,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'ticker' }
      );
      if (error) throw new Error(error.message);
    } catch (e) {
      failed++;
      errors.push({ ticker, error: e instanceof Error ? e.message : 'failed' });
    }
  }

  return {
    fetched,
    cached,
    failed,
    remaining: Math.max(0, todo.length - batch.length),
    errors: errors.slice(0, 10),
  };
}
