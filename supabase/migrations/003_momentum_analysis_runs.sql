-- Supabase schema for momentum persistence analysis results.
-- Consumed by python/momentum_persistence/momentum_persistence.py (--save).

create table if not exists momentum_analysis_runs (
    id              bigserial primary key,
    run_at          timestamptz not null default now(),
    source          text not null,               -- 'csv' | 'yfinance' | 'supabase'
    label           text not null,               -- human-readable identifier

    -- Sample stats
    n_candles               integer not null,
    n_transitions           integer not null,
    base_rate_up            double precision,
    base_rate_down          double precision,

    -- Conditional probabilities
    p_up_given_prev_up      double precision,
    p_down_given_prev_down  double precision,
    hit_rate_follow_prev    double precision,

    -- Transition counts
    uu                      integer,
    ud                      integer,
    du                      integer,
    dd                      integer,

    -- Runs
    longest_up_run          integer,
    longest_down_run        integer,

    -- Strategy metrics
    strategy_avg_pnl_per_bet double precision,
    strategy_win_rate        double precision,
    strategy_avg_win         double precision,
    strategy_avg_loss        double precision,
    strategy_expectancy      double precision
);

create index if not exists idx_momentum_runs_run_at on momentum_analysis_runs (run_at desc);
create index if not exists idx_momentum_runs_label  on momentum_analysis_runs (label);
