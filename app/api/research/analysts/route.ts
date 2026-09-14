import { NextResponse, type NextRequest } from 'next/server';
import { refreshAnalystStats } from '@/lib/research/analysts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Recompute analyst stats. With no keys it refreshes every analyst we hold;
 * with keys it refreshes just those, which is what the per-row button sends.
 */
export async function POST(req: NextRequest) {
  let keys: string[] = [];
  try {
    const body = await req.json();
    if (Array.isArray(body?.analystKeys)) {
      keys = body.analystKeys.filter((k: unknown): k is string => typeof k === 'string');
    }
  } catch {
    // An empty body means "refresh everything".
  }

  try {
    const result = await refreshAnalystStats(keys);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Analyst refresh failed.' },
      { status: 502 }
    );
  }
}
