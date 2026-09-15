-- ============================================================================
-- Stop reading the whole price-window table to return one page.
--
-- 010 replaced a per-row correlated subquery with a single aggregate over
-- `uw_event_price_windows`, which was much faster but kept the shape of the
-- problem: the aggregate covers EVERY rating, so asking for 100 rows still
-- grouped all 157,629 window rows and touched 25,051 buffers. That is ~550ms
-- when those buffers are cached — and a statement timeout when they are not,
-- which is what the 2.5 TB Polymarket table does to the cache all day. It also
-- grows with the backlog: every rating priced pushes it toward 690,000 rows.
--
-- Two changes make a page cost what a page should:
--   * `price_t0` moves onto the rating itself, so the columns derived from it
--     need no join at all.
--   * `moves` becomes a LATERAL, evaluated per returned row against the window
--     table's primary key, so the LIMIT is reached after ~100 index lookups
--     instead of after a full group-aggregate.
-- ============================================================================

alter table uw_analyst_ratings add column if not exists price_t0 numeric;

update uw_analyst_ratings r
   set price_t0 = w.price
  from uw_event_price_windows w
 where w.event_key = r.event_key
   and w.window_label = 't0'
   and r.price_t0 is distinct from w.price;

-- The table's sort order, so a page can be read straight off the index rather
-- than sorted out of a materialised join.
create index if not exists idx_uw_ratings_rated_at_event_key
  on uw_analyst_ratings (rated_at desc, event_key asc);

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
  r.price_t0 as price_at_rating,
  i.last_price as current_price,
  i.last_price_at as current_price_at,
  case
    when i.last_price is not null and i.last_price > 0 and r.target is not null
      then (r.target - i.last_price) / i.last_price * 100
  end as upside_pct,
  case
    when r.price_t0 is not null and r.price_t0 > 0 and i.last_price is not null
      then (i.last_price - r.price_t0) / r.price_t0 * 100
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
  (r.price_t0 is not null) as has_prices,
  (tr.ticker is not null) as has_tipranks,
  (a.analyst_key is not null) as has_analyst
from uw_analyst_ratings r
left join uw_ticker_info i on i.ticker = r.ticker
left join tipranks_research tr on tr.ticker = r.ticker
left join research_analysts a on a.analyst_key = r.analyst_key
left join lateral (
  select jsonb_object_agg(
           w.window_label,
           jsonb_build_object('price', w.price, 'pct', w.pct_from_t0)
         ) as moves
  from uw_event_price_windows w
  where w.event_key = r.event_key
) m on true;
