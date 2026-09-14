-- ============================================================================
-- Daily price windows every day out to +30, not just +1, +5 and +30.
--
-- Costs nothing at the API: the daily bars for a ticker already arrive in one
-- OHLC call covering three months, so the extra windows are read from a
-- response we were fetching anyway.
-- ============================================================================

alter table uw_event_price_windows drop constraint if exists uw_event_price_windows_window_label_check;
alter table uw_event_price_windows add constraint uw_event_price_windows_window_label_check
  check (window_label in (
    't0', 't+1m', 't+5m', 't+15m', 't+30m', 't+1h', 't+4h', 'eod', 't+1d',
    't+2d', 't+3d', 't+4d', 't+5d', 't+6d', 't+7d', 't+8d', 't+9d',
    't+10d', 't+11d', 't+12d', 't+13d', 't+14d', 't+15d', 't+16d', 't+17d',
    't+18d', 't+19d', 't+20d', 't+21d', 't+22d', 't+23d', 't+24d', 't+25d',
    't+26d', 't+27d', 't+28d', 't+29d', 't+30d'
  ));

-- Ratings priced under the old set are missing +2d..+4d and +6d..+29d, so let
-- the next pull pick them up. Their bars are cached; this refills, not refetches.
update uw_analyst_ratings
set windows_pulled_at = null
where windows_pulled_at is not null;
