# Build roadmap

This is the full multi-session plan. Session 1 ships in this seed repo; subsequent sessions are prompts you'll feed to Claude Code as you go.

| # | Session | Output |
|---|---------|--------|
| 1 | Foundation | Schema applied, analyst CRUD UI, MockPriceProvider, Anthropic client, types generated |
| 2 | UW ingestion | Real UW client, `/api/events/ingest` cron endpoint, deduplication, filter to trusted analysts only |
| 3 | Price capture & strategies | Dense price bar capture (second + minute), windowed snapshots, immediate/fade/drift virtual trades against MockProvider |
| 4 | Event detail page | Full chart with publication line, target line, prior PT line, SPY overlay, sector ETF overlay, strategy bands, follow-on rating annotations, news markers, notes field |
| 5 | Real price provider | Polygon (or Databento) implementation behind PriceProvider interface, replace mock in production |
| 6 | Scorecards & comparison | Per-analyst rolling scorecards, strategy comparison view, regime tagging |
| 7 | Backfill | Pull 2-3 years of historical events for each trusted analyst, capture historical prices, compute all virtual trades |
| 8 | v1 baseline model | Logistic regression (Python sidecar), prediction tracking table populated for every new event, calibration plot on `/predictions` |
| 9 | v2 GBM model | XGBoost/LightGBM with full feature set, walk-forward validation, ablation framework |
| 10 | v3 quantile model | p10/p50/p90 outputs, confidence band on chart, Kelly sizing recommendations |
| 11 | Drift & retraining | KS test feature drift detection, calibration divergence alerts, retraining workflow |
| 12 | Weekly Claude reports | Anthropic API generates a weekly summary: leaderboard delta, model performance, anomalies, suggested adds/drops |

## Operational disciplines (every session)

- Migrations are append-only. Never edit `001_*.sql` after it's been applied to a real DB. Add `003_*.sql` and so on.
- Every new feature added to the model gets logged in the `models` registry with the trained_at timestamp and feature list.
- Predictions are immutable once written. Outcomes go to `prediction_outcomes`, never back into `predictions`.
- All time-series train/test splits are walk-forward, never random.
- Cost-adjusted returns are the only returns the scorecards care about.
