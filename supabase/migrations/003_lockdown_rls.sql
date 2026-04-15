-- Migration 003: Lock down the database (Path B hardening)
--
-- Enables Row Level Security on every public table with NO policies. With RLS
-- enabled and no policies, the anon and authenticated Postgres roles get
-- zero access (default deny). The service_role key bypasses RLS entirely,
-- so server-side code using lib/supabase/admin.ts continues to work.
--
-- Threat model:
--   - Vercel Deployment Protection (Password) guards the UI at the edge.
--   - RLS guards the Supabase REST/GraphQL API so even if someone extracts
--     the anon key from client JS, they cannot read or write anything.
--   - Server Components and Server Actions use the service_role key (which
--     never ships to the browser) to read and write on behalf of the one
--     trusted operator (you).
--
-- If you later add Supabase Auth and multi-user support, REPLACE this with
-- per-role policies rather than leaving deny-all in place.

alter table trusted_analysts     enable row level security;
alter table rating_events        enable row level security;
alter table event_features       enable row level security;
alter table price_snapshots      enable row level security;
alter table price_bars           enable row level security;
alter table virtual_trades       enable row level security;
alter table event_context        enable row level security;
alter table event_notes          enable row level security;
alter table models               enable row level security;
alter table predictions          enable row level security;
alter table prediction_outcomes  enable row level security;
alter table analyst_scorecards   enable row level security;
alter table calibration_metrics  enable row level security;
alter table drift_alerts         enable row level security;
alter table market_regimes       enable row level security;
alter table prediction_overrides enable row level security;
