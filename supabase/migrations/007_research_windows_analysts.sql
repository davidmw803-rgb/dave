-- ============================================================================
-- 1. More price windows around a rating (+15m, +4h joined the set).
-- 2. Analyst-level facts, keyed so they show on every rating that analyst made.
-- 3. The research view rebuilt: price at the rating vs the current price, all
--    windows in one jsonb column, and the analyst columns joined in.
-- ============================================================================

alter table uw_event_price_windows drop constraint if exists uw_event_price_windows_window_label_check;
alter table uw_event_price_windows add constraint uw_event_price_windows_window_label_check
  check (window_label in (
    't0', 't+1m', 't+5m', 't+15m', 't+30m', 't+1h', 't+4h', 'eod', 't+1d', 't+5d', 't+30d'
  ));

-- Ratings carry a derived analyst key so the join needs no app-side backfill.
alter table uw_analyst_ratings add column if not exists analyst_key text
  generated always as (
    lower(coalesce(analyst_name, '')) || '|' || lower(coalesce(firm, ''))
  ) stored;

create index if not exists idx_uw_ratings_analyst_key on uw_analyst_ratings (analyst_key);

-- Analyst dimension. One row per (analyst, firm); every rating by that pair
-- joins to it, so pulling an analyst once populates all of their rows.
create table if not exists research_analysts (
  analyst_key text primary key,        -- lower(name)|lower(firm)
  analyst_name text not null,
  firm text,

  -- Computed from the ratings and price windows we hold.
  ratings_count int,
  first_rating_at timestamptz,
  last_rating_at timestamptz,
  avg_upside_pct numeric,
  avg_move_1d_pct numeric,
  avg_move_5d_pct numeric,
  win_rate_1d numeric,                 -- % of rated moves that went the called direction
  scored_ratings int,                  -- how many ratings the rates above are based on
  stats_updated_at timestamptz,

  -- From TipRanks, once that adapter is wired up.
  tr_rank int,
  tr_star_rating numeric,
  tr_success_rate numeric,
  tr_avg_return numeric,
  tr_payload jsonb,
  tr_updated_at timestamptz
);

alter table research_analysts enable row level security;
create index if not exists idx_research_analysts_name on research_analysts (analyst_name);

-- Column list changes shape, so replace-in-place won't do.
drop view if exists uw_research_rows;
create view uw_research_rows with (security_invoker = true) as
select
  r.event_key,
  r.ticker,
  r.analyst_name,
  r.firm,
  r.analyst_key,
  r.recommendation,
  r.action,
  coalesce(i.sector, r.sector) as sector,
  r.target,
  r.rated_at,
  i.full_name,
  i.marketcap,
  i.marketcap_size,
  i.next_earnings_date,

  -- Price at the moment of the rating vs the latest quote.
  t0.price as price_at_rating,
  i.last_price as current_price,
  i.last_price_at as current_price_at,
  case
    when i.last_price is not null and i.last_price > 0 and r.target is not null
      then (r.target - i.last_price) / i.last_price * 100
  end as upside_pct,
  case
    when t0.price is not null and t0.price > 0 and i.last_price is not null
      then (i.last_price - t0.price) / t0.price * 100
  end as move_since_rating_pct,

  -- Every window in one object: { "t+1d": { "price": ..., "pct": ... }, ... }
  (
    select jsonb_object_agg(w.window_label, jsonb_build_object('price', w.price, 'pct', w.pct_from_t0))
    from uw_event_price_windows w
    where w.event_key = r.event_key
  ) as moves,

  a.ratings_count as analyst_ratings_count,
  a.avg_move_1d_pct as analyst_avg_move_1d,
  a.win_rate_1d as analyst_win_rate_1d,
  a.avg_upside_pct as analyst_avg_upside,
  a.scored_ratings as analyst_scored_ratings,
  a.stats_updated_at as analyst_stats_updated_at,
  a.tr_star_rating as analyst_tr_star_rating,
  a.tr_success_rate as analyst_tr_success_rate,
  a.tr_avg_return as analyst_tr_avg_return,

  tr.consensus as tr_consensus,
  tr.analyst_count as tr_analyst_count,
  tr.star_rating as tr_star_rating,
  tr.price_target as tr_price_target,
  tr.success_rate as tr_success_rate,
  tr.avg_return as tr_avg_return,

  (i.ticker is not null) as has_info,
  (t0.event_key is not null) as has_prices,
  (tr.ticker is not null) as has_tipranks,
  (a.analyst_key is not null) as has_analyst
from uw_analyst_ratings r
left join uw_ticker_info i on i.ticker = r.ticker
left join tipranks_research tr on tr.ticker = r.ticker
left join research_analysts a on a.analyst_key = r.analyst_key
left join uw_event_price_windows t0 on t0.event_key = r.event_key and t0.window_label = 't0';
