-- Picking the next slice of price-window work in one query.
--
-- The enrichment loop used to ship every selected event key to the server on
-- every pass and read them back a hundred at a time — twenty round trips for a
-- thousand rows, repeated for each batch of forty. This does the same selection
-- once, on indexed columns, and hands back both the slice to work on and how
-- much is still outstanding, so the client can stop the moment there is nothing
-- left rather than guessing from a count it computed itself.

create or replace function public.research_outstanding_events(
  p_keys text[],
  p_limit int default 100
)
returns table (
  event_key text,
  ticker text,
  rated_at timestamptz,
  outstanding_total bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with offsets as (
    -- Every moment a window is measured at: the six intraday offsets, then one
    -- per calendar day out to +30. (+1d doubles as the end-of-day window.)
    select off from unnest(
      array[
        interval '1 minute',
        interval '5 minutes',
        interval '15 minutes',
        interval '30 minutes',
        interval '1 hour',
        interval '4 hours'
      ] || array(select (n || ' days')::interval from generate_series(1, 30) as n)
    ) as off
  ),
  todo as (
    select r.event_key, r.ticker, r.rated_at
    from uw_analyst_ratings r
    where r.event_key = any(p_keys)
      and (
        r.windows_pulled_at is null
        -- Otherwise it only needs another look if a window has elapsed since
        -- the last pull: a rating priced an hour in comes back for its +1d.
        or exists (
          select 1
          from offsets o
          where r.rated_at + o.off <= now()
            and r.rated_at + o.off > r.windows_pulled_at
        )
      )
  )
  select t.event_key, t.ticker, t.rated_at, (select count(*) from todo)
  from todo t
  -- Newest first, so the rows at the top of the table fill in first.
  order by t.rated_at desc
  limit greatest(p_limit, 1);
$$;

revoke all on function public.research_outstanding_events(text[], int) from public;
grant execute on function public.research_outstanding_events(text[], int) to service_role;
