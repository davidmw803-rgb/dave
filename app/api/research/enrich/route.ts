import { NextResponse, type NextRequest } from 'next/server';
import { enrichPrices } from '@/lib/research/enrich-prices';
import { enrichTipranks } from '@/lib/research/tipranks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * One bounded batch per request. The client calls again while `remaining > 0`,
 * which keeps each request inside the function timeout and lets the UI show
 * progress instead of hanging.
 */
export async function POST(req: NextRequest) {
  let body: { kind?: unknown; eventKeys?: unknown; tickers?: unknown; batchSize?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const batchSize = typeof body.batchSize === 'number' ? Math.min(body.batchSize, 50) : 20;

  try {
    if (body.kind === 'prices') {
      const keys = Array.isArray(body.eventKeys)
        ? body.eventKeys.filter((k): k is string => typeof k === 'string')
        : [];
      if (keys.length === 0) {
        return NextResponse.json({ error: 'No ratings selected.' }, { status: 400 });
      }
      return NextResponse.json({ ok: true, ...(await enrichPrices(keys, batchSize)) });
    }

    if (body.kind === 'tipranks') {
      const tickers = Array.isArray(body.tickers)
        ? body.tickers.filter((t): t is string => typeof t === 'string')
        : [];
      if (tickers.length === 0) {
        return NextResponse.json({ error: 'No tickers selected.' }, { status: 400 });
      }
      return NextResponse.json({ ok: true, ...(await enrichTipranks(tickers, batchSize)) });
    }

    return NextResponse.json({ error: 'Unknown enrichment kind.' }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Enrichment failed.' },
      { status: 502 }
    );
  }
}
