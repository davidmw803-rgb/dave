"""Analyzer (§3.4): hypothesis -> variants -> harness -> findings.

Two LLM calls per cycle, each batched across the whole queue:
1. choose up to 12 variants per hypothesis (every one is a counted trial);
2. interpret the in-sample numbers (parameter sensitivity, confounds).
Pass/fail comes from the harness and is never touched by the interpretation.
The analyzer's only harness entry point is :func:`run.backtest`, which cannot
load holdout data.
"""
from __future__ import annotations

import json
from datetime import date
from typing import Any

import duckdb

from sloop import config, ledger
from sloop.agents import context, feedback, llm, tasks
from sloop.coverage import map as cov
from sloop.harness import events, run
from sloop.schemas import AnalyzerPlan, AnalyzerReport
from sloop.store.duck import audit, new_id, now

_ALLOWED_TOP = {"signal", "entry", "exit"}


def _check_overlay(base, overlay: dict[str, Any]):
    """Apply an overlay; refuse ones that change the family or reach past the schema."""
    if not isinstance(overlay, dict) or set(overlay) - _ALLOWED_TOP:
        raise ValueError(f"overlay keys must be within {sorted(_ALLOWED_TOP)}")
    hyp = run.apply_variant(base, overlay)
    if hyp.family_key() != base.family_key():
        raise ValueError("overlay changes the family (event type or filter fields); propose a new hypothesis instead")
    return hyp


def step(con: duckdb.DuckDBPyConnection, as_of: date, backend: str | None = None,
         n_placebos: int | None = None) -> dict[str, list[dict]]:
    queue = tasks.open_refs(con, "test")[: config.load("rules")["analyzer"]["max_hypotheses_per_cycle"]]
    if not queue:
        return {}
    ctx = context.analyzer_plan(con, as_of, queue)
    plan, version = llm.run(con, "analyzer", "analyzer", ctx, AnalyzerPlan, backend=backend, day=as_of)
    by_id = {p.hypothesis_id: p for p in plan.plans if p.hypothesis_id in queue}

    results: dict[str, list[dict]] = {}
    for hid in queue:
        rec = ledger.get(con, hid)
        variants = by_id[hid].variants if hid in by_id else [{}]
        rs: list[dict] = []
        for overlay in variants:
            try:
                _check_overlay(rec["spec"], overlay)
                r = run.backtest(con, hid, overlay or None, n_placebos=n_placebos, as_of=as_of)
            except run.VariantLimit:
                break
            except (ValueError, events.LookAheadError) as e:
                audit(con, "analyzer", "variant_refused", hid, {"overlay": overlay, "why": str(e)}, version)
                continue
            r["variant"] = overlay
            rs.append(r)
            cov.record_test(con, rec["cell_key"], r["test_id"], r["passed"], r["mean_ar"])
        results[hid] = rs
        feedback.grade_from_tests(con, hid, rs)
        tasks.close(con, "test", hid, note=f"{len(rs)} variants")

    tested = {h: rs for h, rs in results.items() if rs}
    if tested:
        try:
            report, fversion = llm.run(con, "analyzer_findings", "analyzer_findings", context.analyzer_findings(tested),
                                       AnalyzerReport, backend=backend, day=as_of)
        except llm.BudgetExceeded as e:
            audit(con, "analyzer", "findings_skipped", None, {"why": str(e)}, version)
            return results
        for f in report.findings:
            if f.hypothesis_id not in tested:
                continue
            con.execute("INSERT INTO findings VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        [new_id("fnd"), f.hypothesis_id, json.dumps([r["test_id"] for r in tested[f.hypothesis_id]]),
                         f.interpretation, f.parameter_sensitivity, json.dumps(f.suspected_confounds), fversion, now()])
    return results
