import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

// ---------------------------------------------------------------------------
// Yahoo Finance chart endpoint (works for stocks, ETFs, and crypto like BTC-USD)
// ---------------------------------------------------------------------------

const YAHOO_INTERVAL_RANGE: Record<string, string> = {
  '1m': '7d',
  '5m': '60d',
  '15m': '60d',
  '30m': '60d',
  '1h': '730d',
  '60m': '730d',
  '1d': '10y',
  '1wk': 'max',
  '1mo': 'max',
};

async function fetchYahoo(symbol: string, interval: string, bars: number): Promise<Candle[]> {
  const range = YAHOO_INTERVAL_RANGE[interval] ?? '1y';
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json,text/plain,*/*',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Yahoo ${res.status}: ${text.slice(0, 120)}`);
  }
  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
            volume?: (number | null)[];
          }>;
        };
      }>;
      error?: { description?: string };
    };
  };
  const err = json.chart?.error?.description;
  if (err) throw new Error(`Yahoo: ${err}`);
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!ts || !q || !q.open || !q.close || !q.high || !q.low) {
    throw new Error('Yahoo: empty response');
  }
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    const v = q.volume?.[i];
    if (
      typeof o === 'number' &&
      typeof h === 'number' &&
      typeof l === 'number' &&
      typeof c === 'number' &&
      Number.isFinite(o) &&
      Number.isFinite(h) &&
      Number.isFinite(l) &&
      Number.isFinite(c)
    ) {
      out.push({
        time: ts[i],
        open: o,
        high: h,
        low: l,
        close: c,
        volume: typeof v === 'number' && Number.isFinite(v) ? v : undefined,
      });
    }
  }
  return out.slice(-bars);
}

// ---------------------------------------------------------------------------
// Coinbase fallback (Cloudflare often blocks datacenter IPs, so secondary)
// ---------------------------------------------------------------------------

const COINBASE_GRANULARITY: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '1d': 86400,
};

async function fetchCoinbase(symbol: string, interval: string, bars: number): Promise<Candle[]> {
  const granularity = COINBASE_GRANULARITY[interval];
  if (!granularity) throw new Error(`Coinbase does not support interval '${interval}'`);
  const rows: [number, number, number, number, number, number][] = [];
  let endTs = Math.floor(Date.now() / 1000);
  const maxPerReq = 300;

  while (rows.length < bars) {
    const needed = Math.min(maxPerReq, bars - rows.length);
    const startTs = endTs - needed * granularity;
    const url =
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/candles` +
      `?granularity=${granularity}` +
      `&start=${new Date(startTs * 1000).toISOString()}` +
      `&end=${new Date(endTs * 1000).toISOString()}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Coinbase ${res.status}: ${text.slice(0, 120)}`);
    }
    const batch = (await res.json()) as typeof rows;
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    const oldestTs = batch[batch.length - 1][0];
    if (oldestTs >= endTs) break;
    endTs = oldestTs;
  }

  const seen = new Set<number>();
  const uniq = rows.filter((r) => (seen.has(r[0]) ? false : (seen.add(r[0]), true)));
  uniq.sort((a, b) => a[0] - b[0]);
  return uniq.slice(-bars).map((r) => ({
    time: r[0],
    low: r[1],
    high: r[2],
    open: r[3],
    close: r[4],
    volume: r[5],
  }));
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get('symbol') || 'BTC-USD').toUpperCase();
  const interval = searchParams.get('interval') || '1d';
  const bars = Math.min(Math.max(Number(searchParams.get('bars')) || 365, 2), 5000);
  const requested = (searchParams.get('provider') || 'auto').toLowerCase();

  const tried: { provider: string; error: string }[] = [];

  const providers: Array<{ name: string; fn: () => Promise<Candle[]> }> = [];
  if (requested === 'yahoo' || requested === 'auto') {
    providers.push({ name: 'yahoo', fn: () => fetchYahoo(symbol, interval, bars) });
  }
  if (requested === 'coinbase' || requested === 'auto') {
    providers.push({ name: 'coinbase', fn: () => fetchCoinbase(symbol, interval, bars) });
  }

  for (const p of providers) {
    try {
      const candles = await p.fn();
      if (candles.length === 0) {
        tried.push({ provider: p.name, error: 'no candles returned' });
        continue;
      }
      return NextResponse.json({
        symbol,
        interval,
        provider: p.name,
        count: candles.length,
        candles,
      });
    } catch (e) {
      tried.push({ provider: p.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json(
    { error: 'All providers failed', attempts: tried },
    { status: 502 }
  );
}
