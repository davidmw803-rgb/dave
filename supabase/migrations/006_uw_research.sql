-- ============================================================================
-- Analyst-rating research: pulls from UW's /api/screener/analysts, plus the
-- per-ticker enrichment those rows need (price, company info, TipRanks).
--
-- Three identities keep repeated pulls from duplicating anything:
--   1. uw_analyst_ratings.event_key  — the rating itself. The same rating found
--      by five different filters upserts one row.
--   2. uw_pull_runs / uw_pull_run_events — which pull surfaced which rating,
--      so provenance is recorded without copying rows.
--   3. api_call_cache.call_key — one row per outbound API call. Anything with a
--      live cache entry is never requested again.
-- ============================================================================

-- 1. Ratings -----------------------------------------------------------------
create table if not exists uw_analyst_ratings (
  event_key text primary key,          -- sha256(ticker|analyst|firm|action|rec|target|ts)
  ticker text not null,
  analyst_name text,
  firm text,
  recommendation text,                 -- buy | hold | sell
  action text,                         -- initiated | reiterated | downgraded | upgraded | maintained
  sector text,
  target numeric,
  rated_at timestamptz not null,
  raw jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table uw_analyst_ratings enable row level security;

create index if not exists idx_uw_ratings_rated_at on uw_analyst_ratings (rated_at desc);
create index if not exists idx_uw_ratings_ticker on uw_analyst_ratings (ticker);
create index if not exists idx_uw_ratings_firm on uw_analyst_ratings (firm);
create index if not exists idx_uw_ratings_action on uw_analyst_ratings (action);
create index if not exists idx_uw_ratings_rec on uw_analyst_ratings (recommendation);

-- 2. Pull runs ---------------------------------------------------------------
create table if not exists uw_pull_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'screener_analysts',
  params jsonb not null default '{}'::jsonb,
  params_hash text not null,
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  api_calls int not null default 0,
  rows_fetched int not null default 0,
  rows_new int not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table uw_pull_runs enable row level security;
create index if not exists idx_uw_pull_runs_started on uw_pull_runs (started_at desc);

create table if not exists uw_pull_run_events (
  run_id uuid not null references uw_pull_runs(id) on delete cascade,
  event_key text not null references uw_analyst_ratings(event_key) on delete cascade,
  primary key (run_id, event_key)
);

alter table uw_pull_run_events enable row level security;
create index if not exists idx_uw_pull_run_events_event on uw_pull_run_events (event_key);

-- 3. Outbound call cache -----------------------------------------------------
create table if not exists api_call_cache (
  call_key text primary key,           -- e.g. 'uw:info:AAPL', 'uw:ohlc:AAPL:1d:2026-09-11'
  provider text not null,              -- 'uw' | 'tipranks'
  endpoint text not null,
  args jsonb not null default '{}'::jsonb,
  status text not null default 'ok' check (status in ('ok', 'error')),
  http_status int,
  response jsonb,
  error text,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz               -- null = never expires (settled history)
);

alter table api_call_cache enable row level security;
create index if not exists idx_api_call_cache_expires on api_call_cache (expires_at);
create index if not exists idx_api_call_cache_provider on api_call_cache (provider, endpoint);

-- 4. Per-ticker company info + last price ------------------------------------
create table if not exists uw_ticker_info (
  ticker text primary key,
  full_name text,
  sector text,
  issue_type text,
  marketcap numeric,
  marketcap_size text,
  beta numeric,
  avg30_volume numeric,
  next_earnings_date date,
  has_options boolean,
  last_price numeric,
  last_price_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table uw_ticker_info enable row level security;
create index if not exists idx_uw_ticker_info_marketcap on uw_ticker_info (marketcap desc);

-- 5. Price around each rating ------------------------------------------------
-- One row per (rating, window). t0 is the close of the candle covering the
-- rating timestamp; every other window carries its move away from t0.
create table if not exists uw_event_price_windows (
  event_key text not null references uw_analyst_ratings(event_key) on delete cascade,
  window_label text not null check (window_label in (
    't0', 't+1m', 't+5m', 't+30m', 't+1h', 'eod', 't+1d', 't+5d', 't+30d'
  )),
  price numeric,
  bar_at timestamptz,
  pct_from_t0 numeric,
  primary key (event_key, window_label)
);

alter table uw_event_price_windows enable row level security;

-- 6. TipRanks research per ticker --------------------------------------------
create table if not exists tipranks_research (
  ticker text primary key,
  consensus text,
  analyst_count int,
  star_rating numeric,
  price_target numeric,
  upside_pct numeric,
  success_rate numeric,
  avg_return numeric,
  payload jsonb,
  fetched_at timestamptz not null default now()
);

alter table tipranks_research enable row level security;

-- 7. The research table the UI reads -----------------------------------------
-- Ratings joined to whatever enrichment exists yet; un-enriched columns are
-- null rather than missing rows, so a pull is immediately visible.
create or replace view uw_research_rows with (security_invoker = true) as
select
  r.event_key,
  r.ticker,
  r.analyst_name,
  r.firm,
  r.recommendation,
  r.action,
  coalesce(i.sector, r.sector) as sector,
  r.target,
  r.rated_at,
  i.full_name,
  i.marketcap,
  i.marketcap_size,
  i.next_earnings_date,
  i.last_price,
  case
    when i.last_price is not null and i.last_price > 0 and r.target is not null
      then (r.target - i.last_price) / i.last_price * 100
  end as upside_pct,
  t0.price as price_t0,
  d1.pct_from_t0 as move_1d_pct,
  d5.pct_from_t0 as move_5d_pct,
  d30.pct_from_t0 as move_30d_pct,
  tr.consensus as tr_consensus,
  tr.analyst_count as tr_analyst_count,
  tr.star_rating as tr_star_rating,
  tr.price_target as tr_price_target,
  tr.success_rate as tr_success_rate,
  tr.avg_return as tr_avg_return,
  (i.ticker is not null) as has_info,
  (t0.event_key is not null) as has_prices,
  (tr.ticker is not null) as has_tipranks
from uw_analyst_ratings r
left join uw_ticker_info i on i.ticker = r.ticker
left join tipranks_research tr on tr.ticker = r.ticker
left join uw_event_price_windows t0 on t0.event_key = r.event_key and t0.window_label = 't0'
left join uw_event_price_windows d1 on d1.event_key = r.event_key and d1.window_label = 't+1d'
left join uw_event_price_windows d5 on d5.event_key = r.event_key and d5.window_label = 't+5d'
left join uw_event_price_windows d30 on d30.event_key = r.event_key and d30.window_label = 't+30d';
