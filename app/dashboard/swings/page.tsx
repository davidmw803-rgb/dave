"use client";

/**
 * Live Swing Scanner — watch Polymarket markets in real time and surface
 * the price action in the final 60s / 30s / 10s before each 5-minute mark.
 *
 * Strategy context: in prediction markets, late-window swings often reveal
 * informed flow. Buy early, watch the late window, exit (or fade) on the move.
 *
 * Drop this at: app/dashboard/swings/page.tsx
 *
 * Environment: no auth needed for the market channel. The Polymarket
 * WebSocket connects directly from the browser at:
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market
 *
 * To add a market: paste its YES token ID (the long numeric `assets_id`).
 * You can find it in the Polymarket URL bar / Gamma API response for the
 * market you care about.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PolyEvent = {
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
};

type PriceTick = {
  ts: number;        // ms epoch
  price: number;     // 0..1
  side?: "BUY" | "SELL";
  size?: number;
};

type MarketState = {
  assetId: string;
  label: string;
  ticks: PriceTick[];     // rolling buffer, last ~10 minutes
  bestBid?: number;
  bestAsk?: number;
  lastUpdate?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const BUFFER_MS = 10 * 60 * 1000;      // keep last 10 min of ticks per market
const HEARTBEAT_MS = 10_000;           // PING every 10s per Polymarket docs
const FIVE_MIN_MS = 5 * 60 * 1000;
const RECONNECT_DELAY_MS = 2_000;

// Demo markets — replace with whatever you actually trade.
// These are placeholder asset IDs; user should swap for live YES tokens.
const DEFAULT_MARKETS: Array<{ assetId: string; label: string }> = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextFiveMinMark(now: number): number {
  return Math.ceil(now / FIVE_MIN_MS) * FIVE_MIN_MS;
}

function priceFromBook(bids?: Array<{ price: string }>, asks?: Array<{ price: string }>): number | undefined {
  const bestBid = bids?.[0]?.price ? parseFloat(bids[0].price) : undefined;
  const bestAsk = asks?.[0]?.price ? parseFloat(asks[0].price) : undefined;
  if (bestBid !== undefined && bestAsk !== undefined) return (bestBid + bestAsk) / 2;
  return bestBid ?? bestAsk;
}

function fmtPrice(p?: number): string {
  if (p === undefined || Number.isNaN(p)) return "—";
  return (p * 100).toFixed(1) + "¢";
}

function fmtDelta(d: number): string {
  const cents = d * 100;
  const sign = cents >= 0 ? "+" : "";
  return `${sign}${cents.toFixed(1)}¢`;
}

function fmtCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Compute window stats for a given lookback (in ms, ending at `endTs`)
function windowStats(ticks: PriceTick[], endTs: number, lookbackMs: number) {
  const startTs = endTs - lookbackMs;
  const inWindow = ticks.filter(t => t.ts >= startTs && t.ts <= endTs);
  if (inWindow.length === 0) return { count: 0, open: undefined, last: undefined, hi: undefined, lo: undefined, delta: 0, range: 0 };

  const open = inWindow[0].price;
  const last = inWindow[inWindow.length - 1].price;
  const hi = Math.max(...inWindow.map(t => t.price));
  const lo = Math.min(...inWindow.map(t => t.price));
  return { count: inWindow.length, open, last, hi, lo, delta: last - open, range: hi - lo };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SwingsPage() {
  const [markets, setMarkets] = useState<Map<string, MarketState>>(new Map());
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [now, setNow] = useState(Date.now());
  const [newAssetId, setNewAssetId] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscribedAssetsRef = useRef<Set<string>>(new Set());

  // Tick the clock every 250ms so countdowns/highlights update smoothly
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Apply a price tick to a market and prune old ticks
  const applyTick = useCallback((assetId: string, tick: PriceTick) => {
    setMarkets((prev: Map<string, MarketState>) => {
      const existing = prev.get(assetId);
      if (!existing) return prev;
      const next = new Map(prev);
      const cutoff = tick.ts - BUFFER_MS;
      const ticks: PriceTick[] = [...existing.ticks.filter((t: PriceTick) => t.ts >= cutoff), tick];
      next.set(assetId, { ...existing, ticks, lastUpdate: tick.ts });
      return next;
    });
  }, []);

  const updateBestQuote = useCallback((assetId: string, bid?: number, ask?: number) => {
    setMarkets((prev: Map<string, MarketState>) => {
      const existing = prev.get(assetId);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(assetId, {
        ...existing,
        bestBid: bid ?? existing.bestBid,
        bestAsk: ask ?? existing.bestAsk,
      });
      return next;
    });
  }, []);

  // Handle a single WS message (Polymarket sends an array of events)
  const handleMessage = useCallback((raw: string) => {
    if (raw === "PONG") return;
    let payload: PolyEvent[] | PolyEvent;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const events = Array.isArray(payload) ? payload : [payload];
    const ts = Date.now();

    for (const ev of events) {
      if (!ev.asset_id) continue;
      switch (ev.event_type) {
        case "last_trade_price": {
          if (!ev.price) break;
          const price = parseFloat(ev.price);
          const size = ev.size ? parseFloat(ev.size) : undefined;
          applyTick(ev.asset_id, { ts, price, side: ev.side, size });
          break;
        }
        case "book": {
          const mid = priceFromBook(ev.bids, ev.asks);
          if (mid !== undefined) applyTick(ev.asset_id, { ts, price: mid });
          const bestBid = ev.bids?.[0]?.price ? parseFloat(ev.bids[0].price) : undefined;
          const bestAsk = ev.asks?.[0]?.price ? parseFloat(ev.asks[0].price) : undefined;
          updateBestQuote(ev.asset_id, bestBid, bestAsk);
          break;
        }
        case "price_change": {
          // price_change events update individual book levels — we already
          // get the best price from `book` and `best_bid_ask`, so we don't
          // need to derive a tick from these to avoid double counting.
          break;
        }
        case "best_bid_ask": {
          const bid = ev.best_bid ? parseFloat(ev.best_bid) : undefined;
          const ask = ev.best_ask ? parseFloat(ev.best_ask) : undefined;
          if (bid !== undefined && ask !== undefined) {
            applyTick(ev.asset_id, { ts, price: (bid + ask) / 2 });
          }
          updateBestQuote(ev.asset_id, bid, ask);
          break;
        }
      }
    }
  }, [applyTick, updateBestQuote]);

  // Connect to Polymarket WS and (re)subscribe to all current asset IDs
  const connect = useCallback(() => {
    if (typeof window === "undefined") return;
    if (wsRef.current && wsRef.current.readyState <= 1) return;

    setStatus("connecting");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      const assetIds = Array.from(subscribedAssetsRef.current);
      if (assetIds.length > 0) {
        ws.send(JSON.stringify({
          assets_ids: assetIds,
          type: "market",
          custom_feature_enabled: true,
        }));
      }
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, HEARTBEAT_MS);
    };

    ws.onmessage = (e) => handleMessage(typeof e.data === "string" ? e.data : "");

    ws.onclose = () => {
      setStatus("disconnected");
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      // Auto-reconnect
      reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [handleMessage]);

  // Connect on mount / cleanup on unmount
  useEffect(() => {
    connect();
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addMarket = useCallback(() => {
    const id = newAssetId.trim();
    if (!id) return;
    if (markets.has(id)) return;

    const label = newLabel.trim() || `Market ${id.slice(0, 8)}…`;
    setMarkets((prev: Map<string, MarketState>) => {
      const next = new Map(prev);
      next.set(id, { assetId: id, label, ticks: [] });
      return next;
    });
    subscribedAssetsRef.current.add(id);

    // Dynamic subscribe if connected
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        assets_ids: [id],
        operation: "subscribe",
        custom_feature_enabled: true,
      }));
    }

    setNewAssetId("");
    setNewLabel("");
  }, [newAssetId, newLabel, markets]);

  const removeMarket = useCallback((assetId: string) => {
    setMarkets((prev: Map<string, MarketState>) => {
      const next = new Map(prev);
      next.delete(assetId);
      return next;
    });
    subscribedAssetsRef.current.delete(assetId);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        assets_ids: [assetId],
        operation: "unsubscribe",
      }));
    }
  }, []);

  // Add default markets once on mount
  useEffect(() => {
    for (const m of DEFAULT_MARKETS) {
      if (!markets.has(m.assetId)) {
        setMarkets((prev: Map<string, MarketState>) => {
          const next = new Map(prev);
          next.set(m.assetId, { assetId: m.assetId, label: m.label, ticks: [] });
          return next;
        });
        subscribedAssetsRef.current.add(m.assetId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute next 5-min mark + how far we are inside the active window
  const nextMark = useMemo(() => nextFiveMinMark(now), [now]);
  const msUntilMark = nextMark - now;
  const inSixtySec = msUntilMark <= 60_000;
  const inThirtySec = msUntilMark <= 30_000;
  const inTenSec = msUntilMark <= 10_000;

  return (
    <div style={{ padding: "1.5rem", maxWidth: 1280, margin: "0 auto", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Swing Scanner</h1>
        <p style={{ fontSize: 14, color: "#666", margin: "4px 0 0" }}>
          Live Polymarket price action with the final 60s / 30s / 10s before each 5-min mark highlighted.
        </p>
      </header>

      {/* Global countdown bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        background: inTenSec ? "#fee2e2" : inThirtySec ? "#fef3c7" : inSixtySec ? "#fef9c3" : "#f3f4f6",
        borderRadius: 8,
        border: "1px solid " + (inTenSec ? "#fca5a5" : inThirtySec ? "#fcd34d" : inSixtySec ? "#fde047" : "#e5e7eb"),
        marginBottom: "1.5rem",
        transition: "background 200ms",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{
            display: "inline-block",
            width: 8, height: 8, borderRadius: "50%",
            background: status === "connected" ? "#10b981" : status === "connecting" ? "#f59e0b" : "#ef4444",
          }} />
          <span style={{ fontSize: 13, color: "#444" }}>
            {status === "connected" ? "Live" : status === "connecting" ? "Connecting…" : "Disconnected"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: 13, color: "#666" }}>Next 5-min mark in</span>
          <span style={{ fontSize: 28, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
            {fmtCountdown(msUntilMark)}
          </span>
          {inTenSec && <span style={{ fontSize: 12, fontWeight: 500, color: "#991b1b" }}>10s WINDOW</span>}
          {!inTenSec && inThirtySec && <span style={{ fontSize: 12, fontWeight: 500, color: "#92400e" }}>30s WINDOW</span>}
          {!inThirtySec && inSixtySec && <span style={{ fontSize: 12, fontWeight: 500, color: "#854d0e" }}>60s WINDOW</span>}
        </div>
      </div>

      {/* Add market form */}
      <div style={{
        display: "flex",
        gap: 8,
        marginBottom: "1.5rem",
        padding: 12,
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        background: "#fafafa",
      }}>
        <input
          type="text"
          value={newAssetId}
          onChange={e => setNewAssetId(e.target.value)}
          placeholder="Polymarket YES token ID (long numeric asset_id)"
          style={{ flex: 2, padding: "8px 10px", fontSize: 13, border: "1px solid #d1d5db", borderRadius: 6, fontFamily: "monospace" }}
        />
        <input
          type="text"
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          placeholder="Label (e.g. Trump 2024)"
          style={{ flex: 1, padding: "8px 10px", fontSize: 13, border: "1px solid #d1d5db", borderRadius: 6 }}
        />
        <button
          onClick={addMarket}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 500,
            background: "#111",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Watch
        </button>
      </div>

      {/* Empty state */}
      {markets.size === 0 && (
        <div style={{
          padding: "3rem 2rem",
          textAlign: "center",
          border: "1px dashed #d1d5db",
          borderRadius: 8,
          color: "#6b7280",
        }}>
          <p style={{ fontSize: 14, margin: 0 }}>No markets being watched yet.</p>
          <p style={{ fontSize: 13, margin: "8px 0 0", color: "#9ca3af" }}>
            Paste a Polymarket asset ID above to start streaming. Find one at{" "}
            <a href="https://polymarket.com" style={{ color: "#2563eb" }}>polymarket.com</a>{" "}
            (the long numeric YES token).
          </p>
        </div>
      )}

      {/* Market cards */}
      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
        {Array.from(markets.values()).map(m => (
          <MarketCard
            key={m.assetId}
            market={m}
            now={now}
            nextMark={nextMark}
            onRemove={() => removeMarket(m.assetId)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarketCard — per-market live view
// ---------------------------------------------------------------------------

function MarketCard({
  market,
  now,
  nextMark,
  onRemove,
}: {
  market: MarketState;
  now: number;
  nextMark: number;
  onRemove: () => void;
}) {
  const w60 = windowStats(market.ticks, now, 60_000);
  const w30 = windowStats(market.ticks, now, 30_000);
  const w10 = windowStats(market.ticks, now, 10_000);
  const wholeWindow = windowStats(market.ticks, now, FIVE_MIN_MS);

  const msUntilMark = nextMark - now;
  const activeWindow: 10 | 30 | 60 | null =
    msUntilMark <= 10_000 ? 10 :
    msUntilMark <= 30_000 ? 30 :
    msUntilMark <= 60_000 ? 60 : null;

  const lastPrice = market.ticks[market.ticks.length - 1]?.price;

  return (
    <div style={{
      border: "1px solid #e5e7eb",
      borderRadius: 12,
      background: "#fff",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px",
        borderBottom: "1px solid #f3f4f6",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>{market.label}</div>
          <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {market.assetId}
          </div>
        </div>
        <button
          onClick={onRemove}
          style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 18, padding: 0, marginLeft: 8 }}
          aria-label="Remove market"
        >
          ×
        </button>
      </div>

      {/* Last price */}
      <div style={{ padding: "16px", display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontSize: 32, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
          {fmtPrice(lastPrice)}
        </span>
        {market.bestBid !== undefined && market.bestAsk !== undefined && (
          <span style={{ fontSize: 12, color: "#6b7280", fontVariantNumeric: "tabular-nums" }}>
            {fmtPrice(market.bestBid)} / {fmtPrice(market.bestAsk)}
          </span>
        )}
      </div>

      {/* Window stats — three rows, 60s / 30s / 10s */}
      <div style={{ padding: "0 16px 16px" }}>
        <WindowRow label="60s" stats={w60} active={activeWindow === 60} accent="#fef9c3" border="#fde047" />
        <WindowRow label="30s" stats={w30} active={activeWindow === 30} accent="#fef3c7" border="#fcd34d" />
        <WindowRow label="10s" stats={w10} active={activeWindow === 10} accent="#fee2e2" border="#fca5a5" />
      </div>

      {/* Sparkline of last 5 minutes */}
      <div style={{ padding: "0 16px 16px" }}>
        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
          <span>Last 5 min</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            range {fmtDelta(wholeWindow.range)} · {wholeWindow.count} ticks
          </span>
        </div>
        <Sparkline ticks={market.ticks} now={now} nextMark={nextMark} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WindowRow — one of 60s/30s/10s
// ---------------------------------------------------------------------------

function WindowRow({
  label,
  stats,
  active,
  accent,
  border,
}: {
  label: string;
  stats: ReturnType<typeof windowStats>;
  active: boolean;
  accent: string;
  border: string;
}) {
  const delta = stats.delta;
  const deltaColor = delta > 0.001 ? "#15803d" : delta < -0.001 ? "#b91c1c" : "#6b7280";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "44px 1fr 1fr 1fr",
      gap: 8,
      alignItems: "center",
      padding: "8px 10px",
      background: active ? accent : "transparent",
      border: active ? `1px solid ${border}` : "1px solid transparent",
      borderRadius: 6,
      marginBottom: 4,
      transition: "background 200ms",
    }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: active ? "#111" : "#6b7280" }}>{label}</span>
      <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: deltaColor, fontWeight: 500 }}>
        {fmtDelta(delta)}
      </span>
      <span style={{ fontSize: 12, color: "#6b7280", fontVariantNumeric: "tabular-nums" }}>
        range {fmtDelta(stats.range)}
      </span>
      <span style={{ fontSize: 12, color: "#9ca3af", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
        {stats.count} ticks
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline — last 5 min of price ticks with windows shaded
// ---------------------------------------------------------------------------

function Sparkline({ ticks, now, nextMark }: { ticks: PriceTick[]; now: number; nextMark: number }) {
  const W = 380;
  const H = 80;

  const startTs = now - FIVE_MIN_MS;
  const visible = ticks.filter(t => t.ts >= startTs);

  if (visible.length < 2) {
    return (
      <div style={{
        height: H,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        color: "#9ca3af",
        background: "#f9fafb",
        borderRadius: 6,
      }}>
        Waiting for ticks…
      </div>
    );
  }

  const prices = visible.map(t => t.price);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const pRange = Math.max(pMax - pMin, 0.001);

  const xFor = (ts: number) => ((ts - startTs) / FIVE_MIN_MS) * W;
  const yFor = (p: number) => H - ((p - pMin) / pRange) * (H - 8) - 4;

  const path = visible.map((t, i) => `${i === 0 ? "M" : "L"} ${xFor(t.ts).toFixed(1)} ${yFor(t.price).toFixed(1)}`).join(" ");

  // Window shading positions (left edges of 60s/30s/10s before nextMark)
  const x60 = xFor(nextMark - 60_000);
  const x30 = xFor(nextMark - 30_000);
  const x10 = xFor(nextMark - 10_000);
  const xMark = xFor(nextMark);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      {/* Window shading — only draw the parts that fit in the visible 5-min window */}
      {x60 < W && xMark > 0 && (
        <rect x={Math.max(0, x60)} y={0} width={Math.min(W, xMark) - Math.max(0, x60)} height={H} fill="#fef9c3" opacity="0.5" />
      )}
      {x30 < W && xMark > 0 && (
        <rect x={Math.max(0, x30)} y={0} width={Math.min(W, xMark) - Math.max(0, x30)} height={H} fill="#fef3c7" opacity="0.6" />
      )}
      {x10 < W && xMark > 0 && (
        <rect x={Math.max(0, x10)} y={0} width={Math.min(W, xMark) - Math.max(0, x10)} height={H} fill="#fee2e2" opacity="0.7" />
      )}

      {/* 5-min mark line */}
      {xMark > 0 && xMark < W && (
        <line x1={xMark} y1={0} x2={xMark} y2={H} stroke="#dc2626" strokeWidth="1" strokeDasharray="2,2" />
      )}

      {/* Price path */}
      <path d={path} stroke="#111" strokeWidth="1.5" fill="none" />

      {/* Last point dot */}
      {visible.length > 0 && (() => {
        const last = visible[visible.length - 1];
        return (
          <circle cx={xFor(last.ts)} cy={yFor(last.price)} r="2.5" fill="#111" />
        );
      })()}
    </svg>
  );
}
