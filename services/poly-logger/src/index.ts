/**
 * Polymarket 5m/15m BTC/ETH Logger
 *
 * Subscribes to the WebSocket market channel for recurring Up/Down markets
 * on BTC and ETH (5-minute and 15-minute windows). Every trade and every
 * book update gets written to Supabase for later analysis.
 *
 * Because these are RECURRING markets (a new one spawns every 5/15 min),
 * the logger polls the Gamma API every 30 seconds to discover new markets
 * and dynamically subscribes to them.
 */

import dotenv from "dotenv";
import WebSocket from "ws";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GAMMA_URL = "https://gamma-api.polymarket.com/markets";
const HEARTBEAT_MS = 10_000;
const RECONNECT_DELAY_MS = 2_000;
const MARKET_DISCOVERY_INTERVAL_MS = 30_000;

// Slug prefixes for the markets we care about.
// Based on Polymarket's naming: btc-updown-5m-<unix_ts>, eth-updown-5m-<unix_ts>, etc.
const TARGET_SLUG_PREFIXES = [
  "btc-updown-5m-",
  "btc-updown-15m-",
  "eth-updown-5m-",
  "eth-updown-15m-",
];

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GammaMarket {
  id: string;
  slug: string;
  question: string;
  conditionId: string;
  clobTokenIds: string; // JSON-encoded array [yesTokenId, noTokenId]
  active: boolean;
  closed: boolean;
  endDate?: string;
  startDate?: string;
  volumeNum?: number;
  liquidityNum?: number;
}

interface TrackedMarket {
  conditionId: string;
  slug: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  windowStartTs: number | null; // parsed from slug
  windowEndTs: number | null;
  asset: "BTC" | "ETH" | "UNKNOWN";
  timeframe: "5m" | "15m" | "unknown";
}

interface PolyMarketEvent {
  event_type: "book" | "price_change" | "last_trade_price" | "tick_size_change" | "best_bid_ask";
  asset_id: string;
  market?: string;
  timestamp?: string;
  price?: string;
  size?: string;
  side?: "BUY" | "SELL";
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  best_bid?: string;
  best_ask?: string;
  fee_rate_bps?: string;
  hash?: string;
}

// ---------------------------------------------------------------------------
// Slug parsing
// ---------------------------------------------------------------------------

function parseSlug(slug: string): {
  asset: "BTC" | "ETH" | "UNKNOWN";
  timeframe: "5m" | "15m" | "unknown";
  windowStartTs: number | null;
} {
  // btc-updown-5m-1729036800, eth-updown-15m-1729036800, etc.
  const match = slug.match(/^(btc|eth)-updown-(5m|15m)-(\d+)$/);
  if (!match) return { asset: "UNKNOWN", timeframe: "unknown", windowStartTs: null };
  const [, assetRaw, tfRaw, tsRaw] = match;
  return {
    asset: assetRaw.toUpperCase() as "BTC" | "ETH",
    timeframe: tfRaw as "5m" | "15m",
    windowStartTs: parseInt(tsRaw, 10),
  };
}

function slugMatchesTarget(slug: string): boolean {
  return TARGET_SLUG_PREFIXES.some(p => slug.startsWith(p));
}

// ---------------------------------------------------------------------------
// Market discovery via Gamma API
// ---------------------------------------------------------------------------

async function fetchActiveTargetMarkets(): Promise<TrackedMarket[]> {
  const results: TrackedMarket[] = [];
  // Gamma supports pagination — grab active markets in batches.
  // We ask for active markets only and filter client-side by slug prefix.
  const url = `${GAMMA_URL}?active=true&closed=false&limit=500`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Gamma API error: ${resp.status} ${resp.statusText}`);
  }
  const markets = (await resp.json()) as GammaMarket[];

  for (const m of markets) {
    if (!slugMatchesTarget(m.slug)) continue;
    if (m.closed) continue;

    let tokenIds: string[];
    try {
      tokenIds = JSON.parse(m.clobTokenIds);
    } catch {
      continue;
    }
    if (!Array.isArray(tokenIds) || tokenIds.length < 2) continue;

    const parsed = parseSlug(m.slug);
    const windowEnd = parsed.windowStartTs !== null
      ? parsed.windowStartTs + (parsed.timeframe === "15m" ? 900 : 300)
      : null;

    results.push({
      conditionId: m.conditionId,
      slug: m.slug,
      question: m.question,
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
      windowStartTs: parsed.windowStartTs,
      windowEndTs: windowEnd,
      asset: parsed.asset,
      timeframe: parsed.timeframe,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Supabase writers
// ---------------------------------------------------------------------------

// Small in-memory write buffer — batch inserts every 500ms to reduce round-trips.
const tradeBuffer: any[] = [];
const bookSnapshotBuffer: any[] = [];
const priceChangeBuffer: any[] = [];

async function flushBuffers() {
  const trades = tradeBuffer.splice(0);
  const books = bookSnapshotBuffer.splice(0);
  const changes = priceChangeBuffer.splice(0);

  const promises: Promise<void>[] = [];

  if (trades.length > 0) {
    promises.push((async () => {
      const res = await supabase.from("poly_trades").insert(trades);
      if (res.error) console.error("poly_trades insert error:", res.error.message);
    })());
  }
  if (books.length > 0) {
    promises.push((async () => {
      const res = await supabase.from("poly_book_snapshots").insert(books);
      if (res.error) console.error("poly_book_snapshots insert error:", res.error.message);
    })());
  }
  if (changes.length > 0) {
    promises.push((async () => {
      const res = await supabase.from("poly_price_changes").insert(changes);
      if (res.error) console.error("poly_price_changes insert error:", res.error.message);
    })());
  }

  await Promise.all(promises);
}

async function upsertMarket(m: TrackedMarket) {
  const { error } = await supabase.from("poly_markets").upsert({
    condition_id: m.conditionId,
    slug: m.slug,
    question: m.question,
    yes_token_id: m.yesTokenId,
    no_token_id: m.noTokenId,
    asset: m.asset,
    timeframe: m.timeframe,
    window_start_ts: m.windowStartTs ? new Date(m.windowStartTs * 1000).toISOString() : null,
    window_end_ts: m.windowEndTs ? new Date(m.windowEndTs * 1000).toISOString() : null,
    first_seen_at: new Date().toISOString(),
  }, { onConflict: "condition_id", ignoreDuplicates: false });
  if (error) console.error("poly_markets upsert error:", error.message);
}

// ---------------------------------------------------------------------------
// Main Logger class
// ---------------------------------------------------------------------------

class PolyLogger {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  // token_id -> TrackedMarket (indexed by YES and NO token IDs so we can
  // look up a market's metadata from any incoming event)
  private tokenIdToMarket = new Map<string, TrackedMarket>();

  // All token IDs currently subscribed
  private subscribedTokens = new Set<string>();

  // Connection state
  private connected = false;
  private reconnectScheduled = false;

  async start() {
    console.log(`[${new Date().toISOString()}] Starting poly-logger…`);

    // Initial market discovery + subscription
    await this.discoverMarkets();

    // Connect WebSocket
    this.connect();

    // Periodic market discovery — crucial because these markets cycle every 5/15min
    this.discoveryTimer = setInterval(() => {
      this.discoverMarkets().catch(err => console.error("discovery error:", err));
    }, MARKET_DISCOVERY_INTERVAL_MS);

    // Periodic buffer flush to Supabase
    this.flushTimer = setInterval(() => {
      flushBuffers().catch(err => console.error("flush error:", err));
    }, 500);

    // Graceful shutdown
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
  }

  async discoverMarkets() {
    try {
      const markets = await fetchActiveTargetMarkets();
      const newTokenIds: string[] = [];

      for (const m of markets) {
        if (!this.tokenIdToMarket.has(m.yesTokenId)) {
          this.tokenIdToMarket.set(m.yesTokenId, m);
          newTokenIds.push(m.yesTokenId);
        }
        if (!this.tokenIdToMarket.has(m.noTokenId)) {
          this.tokenIdToMarket.set(m.noTokenId, m);
          newTokenIds.push(m.noTokenId);
        }

        // Write market metadata (upsert)
        await upsertMarket(m);
      }

      if (newTokenIds.length > 0) {
        console.log(`[discover] found ${newTokenIds.length} new token IDs across ${markets.length} markets`);
        for (const tid of newTokenIds) this.subscribedTokens.add(tid);

        // If already connected, send dynamic subscription
        if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            assets_ids: newTokenIds,
            operation: "subscribe",
          }));
        }
      }
    } catch (err) {
      console.error("discoverMarkets error:", err);
    }
  }

  private connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    console.log(`[ws] connecting…`);

    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      console.log(`[ws] connected`);
      this.connected = true;
      this.reconnectScheduled = false;

      // Subscribe to all currently tracked tokens
      const assetIds = Array.from(this.subscribedTokens);
      if (assetIds.length > 0) {
        this.ws!.send(JSON.stringify({
          assets_ids: assetIds,
          type: "market",
        }));
        console.log(`[ws] subscribed to ${assetIds.length} tokens`);
      }

      // Heartbeat: Polymarket expects PING every 10s
      this.heartbeatTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send("PING");
        }
      }, HEARTBEAT_MS);
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString()));

    this.ws.on("close", () => {
      console.log(`[ws] disconnected`);
      this.connected = false;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error(`[ws] error:`, err.message);
      // 'close' will fire after 'error', which triggers reconnect
    });
  }

  private scheduleReconnect() {
    if (this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  private handleMessage(raw: string) {
    if (raw === "PONG" || raw.trim() === "") return;

    let payload: PolyMarketEvent[] | PolyMarketEvent;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return;
    }

    const events = Array.isArray(payload) ? payload : [payload];
    const receivedAt = new Date().toISOString();

    for (const ev of events) {
      if (!ev.asset_id) continue;
      const market = this.tokenIdToMarket.get(ev.asset_id);
      if (!market) continue; // stray event from a market we've since rotated off

      const baseRow = {
        condition_id: market.conditionId,
        asset_id: ev.asset_id,
        side_token: ev.asset_id === market.yesTokenId ? "YES" : "NO",
        asset: market.asset,
        timeframe: market.timeframe,
        slug: market.slug,
        received_at: receivedAt,
        source_timestamp: ev.timestamp ? new Date(parseInt(ev.timestamp, 10)).toISOString() : null,
      };

      switch (ev.event_type) {
        case "last_trade_price": {
          if (!ev.price) break;
          tradeBuffer.push({
            ...baseRow,
            price: parseFloat(ev.price),
            size: ev.size ? parseFloat(ev.size) : null,
            side: ev.side ?? null,
            fee_rate_bps: ev.fee_rate_bps ? parseInt(ev.fee_rate_bps, 10) : null,
            hash: ev.hash ?? null,
          });
          break;
        }
        case "book": {
          const bestBid = ev.bids?.[0]?.price ? parseFloat(ev.bids[0].price) : null;
          const bestAsk = ev.asks?.[0]?.price ? parseFloat(ev.asks[0].price) : null;
          const bidDepth = ev.bids?.reduce((s, l) => s + parseFloat(l.size), 0) ?? 0;
          const askDepth = ev.asks?.reduce((s, l) => s + parseFloat(l.size), 0) ?? 0;
          bookSnapshotBuffer.push({
            ...baseRow,
            best_bid: bestBid,
            best_ask: bestAsk,
            mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
            spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
            total_bid_depth: bidDepth,
            total_ask_depth: askDepth,
            book_levels: ev.bids?.length ?? 0,
            raw_bids: ev.bids ?? null,
            raw_asks: ev.asks ?? null,
          });
          break;
        }
        case "price_change": {
          // These fire for individual book-level updates. Lighter-weight log.
          priceChangeBuffer.push({
            ...baseRow,
            price: ev.price ? parseFloat(ev.price) : null,
            size: ev.size ? parseFloat(ev.size) : null,
            side: ev.side ?? null,
          });
          break;
        }
        case "best_bid_ask": {
          const bid = ev.best_bid ? parseFloat(ev.best_bid) : null;
          const ask = ev.best_ask ? parseFloat(ev.best_ask) : null;
          bookSnapshotBuffer.push({
            ...baseRow,
            best_bid: bid,
            best_ask: ask,
            mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
            spread: bid !== null && ask !== null ? ask - bid : null,
            total_bid_depth: null,
            total_ask_depth: null,
            book_levels: null,
            raw_bids: null,
            raw_asks: null,
          });
          break;
        }
      }
    }
  }

  private async shutdown() {
    console.log(`[${new Date().toISOString()}] shutting down…`);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.ws) this.ws.close();
    await flushBuffers();
    console.log(`[${new Date().toISOString()}] done.`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const logger = new PolyLogger();
logger.start().catch(err => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
