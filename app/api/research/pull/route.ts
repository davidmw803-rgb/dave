import { NextResponse, type NextRequest } from 'next/server';
import { pullRatings } from '@/lib/research/pull';
import { RATING_ACTIONS, RECOMMENDATIONS, type PullFilters } from '@/lib/research/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Gated by the middleware like every other /api route.

function parseFilters(body: Record<string, unknown>): PullFilters {
  const tickers =
    typeof body.tickers === 'string'
      ? body.tickers
          .split(/[\s,]+/)
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 25)
      : undefined;

  const action = RATING_ACTIONS.find((a) => a === body.action);
  const recommendation = RECOMMENDATIONS.find((r) => r === body.recommendation);

  return {
    tickers,
    action,
    recommendation,
    newerThan: typeof body.newerThan === 'string' && body.newerThan ? body.newerThan : undefined,
    olderThan: typeof body.olderThan === 'string' && body.olderThan ? body.olderThan : undefined,
    maxRows: typeof body.maxRows === 'number' ? body.maxRows : undefined,
  };
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  try {
    const result = await pullRatings(parseFilters(body));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Pull failed.' },
      { status: 502 }
    );
  }
}
