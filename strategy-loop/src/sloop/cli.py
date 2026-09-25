"""`loop` command line. The only place actor "david" exists (human gates, §1.6)."""
from __future__ import annotations

import argparse
import json
import os
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


def clock_today() -> date:
    from sloop import clock
    return clock.Clock().et().date()


def load_dotenv(path: Path | None = None) -> None:
    """Read KEY=VALUE lines from strategy-loop/.env into the environment (existing vars win)."""
    from sloop import config as _cfg

    p = path or _cfg.ROOT / ".env"
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        if v:
            os.environ.setdefault(k.strip(), v)


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
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
    st.add_argument("name", choices=["evaluator", "orchestrator", "researcher", "analyzer"])
    sm = sub.add_parser("simulate", help="replay N weekday cycles from --start against history")
    sm.add_argument("--start", required=True); sm.add_argument("--days", type=int, default=5)
    for x in (rc, st, sm):
        x.add_argument("--as-of", dest="as_of", help="cycle date (default today)")
        x.add_argument("--backend", choices=["claude_code", "api", "fake"], help="default: $LLM_BACKEND or claude_code")
        x.add_argument("--placebos", type=int, help="override null placebo count (faster dry runs)")
    sub.add_parser("audit", help="Phase 2 checks: holdout leaks, duplicate families, repeated holdout runs")

    sv = sub.add_parser("serve", help="run an always-on service (launchd/systemd call this)")
    sv.add_argument("name", choices=["ingest", "executor", "watchdog"])
    sub.add_parser("flush", help="copy fast-loop rows into the ledger and push strategies to the executor")
    eo = sub.add_parser("eod", help="16:30 job: flush, refresh bars/universe for tickers in play, regimes, refdata")
    eo.add_argument("--day")
    wk = sub.add_parser("wakeups", help="run queued trigger wakeups through the researcher")
    wk.add_argument("--backend", choices=["claude_code", "api", "fake"])
    bk = sub.add_parser("backup", help="nightly parquet + hot-store backup")
    bk.add_argument("dest", nargs="?", default=None)
    sub.add_parser("flatten", help="halt entries and close every paper position on the executor's next tick")

    jb = sub.add_parser("job", help="run a scheduled job if the ET clock says it is due (what launchd/systemd call)")
    jb.add_argument("name"); jb.add_argument("--force", action="store_true", help="run now regardless of the schedule")
    ins = sub.add_parser("install", help="write and load launchd agents (macOS) or systemd user units (Linux)")
    ins.add_argument("--platform", choices=["macos", "linux"], help="default: this machine's")
    ins.add_argument("--dry-run", action="store_true", help="write units to --out (or print the plan) without loading them")
    ins.add_argument("--out", help="directory to write units into (default: the platform's user unit directory)")
    ins.add_argument("--uninstall", action="store_true")
    sub.add_parser("jobs", help="list the schedule and when each job last ran")
    sub.add_parser("roll-holdout", help="quarterly: move holdout_start to today minus 12 months")

    rp = sub.add_parser("report", help="write the daily or weekly report (data/reports/) and push its summary")
    rp.add_argument("kind", choices=["daily", "weekly"]); rp.add_argument("--day")
    ls = sub.add_parser("lessons", help="compact feedback into data/lessons.md (weekly)")
    ls.add_argument("action", choices=["compact", "show"]); ls.add_argument("--backend", choices=["claude_code", "api", "fake"])
    sub.add_parser("scores", help="rebuild and show agent scorecards (§10)")

    sub.add_parser("halt", help="stop new orders immediately (touch KILL)")
    sub.add_parser("resume", help="clear KILL")
    sub.add_parser("status")
    sub.add_parser("coverage")
    a = p.parse_args(argv)
    if a.db and not os.environ.get("LOOP_HOT_PATH"):
        os.environ["LOOP_HOT_PATH"] = str(Path(a.db).with_suffix(".hot.sqlite"))  # keep a custom ledger's hot store beside it

    if a.cmd == "halt":
        orders.kill_file().touch()
        print(f"halted: {orders.kill_file()} exists; no new orders will be placed")
        return 0
    if a.cmd == "job":
        return _job(a.name, a.force, a.db)
    if a.cmd in ("install", "jobs"):
        return _install(a) if a.cmd == "install" else _jobs()
    if a.cmd == "serve":
        from sloop import services
        services.serve(a.name)
        return 0
    if a.cmd == "flatten":
        from sloop.store import hot
        orders.kill_file().touch()
        hot.set_control(hot.connect(), "flatten", "requested", ledger.HUMAN)
        print("flatten requested: entries halted (KILL); the executor closes all paper positions on its next tick")
        return 0

    from sloop.store.duck import connect_retry
    con = connect_retry(a.db) if a.db is None else connect(a.db)
    if a.cmd in ("flush", "eod", "wakeups", "run-cycle", "step", "approve", "report"):
        from sloop import ops
        from sloop.store import hot
        hcon = hot.connect()
        if a.cmd != "eod":
            ops.flush(hcon, con)  # agents and approvals see the latest fast-loop rows
    if a.cmd == "flush":
        _print(ops.flush(hcon, con))
    elif a.cmd == "eod":
        _print(ops.eod(hcon, con, date.fromisoformat(a.day) if a.day else None))
    elif a.cmd == "wakeups":
        _print(ops.drain_wakeups(hcon, con, a.backend))
    elif a.cmd == "report":
        from sloop.report import reports
        day = date.fromisoformat(a.day) if a.day else clock_today()
        print(reports.write(a.kind, con, hcon, day))
    elif a.cmd == "lessons":
        from sloop.agents import feedback, lessons
        if a.action == "compact":
            _print(lessons.compact(con, clock_today(), a.backend))
        else:
            print(feedback.digest() or "(no lessons.md yet)")
    elif a.cmd == "scores":
        from sloop.agents import scores
        scores.compute(con)
        _print(scores.table(con))
        _print(scores.research_weights(con))
    elif a.cmd == "roll-holdout":
        from sloop.harness import holdout
        print(f"holdout_start = {holdout.roll(con)}")
    elif a.cmd == "backup":
        from sloop import config as cfg, ops as ops_
        _print(str(ops_.backup(con, a.dest or cfg.data_dir() / "backups")))
    elif a.cmd == "init":
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
        hot.sync_strategies(hcon, con)
        print(f"{a.strategy_id} -> {a.to}")
    elif a.cmd in ("run-cycle", "step"):
        from sloop.agents import cycle
        as_of = date.fromisoformat(a.as_of) if a.as_of else date.today()
        if a.cmd == "step":
            _print(cycle.run_step(con, a.name, as_of, a.backend, a.placebos))
        else:
            _print(cycle.run_cycle(con, as_of, a.backend, a.placebos))
        hot.sync_strategies(hcon, con)  # promotions/kills reach the executor
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
        from sloop.store import hot
        h = hot.connect()
        cleared = [r["key"] for r in hot.rows(h, "SELECT key FROM controls WHERE key IN "
                                                "('halt','weekly_halt','reconciliation','daily_halt','flatten')")]
        for k in cleared:
            hot.set_control(h, k, None, ledger.HUMAN)
        hot.set_cursor(h, "reconcile_streak", "0")
        orders.kill_file().unlink(missing_ok=True)
        audit(con, ledger.HUMAN, "resume", None, {"cleared": cleared})
        print(f"resumed: KILL cleared; controls cleared: {cleared or 'none'}")
    elif a.cmd == "status":
        from sloop.store import hot
        h = hot.connect()
        _print({"killed": orders.killed(), "trial_counter": trial_count(con),
                "controls": {r["key"]: r["value"] for r in hot.rows(h, "SELECT key, value FROM controls")},
                "heartbeats": {r["service"]: [r["ts"], r["status"]] for r in hot.rows(h, "SELECT * FROM heartbeats")},
                "open_positions": hot.one(h, "SELECT count(*) AS n FROM positions WHERE closed_at IS NULL")["n"],
                "recent_alerts": [f"{r['ts']} {r['key']}: {r['message']}" for r in
                                  hot.rows(h, "SELECT * FROM alerts ORDER BY alert_id DESC LIMIT 5")]})
        _print(con.execute("SELECT status, count(*) n FROM hypotheses GROUP BY 1 ORDER BY 1").df())
        _print(con.execute("SELECT strategy_id, state, allocation_pct, approved_by FROM strategies").df())
    elif a.cmd == "coverage":
        from sloop.coverage import map as cov
        _print(cov.summary(con))
    return 0


def _job(name: str, force: bool, db: str | None) -> int:
    """Scheduler entry point. Runs the job's command in-process if due; records the ET date it ran."""
    import shlex
    from datetime import datetime

    from sloop import clock, config, scheduler
    from sloop.store import hot

    job = scheduler.get(name)
    h = hot.connect()
    key = f"job:{name}"
    now_et = clock.Clock().et()
    run, why = (True, "forced") if force else scheduler.due(job, now_et, hot.get_cursor(h, key) or None)
    stamp = datetime.now().isoformat(timespec="seconds")
    if not run:
        print(f"{stamp} job {name}: skip ({why})")
        return 0
    os.environ.setdefault("LOOP_DUCK_WAIT", str(config.load("schedule")["job_ledger_wait_seconds"]))
    print(f"{stamp} job {name}: run `loop {job.cmd}`", flush=True)
    rc = main((["--db", db] if db else []) + shlex.split(job.cmd))
    if rc == 0 and job.at:
        hot.set_cursor(h, key, now_et.date().isoformat())
    hot.set_cursor(h, f"{key}:last", f"{now_et.isoformat(timespec='seconds')} rc={rc}")
    print(f"{datetime.now().isoformat(timespec='seconds')} job {name}: exit {rc}")
    return rc


def _jobs() -> int:
    from sloop import scheduler
    from sloop.store import hot

    h = hot.connect()
    rows = []
    for j in scheduler.jobs(include_disabled=True):
        enabled = j in scheduler.jobs()
        when = f"{j.at} ET" if j.at else f"every {j.every_minutes} min {j.window[0]}-{j.window[1]} ET"
        rows.append({"job": j.name, "enabled": enabled, "when": when, "cmd": f"loop {j.cmd}",
                     "last": hot.get_cursor(h, f"job:{j.name}:last") or "-"})
    _print(pd.DataFrame(rows))
    return 0


def _install(a) -> int:
    from sloop import scheduler

    platform = a.platform or scheduler.detect_platform()
    out = Path(a.out) if a.out else None
    if a.uninstall:
        cmds = scheduler.uninstall(platform, out, load=not a.dry_run)
    else:
        if a.dry_run and out is None:
            units = scheduler.launchd_units() if platform == "macos" else scheduler.systemd_units()
            print(f"would write {len(units)} units to {scheduler.target_dir(platform)}:")
            for n in units:
                print(f"  {n}")
            return 0
        cmds = scheduler.install(platform, out, load=not a.dry_run)
        print(f"wrote units to {out or scheduler.target_dir(platform)}")
    print(("commands to run:" if a.dry_run else "ran:") + "\n  " + "\n  ".join(cmds))
    if platform == "linux" and not a.dry_run and not a.uninstall:
        print("note: run `sudo loginctl enable-linger $USER` once so services keep running while you're logged out")
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
