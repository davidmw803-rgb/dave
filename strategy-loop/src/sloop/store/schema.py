"""DuckDB DDL for every table in spec §6.3. Idempotent."""
from __future__ import annotations

DDL = r"""
CREATE TABLE IF NOT EXISTS events (
  event_id VARCHAR PRIMARY KEY, source VARCHAR, source_id VARCHAR, type VARCHAR,
  ticker VARCHAR, ts_published TIMESTAMPTZ, ts_ingested TIMESTAMPTZ, payload_json JSON
);  -- event_id is derived from (source, source_id), so re-ingesting a row replaces it
CREATE TABLE IF NOT EXISTS universe_pit (
  ticker VARCHAR, date DATE, mcap DOUBLE, sector VARCHAR, industry VARCHAR,
  avg_dollar_vol_20d DOUBLE, listed BOOLEAN, PRIMARY KEY (ticker, date)
);
CREATE TABLE IF NOT EXISTS prices (
  ticker VARCHAR, date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
  volume DOUBLE, adj_close DOUBLE, PRIMARY KEY (ticker, date)
);
CREATE TABLE IF NOT EXISTS regimes (
  date DATE PRIMARY KEY, vix_bucket VARCHAR, spy_trend VARCHAR, iwm_trend VARCHAR,
  breadth_bucket VARCHAR, regime_label VARCHAR
);
CREATE TABLE IF NOT EXISTS hypotheses (
  hypothesis_id VARCHAR PRIMARY KEY, parent_id VARCHAR, family_key VARCHAR, cell_key VARCHAR,
  proposed_by VARCHAR, trigger_event_id VARCHAR, created_at TIMESTAMPTZ, spec_json JSON,
  mechanism VARCHAR, status VARCHAR, status_changed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS tests (
  test_id VARCHAR PRIMARY KEY, hypothesis_id VARCHAR, variant_json JSON, sample VARCHAR,
  segment_key VARCHAR, n_events INTEGER, n_dates INTEGER, mean_ar DOUBLE, hit_rate DOUBLE,
  p_clustered DOUBLE, sharpe DOUBLE, deflated_sharpe DOUBLE, null_percentile DOUBLE,
  half1_pass BOOLEAN, half2_pass BOOLEAN, passed BOOLEAN, run_at TIMESTAMPTZ,
  details_json JSON
);
CREATE TABLE IF NOT EXISTS coverage (
  cell_key VARCHAR PRIMARY KEY, catalyst_type VARCHAR, sector VARCHAR, cap_bucket VARCHAR,
  state VARCHAR, n_tests INTEGER, est_event_count INTEGER, best_test_id VARCHAR,
  last_touched TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS strategies (
  strategy_id VARCHAR PRIMARY KEY, hypothesis_id VARCHAR, config_json JSON, config_hash VARCHAR,
  state VARCHAR, allocation_pct DOUBLE, approved_by VARCHAR, approved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS signals (
  signal_id VARCHAR PRIMARY KEY, strategy_id VARCHAR, event_id VARCHAR, ts TIMESTAMPTZ,
  action VARCHAR, skipped_reason VARCHAR
);
CREATE TABLE IF NOT EXISTS orders (
  order_id VARCHAR PRIMARY KEY, client_order_id VARCHAR UNIQUE, signal_id VARCHAR,
  broker_order_id VARCHAR, side VARCHAR, qty DOUBLE, type VARCHAR, "limit" DOUBLE, stop DOUBLE,
  take_profit DOUBLE, mode VARCHAR, status VARCHAR, ts TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS fills (
  fill_id VARCHAR PRIMARY KEY, order_id VARCHAR, price DOUBLE, qty DOUBLE, ts TIMESTAMPTZ, fees DOUBLE
);
CREATE TABLE IF NOT EXISTS positions (
  strategy_id VARCHAR, ticker VARCHAR, qty DOUBLE, avg_cost DOUBLE, opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ, pnl DOUBLE
);
CREATE TABLE IF NOT EXISTS evaluations (
  eval_id VARCHAR PRIMARY KEY, strategy_id VARCHAR, as_of DATE, stats_json JSON,
  regime_stats_json JSON, verdict VARCHAR, attribution VARCHAR, lesson VARCHAR
);
CREATE TABLE IF NOT EXISTS feedback (
  feedback_id VARCHAR PRIMARY KEY, from_agent VARCHAR, to_agent VARCHAR, hypothesis_id VARCHAR,
  grade VARCHAR, lesson VARCHAR, created_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS agent_scores (
  agent VARCHAR, source VARCHAR, "window" VARCHAR, proposed INTEGER, passed_insample INTEGER,
  passed_holdout INTEGER, profitable_live INTEGER, score DOUBLE
);
CREATE TABLE IF NOT EXISTS trial_counter (
  id INTEGER PRIMARY KEY, total BIGINT
);
CREATE TABLE IF NOT EXISTS heartbeats (
  service VARCHAR, ts TIMESTAMPTZ, status VARCHAR
);
CREATE TABLE IF NOT EXISTS llm_usage (
  call_id VARCHAR PRIMARY KEY, role VARCHAR, backend VARCHAR, tokens_in INTEGER,
  tokens_out INTEGER, cost_est DOUBLE, ts TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS audit (
  ts TIMESTAMPTZ, actor VARCHAR, action VARCHAR, object_id VARCHAR, details_json JSON,
  prompt_version VARCHAR, config_hash VARCHAR
);
CREATE TABLE IF NOT EXISTS holdout_state (
  id INTEGER PRIMARY KEY, holdout_start DATE, rolled_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id VARCHAR PRIMARY KEY, kind VARCHAR, ref VARCHAR, payload_json JSON, status VARCHAR,
  created_by VARCHAR, created_at TIMESTAMPTZ, done_at TIMESTAMPTZ, note VARCHAR
);
CREATE TABLE IF NOT EXISTS findings (
  finding_id VARCHAR PRIMARY KEY, hypothesis_id VARCHAR, test_ids JSON, interpretation VARCHAR,
  parameter_sensitivity VARCHAR, confounds_json JSON, prompt_version VARCHAR, created_at TIMESTAMPTZ
);
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS day DATE;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS position_id VARCHAR;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS sector VARCHAR;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS stop DOUBLE;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS take_profit DOUBLE;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS max_exit_date DATE;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_price DOUBLE;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_reason VARCHAR;
INSERT INTO trial_counter VALUES (1, 0) ON CONFLICT DO NOTHING;
"""
