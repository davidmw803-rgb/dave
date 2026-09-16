-- ============================================================================
-- Page the research table by cursor instead of by OFFSET.
--
-- The client loads every matching row by asking for successive pages, and with
-- OFFSET each page re-walks everything before it: page 18 of 18 produced 18,000
-- rows to return 1,000, touching 101,771 buffers. Loading the whole table cost
-- ~900,000 buffer touches, and when those buffers were not cached it was a
-- statement timeout instead.
--
-- A cursor on (rated_at, event_key) turns each page into an index seek, so
-- page 18 costs what page 1 costs. Sorting both columns DESC is what makes it a
-- single row-value comparison the index can satisfy in one range scan — a mixed
-- ASC/DESC order cannot be expressed that way.
--
-- The count moves off the view onto the ratings table, where every filter
-- actually lives: the client needs it once per filter change, not once per page.
-- ============================================================================

create index if not exists idx_uw_ratings_keyset
  on uw_analyst_ratings (rated_at desc, event_key desc);

-- Values are interpolated with %L, which quotes them as literals; building the
-- text this way (rather than one statement full of `or $1 is null` branches)
-- keeps the planner on the index for whichever filters are actually in play.
create or replace function public.research_rows_filter_sql(
  p_from timestamptz,
  p_to timestamptz,
  p_tickers text[],
  p_action text,
  p_rating text,
  p_event_keys text[]
) returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  clause text := '';
begin
  if p_from is not null then
    clause := clause || format(' and rated_at >= %L::timestamptz', p_from);
  end if;
  if p_to is not null then
    clause := clause || format(' and rated_at < %L::timestamptz', p_to);
  end if;
  if p_tickers is not null and array_length(p_tickers, 1) is not null then
    clause := clause || format(' and ticker = any(%L::text[])', p_tickers);
  end if;
  if p_action is not null then
    clause := clause || format(' and action = %L', p_action);
  end if;
  if p_rating is not null then
    clause := clause || format(' and recommendation = %L', p_rating);
  end if;
  if p_event_keys is not null and array_length(p_event_keys, 1) is not null then
    clause := clause || format(' and event_key = any(%L::text[])', p_event_keys);
  end if;
  return clause;
end;
$$;

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
) returns setof uw_research_rows
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

-- The filters all live on the ratings table, so the total never needs the view's
-- joins or its per-row price windows.
create or replace function public.research_rows_count(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_tickers text[] default null,
  p_action text default null,
  p_rating text default null,
  p_event_keys text[] default null
) returns bigint
language plpgsql
stable
set search_path = public
as $$
declare
  total bigint;
begin
  execute 'select count(*) from uw_analyst_ratings where true'
       || research_rows_filter_sql(p_from, p_to, p_tickers, p_action, p_rating, p_event_keys)
    into total;
  return total;
end;
$$;

revoke all on function public.research_rows_page(timestamptz, timestamptz, text[], text, text, text[], timestamptz, text, int) from public;
revoke all on function public.research_rows_count(timestamptz, timestamptz, text[], text, text, text[]) from public;
grant execute on function public.research_rows_page(timestamptz, timestamptz, text[], text, text, text[], timestamptz, text, int) to service_role;
grant execute on function public.research_rows_count(timestamptz, timestamptz, text[], text, text, text[]) to service_role;
