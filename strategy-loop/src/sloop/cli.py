"""`loop` command line. The only place actor "david" exists (human gates, §1.6)."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import pandas as pd

from sloop import ledger
from sloop.executor import orders
from sloop.schemas import Hypothesis
from sloop.store.duck import audit, connect, trial_count


def _print(obj) -> None:
    if isinstance(obj, pd.DataFrame):
        print(obj.to_string(index=False) if len(obj) else "(none)")
    else:
        print(json.dumps(obj, indent=2, default=str))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="loop")
    p.add_argument("--db", help="DuckDB path (default: data/loop.duckdb)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create the store and seed the coverage map")
    d = sub.add_parser("demo", help="build a synthetic market and run the harness self-test")
    d.add_argument("--placebos", type=int, default=200)
    sub.add_parser("regimes", help="recompute daily regime labels")
    ip = sub.add_parser("import-prices"); ip.add_argument("path")
    iu = sub.add_parser("import-universe"); iu.add_argument("path")
    uw = sub.add_parser("ingest-uw", help="backfill UW analyst ratings")
    uw.add_argument("--since", required=True); uw.add_argument("--until"); uw.add_argument("--action")
    ed = sub.add_parser("ingest-edgar", help="backfill one EDGAR quarter")
    ed.add_argument("year", type=int); ed.add_argument("quarter", type=int)

    pr = sub.add_parser("propose", help="register a hypothesis from a JSON file (§7.1)")
    pr.add_argument("path"); pr.add_argument("--by", default="david"); pr.add_argument("--parent")
    bt = sub.add_parser("backtest", help="in-sample test of a hypothesis")
    bt.add_argument("hypothesis_id"); bt.add_argument("--variant", help="JSON overlay"); bt.add_argument("--placebos", type=int)
    ho = sub.add_parser("holdout", help="the single holdout run for a backtested hypothesis's family")
    ho.add_argument("hypothesis_id")
    ap = sub.add_parser("approve", help="human gate: move a strategy to live_small/live or change its allocation")
    ap.add_argument("strategy_id"); ap.add_argument("--to", choices=["live_small", "live"], required=True)
    ap.add_argument("--allocation", type=float)

    rc = sub.add_parser("run-cycle", help="one slow-loop day: orchestrator -> researcher -> analyzer")
    st = sub.add_parser("step", help="run one slow-loop step (what the scheduler calls)")
    st.add_argument("name", choices=["orchestrator", "researcher", "analyzer"])
    sm = sub.add_parser("simulate", help="replay N weekday cycles from --start against history")
    sm.add_argument("--start", required=True); sm.add_argument("--days", type=int, default=5)
    for x in (rc, st, sm):
        x.add_argument("--as-of", dest="as_of", help="cycle date (default today)")
        x.add_argument("--backend", choices=["claude_code", "api", "fake"], help="default: $LLM_BACKEND or claude_code")
        x.add_argument("--placebos", type=int, help="override null placebo count (faster dry runs)")
    sub.add_parser("audit", help="Phase 2 checks: holdout leaks, duplicate families, repeated holdout runs")

    sub.add_parser("halt", help="stop new orders immediately (touch KILL)")
    sub.add_parser("resume", help="clear KILL")
    sub.add_parser("status")
    sub.add_parser("coverage")
    a = p.parse_args(argv)

    if a.cmd == "halt":
        orders.kill_file().touch()
        print(f"halted: {orders.kill_file()} exists; no new orders will be placed")
        return 0

    con = connect(a.db)
    if a.cmd == "init":
        from sloop.coverage import map as cov
        print(f"coverage cells added: {cov.seed(con)}")
    elif a.cmd == "demo":
        return _demo(con, a.placebos)
    elif a.cmd == "regimes":
        from sloop.harness import regimes
        print(f"regime rows: {len(regimes.compute(con))}")
    elif a.cmd == "import-prices":
        from sloop.ingest import prices
        print(f"rows: {prices.import_prices(con, a.path)}")
    elif a.cmd == "import-universe":
        from sloop.ingest import prices
        print(f"rows: {prices.import_universe(con, a.path)}")
    elif a.cmd == "ingest-uw":
        from sloop.ingest import uw
        print(f"events: {uw.backfill_analysts(con, a.since, a.until, a.action)}")
    elif a.cmd == "ingest-edgar":
        from sloop.ingest import edgar
        print(f"events: {edgar.backfill_quarter(con, a.year, a.quarter)}")
    elif a.cmd == "propose":
        hyp = Hypothesis.model_validate_json(Path(a.path).read_text())
        hid, dup = ledger.register(con, hyp, a.by, parent_id=a.parent)
        _print({"hypothesis_id": hid, "family_key": hyp.family_key(), "duplicate_of": dup})
    elif a.cmd == "backtest":
        from sloop.harness import run
        r = run.backtest(con, a.hypothesis_id, json.loads(a.variant) if a.variant else None, n_placebos=a.placebos)
        _print({k: v for k, v in r.items() if k != "segments"})
        _print(pd.DataFrame(r["segments"]))
    elif a.cmd == "holdout":
        from sloop.harness import run
        _print(run.run_holdout(con, a.hypothesis_id))
    elif a.cmd == "approve":
        ledger.approve_strategy(con, a.strategy_id, a.to, ledger.HUMAN, a.allocation)
        print(f"{a.strategy_id} -> {a.to}")
    elif a.cmd in ("run-cycle", "step"):
        from sloop.agents import cycle
        as_of = date.fromisoformat(a.as_of) if a.as_of else date.today()
        if a.cmd == "step":
            _print(cycle.run_step(con, a.name, as_of, a.backend, a.placebos))
        else:
            _print(cycle.run_cycle(con, as_of, a.backend, a.placebos))
    elif a.cmd == "simulate":
        from sloop.agents import cycle
        _print(pd.DataFrame(cycle.simulate(con, date.fromisoformat(a.start), a.days, a.backend, a.placebos)))
        problems = cycle.audit_leaks(con)
        print("audit:", "clean" if not problems else problems)
        return 1 if problems else 0
    elif a.cmd == "audit":
        from sloop.agents import cycle
        problems = cycle.audit_leaks(con)
        print("clean" if not problems else "\n".join(problems))
        return 1 if problems else 0
    elif a.cmd == "resume":
        orders.kill_file().unlink(missing_ok=True)
        audit(con, ledger.HUMAN, "resume", None)
        print("resumed: KILL cleared")
    elif a.cmd == "status":
        _print({"killed": orders.killed(), "trial_counter": trial_count(con)})
        _print(con.execute("SELECT status, count(*) n FROM hypotheses GROUP BY 1 ORDER BY 1").df())
        _print(con.execute("SELECT strategy_id, state, allocation_pct, approved_by FROM strategies").df())
    elif a.cmd == "coverage":
        from sloop.coverage import map as cov
        _print(cov.summary(con))
    return 0


def _demo(con, placebos: int) -> int:
    """Phase-1 exit check on synthetic data: real edge passes, noise and a look-ahead-only edge fail."""
    from sloop.harness import holdout, regimes, run, synthetic

    if con.execute("SELECT count(*) FROM events WHERE source = 'synthetic'").fetchone()[0] == 0:
        synthetic.build(con)
        regimes.compute(con)
    as_of = date(2026, 9, 1)
    ok = True
    for typ, expect in (("synthetic_edge", True), ("synthetic_noise", False), ("synthetic_leak", False)):
        hyp = Hypothesis(title=f"demo {typ}", mechanism="planted effect used to validate the harness end to end",
                         cell_key=f"{typ}|all|all", signal={"event_type": typ}, exit={"horizon_days": 5})
        hid, _ = ledger.register(con, hyp, "demo")
        r = run.backtest(con, hid, n_placebos=placebos, as_of=as_of)
        verdict = "PASS" if r["passed"] else "FAIL"
        print(f"{typ:16s} n={r['n_events']:4d} mean_ar={r['mean_ar']:+.4f} p={r['p_clustered']:.2g} "
              f"null_pct={r['null_percentile']:.1f} -> {verdict} (expected {'PASS' if expect else 'FAIL'})")
        ok &= r["passed"] == expect
        if r["passed"]:
            try:
                h = run.run_holdout(con, hid, as_of=as_of)
            except holdout.HoldoutAlreadyUsed:
                print(f"{'  holdout':16s} already used by an earlier demo run in this database")
                continue
            print(f"{'  holdout':16s} n={h['n_events']:4d} mean_ar={h['mean_ar']:+.4f} -> {'PASS' if h['passed'] else 'FAIL'}")
    print("harness self-test:", "OK" if ok else "UNEXPECTED RESULT")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
