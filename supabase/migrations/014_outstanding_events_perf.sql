-- ============================================================================
-- Make picking the next slice of enrichment work cheap again.
--
-- 011 selected the batch with `event_key = any(p_keys)` and carried the
-- outstanding total on every returned row as `(select count(*) from todo)`.
-- Both were mistakes once the key list was the whole table: the correlated
-- count forced the CTE to materialise all 14,680 outstanding rows before the
-- LIMIT could take 150, and inside the function the array predicate planned
-- generically. Measured 10,094ms — out of a 45-second pass budget, spent
-- before a single price was fetched.
--
-- Joining `unnest(p_keys)` to the table instead gives the planner a join it can
-- cost properly, and the total moves to its own function the caller asks for
-- separately. 10,094ms -> 117ms for the batch, 114ms for the count.
-- ============================================================================

drop function if exists public.research_outstanding_events(text[], int);

-- Every moment a window is measured at: the six intraday offsets, then one per
-- calendar day out to +30. (+1d doubles as the end-of-day window.)
create or replace function public.research_window_offsets()
returns table (off interval)
language sql
immutable
set search_path = public
as $$
  select off from unnest(
    array[
      interval '1 minute',
      interval '5 minutes',
      interval '15 minutes',
      interval '30 minutes',
      interval '1 hour',
      interval '4 hours'
    ] || array(select (n || ' days')::interval from generate_series(1, 30) as n)
  ) as off;
$$;

create or replace function public.research_outstanding_events(
  p_keys text[],
  p_limit int default 150
)
returns table (event_key text, ticker text, rated_at timestamptz)
language sql
stable
set search_path = public
as $$
  select r.event_key, r.ticker, r.rated_at
  from unnest(p_keys) as k(event_key)
  join uw_analyst_ratings r on r.event_key = k.event_key
  where r.windows_pulled_at is null
     -- Otherwise it only needs another look if a window has elapsed since the
     -- last pull: a rating priced an hour in comes back for its +1d.
     or exists (
       select 1 from research_window_offsets() o
       where r.rated_at + o.off <= now()
         and r.rated_at + o.off > r.windows_pulled_at
     )
  -- Newest first, so the rows at the top of the table fill in first.
  order by r.rated_at desc
  limit greatest(coalesce(p_limit, 150), 1);
$$;

create or replace function public.research_outstanding_count(p_keys text[])
returns bigint
language sql
stable
set search_path = public
as $$
  select count(*)
  from unnest(p_keys) as k(event_key)
  join uw_analyst_ratings r on r.event_key = k.event_key
  where r.windows_pulled_at is null
     or exists (
       select 1 from research_window_offsets() o
       where r.rated_at + o.off <= now()
         and r.rated_at + o.off > r.windows_pulled_at
     );
$$;

revoke all on function public.research_outstanding_events(text[], int) from public;
revoke all on function public.research_outstanding_count(text[]) from public;
grant execute on function public.research_outstanding_events(text[], int) to service_role;
grant execute on function public.research_outstanding_count(text[]) to service_role;
