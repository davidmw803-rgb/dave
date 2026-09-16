import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-request page size only. There is no cap on how many rows can be read in
// total: the client pages until the server says there are no more.
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

/**
 * Rows for the research table.
 *
 * Paged by CURSOR, not offset. The client loads every matching row by asking
 * for successive pages, and with OFFSET each page re-walks everything before
 * it — the last page of eighteen produced 18,000 rows to return 1,000, and a
 * cold cache turned that into a statement timeout. A cursor on
 * (rated_at, event_key) makes every page an index seek, so the last costs what
 * the first costs.
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
  const cursorRatedAt = params.get('cursorRatedAt');
  const cursorEventKey = params.get('cursorEventKey');

  try {
    const supabase = createAdminClient();

    let keys: string[] | null = null;
    if (runId) {
      // Every key in the run, not the first page of them: a run can hold more
      // rows than one response returns.
      keys = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase
          .from('uw_pull_run_events')
          .select('event_key')
          .eq('run_id', runId)
          .range(offset, offset + 999);
        if (error) throw new Error(error.message);
        const batch = (data ?? []).map((r) => r.event_key as string);
        keys.push(...batch);
        if (batch.length < 1000) break;
      }
      if (keys.length === 0) {
        return NextResponse.json({ rows: [], total: 0, hasMore: false, nextCursor: null });
      }
    }

    // One day of slack past `to`: a rating at 23:30 ET on that date is already
    // the next day in UTC, and the client decides the exact boundary.
    let toExclusive: string | null = null;
    if (to) {
      const end = new Date(`${to}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 2);
      toExclusive = end.toISOString();
    }

    const filters = {
      p_from: from ? `${from}T00:00:00Z` : null,
      p_to: toExclusive,
      p_tickers: tickers.length > 0 ? tickers : null,
      p_action: action || null,
      p_rating: rating || null,
      p_event_keys: keys,
    };

    const { data, error } = await supabase.rpc('research_rows_page', {
      ...filters,
      p_cursor_rated_at: cursorRatedAt,
      p_cursor_event_key: cursorEventKey,
      p_limit: limit,
    });
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as { rated_at: string; event_key: string }[];

    // The total is for the progress line and changes only when the filters do,
    // so it is counted once for the first page rather than on every one of
    // them. It also counts the ratings table directly — every filter lives
    // there, so it needs none of the view's joins.
    let total: number | null = null;
    if (!cursorRatedAt) {
      const { data: count, error: countError } = await supabase.rpc(
        'research_rows_count',
        filters
      );
      if (countError) throw new Error(countError.message);
      total = Number(count ?? 0);
    }

    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    return NextResponse.json({
      rows,
      total,
      // A short page is the end of the results; a full one might not be.
      hasMore: rows.length === limit,
      nextCursor: last ? { ratedAt: last.rated_at, eventKey: last.event_key } : null,
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
