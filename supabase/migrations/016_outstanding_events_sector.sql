-- Carry the rating's own sector through the work-selection query.
--
-- The benchmark is chosen per rating, and the sector on the rating is the one
-- the feed reported at the time. Reading it from `uw_ticker_info` instead would
-- pick up whatever that ticker's sector was last refreshed to, which is a
-- (small) look-ahead and is also empty for a name not yet enriched.

drop function if exists public.research_outstanding_events(text[], int);

create or replace function public.research_outstanding_events(
  p_keys text[],
  p_limit int default 150
)
returns table (event_key text, ticker text, rated_at timestamptz, sector text)
language sql
stable
set search_path = public
as $$
  select r.event_key, r.ticker, r.rated_at, r.sector
  from unnest(p_keys) as k(event_key)
  join uw_analyst_ratings r on r.event_key = k.event_key
  where r.windows_pulled_at is null
     or exists (
       select 1 from research_window_offsets() o
       where r.rated_at + o.off <= now()
         and r.rated_at + o.off > r.windows_pulled_at
     )
  order by r.rated_at desc
  limit greatest(coalesce(p_limit, 150), 1);
$$;

revoke all on function public.research_outstanding_events(text[], int) from public;
grant execute on function public.research_outstanding_events(text[], int) to service_role;
