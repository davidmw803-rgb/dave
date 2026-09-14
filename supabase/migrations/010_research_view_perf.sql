-- ============================================================================
-- Rebuild uw_research_rows so its cost stops scaling with windows-per-rating.
--
-- The view built each row's `moves` object with a correlated subquery, so a
-- 500-row page ran 500 separate aggregates — about 11ms each once ratings
-- carried ~10 windows, which is 5.7s of the 8s statement timeout. Widening the
-- daily series to +1d..+30d would have tripled that.
--
-- Aggregating the window table once and hash-joining it is a single pass:
-- measured 5771ms -> 32ms on 710 ratings and 6990 window rows.
-- ============================================================================

drop view if exists uw_research_rows;

create view uw_research_rows with (security_invoker = true) as
with moves_agg as (
  select
    event_key,
    jsonb_object_agg(
      window_label,
      jsonb_build_object('price', price, 'pct', pct_from_t0)
    ) as moves,
    max(price) filter (where window_label = 't0') as price_t0
  from uw_event_price_windows
  group by event_key
)
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
  m.price_t0 as price_at_rating,
  i.last_price as current_price,
  i.last_price_at as current_price_at,
  case
    when i.last_price is not null and i.last_price > 0 and r.target is not null
      then (r.target - i.last_price) / i.last_price * 100
  end as upside_pct,
  case
    when m.price_t0 is not null and m.price_t0 > 0 and i.last_price is not null
      then (i.last_price - m.price_t0) / m.price_t0 * 100
  end as move_since_rating_pct,
  m.moves,
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
  (m.event_key is not null) as has_prices,
  (tr.ticker is not null) as has_tipranks,
  (a.analyst_key is not null) as has_analyst
from uw_analyst_ratings r
left join uw_ticker_info i on i.ticker = r.ticker
left join tipranks_research tr on tr.ticker = r.ticker
left join research_analysts a on a.analyst_key = r.analyst_key
left join moves_agg m on m.event_key = r.event_key;
