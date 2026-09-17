-- ============================================================================
-- Sector-adjusted returns.
--
-- Every forward return in this table was raw, which makes two ratings a month
-- apart incomparable: each was graded against a different market. The sector
-- ETF is the standard control — it removes the market move and the sector
-- rotation and leaves what was specific to the name.
--
-- `pct` is unchanged: the move from the rating-time anchor. The two new
-- columns are deliberately measured differently — close-to-close from the last
-- session at or before the rating, for BOTH the stock and the ETF. That
-- symmetry is the whole point: an abnormal return is only meaningful if the
-- two legs span the same interval, and the ETF has no intraday bar to anchor
-- against. So `abn_pct` is not `pct` minus `bench_pct`, and is not meant to be.
--
-- Intraday windows (t+1m..t+4h) carry no benchmark: a minute of market drift
-- is noise, and adjusting it would cost one ETF call per fund per session.
-- ============================================================================

alter table uw_analyst_ratings
  add column if not exists bench_ticker text;

alter table uw_event_price_windows
  add column if not exists bench_pct numeric,
  add column if not exists abn_pct numeric;

comment on column uw_event_price_windows.bench_pct is
  'Sector-ETF return over the same interval, close-to-close from the session at or before the rating.';
comment on column uw_event_price_windows.abn_pct is
  'Stock return minus benchmark return, both close-to-close from the session at or before the rating.';

-- `research_rows_page` returns `setof uw_research_rows`, so it depends on the
-- view's row type and has to be dropped and rebuilt around the change.
drop function if exists public.research_rows_page(
  timestamptz, timestamptz, text[], text, text, text[], timestamptz, text, int
);
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
  r.bench_ticker,
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
           jsonb_build_object(
             'price', w.price,
             'pct', w.pct_from_t0,
             'bench', w.bench_pct,
             'abn', w.abn_pct
           )
         ) as moves
  from uw_event_price_windows w
  where w.event_key = r.event_key
) m on true;

create or replace function public.research_rows_page(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_tickers text[] default null,
  p_action text default null,
  p_rating text default null,
  p_event_keys text[] default null,
  p_cursor_rated_at timestamptz default null,
  p_cursor_event_key text default null,
  p_limit int default 1000
)
returns setof uw_research_rows
language plpgsql
stable
set search_path = public
as $$
declare
  sql text;
begin
  sql := 'select * from uw_research_rows where true'
      || research_rows_filter_sql(p_from, p_to, p_tickers, p_action, p_rating, p_event_keys);

  if p_cursor_rated_at is not null and p_cursor_event_key is not null then
    sql := sql || format(
      ' and (rated_at, event_key) < (%L::timestamptz, %L::text)',
      p_cursor_rated_at, p_cursor_event_key
    );
  end if;

  sql := sql || format(
    ' order by rated_at desc, event_key desc limit %s',
    greatest(coalesce(p_limit, 1000), 1)
  );

  return query execute sql;
end;
$$;

revoke all on function public.research_rows_page(timestamptz, timestamptz, text[], text, text, text[], timestamptz, text, int) from public;
grant execute on function public.research_rows_page(timestamptz, timestamptz, text[], text, text, text[], timestamptz, text, int) to service_role;
