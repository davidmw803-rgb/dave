-- ============================================================================
-- The grouped-returns query behind the MCP `summarize_returns` tool, plus the
-- index that makes it usable.
--
-- Without the index the planner probes uw_event_price_windows once per rating
-- through its (event_key, window_label) primary key — about four buffers each,
-- 3.4 seconds for one grouping today and roughly four times that once every
-- rating is priced. The leading column of the PK is event_key, so filtering by
-- window_label alone cannot use it.
--
-- Covering window_label with the three columns the aggregate reads turns that
-- into one index-only scan hash-joined to the ratings: 3,398ms -> 13ms, and
-- 7,555 buffers -> 2,562.
--
-- Both functions below were applied live before this file existed; it is here
-- so the schema can be rebuilt from the repo.
-- ============================================================================

create index if not exists idx_windows_label_cover
  on uw_event_price_windows (window_label)
  include (event_key, pct_from_t0, abn_pct);

create or replace function public.research_summary(
  p_window text default 't+5d',
  p_group_by text default 'none',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_action text default null,
  p_rating text default null,
  p_tickers text[] default null,
  p_min_n int default 1
)
returns table (
  bucket text,
  n bigint,
  n_adjusted bigint,
  mean_raw_pct numeric,
  mean_abn_pct numeric,
  median_abn_pct numeric,
  stddev_abn_pct numeric,
  share_positive_raw numeric,
  share_positive_abn numeric
)
language plpgsql
stable
set search_path = public
as $$
declare
  grp text;
  sql text;
begin
  -- Whitelist. The grouping is interpolated into the statement, so it may only
  -- ever be one of these expressions and never caller text.
  grp := case lower(coalesce(p_group_by, 'none'))
    when 'none'     then '''all'''
    when 'sector'   then 'coalesce(i.sector, r.sector)'
    when 'action'   then 'r.action'
    when 'rating'   then 'r.recommendation'
    when 'firm'     then 'r.firm'
    when 'analyst'  then 'r.analyst_name'
    when 'weekday'  then 'trim(to_char(r.rated_at at time zone ''America/New_York'', ''Day''))'
    when 'session'  then $g$case
        when (r.rated_at at time zone 'America/New_York')::time >= time '09:30'
         and (r.rated_at at time zone 'America/New_York')::time <  time '16:00' then 'regular'
        when (r.rated_at at time zone 'America/New_York')::time >= time '04:00'
         and (r.rated_at at time zone 'America/New_York')::time <  time '09:30' then 'pre-market'
        when (r.rated_at at time zone 'America/New_York')::time >= time '16:00'
         and (r.rated_at at time zone 'America/New_York')::time <  time '20:00' then 'after-hours'
        else 'closed' end$g$
    when 'mcap'     then $g$case
        when i.marketcap is null then 'unknown'
        when i.marketcap <   300000000 then 'micro (<300M)'
        when i.marketcap <  2000000000 then 'small (300M-2B)'
        when i.marketcap < 10000000000 then 'mid (2B-10B)'
        else 'large (>10B)' end$g$
    else null
  end;

  if grp is null then
    raise exception 'unknown group_by %; allowed: none, sector, action, rating, firm, analyst, weekday, session, mcap', p_group_by;
  end if;

  -- Counted on the RAW move so the tool is useful before the benchmark
  -- backfill has run; `n_adjusted` says how much of each bucket the adjusted
  -- columns actually cover.
  sql := format($f$
    select %s::text as bucket,
           count(*)::bigint,
           count(w.abn_pct)::bigint,
           round(avg(w.pct_from_t0)::numeric, 4),
           round(avg(w.abn_pct)::numeric, 4),
           round((percentile_cont(0.5) within group (order by w.abn_pct))::numeric, 4),
           round(stddev_samp(w.abn_pct)::numeric, 4),
           round(avg((w.pct_from_t0 > 0)::int)::numeric * 100, 2),
           round(avg((w.abn_pct > 0)::int)::numeric * 100, 2)
    from uw_analyst_ratings r
    join uw_event_price_windows w
      on w.event_key = r.event_key and w.window_label = %L
    left join uw_ticker_info i on i.ticker = r.ticker
    where w.pct_from_t0 is not null
  $f$, grp, p_window);

  if p_from is not null then sql := sql || format(' and r.rated_at >= %L::timestamptz', p_from); end if;
  if p_to is not null then sql := sql || format(' and r.rated_at < %L::timestamptz', p_to); end if;
  if p_action is not null then sql := sql || format(' and r.action = %L', p_action); end if;
  if p_rating is not null then sql := sql || format(' and r.recommendation = %L', p_rating); end if;
  if p_tickers is not null and array_length(p_tickers,1) is not null then
    sql := sql || format(' and r.ticker = any(%L::text[])', p_tickers);
  end if;

  sql := sql || format(' group by 1 having count(*) >= %s order by 2 desc',
                       greatest(coalesce(p_min_n,1),1));
  return query execute sql;
end;
$$;

revoke all on function public.research_summary(text, text, timestamptz, timestamptz, text, text, text[], int) from public;
grant execute on function public.research_summary(text, text, timestamptz, timestamptz, text, text, text[], int) to service_role;
