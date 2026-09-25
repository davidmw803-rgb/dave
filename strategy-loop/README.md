# strategy-loop

A system that proposes, tests, trades and evaluates event-driven stock strategies. Agents propose ideas; code measures them and executes trades. This implements [`strategy-loop-spec.md`](strategy-loop-spec.md) (v2).

## Status

| Phase | State |
|---|---|
| 0 — checks (Webull API, `claude -p`, UW limits, PDT rule) | `claude -p` headless with JSON output: **checked** (one real researcher call, schema-valid). The rest needs your accounts |
| 1 — data + harness | **built.** Tested on synthetic data. Real data still needs a price/universe source |
| 2 — slow loop (agents) | **built.** Orchestrator, researcher (scheduled + event wakeups), analyzer, prompts, feedback, coverage map. Exit check passes with the `fake` backend |
| 3 — fast loop (paper) | partial: risk limits, deterministic client order IDs, kill switch. Executor loop, Webull client, paper_sim, watchdog not written |
| 4–6 | not started |

## Quick start

```bash
cd strategy-loop
pip install -e '.[dev]'
loop demo            # synthetic market: harness self-test (about 20 s)
loop simulate --start 2026-09-01 --days 5 --backend fake --placebos 10   # after demo: Phase 2 exit check
pytest -q            # 64 tests
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
  executor/      risk.py (all §9 limits), orders.py (client order IDs, KILL)
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

## Needed from you before real data

- **Price and universe source.** Point-in-time market cap and sector, including delisted names. `loop import-prices` and `loop import-universe` accept CSV/parquet until a vendor is chosen.
- **`SEC_USER_AGENT` and `UW_API_KEY`** in `.env`. Then run `loop ingest-uw --since 2019-01-01` and `loop ingest-edgar 2024 1`.
- **Phase 0 checks.** EDGAR's `company_tickers.json` covers current listings only, so delisted issuers need a vendor CIK→ticker map.
- **Spec §18 open questions.**
