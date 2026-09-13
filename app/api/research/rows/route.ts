import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rows for the research table — the pulled ratings plus whatever enrichment exists. */
export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get('runId');
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 500) || 500, 2000);

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
      if (keys.length === 0) return NextResponse.json({ rows: [] });
    }

    let q = supabase
      .from('uw_research_rows')
      .select('*')
      .order('rated_at', { ascending: false })
      .limit(limit);
    if (keys) q = q.in('event_key', keys);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return NextResponse.json({ rows: data ?? [] });
  } catch (e) {
    return NextResponse.json(
      { rows: [], error: e instanceof Error ? e.message : 'Could not load rows.' },
      { status: 502 }
    );
  }
}
