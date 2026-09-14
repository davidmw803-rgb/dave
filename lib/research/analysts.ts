import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Analyst-level facts, keyed by (name, firm) so they attach to every rating
 * that analyst made rather than being re-derived per row.
 *
 * The stats here are computed from data we already hold — the ratings and the
 * price windows around them — so they cost no API calls and improve as more
 * price history is pulled. TipRanks analyst fields sit alongside them and fill
 * in once that adapter is wired.
 */

export function analystKey(name: string | null, firm: string | null): string | null {
  const n = (name ?? '').trim().toLowerCase();
  if (!n) return null;
  return `${n}|${(firm ?? '').trim().toLowerCase()}`;
}

export interface AnalystRefreshResult {
  analysts: number;
  scoredRatings: number;
}

interface RatingRow {
  event_key: string;
  ticker: string;
  analyst_key: string;
  analyst_name: string | null;
  firm: string | null;
  recommendation: string | null;
  target: number | null;
  rated_at: string;
}

/**
 * Recompute stats for the given analysts (all of them when the list is empty).
 * A "win" is a move that went the way the call did: up for buy, down for sell.
 * Holds are counted in the sample but never as wins or losses.
 */
export async function refreshAnalystStats(
  analystKeys: string[] = []
): Promise<AnalystRefreshResult> {
  const supabase = createAdminClient();

  let q = supabase
    .from('uw_analyst_ratings')
    .select('event_key, ticker, analyst_key, analyst_name, firm, recommendation, target, rated_at')
    .not('analyst_name', 'is', null)
    .limit(20000);
  if (analystKeys.length > 0) q = q.in('analyst_key', analystKeys.slice(0, 500));

  const { data: ratings, error } = await q;
  if (error) throw new Error(error.message);

  const rows = (ratings ?? []) as RatingRow[];
  if (rows.length === 0) return { analysts: 0, scoredRatings: 0 };

  // Price moves for those ratings, plus the ticker prices behind the upside.
  const eventKeys = rows.map((r) => r.event_key);
  const moves = new Map<string, { d1: number | null; d5: number | null }>();
  for (let i = 0; i < eventKeys.length; i += 500) {
    const { data } = await supabase
      .from('uw_event_price_windows')
      .select('event_key, window_label, pct_from_t0')
      .in('event_key', eventKeys.slice(i, i + 500))
      .in('window_label', ['t+1d', 't+5d']);
    for (const row of data ?? []) {
      const key = row.event_key as string;
      const entry = moves.get(key) ?? { d1: null, d5: null };
      const pct = row.pct_from_t0 === null ? null : Number(row.pct_from_t0);
      if (row.window_label === 't+1d') entry.d1 = pct;
      if (row.window_label === 't+5d') entry.d5 = pct;
      moves.set(key, entry);
    }
  }

  const { data: infoRows } = await supabase.from('uw_ticker_info').select('ticker, last_price');
  const priceByTicker = new Map<string, number | null>(
    (infoRows ?? []).map((r) => [r.ticker as string, r.last_price as number | null])
  );

  interface Acc {
    name: string;
    firm: string | null;
    count: number;
    first: string;
    last: string;
    upsides: number[];
    d1: number[];
    d5: number[];
    wins: number;
    scored: number;
  }

  const acc = new Map<string, Acc>();

  for (const r of rows) {
    const key = r.analyst_key;
    if (!key) continue;
    const a =
      acc.get(key) ??
      ({
        name: r.analyst_name ?? '',
        firm: r.firm,
        count: 0,
        first: r.rated_at,
        last: r.rated_at,
        upsides: [],
        d1: [],
        d5: [],
        wins: 0,
        scored: 0,
      } as Acc);

    a.count += 1;
    if (r.rated_at < a.first) a.first = r.rated_at;
    if (r.rated_at > a.last) a.last = r.rated_at;

    const price = priceByTicker.get(r.ticker) ?? null;
    if (price && price > 0 && r.target !== null) {
      a.upsides.push(((Number(r.target) - price) / price) * 100);
    }

    const m = moves.get(r.event_key);
    if (m?.d1 !== null && m?.d1 !== undefined) {
      a.d1.push(m.d1);
      const rec = (r.recommendation ?? '').toLowerCase();
      if (rec === 'buy' || rec === 'sell') {
        a.scored += 1;
        if ((rec === 'buy' && m.d1 > 0) || (rec === 'sell' && m.d1 < 0)) a.wins += 1;
      }
    }
    if (m?.d5 !== null && m?.d5 !== undefined) a.d5.push(m.d5);

    acc.set(key, a);
  }

  const mean = (xs: number[]) =>
    xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

  const payload = Array.from(acc.entries()).map(([analyst_key, a]) => ({
    analyst_key,
    analyst_name: a.name,
    firm: a.firm,
    ratings_count: a.count,
    first_rating_at: a.first,
    last_rating_at: a.last,
    avg_upside_pct: mean(a.upsides),
    avg_move_1d_pct: mean(a.d1),
    avg_move_5d_pct: mean(a.d5),
    win_rate_1d: a.scored > 0 ? (a.wins / a.scored) * 100 : null,
    scored_ratings: a.scored,
    stats_updated_at: new Date().toISOString(),
  }));

  let scoredRatings = 0;
  for (const p of payload) scoredRatings += p.scored_ratings;

  for (let i = 0; i < payload.length; i += 500) {
    const { error: upsertError } = await supabase
      .from('research_analysts')
      .upsert(payload.slice(i, i + 500), { onConflict: 'analyst_key' });
    if (upsertError) throw new Error(upsertError.message);
  }

  return { analysts: payload.length, scoredRatings };
}
