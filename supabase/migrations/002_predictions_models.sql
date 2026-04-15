-- Migration 002: Predictions, models, calibration, scorecards
-- Applied during Session 1 alongside 001
-- These tables are referenced from later sessions but defined upfront so we never have to migrate them in piecemeal.

-- ============================================================================
-- Model registry
-- ============================================================================
create table models (
  version text primary key,
  algorithm text not null,
  trained_at timestamptz not null,
  training_set_size int,
  training_window_start timestamptz,
  training_window_end timestamptz,
  features text[],
  hyperparameters jsonb,
  oos_metrics jsonb,
  notes text,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index idx_models_active on models (active) where active = true;

-- ============================================================================
-- Locked predictions
-- One row per (event, model_version, horizon)
-- feature_snapshot is a frozen copy of inputs — DO NOT update after insert.
-- ============================================================================
create table predictions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references rating_events(id) on delete cascade,
  model_version text not null references models(version),
  horizon text not null check (horizon in ('30m','eod','1d','5d','30d')),
  predicted_direction text not null check (predicted_direction in ('up','down','flat')),
  predicted_return numeric,
  predicted_return_p10 numeric,
  predicted_return_p50 numeric,
  predicted_return_p90 numeric,
  predicted_prob_positive numeric check (predicted_prob_positive between 0 and 1),
  confidence_bucket text,
  feature_snapshot jsonb not null,
  recommended_kelly_fraction numeric,
  predicted_at timestamptz not null default now(),
  unique (event_id, model_version, horizon)
);

create index idx_predictions_event on predictions (event_id);
create index idx_predictions_model_horizon on predictions (model_version, horizon);
create index idx_predictions_unresolved on predictions (predicted_at) where predicted_prob_positive is not null;

-- ============================================================================
-- Prediction outcomes — resolved once horizon passes
-- ============================================================================
create table prediction_outcomes (
  prediction_id uuid primary key references predictions(id) on delete cascade,
  actual_return numeric,
  actual_market_adj_return numeric,
  actual_direction text check (actual_direction in ('up','down','flat')),
  was_correct_direction boolean,
  hit_p10_p90_band boolean,
  squared_error numeric,
  log_loss_contribution numeric,
  resolved_at timestamptz not null default now()
);

-- ============================================================================
-- Per-analyst, per-strategy scorecards (rolled up nightly)
-- ============================================================================
create table analyst_scorecards (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references trusted_analysts(id) on delete cascade,
  strategy text not null check (strategy in ('immediate','fade','drift')),
  lookback_days int not null check (lookback_days in (30, 90, 365, 0)),  -- 0 = all-time
  event_count int not null,
  hit_rate numeric,
  avg_return numeric,
  median_return numeric,
  avg_market_adj_return numeric,
  median_market_adj_return numeric,
  max_drawdown numeric,
  sharpe numeric,
  sortino numeric,
  computed_at timestamptz not null default now(),
  unique (analyst_id, strategy, lookback_days)
);

create index idx_analyst_scorecards_analyst on analyst_scorecards (analyst_id);

-- ============================================================================
-- Calibration metrics by confidence bucket (rolled up nightly per active model)
-- ============================================================================
create table calibration_metrics (
  id uuid primary key default gen_random_uuid(),
  model_version text not null references models(version),
  horizon text not null,
  bucket_label text not null,
  predictions_count int not null,
  actual_positive_rate numeric,
  expected_positive_rate numeric,
  brier_score numeric,
  log_loss numeric,
  computed_at timestamptz not null default now()
);

create index idx_calibration_model_horizon on calibration_metrics (model_version, horizon, computed_at desc);

-- ============================================================================
-- Drift detection log
-- ============================================================================
create table drift_alerts (
  id uuid primary key default gen_random_uuid(),
  model_version text not null references models(version),
  feature_name text,
  test_type text,                       -- 'ks','psi','calibration_divergence'
  test_statistic numeric,
  p_value numeric,
  threshold numeric,
  triggered boolean not null,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  notes text
);

-- ============================================================================
-- Regime tagging (one row per trading day, used for slicing)
-- ============================================================================
create table market_regimes (
  trading_date date primary key,
  regime text not null check (regime in ('bull','bear','chop')),
  spy_trend_50d numeric,
  vix_level numeric,
  notes text,
  computed_at timestamptz not null default now()
);

-- ============================================================================
-- User overrides — when I disagree with the model
-- ============================================================================
create table prediction_overrides (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references predictions(id) on delete cascade,
  override_direction text check (override_direction in ('up','down','flat','skip')),
  override_size_fraction numeric,
  reasoning text not null,
  created_at timestamptz not null default now()
);

create index idx_prediction_overrides_prediction on prediction_overrides (prediction_id);
