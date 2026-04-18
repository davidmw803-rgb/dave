# Polymarket paper-trade dashboard

Live dashboard for the BTC 5m Polymarket paper-trading bot, built on top of the
existing Next.js 14 / Supabase / Vercel setup. The dashboard reads from the
`btc5m_paper_trades` table and supporting views (`btc5m_paper_summary`,
`btc5m_trades_detailed`, `btc5m_seconds`).

## Routes

- `/` — tiles (open count, today realized P&L, 7d win rate, total closed), live
  open-positions table, equity curve (last 500 closed)
- `/trades` — filterable/sortable/paginated closed-trade log
- `/markets/[slug]` — mid-price chart with paper-trade markers + trade list
- `/strategy` — rolling 50-trade win rate / avg P&L, P&L histogram, STC buckets

## Environment variables

Set these in `.env.local` and in Vercel project settings:

| Var | Used by | Scope |
|-----|---------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser Realtime + client reads | public |
| `SUPABASE_SERVICE_ROLE_KEY` | server components + `/api/live-mids` | **server only** |

The service-role key is consumed via `lib/supabase/admin.ts`. Do **not** import
that module from client components.

## Live mids

`/api/live-mids?ids=<comma_separated_asset_ids>` returns the latest
`mid_before` / `price` per `asset_id` from `btc5m_trades_detailed`. The open
positions table polls it every 2s when positions exist.

## Realtime

Browser clients subscribe to `postgres_changes` on `btc5m_paper_trades`; new
opens prepend to the open-positions table, closes remove from it and refresh
the equity curve / tiles.

## Honesty guardrails

- Every win-rate / avg-P&L tile shows sample size and greys out when `n < 30`.
- `/strategy` shows a banner when total closed trades < 200.

---

# Trusted Analyst Rating Reaction & Prediction Engine

A research and prediction system for tracking how trusted Wall Street analysts' rating actions move stocks, with a built-in prediction engine that learns from outcomes over time.

## What this does

1. **Captures** rating actions from a curated list of trusted analysts via the Unusual Whales API
2. **Stores** dense price data (second + minute bars) around each event for reproducible analysis
3. **Displays** events on a chart with the publication timestamp marked, the analyst's price target as a horizontal line, three strategy bands (immediate / fade / drift), SPY overlay, and follow-on rating annotations
4. **Analyzes** three parallel virtual trading strategies per event and rolls up per-analyst scorecards
5. **Predicts** market-adjusted return distributions for each new event using a model that improves over time
6. **Learns** by tracking every prediction against its actual outcome, with calibration plots and drift detection

## Architecture

- **Frontend:** Next.js 14 (App Router) + Tailwind + shadcn/ui
- **Database:** Supabase (Postgres + Edge Functions + Cron)
- **Charts:** lightweight-charts (TradingView's open-source library)
- **Data sources:** Unusual Whales API (events), Polygon/Databento (prices — provider-agnostic interface)
- **Models:** Python sidecar (FastAPI) for sklearn / xgboost / lightgbm — called from Next.js via internal API
- **AI layer:** Anthropic API (Claude Sonnet) for weekly reports and event narratives

## Repo layout

```
/app                    Next.js App Router
  /api                  REST endpoints (ingest, backfill, predictions)
  /dashboard            Live event feed, scorecards, prediction tracker
  /event/[id]           Event detail page with the full chart
/lib
  /providers            PriceProvider interface + implementations
  /uw                   Unusual Whales API client
  /strategies           immediate / fade / drift virtual trade math
  /scorecard            Per-analyst, per-strategy rollups
  /features             Feature snapshot computation (frozen at publication)
  /predictions          Model serving glue, calibration tracking
/supabase
  /migrations           SQL migrations, numbered
  /functions            Edge functions (capture-prices, score-refresh)
/python
  /model                Training and serving (FastAPI)
/types                  Shared TypeScript types
```

## Build phases

| Session | Scope |
|--|--|
| **1** | Schema + analyst CRUD + provider interface + types (this repo) |
| 2 | UW ingestion, dedup, backfill of events |
| 3 | Price capture (dense bars + windowed snapshots) + strategy math |
| 4 | Event detail page with full chart |
| 5 | Scorecards + strategy comparison views |
| 6 | Backfill orchestration + first real model (logistic baseline) |
| 7 | GBM model + prediction tracking + calibration |
| 8 | Quantile model + drift detection + weekly Claude reports |

## Quick start

```bash
# 1. Clone + install
git clone <your-repo-url>
cd analyst-tracker
npm install

# 2. Environment
cp .env.example .env.local
# Fill in: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
#          UW_API_KEY, ANTHROPIC_API_KEY, (PRICE_PROVIDER_KEY when chosen)

# 3. Supabase
npx supabase init
npx supabase start          # local dev DB
npx supabase db reset       # applies migrations in /supabase/migrations

# 4. Run dev server
npm run dev
```

## Disciplines this repo enforces

These aren't optional — they're what separates a real prediction system from self-deception:

- **Frozen feature snapshots.** Every event captures its inputs at publication time into `event_features`. Predictions reference that snapshot, never re-derive features from current data.
- **Locked predictions.** Every prediction is written to the `predictions` table with the model version and a JSON copy of inputs used. Outcomes are computed against locked predictions, not re-run models.
- **Walk-forward validation only.** No leave-one-out, no random splits, no peeking at future data. All training/test boundaries are time-based.
- **Cost-adjusted returns.** Every virtual trade computes both raw and slippage/borrow-adjusted returns. The adjusted number is what you trust.
- **Calibration over accuracy.** Track Brier score and reliability diagrams, not just hit rate. A 70% confidence prediction must actually be right ~70% of the time.

## License

Private. Internal use only.
