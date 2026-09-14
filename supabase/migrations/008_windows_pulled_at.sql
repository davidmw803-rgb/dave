-- ============================================================================
-- Mark on the rating itself when its price windows were last computed.
--
-- The enrichment loop used to decide "is this rating done?" by reading every
-- window row for every rating in the batch and comparing label sets. At ~10
-- rows per rating that request crosses PostgREST's 1000-row response cap once
-- ~100 ratings are priced: everything past the cap looks unpriced, so the loop
-- reprocesses it forever and the progress counter freezes.
--
-- One timestamp per rating answers the same question in O(1) per row.
-- ============================================================================

alter table uw_analyst_ratings add column if not exists windows_pulled_at timestamptz;

create index if not exists idx_uw_ratings_windows_pulled_at
  on uw_analyst_ratings (windows_pulled_at);

-- Ratings priced before this column existed: date them from their newest
-- window so they aren't all re-pulled from scratch.
update uw_analyst_ratings r
set windows_pulled_at = w.latest
from (
  select event_key, max(coalesce(bar_at, now())) as latest
  from uw_event_price_windows
  group by event_key
) w
where w.event_key = r.event_key
  and r.windows_pulled_at is null;
