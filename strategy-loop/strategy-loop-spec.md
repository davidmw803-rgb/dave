# Strategy Research Loop — Build Spec (v2)

A multi-agent system that continuously proposes, tests, trades and evaluates stock trading strategies, and learns from the results. Agents reason; code measures and executes.

> Project name and repo name are placeholders — rename freely.
>
> **v2 changes:** always-on ingestion + executor services, event-triggered agent wakeups, coverage map for research breadth, automatic segment breakdowns, point-in-time data, null baselines, regime tagging, portfolio-level risk, operations/monitoring, prompt-injection handling, program-level kill criteria.

---

## 1. Principles (non-negotiable)

1. **Code grades, agents propose.** No LLM ever decides whether a strategy "works." The harness and the evaluator's statistics do. Agents interpret numbers; they never produce them.
2. **Separation of duties.** The agent that proposes an idea never tests it; the agent that tests it never grades its live results.
3. **Every test is counted.** All hypotheses, variants and segment splits are logged. The bar rises with the trial count.
4. **Locked holdout.** The most recent 12 months of history is invisible to agents. Each hypothesis family touches it once.
5. **Promotion ladder, no skipping:** `proposed → backtested → holdout_passed → paper → live_small → live`. Any revision restarts at `backtested`.
6. **Human gate on real money.** `paper → live_small` and every size increase require David's explicit approval via CLI. Agents cannot call it.
7. **The executor is deterministic code** with hard risk limits agents cannot modify.
8. **Point-in-time everything.** No backtest may use information that wasn't available at the moment of the simulated decision.
9. **External text is data, not instructions.** News, filings and social text passed to agents can never trigger actions directly.
10. **Secrets** in `.env`, gitignored, read from environment. Never inlined, logged, or committed.
11. **"Nothing works" is a valid outcome.** The system reports it rather than lowering the bar.

---

## 2. Architecture: fast loop vs. slow loop

```
FAST LOOP (code, always on, market hours; ingestion 24/7)
  ingestion service ──► events ──► trigger filter ──► (wake researcher)
                           │
                           └──► executor ──► Webull (paper/live)
                                   │
                              risk + reconciliation + watchdog

SLOW LOOP (LLM agents, scheduled + event-triggered)
  orchestrator ──► researcher ──► analyzer ──► harness
       ▲                                         │
       └──────── evaluator ◄── live/paper results┘
```

- **Fast loop** runs every 30–60 s (or streaming where a source supports it). Zero LLM calls.
- **Slow loop** runs on a daily schedule plus event-triggered wakeups. Target: dozens of agent calls per day, not thousands.

---

## 3. Roles

| Role | Type | Model (default) | Job |
|---|---|---|---|
| Orchestrator | LLM agent | Opus | Plans, manages ledger + coverage map, promotes/kills, writes feedback |
| Researcher | LLM agent + ingestion code | Sonnet (Haiku for bulk summarizing) | Proposes hypotheses from events and coverage gaps |
| Specialist researchers | LLM agent (optional) | Sonnet | Same as researcher, scoped to a domain with distinct mechanisms (e.g. biotech FDA) |
| Analyzer | LLM agent + harness | Sonnet | Hypothesis → backtest config → findings |
| Harness | Code | — | Backtests, statistics, segment breakdowns, pass/fail |
| Executor | Code (always on) | — | Trades promoted strategies under hard risk limits |
| Evaluator | LLM agent + stats code | Sonnet | Live vs. expected; keep / resize / revise / kill |
| Watchdog | Code (always on) | — | Heartbeats, staleness, reconciliation, alerts |

### 3.1 Orchestrator
- **Inputs:** ledger summary, coverage map, analyzer reports, evaluator verdicts, agent scorecards, regime state, budget.
- **Outputs (structured JSON only):**
  - `research_tasks[]` — cells from the coverage map or specific questions (source, question, priority)
  - `test_queue[]` — hypothesis IDs for the analyzer
  - `promotions[]` — `holdout_passed → paper` only (higher rungs are human-gated)
  - `kills[]`, `revisions[]` (revision = child hypothesis with `parent_id`)
  - `feedback[]` — `{agent, hypothesis_id, grade: good|bad|neutral, lesson}`
- **Must** dedupe against the ledger on `family_key` before approving tests.

### 3.2 Researcher
- **Scheduled step:** reads recent events, assigned coverage cells, feedback history; proposes 0–5 hypotheses in §7.1 schema, each with a written mechanism.
- **Event-triggered step:** woken by the trigger filter (§3.8) with a single event bundle; asks "does this suggest a new or existing hypothesis?" Max 20 wakeups/day (config).
- Hypotheses without a plausible mechanism are rejected.
- **Default scope is broad** (catalyst type across the whole universe). Narrowing to a segment happens only after the harness shows the edge concentrates there (§8.3).

### 3.3 Specialist researchers (optional, add later)
- Only where the mechanism and data genuinely differ from the general case (e.g. biotech PDUFA dates/trial readouts, bank regulatory filings).
- Own sources and prompt; **same** ledger, harness, coverage map, executor.

### 3.4 Analyzer
- Converts hypothesis → `backtest_config`, calls harness, writes `findings`: pass/fail, parameter sensitivity, segment breakdown, suspected confounds.
- Max 12 parameter variants per hypothesis; all count as trials.
- Cannot query the holdout.

### 3.5 Executor (code, always on)
- During market hours, every 30–60 s: evaluate new events against strategies in `paper | live_small | live`; place/manage orders.
- Every order: entry + stop-loss + take-profit (bracket where supported).
- Client order IDs are deterministic (`strategy_id + event_id + leg`) so retries can never double-order.
- Paper mode: Webull paper if the API supports it; otherwise `paper_sim.py` filling against live quotes with modeled slippage.
- Logs every signal, order, fill, and skip reason.

### 3.6 Evaluator
- **Stats code** per paper/live strategy: realized vs. expected return distribution, hit rate, avg win/loss, slippage vs. model, fill rate, rolling 20-trade hit rate, drawdown, performance by regime.
- **Agent step** attributes the gap: *execution* (slippage, fills, timing, liquidity), *signal* (edge smaller than backtest), or *regime/decay*.
- Verdict per strategy: `keep | resize | revise | kill`, naming the parameter or assumption that was wrong.
- Minimum 20 closed trades or 30 trading days before any verdict other than `keep`, except hard risk breaches (immediate kill).

### 3.7 Watchdog (code, always on)
- Heartbeat from every service each minute; alert if missing > 3 min.
- Data staleness: alert if a source hasn't produced events within its expected interval.
- Broker reconciliation every minute during market hours: broker positions/orders vs. DB. Any mismatch → halt new entries + alert.
- Broker disconnect → halt new entries; existing broker-side brackets remain.

### 3.8 Trigger filter (code)
Rules in `config/triggers.yaml` that decide which events wake the researcher. Examples:
- contract award > 20% of market cap
- ≥ 3 insider open-market buys in 10 days
- options sweep premium > 5× the ticker's 30-day average
- analyst initiation from a firm/analyst with a top-decile historical score

Filter is deterministic; the agent sees only the matched bundle.

---

## 4. Schedule

All times ET.

**Always on:** ingestion (24/7), executor + watchdog (09:25–16:05), trigger filter (24/7, wakeups queued outside market hours).

| Time | Slow-loop step |
|---|---|
| 06:30 | Evaluator: score paper/live strategies on prior day |
| 07:00 | Orchestrator: plan cycle, update coverage map, apply verdicts, write feedback |
| 07:30 | Researcher: propose hypotheses for assigned cells |
| 08:00 | Analyzer: backtest queue (continues through the day) |
| intraday | Event-triggered researcher wakeups (capped) |
| 16:30 | EOD prices, fills reconciliation, regime update |
| 17:00 | Daily report to David |

**Weekly (Saturday):** extended research + backtests, coverage map review, `lessons.md` compaction, weekly report.

**Quarterly:** roll holdout forward; program review against §12.

---

## 5. Research breadth: coverage map

The orchestrator maintains a grid so research never goes stale and never retreads ground.

**Dimensions:** catalyst type × sector (GICS level 1) × market-cap bucket (micro < 300M, small 300M–2B, mid 2B–10B, large > 10B).

**Cell state:** `untested | tested_fail | tested_pass | live | decayed`, plus n_tests, best result, last touched.

**Allocation each cycle:**
- 60% — follow-ups on promising cells and live-strategy revisions
- 25% — untested cells, prioritized by estimated event count (skip cells that can't reach n > 200)
- 15% — researcher-originated ideas outside the grid (new catalyst types, new sources)

Tickers are never a research unit — too few events per ticker. They appear only at execution time.

---

## 6. Data

### 6.1 Sources (v1)
- **Unusual Whales** (existing key): analyst ratings, options flow, insider trades, congressional trades, news.
- **SEC EDGAR** (free): 8-K, Form 4, S-1/424B, 13D/G. Respect SEC fair-access limits (declared User-Agent, ≤ 10 req/s).
- **Government contract awards:** USAspending / SAM.gov.
- **Prices:** daily OHLCV for universe + sector ETFs + SPY/IWM/VIX; intraday bars for open positions and for executor quote checks.

### 6.2 Point-in-time correctness
- Every event stores `ts_published` (source timestamp) and `ts_ingested`. Backtests use `max(ts_published, ts_ingested_equivalent)` — the earliest moment the system could realistically have acted — and enter at the next tradable price after that.
- **Survivorship:** the universe includes delisted, acquired and bankrupt tickers with their full price history. Universe membership (market-cap bucket, sector) is computed as of each event date, not today.
- Corporate actions (splits, reverse splits common in small caps) handled via adjusted prices; raw prices kept for execution modeling.
- Harness refuses any config that references data with a timestamp after the simulated decision time.

### 6.3 Storage
Parquet on disk with DuckDB over it. No server, no ORM. Fast-loop services write to a small DuckDB/SQLite hot store, flushed to Parquet every few minutes.

```
events          event_id, source, source_id, type, ticker, ts_published, ts_ingested, payload_json
universe_pit    ticker, date, mcap, sector, industry, avg_dollar_vol_20d, listed
prices          ticker, date, open, high, low, close, volume, adj_close
regimes         date, vix_bucket, spy_trend, iwm_trend, breadth_bucket, regime_label
hypotheses      hypothesis_id, parent_id, family_key, cell_key, proposed_by, trigger_event_id,
                created_at, spec_json, mechanism, status, status_changed_at
tests           test_id, hypothesis_id, variant_json, sample (in|holdout), segment_key,
                n_events, n_dates, mean_ar, hit_rate, p_clustered, sharpe, deflated_sharpe,
                null_percentile, half1_pass, half2_pass, passed, run_at
coverage        cell_key, catalyst_type, sector, cap_bucket, state, n_tests,
                est_event_count, best_test_id, last_touched
strategies      strategy_id, hypothesis_id, config_json, config_hash, state, allocation_pct,
                approved_by, approved_at
signals         signal_id, strategy_id, event_id, ts, action, skipped_reason
orders          order_id, client_order_id, signal_id, broker_order_id, side, qty, type,
                limit, stop, take_profit, mode, status, ts
fills           fill_id, order_id, price, qty, ts, fees
positions       strategy_id, ticker, qty, avg_cost, opened_at, closed_at, pnl
evaluations     eval_id, strategy_id, as_of, stats_json, regime_stats_json, verdict, attribution, lesson
feedback        feedback_id, from_agent, to_agent, hypothesis_id, grade, lesson, created_at
agent_scores    agent, source, window, proposed, passed_insample, passed_holdout, profitable_live, score
trial_counter   total hypotheses + variants + segment splits ever tested
heartbeats      service, ts, status
llm_usage       call_id, role, backend, tokens_in, tokens_out, cost_est, ts
audit           ts, actor, action, object_id, details_json, prompt_version, config_hash
```

### 6.4 Holdout
- `holdout_start` = today − 12 months, rolled forward quarterly.
- Harness raises on any analyzer query with `date >= holdout_start`.
- One holdout run per `family_key`. Failed holdout cannot be retried with tweaks.
- Paper trading is the ultimate out-of-sample test; holdout is the gate before it.

---

## 7. Schemas

### 7.1 Hypothesis (researcher output)
```json
{
  "title": "Small-cap 8-K contract award > 20% of market cap",
  "mechanism": "Material revenue news in thinly-covered names is under-reacted to on day 0",
  "cell_key": "contract_award|all|small",
  "signal": {
    "event_type": "sec_8k_contract",
    "filters": {"award_to_mcap_min": 0.20, "mcap_max": 2e9, "avg_dollar_vol_min": 1e6}
  },
  "universe": "us_equities_mcap_50m_2b",
  "entry": {"timing": "next_tradable_after_publish", "max_gap_pct": 15},
  "exit": {"horizon_days": 5, "stop_atr_mult": 1.5, "take_profit_pct": 12},
  "expected": {"direction": "long", "min_abnormal_return_5d": 0.015},
  "sources": ["edgar", "usaspending"]
}
```

### 7.2 Strategy config (executor input, frozen at promotion)
```json
{
  "strategy_id": "stg_0012",
  "hypothesis_id": "hyp_0147",
  "signal": { "...": "copied from hypothesis" },
  "entry": {"order_type": "limit", "limit_offset_pct": 0.5, "timing": "next_tradable_after_publish"},
  "exit": {"stop_atr_mult": 1.5, "take_profit_pct": 12, "max_hold_days": 5},
  "sizing": {"method": "fixed_fraction", "risk_per_trade_pct": 0.25},
  "regime_filter": null,
  "expected": {"mean_ar_5d": 0.021, "hit_rate": 0.58, "ar_std": 0.09}
}
```
Configs are immutable and hashed. A revision creates a new hypothesis and, if promoted, a new strategy.

---

## 8. Harness

### 8.1 Metrics
Sector-ETF-adjusted abnormal return at t+1, t+5, t+20; two-way clustered SEs (event date × issuer).

### 8.2 Cost model (applied to every backtest)
- Spread + slippage by liquidity bucket (from `avg_dollar_vol_20d`), calibrated from paper/live fills once available.
- Skip entries where position would exceed 2% of 20-day avg dollar volume.
- Skip halted names; gap filter per config.
- Fees per broker schedule.

### 8.3 Segment breakdown (automatic)
Every test also reports results by sector, cap bucket, and regime. Each reported segment increments `trial_counter`. A segment that looks strong becomes a **child hypothesis** that must pass on its own — never promoted directly from a breakdown.

### 8.4 Null baseline
For each test, run ≥ 200 placebo backtests: same number of entries, same timing distribution, random tickers from the same universe bucket. Report the real result's percentile (`null_percentile`). Must beat the 99th percentile.

### 8.5 Regime tagging
Daily regime label from VIX bucket, SPY/IWM trend, breadth. Results reported per regime. A strategy may carry a `regime_filter` only if the regime split was itself tested as a child hypothesis.

### 8.6 Promotion rules
**In-sample pass** (all required):
- n > 200 events across > 50 distinct dates
- mean 5-day adjusted AR > 1.5% net of costs
- hit rate > 55%
- p < 0.01 clustered
- same sign and p < 0.05 in both halves of the in-sample period
- deflated Sharpe > 0 given current `trial_counter`
- `null_percentile` > 99

**Holdout pass:** same sign, mean AR > 1.0%, p < 0.05, n > 50.

**Paper → live_small eligibility** (flagged to David, not automatic):
- ≥ 30 trading days and ≥ 20 closed trades in paper
- realized mean return within the backtest's 80% interval
- slippage within 1.5× model

Thresholds live in `config/rules.yaml`. Changing them requires a git commit by David; agents have no write access.

---

## 9. Risk (executor, agent-inaccessible)

**Per trade / strategy**
- Max risk per trade: 0.25% of account
- Max position size: 5% of account
- Max open positions per strategy: 3
- Strategy drawdown > 8% of its allocation → auto-demote to paper

**Portfolio**
- Max open positions total: 10
- Max gross exposure: 50% of account (v1)
- Max 25% of account in any one sector; max 2 positions in the same ticker across strategies (then skip)
- Max daily realized loss 2% → halt new entries for the day
- Max weekly loss 5% → halt new entries until David resumes

**Sizing**
- Fixed fraction until a strategy has ≥ 50 live trades; then optionally quarter-Kelly capped at the fixed-fraction limit.

**Controls**
- Kill switch: `touch KILL` or `loop halt` → stop new orders immediately; `loop flatten` closes everything.
- Account rules: executor checks day-trade count against pattern-day-trader rules applicable to the account before any same-day round trip (confirm current rule status in Phase 0).

---

## 10. Feedback & learning

- Orchestrator writes `feedback` rows for every decision. Each agent's prompt includes its last ~20 lessons and its scorecard.
- `agent_scores` computed nightly: per researcher/source, fraction of proposals passing in-sample, holdout, and profitable live. Research allocation weights by score with a 20% exploration floor.
- `lessons.md` digest (capped length, compacted weekly) injected into researcher and analyzer prompts.

---

## 11. Safety: prompt injection

- News, filings and social text are wrapped as quoted data in agent prompts, with an explicit instruction that they are not instructions.
- Agents have no order-placement tools, no write access to `config/`, and no network access beyond the data tools they're given.
- Agent outputs are validated against pydantic schemas; free-text fields are never executed or used as file paths/commands.

---

## 12. Program-level success criteria

Set now, before results, so the system doesn't quietly lower its own bar.

- **3 months:** harness reproduces known results; ≥ 1 strategy in paper, or a documented "no edge found" across ≥ 20 coverage cells.
- **6 months:** ≥ 1 strategy passes paper → live_small eligibility. If none, David reviews whether to change data sources or stop.
- **12 months:** live strategies net positive after costs vs. IWM on a risk-adjusted basis. If not, reduce to paper-only.

---

## 13. LLM backend & cost control

```python
llm.run(role: str, prompt: str, schema: dict, tools: list[str] | None) -> dict
```

1. **`claude_code` (default):** subprocess `claude -p "<prompt>" --output-format json` with an allowlisted tool set. Runs under David's Claude plan limits.
2. **`api`:** Anthropic SDK with prompt caching on the static system prompt + lessons; Batch API for evaluator and weekend research.

Cost rules:
- Fast loop, harness, stats: zero LLM calls.
- Weekday target: ≤ 6 scheduled calls + ≤ 20 triggered wakeups. Logged in `llm_usage`.
- Researcher sees code-filtered summaries, not raw payloads.
- Monthly budget in config; when hit, skip research and run executor + evaluator stats only.

---

## 14. Operations & reproducibility

- Services run under a process supervisor (launchd on macOS / systemd on Linux) with auto-restart.
- Machine must stay awake during market hours (disable sleep; UPS optional). If the machine is down, broker-side brackets protect open positions; watchdog alerts on recovery.
- Every decision logs `prompt_version` and `config_hash` in `audit` so any trade can be traced to the exact prompt, config and data that produced it.
- Nightly backup of `data/` and the DB to a second location.
- Alerts (halt, reconciliation mismatch, stale data, promotion awaiting approval) via push/email.

---

## 15. Repo layout

```
strategy-loop/
  config/            rules.yaml, risk.yaml, sources.yaml, schedule.yaml, triggers.yaml, coverage.yaml
  data/              parquet (gitignored)
  prompts/           orchestrator.md, researcher.md, analyzer.md, evaluator.md, specialists/
  src/
    ingest/          uw.py, edgar.py, contracts.py, prices.py, universe_pit.py, service.py
    store/           duck.py, hot.py (hot store), schema.py
    harness/         events.py, returns.py, costs.py, stats.py, nulls.py, segments.py,
                     regimes.py, rules.py, holdout.py
    executor/        webull.py, paper_sim.py, risk.py, portfolio.py, loop.py
    triggers/        filter.py
    watchdog/        heartbeat.py, reconcile.py, alerts.py
    evaluator/       stats.py
    agents/          llm.py, orchestrator.py, researcher.py, analyzer.py, evaluator.py
    coverage/        map.py
    report/          daily.py, weekly.py
  cli.py             loop run-cycle | approve <strategy> | halt | resume | flatten | status | coverage
  tests/
  .env.example
```

Python 3.12, DuckDB, polars/pandas, statsmodels, pydantic.

---

## 16. Build order

**Phase 0 — Checks**
- Webull API: paper trading, bracket orders, client order IDs, rate limits, streaming quotes. No paper API → build `paper_sim.py`.
- `claude -p` headless from the scheduler with JSON output.
- Unusual Whales plan rate limits and any streaming endpoints.
- Current pattern-day-trader rules for the account type.

**Phase 1 — Data + harness (no agents)**
- Ingestion (batch first), point-in-time universe incl. delisted names, regimes.
- Harness with costs, nulls, segments, holdout, trial counter, §8.6 rules.
- *Exit:* reproduces the analyst-initiation study; a known-false hypothesis fails; a look-ahead config is refused.

**Phase 2 — Slow loop**
- `llm.py` both backends; schema validation with one retry.
- Orchestrator, researcher, analyzer; ledger, coverage map, feedback.
- *Exit:* a week of automated cycles against history, no duplicate families, no holdout leaks, coverage map advancing.

**Phase 3 — Fast loop (paper only)**
- Ingestion as always-on service; trigger filter + capped wakeups.
- Risk + portfolio modules with unit tests for every limit.
- Executor, idempotent orders, watchdog, reconciliation, kill switch.
- *Exit:* 2 weeks of paper trading, full reconciliation, zero limit violations, zero duplicate orders, recovers cleanly from a forced restart mid-session.

**Phase 4 — Evaluator + learning**
- Stats vs. expected, regime breakdown, attribution, verdicts; agent scorecards; daily + weekly reports.

**Phase 5 — Live small (human gate)**
- `loop approve <strategy_id>` only; one strategy first.

**Phase 6 — Specialists (optional)**
- Add a specialist researcher only when a domain shows events the general researcher handles poorly.

---

## 17. Out of scope for v1
- Options, shorting, leverage
- Sub-daily-horizon strategies (the executor runs intraday; holding periods are ≥ 1 day)
- Agents writing or modifying code
- Cross-strategy portfolio optimization beyond §9 caps

## 18. Open questions for David
- Account size for paper and live_small?
- Long-only to start? (Assumed yes.)
- Universe: small caps only, or all US equities with cap buckets? (Spec assumes all, bucketed.)
- Alert channel: push, email, or both?
- Machine: which box runs the always-on services, and can it stay awake 24/7?
