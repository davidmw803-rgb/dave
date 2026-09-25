"""One slow-loop day (§4): evaluator -> orchestrator -> researcher -> analyzer.

The scheduler runs the steps separately at 07:00 / 07:30 / 08:00; this module
also runs them back to back (``loop run-cycle``) and replays days against
history (``loop simulate``) for the Phase 2 exit check.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

import duckdb

from sloop.agents import analyzer, evaluator, llm, orchestrator, researcher
from sloop.coverage import map as cov
from sloop.store.duck import audit, trial_count

STEPS = ("evaluator", "orchestrator", "researcher", "analyzer")


def run_step(con: duckdb.DuckDBPyConnection, name: str, as_of: date, backend: str | None = None,
             n_placebos: int | None = None) -> Any:
    try:
        if name == "evaluator":
            return evaluator.step(con, as_of, backend)
        if name == "orchestrator":
            return orchestrator.step(con, as_of, backend)
        if name == "researcher":
            return researcher.step(con, as_of, backend)
        if name == "analyzer":
            return analyzer.step(con, as_of, backend, n_placebos)
        raise ValueError(f"unknown step {name!r}")
    except llm.BudgetExceeded as e:
        # §13: when the budget is hit, research stops; executor and evaluator stats keep running.
        audit(con, name, "skipped_budget", None, {"why": str(e)})
        return {"skipped": str(e)}


def run_cycle(con: duckdb.DuckDBPyConnection, as_of: date, backend: str | None = None,
              n_placebos: int | None = None) -> dict[str, Any]:
    out = {s: run_step(con, s, as_of, backend, n_placebos) for s in STEPS}
    out["summary"] = {"as_of": str(as_of), "trial_counter": trial_count(con), "cells_touched": cov.touched(con),
                      "llm_calls": int(con.execute("SELECT count(*) FROM llm_usage WHERE day = ?", [as_of]).fetchone()[0])}
    return out


def simulate(con: duckdb.DuckDBPyConnection, start: date, days: int, backend: str | None = None,
             n_placebos: int | None = None) -> list[dict[str, Any]]:
    """Run ``days`` consecutive weekday cycles starting at ``start``."""
    out, d = [], start
    while len(out) < days:
        if d.weekday() < 5:
            out.append(run_cycle(con, d, backend, n_placebos)["summary"])
        d += timedelta(days=1)
    return out


def audit_leaks(con: duckdb.DuckDBPyConnection) -> list[str]:
    """Phase 2 exit checks over the whole ledger. Returns a list of problems (empty = clean)."""
    problems = []
    tests = con.execute("SELECT test_id, hypothesis_id, details_json FROM tests WHERE sample = 'in' AND segment_key IS NULL").df()
    for t in tests.itertuples(index=False):
        d = json.loads(t.details_json) if isinstance(t.details_json, str) else (t.details_json or {})
        if d.get("max_exit_date") and d.get("holdout_start") and str(d["max_exit_date"]) >= str(d["holdout_start"]):
            problems.append(f"{t.test_id}: in-sample trade exits on/after holdout_start")
    dups = con.execute("""
        SELECT family_key, count(DISTINCT hypothesis_id) AS n FROM hypotheses h
        WHERE parent_id IS NULL AND EXISTS (SELECT 1 FROM tests t WHERE t.hypothesis_id = h.hypothesis_id)
        GROUP BY family_key HAVING n > 1""").df()
    problems += [f"family tested more than once: {r.family_key}" for r in dups.itertuples(index=False)]
    multi = con.execute("""SELECT h.family_key, count(*) n FROM tests t JOIN hypotheses h USING (hypothesis_id)
                           WHERE t.sample = 'holdout' GROUP BY 1 HAVING n > 1""").df()
    problems += [f"family used holdout more than once: {r.family_key}" for r in multi.itertuples(index=False)]
    return problems
