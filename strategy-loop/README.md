# strategy-loop

A system that proposes, tests, trades and evaluates event-driven stock strategies. Agents propose ideas; code measures them and executes trades. This implements [`strategy-loop-spec.md`](strategy-loop-spec.md) (v2).

## Status

| Phase | State |
|---|---|
| 0 — checks (Webull API, `claude -p`, UW limits, PDT rule) | `claude -p` headless with JSON output: **checked** (one real researcher call, schema-valid). The rest needs your accounts |
| 1 — data + harness | **built.** Tested on synthetic data. Real data still needs a price/universe source |
| 2 — slow loop (agents) | **built.** Orchestrator, researcher (scheduled + event wakeups), analyzer, prompts, feedback, coverage map. Exit check passes with the `fake` backend |
| 3 — fast loop (paper) | **built, paper only.** Ingestion service, trigger queue, executor, `paper_sim` broker, watchdog, reconciliation, flatten/kill. The exit check passes on a replayed two weeks. Real paper time on your machine is still to come |
| 4 — evaluator + learning | **built.** Evaluator stats and agent step, hard-breach kills, eligibility alerts, agent scorecards, weekly lessons compaction, daily and weekly reports. Evaluator and report jobs are on |
| 5–6 | not started |

## Quick start

```bash
cd strategy-loop
pip install -e '.[dev]'
loop demo            # synthetic market: harness self-test (about 20 s)
loop simulate --start 2026-09-01 --days 5 --backend fake --placebos 10   # after demo: Phase 2 exit check
pytest -q            # 95 tests
```

`loop demo` builds a synthetic market with three planted event types and checks that the harness grades each one correctly:

```
synthetic_edge   n= 422 mean_ar=+0.0299 p=2.6e-37 null_pct=100.0 -> PASS (expected PASS)
  holdout        n=  72 mean_ar=+0.0277 -> PASS
synthetic_noise  n= 417 mean_ar=-0.0004 p=0.85  null_pct=74.5  -> FAIL (expected FAIL)
synthetic_leak   n= 329 mean_ar=-0.0034 p=0.13  null_pct=32.5  -> FAIL (expected FAIL)
```

`synthetic_leak` is the look-ahead check. The whole move happens between the open and a noon publication. An entry at the open would show +3%. The harness enters at the first price after publication and finds nothing (see `tests/test_harness.py::test_move_before_publication_is_not_capturable`).

## Layout

```
config/          rules.yaml risk.yaml sources.yaml schedule.yaml triggers.yaml coverage.yaml
src/sloop/
  schemas.py     pydantic I/O for every agent (§7); extra fields rejected
  ledger.py      hypotheses + promotion ladder + human gate (§1.5–1.6)
  cli.py         `loop …`
  store/         DuckDB schema for every §6.3 table; parquet export
  harness/       market, events (point-in-time), returns, costs, stats, nulls,
                 segments, regimes, rules, holdout, run, synthetic
  executor/      risk.py (all §9 limits), orders.py (client order IDs, KILL), portfolio.py,
                 broker.py (interface, UW quotes), paper_sim.py, loop.py (executor), replay.py
  store/hot.py   SQLite hot store shared by the always-on services
  watchdog/      service.py (heartbeats, staleness), reconcile.py, alerts.py
  services.py    `loop serve ingest|executor|watchdog`
  ops.py         flush, eod, wakeups, backup
  scheduler.py   job guard + launchd/systemd unit generation (`loop install`, `loop job`)
  clock.py       NYSE calendar (config/market_calendar.yaml)
  agents/        llm.py (claude_code | api | fake), context.py (what each agent sees),
                 orchestrator.py, researcher.py, analyzer.py, feedback.py, tasks.py, cycle.py, fake.py
prompts/         orchestrator, researcher, researcher_wakeup, analyzer, analyzer_findings
  coverage/      coverage map
  triggers/      trigger filter
  ingest/        uw.py (analyst ratings), edgar.py (form index), prices.py (file import)
```

The package is `sloop` rather than a bare `src/`, so it installs and imports cleanly.

## How the harness decides

- **Decision time** = `max(ts_published + source latency, ts_ingested)`. Rows ingested more than 24 h after publication are backfills, so their ingest time is ignored and the modelled latency is used.
- **Entry** = the next tradable price after the decision:
  - before 09:30 ET → that day's open
  - 09:30–15:45 → that day's close
  - later, or on a non-trading day → the next open
- **Features** (market cap, dollar volume, sector, regime) come from the last `universe_pit` / `regimes` row dated *before* the decision day. Filter names that describe the future (`fwd_*`, `ret_*`, `*_after`, …) are refused before any data is read.
- **Holdout.** In-sample runs load no data on or after `holdout_start`. It isn't filtered out afterwards; it is never read into memory. A trade whose window would run into the holdout is dropped, not truncated. Each `family_key` gets one holdout run.
- **Costs** are spread and slippage by liquidity bucket, plus the SEC fee. Entries are skipped when the position would exceed 2% of 20-day dollar volume, the stock was halted, or it gapped more than `max_gap_pct`.
- **Stats:**
  - sector-ETF-adjusted AR with two-way (date × issuer) clustered SEs
  - split-half check
  - 200 placebo runs: same dates and exits, random tickers from the same cap bucket
  - deflated Sharpe
  - automatic sector / cap / regime segments, each counted as a trial
- **Survivorship.** Delisted tickers exit at their last close. Tickers still trading when the data window ends are skipped.

### Interpretations of the spec to check

1. **Deflated Sharpe > 0** means the per-trade Sharpe minus the Sharpe you'd expect from the best of `trial_counter` zero-edge trials (Bailey & López de Prado). The probability form is also stored in `tests.details_json.dsr_prob`.
2. **`family_key`** = event type + the *set* of filter fields + cell + regime filter. Changing thresholds or exits is a variant in the same family; adding a new filter field makes a new family.
3. **Primary AR** is the trade return with stops and targets, net of costs, minus the sector ETF over the same holding window. Plain t+1 / t+5 / t+20 ARs are reported alongside it.
4. **EDGAR backfill** has only filing dates, so filings are stamped 17:30 ET on the filing date (EDGAR's cutoff) and enter at the next open.
5. **The human gate** is enforced in `ledger.py`. Only the actor `"david"` can approve `live_small` / `live`, and only the CLI passes that actor. It is a code-path control, not authentication.

## Slow loop (Phase 2)

A day is `orchestrator → researcher → analyzer`. The scheduler runs them separately with `loop step <name>` at 07:00, 07:30 and 08:00 ET; `loop run-cycle` runs all three back to back.

| Step | LLM calls | Code does |
|---|---|---|
| orchestrator | 1 (Opus) | Refreshes the coverage map, builds the context, applies the plan. Anything out of bounds is refused and logged, not executed: a duplicate family, a hypothesis that isn't `proposed`, a promotion above paper, a holdout for a family that already used one |
| researcher | 1 (Sonnet) | Admits proposals: schema-valid, mechanism present, event type exists in the store. Duplicates are stored (they count as trials) but flagged, and the orchestrator won't queue them |
| analyzer | 2 (Sonnet), batched across the queue | Runs each chosen variant through `harness.run.backtest` (no holdout access). Refuses overlays that change the family, updates the coverage map, grades the proposer from the numbers, then stores the LLM's interpretation in `findings` |

That's 4 scheduled calls a weekday, under the cap of 6. Event-triggered wakeups (`researcher.on_event`) are capped at 20 a day. When the monthly budget or a daily cap is hit, the step is skipped and logged; the fast loop is unaffected.

**What agents see** (`agents/context.py`):

- Agents have no tools. With `claude_code`, `claude -p` runs with `--tools ""`, from an empty temp directory, with API keys stripped from its environment.
- No agent sees holdout statistics. The orchestrator gets pass/fail only; the analyzer gets in-sample numbers only.
- The researcher sees event counts and payload field names, never outcomes.
- Event payload text reaches an agent only inside an `<untrusted>` fence.
- Every applied decision is written to `audit` with the prompt's content hash (`prompt_version`) and the rules hash.

**Backends:**

- `claude_code` is the default and runs under your Claude plan.
- `api` needs `pip install '.[api]'` and `ANTHROPIC_API_KEY`. It caches the system prompt, and Opus calls opt into Anthropic's server-side refusal fallbacks (`fallbacks: "default"`).
- `fake` is deterministic and makes no model calls. Use it for tests and to try a new host before spending tokens.

The models are `claude-opus-5` for the orchestrator and `claude-sonnet-5` for the rest. Change them in `config/schedule.yaml`.

**Phase 2 exit check.** `loop simulate --start 2026-09-01 --days 5 --backend fake` on the demo database runs five weekday cycles against history, then `loop audit`:

```
     as_of  trial_counter  cells_touched  llm_calls
2026-09-01              0              0          2
2026-09-02            165              3          4
2026-09-03            166              3          2
2026-09-04            166              3          2
2026-09-07            166              3          2
audit: clean
```

What that shows:

- Day 1 proposes, day 2 tests, day 3 spends the edge's holdout run, day 4 promotes it to paper.
- Noise and the look-ahead-only leak stay at `proposed` with failed tests.
- The map stops advancing once every cell that can reach 200 events has been tested, which is the correct behaviour. The synthetic world has only three such cells.

`loop audit` checks three things: no in-sample trade exits on or after `holdout_start`, no family tested twice (revisions excepted), and no family with two holdout runs.

## Fast loop (Phase 3, paper only)

```
ingest (24/7) ──► hot store (SQLite, WAL) ◄── executor (09:25–16:05) ──► paper_sim
                     │     ▲                       ▲
       wakeups queue │     │ strategies, refdata   │ watchdog (every minute):
                     ▼     │                       │ heartbeats, staleness,
      `loop wakeups` ──► DuckDB ledger ◄── `loop flush` / `loop eod`   reconciliation, limits
```

**Why two stores.** DuckDB allows one writing process, and an analyzer run holds it for minutes. The always-on services therefore use a SQLite hot store in WAL mode. `loop flush` (run before every slow-loop step, and by the scheduler) copies events, signals, orders, fills and positions into the ledger, and pushes frozen strategy configs back.

**Ingestion** (`loop serve ingest`) polls UW analyst ratings and EDGAR's live "current filings" Atom feed every 60 s. The feed carries the acceptance time to the second; the quarterly backfill is date-only. Each new event runs through the trigger filter, and matches are queued. `loop wakeups` drains the queue through the researcher, and the scheduler runs it only in market hours, so overnight triggers wait (§4).

**Executor** (`loop serve executor`) enters when the harness assumed entry, so paper results stay comparable to the backtest:

| Event arrives | Entry window |
|---|---|
| before 09:30 | 09:30–09:45 at the open |
| 09:30–15:45 | 15:45–15:55 near the close |
| later | the next open |

Each entry is a DAY limit bracket: limit = ask + 0.5%, stop = limit − ATR × `stop_atr_mult` (3 × ATR when the strategy sets none, because sizing needs a stop), and the strategy's target.

- Every entry goes through `risk.check_entry`, and open entry orders count toward the caps.
- The client order ID is `hash(strategy, event, leg)`, and the order is recorded before the broker sees it. After a crash, the executor adopts what the broker has, drops what it never got, then syncs fills.
- Positions past `max_hold_days` are sold at 15:50.
- Loss halts: daily at −2% clears the next day; weekly at −5% holds until `loop resume`. A strategy past 8% drawdown on its allocation is demoted if live and alerted either way.

**`paper_sim` instead of Webull paper, for now.** Webull does have a paper environment (`api.sandbox.webull.com`, orders simulated). Its public docs show account listing and plain orders, but not the positions, open-orders or bracket calls that reconciliation needs. Rather than guess, `executor/broker.py` defines the interface and `paper_sim` implements it:

- It keeps its own book (`sim_*` tables), so reconciliation compares two independent records.
- It fills against UW last-trade quotes, with bid and ask modelled from the harness's spread for the ticker's liquidity bucket, so paper pays the costs the backtest charged.
- Stops fill at min(bid, stop) less slippage, so gaps fill worse.
- Unfilled entries expire at the close.
- Limitation: `paper_sim` triggers stops only while the executor is running; a real broker holds them server-side.

**Nothing places live orders.** There is no live broker class. `executor.broker` must be `paper_sim` or `loop serve` exits. A strategy David approves to `live_small`/`live` is skipped at signal time with an `live_broker_not_configured` alert. `loop approve` stays the only way to change a strategy's state above paper.

**Watchdog** (`loop serve watchdog`, every minute):

- **Heartbeats:** ingest always, the executor in market hours; alert after 3 minutes without one.
- **Staleness** for each configured source.
- **Reconciliation:** orders and per-ticker positions, the broker's book against the executor's. Two consecutive mismatches halt entries until `loop resume`.
- **Hard-limit invariants:** risk and notional at entry, position counts.

Alerts go to the `alerts` table, `data/alerts.log`, and a POST to `LOOP_ALERT_WEBHOOK` if it's set (an ntfy.sh topic URL works). The same key is sent at most once an hour.

**Controls:** `loop halt` (KILL file), `loop flatten` (halt, then close everything on the next tick), `loop resume` (clears KILL and every sticky halt), `loop status` (controls, heartbeats, open positions, recent alerts).

**Phase 3 exit check.** The spec asks for 2 weeks of real paper trading; that needs your machine and market hours. `tests/test_fast_loop.py::test_two_weeks_of_paper_trading_reconcile_with_a_forced_restart` replays 10 synthetic sessions through the real executor, broker and watchdog. It uses 5-minute ticks, events arriving live, and intraday quotes drawn from each day's bar. It kills the executor right after the broker accepts an order, before the executor records it. The run ends with:

- 11 entries; 33 signals refused by the 3-per-strategy cap
- 9 time exits, 1 stop, 1 position still open
- zero watchdog findings: reconciled every tick, no limit violations
- zero duplicate orders, and the crash's order adopted on restart

## Setting up the host machine

One machine runs everything: three always-on services and the scheduled jobs. It must be awake from 09:25 to 16:05 ET on trading days; ingestion and the watchdog run around the clock.

### 1. Install

```bash
git clone https://github.com/davidmw803-rgb/dave.git && cd dave/strategy-loop
python3 -m venv .venv && . .venv/bin/activate      # Python 3.11+
pip install -e '.[dev]'                            # add '.[api]' for the API backend
pytest -q                                          # should pass before going further
cp .env.example .env && chmod 600 .env             # then fill it in (below)
```

The unit files point at this checkout and at the Python that ran `loop install`, so install from inside the venv.

### 2. Fill in `.env`

Every `loop` command reads it, including the ones launchd/systemd start. Nothing secret goes into the unit files.

| Variable | Needed for |
|---|---|
| `UW_API_KEY` | ingestion (analyst ratings), executor quotes, EOD bars. Without it the executor idles and alerts |
| `SEC_USER_AGENT` | EDGAR ingestion: `"Your Name you@example.com"` |
| `LLM_BACKEND` | `claude_code` (default) or `api` |
| `ANTHROPIC_API_KEY` | only with `LLM_BACKEND=api` |
| `LOOP_ALERT_WEBHOOK` | push alerts (e.g. `https://ntfy.sh/<private-topic>`, then subscribe in the ntfy app) |

With `claude_code`, run `claude` once interactively as the same user to log in. The agents then run under your Claude plan. `loop install` records your current `PATH` so the scheduler can find `claude`.

### 3. Seed data and a first cycle

```bash
loop init                                   # store + coverage map
loop import-prices prices.parquet           # vendor history (see "Needed from you")
loop import-universe universe.parquet
loop ingest-uw --since 2019-01-01           # backfills
loop ingest-edgar 2025 1                    # one quarter per call
loop regimes && loop eod                    # regimes, refdata for the executor
loop run-cycle --backend fake --placebos 20 # dry run of the slow loop, no model calls
loop audit
```

### 4. Keep it awake

**macOS**

- `sudo pmset -a sleep 0 disksleep 0 standby 0 autopoweroff 0`, or System Settings → Energy → "Prevent automatic sleeping". The display can still sleep.
- LaunchAgents run only while you're logged in. To come back unattended after a power cut, enable automatic login (System Settings → Users & Groups) and run `sudo pmset -a autorestart 1`. macOS doesn't allow automatic login with FileVault on; if you keep FileVault, someone has to log in after a restart.

**Linux**

- `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`
- `sudo loginctl enable-linger $USER`, so user services run without an open login session.

**Both:** a small UPS is worth it. If the machine goes down with positions open, remember that `paper_sim` can only trigger stops while the executor is running. The watchdog alerts on restart and the executor reconciles.

### 5. Install the services and schedule

```bash
loop install --dry-run          # list the units it would write
loop install                    # write + load (macOS: ~/Library/LaunchAgents, Linux: ~/.config/systemd/user)
loop jobs                       # schedule + last run of each job
loop status                     # heartbeats, controls, open positions, alerts
```

**Services** (restarted on exit):

| Service | Runs |
|---|---|
| `serve ingest` | 24/7 |
| `serve executor` | always up; trades only 09:25–16:05 ET on trading days |
| `serve watchdog` | 24/7, every minute |

**Jobs** (ET, from `config/schedule.yaml` `jobs:`):

| Job | When |
|---|---|
| `step evaluator` | 06:30 weekdays |
| `step orchestrator` | 07:00 weekdays |
| `step researcher` | 07:30 weekdays |
| `step analyzer` | 08:00 weekdays |
| `wakeups` | every 10 min, 09:30–16:00 on trading days |
| `flush` | every 30 min |
| `eod` | 16:30 on trading days |
| `report daily` | 17:00 on trading days |
| `backup` | 23:00 daily |
| `lessons compact` | Saturday 08:30 |
| `report weekly` | Saturday 12:00 |
| `run-cycle` | Saturday 09:00 (extended research, weekend call cap of 20) |
| `roll-holdout` | 06:00 on Jan/Apr/Jul/Oct 1 |

Weekdays also run the evaluator at 06:30 and the daily report at 17:00; Saturdays run lessons compaction at 08:30 and the weekly report at 12:00.

**How timing works on any host timezone.** launchd can't take a timezone, so each job's plist fires at every local time its ET slot can map to (both sides of DST). systemd timers carry `America/New_York` directly. Either way the unit calls `loop job <name>`, which:

- runs only when the ET clock says the job is due;
- runs each daily job once per ET date;
- still runs a job missed while asleep if the machine wakes within 45 minutes;
- skips market-only jobs on NYSE holidays (`config/market_calendar.yaml`, which needs extending each December).

Jobs that find the ledger locked by a long analyzer run wait up to 30 min (`job_ledger_wait_seconds`).

**Logs** are in `data/logs/<unit>.log` on macOS, and `journalctl --user -u sloop-<name>` on Linux. Alerts also go to `data/alerts.log`.

**Changing the schedule, updating the code, or moving the checkout:** edit `config/schedule.yaml` or pull, then re-run `loop install`. It rewrites every unit and unloads retired ones. `loop install --uninstall` removes everything.

**Backups:** `loop backup [dest]` writes parquet for every ledger table plus a copy of the hot store to `data/backups/<date>/` and keeps 14 days. Point `dest` at a second disk or a synced folder (§14).

### 6. Daily operation

- **Halt new orders:** `loop halt`.
- **Close everything:** `loop flatten`. It halts, then sells every paper position on the executor's next tick.
- **Resume:** `loop resume` clears KILL and any sticky halt: weekly loss, reconciliation, flatten.
- **Promote to real money:** there is still no live broker, so an approval to `live_small` only makes the executor skip that strategy's signals and alert. `loop approve <strategy_id> --to live_small` stays the only command that can change a strategy's state above paper.

## Evaluator and learning (Phase 4)

**Evaluator** (`loop step evaluator`, 06:30 on weekdays, and the first step of `run-cycle`):

1. **Stats (code, `evaluator/stats.py`)** for each paper/live strategy:
   - realized trade return and sector-ETF abnormal return (the same benchmark rule as the harness);
   - hit rate, average win/loss, realized mean vs the backtest's 80% interval for that many trades;
   - entry slippage vs the cost model (the executor now records the reference quote and modelled bps), fill rate;
   - rolling 20-trade hit rate, drawdown on the allocation, results by regime at entry.
2. **Hard risk breach:** drawdown past `max_drawdown_pct_of_allocation`. Code kills the strategy immediately, with no agent involved, and alerts.
3. **Agent step:** one batched call for strategies with closed trades. It returns `keep | resize | revise | kill`, an attribution (`execution | signal | regime_decay | none`), the wrong assumption, and a lesson. Code enforces §3.6: before 20 closed trades or 30 trading days, anything but `keep` becomes `keep` and is logged as gated.
4. **Where the results go:** verdicts land in `evaluations`, and the orchestrator sees the latest per strategy and acts on revise/kill. Lessons become feedback.
5. **§8.6 eligibility for paper → live_small** is detected and alerted. Nothing is promoted; that stays `loop approve`.

**Scorecards** (`loop scores`, rebuilt nightly by `eod`):

- One row per proposer and source, for all time and the last 90 days: proposed, passed in-sample, passed holdout, profitable when traded.
- Score = (in-sample + 2 × holdout + 4 × profitable) / (proposed + 5).
- Research weights by source are 80% score-proportional plus a 20% exploration floor split evenly. The orchestrator and researcher both see them.

**Lessons** (`loop lessons compact`, Saturday 08:30):

- One LLM call merges the week's feedback with the current digest into at most 40 one-line lessons, grouped by agent.
- It's written to `data/lessons.md`, capped at 6,000 characters, and the previous version is kept as `lessons.<date>.md`. Researcher and analyzer prompts carry it.

**Reports** (`loop report daily|weekly`, 17:00 on trading days and Saturday 12:00) are Markdown files in `data/reports/`, with a one-line summary pushed to `LOOP_ALERT_WEBHOOK`:

- **Daily:** closed trades and P&L, open positions, skipped-signal reasons, controls in force, evaluator verdicts, strategies eligible for live_small, research activity, ladder moves, LLM spend, alerts.
- **Weekly:** everything above for the week, plus §12 program criteria, the coverage map, agent scorecards, research weights, and the lessons digest.

Validation retries on any agent call are logged to `audit` (`llm_validation_retry`) with the error.

## Needed from you before real data

- **Price and universe source.** Point-in-time market cap and sector, including delisted names. `loop import-prices` and `loop import-universe` accept CSV/parquet until a vendor is chosen.
- **`SEC_USER_AGENT` and `UW_API_KEY`** in `.env`. Then run `loop ingest-uw --since 2019-01-01` and `loop ingest-edgar 2024 1`.
- **Phase 0 checks.** EDGAR's `company_tickers.json` covers current listings only, so delisted issuers need a vendor CIK→ticker map.
- **Spec §18 open questions.**
