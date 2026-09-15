import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 2000;

/**
 * Rows for the research table.
 *
 * The date range matters here, not just in the browser: the table can only
 * filter rows it has loaded, and loading "the newest N" means a pull of older
 * ratings lands in the database but never reaches the page. The window is
 * applied with a day of slack on each side and the exact market-time filtering
 * is left to the client, so the two can't disagree about which day a rating
 * near midnight belongs to.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const runId = params.get('runId');
  const from = params.get('from');
  const to = params.get('to');
  const tickers = (params.get('tickers') ?? '')
    .split(/[\s,]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const action = params.get('action');
  const rating = params.get('rating');
  const limit = Math.min(Number(params.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);

  try {
    const supabase = createAdminClient();

    let keys: string[] | null = null;
    if (runId) {
      const { data, error } = await supabase
        .from('uw_pull_run_events')
        .select('event_key')
        .eq('run_id', runId)
        .limit(limit);
      if (error) throw new Error(error.message);
      keys = (data ?? []).map((r) => r.event_key as string);
      if (keys.length === 0) {
        return NextResponse.json({ rows: [], total: 0, offset, hasMore: false });
      }
    }

    let q = supabase
      .from('uw_research_rows')
      // An exact count lets the client fetch the remaining pages without
      // guessing, and lets the table say how many matches exist in total.
      .select('*', { count: 'exact' })
      .order('rated_at', { ascending: false })
      // A stable tiebreak: two ratings can share a timestamp, and without it
      // paging by offset can repeat or skip one.
      .order('event_key', { ascending: true })
      .range(offset, offset + limit - 1);

    if (keys) q = q.in('event_key', keys);
    if (from) q = q.gte('rated_at', `${from}T00:00:00Z`);
    if (to) {
      // One day of slack: a rating at 23:30 ET on the `to` date is already the
      // next day in UTC, and the client decides the exact boundary.
      const end = new Date(`${to}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 2);
      q = q.lt('rated_at', end.toISOString());
    }
    if (tickers.length > 0) q = q.in('ticker', tickers);
    if (action) q = q.eq('action', action);
    if (rating) q = q.eq('recommendation', rating);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);

    const rows = data ?? [];
    const total = count ?? rows.length;
    return NextResponse.json({
      rows,
      total,
      offset,
      hasMore: offset + rows.length < total,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not load rows.';
    const timedOut = /statement timeout|canceling statement/i.test(message);
    return NextResponse.json(
      {
        rows: [],
        error: timedOut
          ? 'The database was too busy to return the table. Try again in a moment.'
          : message,
      },
      { status: 502 }
    );
  }
}
