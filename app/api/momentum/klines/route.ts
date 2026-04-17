import { NextResponse } from 'next/server';

export const runtime = 'edge';

const GRANULARITY_SEC: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '1d': 86400,
};

type CoinbaseRow = [number, number, number, number, number, number];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get('symbol') || 'BTC-USD').toUpperCase();
  const interval = (searchParams.get('interval') || '1d').toLowerCase();
  const bars = Math.min(Math.max(Number(searchParams.get('bars')) || 365, 2), 2000);

  const granularity = GRANULARITY_SEC[interval];
  if (!granularity) {
    return NextResponse.json(
      { error: `Unsupported interval '${interval}'. Use one of: ${Object.keys(GRANULARITY_SEC).join(', ')}` },
      { status: 400 }
    );
  }

  // Coinbase caps each request at 300 candles. Paginate backwards through time
  // until we have `bars`, then return them sorted ascending.
  const all: CoinbaseRow[] = [];
  let endTs = Math.floor(Date.now() / 1000);
  const maxPerReq = 300;

  try {
    while (all.length < bars) {
      const needed = Math.min(maxPerReq, bars - all.length);
      const startTs = endTs - needed * granularity;
      const url =
        `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/candles` +
        `?granularity=${granularity}` +
        `&start=${new Date(startTs * 1000).toISOString()}` +
        `&end=${new Date(endTs * 1000).toISOString()}`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'analyst-tracker/momentum' },
        cache: 'no-store',
      });
      if (!res.ok) {
        const text = await res.text();
        return NextResponse.json(
          { error: `Coinbase error ${res.status}: ${text.slice(0, 200)}` },
          { status: 502 }
        );
      }
      const batch = (await res.json()) as CoinbaseRow[];
      if (!Array.isArray(batch) || batch.length === 0) break;

      all.push(...batch);
      const oldestTs = batch[batch.length - 1][0];
      if (oldestTs >= endTs) break; // no progress, bail
      endTs = oldestTs;
    }

    // De-dup by timestamp and sort ascending by time
    const seen = new Set<number>();
    const uniq = all.filter((r) => {
      if (seen.has(r[0])) return false;
      seen.add(r[0]);
      return true;
    });
    uniq.sort((a, b) => a[0] - b[0]);
    const trimmed = uniq.slice(-bars);

    const candles = trimmed.map((r) => ({
      time: r[0],
      open: r[3],
      close: r[4],
    }));

    return NextResponse.json({
      symbol,
      interval,
      count: candles.length,
      candles,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
