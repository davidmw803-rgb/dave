-- Migration 001: Core schema for trusted analysts, rating events, prices, virtual trades
-- Applied during Session 1

-- ============================================================================
-- Trusted analysts (manually curated)
-- ============================================================================
create table trusted_analysts (
  id uuid primary key default gen_random_uuid(),
  uw_analyst_id text unique not null,
  name text not null,
  firm text not null,
  tier int not null check (tier between 1 and 3),
  sectors text[] default '{}',
  confidence_score int not null check (confidence_score between 1 and 10),
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_trusted_analysts_active on trusted_analysts (active) where active = true;
create index idx_trusted_analysts_uw_id on trusted_analysts (uw_analyst_id);

-- ============================================================================
-- Rating events (filtered to trusted analysts only at ingest)
-- ============================================================================
create table rating_events (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references trusted_analysts(id) on delete restrict,
  ticker text not null,
  action_type text not null check (action_type in (
    'initiation','upgrade','downgrade','pt_change','reiteration','suspension'
  )),
  old_rating text,
  new_rating text,
  old_pt numeric,
  new_pt numeric,
  implied_upside numeric,
  published_at timestamptz not null,
  source text not null default 'unusual_whales',
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  unique (analyst_id, ticker, published_at, action_type)
);

create index idx_rating_events_published_at on rating_events (published_at desc);
create index idx_rating_events_ticker on rating_events (ticker);
create index idx_rating_events_analyst on rating_events (analyst_id);

-- ============================================================================
-- Frozen feature snapshot at publication time
-- Captured ONCE at event ingest. Never updated. Used as model input.
-- ============================================================================
create table event_features (
  event_id uuid primary key references rating_events(id) on delete cascade,
  spot_price numeric,
  prev_close numeric,
  adv_30d bigint,
  market_cap numeric,
  sector text,
  sector_etf text,
  sector_etf_level numeric,
  spy_level numeric,
  vix numeric,
  days_to_earnings int,
  days_since_last_rating int,
  analyst_coverage_count int,
  short_interest_pct numeric,
  iv_30d numeric,
  pre_market_return numeric,
  analyst_tier int,
  analyst_hit_rate_90d numeric,
  analyst_avg_return_90d numeric,
  implied_upside numeric,
  pt_change_pct numeric,
  is_initiation boolean,
  is_top_pick boolean,
  regime text check (regime in ('bull','bear','chop')),
  captured_at timestamptz not null default now()
);

-- ============================================================================
-- Windowed price snapshots (the 7 canonical points used by strategies)
-- ============================================================================
create table price_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references rating_events(id) on delete cascade,
  ticker text not null,
  window_label text not null check (window_label in (
    't0','t+1m','t+2m','t+5m','t+30m','eod','t+1d','t+5d','t+30d'
  )),
  price numeric,
  spy_price numeric,
  sector_etf_price numeric,
  volume bigint,
  captured_at timestamptz,
  unique (event_id, window_label)
);

create index idx_price_snapshots_event on price_snapshots (event_id);

-- ============================================================================
-- Dense price bars per event (second granularity for first 30m, then minute)
-- ============================================================================
create table price_bars (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references rating_events(id) on delete cascade,
  ticker text not null,
  bar_timestamp timestamptz not null,
  granularity text not null check (granularity in ('second','minute','daily')),
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume bigint,
  unique (event_id, ticker, bar_timestamp, granularity)
);

create index idx_price_bars_event_time on price_bars (event_id, bar_timestamp);
create index idx_price_bars_ticker_time on price_bars (ticker, bar_timestamp);

-- ============================================================================
-- Virtual trades — three per event (immediate, fade, drift)
-- ============================================================================
create table virtual_trades (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references rating_events(id) on delete cascade,
  strategy text not null check (strategy in ('immediate','fade','drift')),
  entry_window text not null,
  exit_window text not null,
  entry_price numeric,
  exit_price numeric,
  raw_return numeric,
  market_adj_return numeric,
  sector_adj_return numeric,
  cost_adjusted_return numeric,
  estimated_slippage_bps numeric,
  estimated_borrow_cost_bps numeric,
  status text not null default 'pending' check (status in ('pending','filled','closed','failed')),
  failure_reason text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (event_id, strategy)
);

create index idx_virtual_trades_event on virtual_trades (event_id);
create index idx_virtual_trades_strategy_status on virtual_trades (strategy, status);

-- ============================================================================
-- Confounding context (news, follow-on ratings, earnings, halts within window)
-- ============================================================================
create table event_context (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references rating_events(id) on delete cascade,
  context_type text not null check (context_type in (
    'news','filing','followon_rating','earnings','halt','corporate_action','m_and_a'
  )),
  occurred_at timestamptz not null,
  source text,
  headline text,
  raw_payload jsonb,
  flagged_as_confound boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_event_context_event on event_context (event_id);
create index idx_event_context_confound on event_context (event_id) where flagged_as_confound = true;

-- ============================================================================
-- Free-text user notes per event
-- ============================================================================
create table event_notes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references rating_events(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_event_notes_event on event_notes (event_id);

-- ============================================================================
-- Updated-at triggers
-- ============================================================================
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_trusted_analysts_updated_at
  before update on trusted_analysts
  for each row execute function set_updated_at();

create trigger trg_event_notes_updated_at
  before update on event_notes
  for each row execute function set_updated_at();
