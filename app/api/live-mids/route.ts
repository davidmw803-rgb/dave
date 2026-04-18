import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { LiveMid } from '@/lib/paper/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const idsParam = searchParams.get('ids');
  if (!idsParam) {
    return NextResponse.json({ mids: [] satisfies LiveMid[] });
  }
  const ids = idsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ mids: [] satisfies LiveMid[] });
  }

  const supabase = createAdminClient();

  // Fetch the latest trade-detailed row per asset_id. We emulate
  // `select distinct on (asset_id) ... order by asset_id, event_ts desc`
  // by pulling a bounded recent window, then reducing to the latest per asset
  // in JS — this avoids a Postgres RPC and works with PostgREST directly.
  const { data, error } = await supabase
    .from('btc5m_trades_detailed')
    .select('asset_id, mid_before, price, event_ts')
    .in('asset_id', ids)
    .order('event_ts', { ascending: false })
    .limit(Math.max(500, ids.length * 20));

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const latestByAsset = new Map<string, LiveMid>();
  for (const row of (data ?? []) as LiveMid[]) {
    if (!latestByAsset.has(row.asset_id)) {
      latestByAsset.set(row.asset_id, row);
    }
  }
  const mids: LiveMid[] = ids.map(
    (id) =>
      latestByAsset.get(id) ?? { asset_id: id, mid_before: null, price: null, event_ts: null }
  );

  return NextResponse.json({ mids });
}
