# strategy-loop

A system that proposes, tests, trades and evaluates event-driven stock strategies. Agents propose ideas; code measures them and executes trades. This is the implementation of the Strategy Research Loop build spec (v2).

## Status

| Phase | State |
|---|---|
| 0 — checks (Webull API, `claude -p`, UW limits, PDT rule) | **not done.** Needs your accounts |
| 1 — data + harness | **built.** Tested on synthetic data. Real data still needs a price/universe source |
| 2 — slow loop (agents) | partial: schemas, `llm.run` (both backends, validation + one retry), ledger, coverage map. Prompts and agent steps not written |
| 3 — fast loop (paper) | partial: risk limits, deterministic client order IDs, kill switch. Executor loop, Webull client, paper_sim, watchdog not written |
| 4–6 | not started |

## Quick start

```bash
cd strategy-loop
pip install -e '.[dev]'
loop demo            # synthetic market: harness self-test (about 20 s)
pytest -q            # 52 tests
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
  agents/llm.py  claude_code | api backends
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

## Needed from you before real data

- **Price and universe source.** Point-in-time market cap and sector, including delisted names. `loop import-prices` and `loop import-universe` accept CSV/parquet until a vendor is chosen.
- **`SEC_USER_AGENT` and `UW_API_KEY`** in `.env`. Then run `loop ingest-uw --since 2019-01-01` and `loop ingest-edgar 2024 1`.
- **Phase 0 checks.** EDGAR's `company_tickers.json` covers current listings only, so delisted issuers need a vendor CIK→ticker map.
- **Spec §18 open questions.**
