"""Orchestrator (§3.1): the LLM plans; this module applies the plan under hard rules.

Every item in the plan is checked here, and anything out of bounds is refused
and reported rather than executed:
- tests only for hypotheses that are proposed, untested, and not a duplicate
  of an earlier family (revisions excepted);
- holdout runs only for backtested hypotheses whose family hasn't used one;
- promotions only holdout_passed -> paper;
- kills and revisions through the ledger.
"""
from __future__ import annotations

import json
from datetime import date
from typing import Any

import duckdb

from sloop import config, ledger
from sloop.agents import context, feedback, llm, tasks
from sloop.coverage import map as cov
from sloop.harness import holdout, run
from sloop.schemas import OrchestratorPlan
from sloop.store.duck import audit


def plan(con: duckdb.DuckDBPyConnection, as_of: date, backend: str | None = None) -> tuple[OrchestratorPlan, str]:
    cov.seed(con)
    ctx = context.orchestrator(con, as_of)
    return llm.run(con, "orchestrator", "orchestrator", ctx, OrchestratorPlan, backend=backend, day=as_of)


def _family_tested(con: duckdb.DuckDBPyConnection, family_key: str, exclude: str) -> str | None:
    row = con.execute("""SELECT h.hypothesis_id FROM hypotheses h WHERE h.family_key = ? AND h.hypothesis_id <> ?
                         AND (EXISTS (SELECT 1 FROM tests t WHERE t.hypothesis_id = h.hypothesis_id)
                              OR EXISTS (SELECT 1 FROM tasks k WHERE k.kind = 'test' AND k.status = 'open'
                                         AND k.ref = h.hypothesis_id)) LIMIT 1""", [family_key, exclude]).fetchone()
    return row[0] if row else None


def _expected(con: duckdb.DuckDBPyConnection, hypothesis_id: str) -> tuple[dict[str, Any], dict[str, float]]:
    row = con.execute("""SELECT variant_json, mean_ar, hit_rate, details_json FROM tests WHERE hypothesis_id = ?
                         AND sample = 'in' AND segment_key IS NULL AND passed ORDER BY mean_ar DESC LIMIT 1""",
                      [hypothesis_id]).fetchone()
    variant = json.loads(row[0]) if row and isinstance(row[0], str) else (row[0] if row else {})
    se = (json.loads(row[3]) if row and isinstance(row[3], str) else {}).get("se") if row else None
    exp = {"mean_ar": float(row[1]), "hit_rate": float(row[2])} if row else {}
    if se:
        exp["mean_ar_se"] = float(se)
    return variant or {}, exp


def apply(con: duckdb.DuckDBPyConnection, p: OrchestratorPlan, as_of: date, prompt_version: str) -> dict[str, list]:
    rules = config.load("rules")
    report: dict[str, list] = {"accepted": [], "refused": []}

    def ok(kind: str, ref: str | None, **kw: Any) -> None:
        report["accepted"].append({"kind": kind, "ref": ref, **kw})
        audit(con, "orchestrator", kind, ref, kw, prompt_version)

    def no(kind: str, ref: str | None, why: str) -> None:
        report["refused"].append({"kind": kind, "ref": ref, "why": why})
        audit(con, "orchestrator", f"refused:{kind}", ref, {"why": why}, prompt_version)

    # Research tasks (the researcher's assignments for its next step).
    tasks.close(con, "research", note="superseded by new plan", status="superseded")
    for t in p.research_tasks[: rules["orchestrator"]["max_research_tasks"]]:
        if t.cell_key:
            cov.ensure(con, t.cell_key)
        tid = tasks.add(con, "research", t.cell_key, t.model_dump(), "orchestrator")
        ok("research_task", tid, cell_key=t.cell_key)

    # Test queue.
    queued = 0
    for hid in dict.fromkeys(p.test_queue):
        try:
            rec = ledger.get(con, hid)
        except KeyError:
            no("test", hid, "unknown hypothesis")
            continue
        if rec["status"] != "proposed":
            no("test", hid, f"status is {rec['status']}")
        elif con.execute("SELECT 1 FROM tests WHERE hypothesis_id = ? LIMIT 1", [hid]).fetchone():
            no("test", hid, "already tested; revise it as a child hypothesis instead")
        elif hid in tasks.open_refs(con, "test"):
            no("test", hid, "already queued")
        elif rec["parent_id"] is None and (dup := _family_tested(con, rec["family_key"], hid)):
            no("test", hid, f"duplicate family {rec['family_key']} (tested or queued as {dup})")
        elif queued >= rules["analyzer"]["max_hypotheses_per_cycle"]:
            no("test", hid, "queue full this cycle")
        else:
            tasks.add(con, "test", hid, {}, "orchestrator")
            queued += 1
            ok("test", hid)

    # Holdout runs: the family's single look at the last 12 months.
    for hid in dict.fromkeys(p.holdout_runs):
        try:
            r = run.run_holdout(con, hid, as_of=as_of)
            ok("holdout", hid, passed=r["passed"], test_id=r["test_id"])
            feedback.write(con, "harness", "orchestrator", hid, "good" if r["passed"] else "bad",
                           "holdout passed" if r["passed"] else "holdout failed: family closed to further holdout runs")
        except (ledger.LadderError, holdout.HoldoutAlreadyUsed, KeyError) as e:
            no("holdout", hid, str(e))

    # Promotions: holdout_passed -> paper only.
    for hid in dict.fromkeys(p.promotions):
        try:
            rec = ledger.get(con, hid)
            if rec["status"] != "holdout_passed":
                raise ledger.LadderError(f"status is {rec['status']}; orchestrator promotes holdout_passed -> paper only")
            ledger.transition(con, hid, "paper", "orchestrator", reason="orchestrator promotion")
            variant, expected = _expected(con, hid)
            sid = ledger.freeze_strategy(con, hid, variant, expected, rules["orchestrator"]["paper_allocation_pct"])
            ok("promote", hid, strategy_id=sid)
        except (ledger.LadderError, KeyError) as e:
            no("promote", hid, str(e))

    for hid in dict.fromkeys(p.kills):
        try:
            ledger.transition(con, hid, "killed", "orchestrator", reason="orchestrator kill")
            con.execute("UPDATE strategies SET state = 'killed' WHERE hypothesis_id = ? AND state = 'paper'", [hid])
            ok("kill", hid)
        except (ledger.LadderError, KeyError) as e:
            no("kill", hid, str(e))

    for rv in p.revisions:
        try:
            ledger.get(con, rv.parent_id)
        except KeyError:
            no("revision", rv.parent_id, "unknown parent")
            continue
        child, _ = ledger.register(con, rv.hypothesis, "orchestrator", parent_id=rv.parent_id)
        ok("revision", child, parent_id=rv.parent_id, change=rv.change)

    for fb in p.feedback:
        feedback.write(con, "orchestrator", fb.agent, fb.hypothesis_id, fb.grade, fb.lesson)
    if p.feedback:
        ok("feedback", None, n=len(p.feedback))
    return report


def step(con: duckdb.DuckDBPyConnection, as_of: date, backend: str | None = None) -> dict[str, list]:
    p, version = plan(con, as_of, backend)
    return apply(con, p, as_of, version)
