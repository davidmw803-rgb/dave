-- ============================================================================
-- Unusual Whales x TipRanks stock analysis
--
-- One row per (ticker, as_of) snapshot. The left half of the row is options /
-- flow data from Unusual Whales, the right half is analyst-consensus data from
-- TipRanks, and the tail is the combined read (composite score + signal).
--
-- Populated by the ingest job; the /stocks/analysis page reads it directly.
-- ============================================================================

create table if not exists uw_tipranks_analysis (
  id uuid primary key default gen_random_uuid(),

  ticker text not null,
  company text,
  sector text,
  price numeric,

  -- Unusual Whales (options flow) --------------------------------------------
  uw_sentiment text check (uw_sentiment in ('bullish', 'bearish', 'neutral')),
  uw_net_premium numeric,          -- net call - put premium, USD
  uw_call_put_ratio numeric,
  uw_unusual_score numeric check (uw_unusual_score between 0 and 100),
  uw_iv_rank numeric check (uw_iv_rank between 0 and 100),
  uw_dark_pool_pct numeric,        -- % of volume printed off-exchange

  -- TipRanks (analyst consensus) ---------------------------------------------
  tr_consensus text check (tr_consensus in (
    'strong_buy', 'buy', 'hold', 'sell', 'strong_sell'
  )),
  tr_analyst_count int,
  tr_star_rating numeric check (tr_star_rating between 0 and 5),
  tr_price_target numeric,
  tr_upside_pct numeric,           -- (pt - price) / price * 100
  tr_success_rate numeric,         -- % of the covering analysts' calls that worked
  tr_avg_return numeric,           -- avg 1y return of their calls, %

  -- Combined read --------------------------------------------------------------
  composite_score numeric check (composite_score between 0 and 100),
  signal text check (signal in (
    'aligned_bull', 'aligned_bear', 'divergent', 'neutral'
  )),
  notes text,

  as_of timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (ticker, as_of)
);

-- Reads and writes go through the service-role client, which bypasses RLS.
-- RLS on with no policies keeps the anon key out entirely.
alter table uw_tipranks_analysis enable row level security;

create index if not exists idx_uw_tipranks_as_of on uw_tipranks_analysis (as_of desc);
create index if not exists idx_uw_tipranks_ticker on uw_tipranks_analysis (ticker);
create index if not exists idx_uw_tipranks_signal on uw_tipranks_analysis (signal);
create index if not exists idx_uw_tipranks_composite on uw_tipranks_analysis (composite_score desc);

-- Latest snapshot per ticker — what the dashboard shows by default.
-- security_invoker so the view is subject to the caller's RLS, not the owner's.
create or replace view uw_tipranks_latest with (security_invoker = true) as
select distinct on (ticker) *
from uw_tipranks_analysis
order by ticker, as_of desc;
