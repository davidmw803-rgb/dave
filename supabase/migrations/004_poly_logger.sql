-- Supabase schema for poly-logger.
-- Run this in the Supabase SQL editor before starting the logger.

-- ---------------------------------------------------------------------------
-- poly_markets: metadata for each discovered market (recurring 5m/15m)
-- ---------------------------------------------------------------------------
create table if not exists poly_markets (
    condition_id      text primary key,
    slug              text not null,
    question          text not null,
    yes_token_id      text not null,
    no_token_id       text not null,
    asset             text not null,        -- 'BTC' | 'ETH' | 'UNKNOWN'
    timeframe         text not null,        -- '5m' | '15m' | 'unknown'
    window_start_ts   timestamptz,
    window_end_ts     timestamptz,
    first_seen_at     timestamptz not null default now()
);

create index if not exists idx_poly_markets_asset_tf      on poly_markets (asset, timeframe);
create index if not exists idx_poly_markets_window_start  on poly_markets (window_start_ts desc);

-- ---------------------------------------------------------------------------
-- poly_trades: every last_trade_price event
-- ---------------------------------------------------------------------------
create table if not exists poly_trades (
    id                bigserial primary key,
    condition_id      text not null,
    asset_id          text not null,       -- token_id
    side_token        text not null,       -- 'YES' | 'NO' (which side of the market this token represents)
    asset             text not null,       -- 'BTC' | 'ETH'
    timeframe         text not null,       -- '5m' | '15m'
    slug              text not null,
    price             double precision not null,
    size              double precision,
    side              text,                -- 'BUY' | 'SELL' (aggressor)
    fee_rate_bps      integer,
    hash              text,
    received_at       timestamptz not null,
    source_timestamp  timestamptz
);

create index if not exists idx_poly_trades_condition_ts   on poly_trades (condition_id, received_at desc);
create index if not exists idx_poly_trades_received       on poly_trades (received_at desc);
create index if not exists idx_poly_trades_asset_tf       on poly_trades (asset, timeframe, received_at desc);

-- ---------------------------------------------------------------------------
-- poly_book_snapshots: full book events + best_bid_ask
-- ---------------------------------------------------------------------------
create table if not exists poly_book_snapshots (
    id                bigserial primary key,
    condition_id      text not null,
    asset_id          text not null,
    side_token        text not null,
    asset             text not null,
    timeframe         text not null,
    slug              text not null,
    best_bid          double precision,
    best_ask          double precision,
    mid               double precision,
    spread            double precision,
    total_bid_depth   double precision,
    total_ask_depth   double precision,
    book_levels       integer,
    raw_bids          jsonb,
    raw_asks          jsonb,
    received_at       timestamptz not null,
    source_timestamp  timestamptz
);

create index if not exists idx_poly_book_condition_ts    on poly_book_snapshots (condition_id, received_at desc);
create index if not exists idx_poly_book_received        on poly_book_snapshots (received_at desc);

-- ---------------------------------------------------------------------------
-- poly_price_changes: individual book level updates (lighter weight)
-- ---------------------------------------------------------------------------
create table if not exists poly_price_changes (
    id                bigserial primary key,
    condition_id      text not null,
    asset_id          text not null,
    side_token        text not null,
    asset             text not null,
    timeframe         text not null,
    slug              text not null,
    price             double precision,
    size              double precision,
    side              text,
    received_at       timestamptz not null,
    source_timestamp  timestamptz
);

create index if not exists idx_poly_price_changes_cond_ts on poly_price_changes (condition_id, received_at desc);

-- ---------------------------------------------------------------------------
-- Useful view: "last N seconds before window close" per market
-- Use this in analysis queries to pull the crucial late-window action.
-- ---------------------------------------------------------------------------
create or replace view poly_late_window_trades as
select
    t.*,
    m.window_end_ts,
    extract(epoch from (m.window_end_ts - t.received_at)) as seconds_to_close
from poly_trades t
join poly_markets m on m.condition_id = t.condition_id
where m.window_end_ts is not null
  and t.received_at <= m.window_end_ts
  and t.received_at >= m.window_end_ts - interval '60 seconds';
