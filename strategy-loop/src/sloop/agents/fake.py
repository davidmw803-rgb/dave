"""Deterministic stand-ins for the agents (``LLM_BACKEND=fake``).

They read the same context a real model gets and return schema-valid JSON, so
the whole slow loop can run end to end with no model calls: in tests, in
``loop simulate`` dry runs, and when checking a new host before spending tokens.
They are deliberately simple and are not a research strategy.
"""
from __future__ import annotations

from typing import Any

from sloop.agents.llm import register_fake


def orchestrator(ctx: dict[str, Any], _schema) -> dict[str, Any]:
    h = ctx["hypotheses"]
    queue = [x["hypothesis_id"] for x in h["proposed_untested"] if not x.get("duplicate_of")]
    queue = queue[: ctx["limits"]["max_test_queue"]]
    cells = [c["cell_key"] for c in ctx["coverage"]["untested_cells"]]
    tasks = [{"source": "coverage_map", "question": f"Propose a mechanism-backed test for {c}", "cell_key": c, "priority": 3}
             for c in cells[: ctx["limits"]["max_research_tasks"]]]
    return {
        "research_tasks": tasks,
        "test_queue": queue,
        "holdout_runs": [x["hypothesis_id"] for x in h["backtested_awaiting_holdout"]],
        "promotions": [x["hypothesis_id"] for x in h["holdout_passed_awaiting_paper"]],
        "feedback": [{"agent": "researcher", "hypothesis_id": x["hypothesis_id"], "grade": "neutral",
                      "lesson": "queued for testing"} for x in h["proposed_untested"] if x["hypothesis_id"] in queue],
    }


def researcher(ctx: dict[str, Any], _schema) -> dict[str, Any]:
    known = {e["type"] for e in ctx["event_types"]}
    families = set(ctx["existing_families"])
    cells = [t["cell_key"] for t in ctx["assigned_tasks"] if t.get("cell_key")] or [c["cell_key"] for c in ctx["untested_cells"]]
    out = []
    for cell in cells:
        catalyst, sector, cap = cell.split("|")
        if catalyst not in known:
            continue
        filters: dict[str, Any] = {}
        if sector != "all":
            filters["sector_eq"] = sector
        if cap != "all":
            filters["cap_bucket_eq"] = cap
        fields = ",".join(sorted({k.rsplit("_", 1)[0] for k in filters}))
        if f"{catalyst}|{fields}|{cell}|-" in families:
            continue
        out.append({"title": f"{catalyst} drift in {sector}/{cap}",
                    "mechanism": f"Investors under-react to {catalyst} events, so prices drift over the following week.",
                    "cell_key": cell, "signal": {"event_type": catalyst, "filters": filters},
                    "exit": {"horizon_days": 5}, "sources": ["fake"]})
        if len(out) == 5:
            break
    return {"hypotheses": out}


def researcher_wakeup(ctx: dict[str, Any], _schema) -> dict[str, Any]:
    return {"hypotheses": []}


def analyzer(ctx: dict[str, Any], _schema) -> dict[str, Any]:
    return {"plans": [{"hypothesis_id": q["hypothesis_id"], "rationale": "horizon sensitivity",
                       "variants": [{}, {"exit": {"horizon_days": 3}}, {"exit": {"horizon_days": 10}}]}
                      for q in ctx["queue"]]}


def analyzer_findings(ctx: dict[str, Any], _schema) -> dict[str, Any]:
    out = []
    for hid, rs in ctx["results"].items():
        best = max(rs, key=lambda r: r.get("mean_ar") or -1)
        out.append({"hypothesis_id": hid,
                    "interpretation": f"{sum(bool(r['passed']) for r in rs)}/{len(rs)} variants passed; "
                                      f"best mean AR {best.get('mean_ar')}",
                    "parameter_sensitivity": "; ".join(f"{r['variant']}: {r.get('mean_ar')}" for r in rs)[:900],
                    "suspected_confounds": []})
    return {"findings": out}


def evaluator(ctx: dict[str, Any], _schema) -> dict[str, Any]:
    out = []
    for st in ctx["strategies"]:
        below = st.get("within_interval") is False and (st.get("mean_ar") or 0) < (st.get("expected") or {}).get("mean_ar", 0)
        slip = (st.get("slippage") or {}).get("ratio")
        if st.get("gate_open") and below:
            attribution = "execution" if slip and slip > 1.5 else "signal"
            out.append({"strategy_id": st["strategy_id"], "verdict": "revise", "attribution": attribution,
                        "wrong_assumption": "cost model" if attribution == "execution" else "effect size",
                        "lesson": "Realized abnormal return fell below the backtest interval."})
        else:
            out.append({"strategy_id": st["strategy_id"], "verdict": "keep", "attribution": "none",
                        "lesson": "Results so far are consistent with the backtest."})
    return {"verdicts": out}


def lessons(ctx: dict[str, Any], _schema) -> dict[str, Any]:
    seen, out = set(), []
    for f in ctx["new_feedback"]:
        agent = f["to_agent"] if f["to_agent"] in ("researcher", "analyzer", "orchestrator", "evaluator") else "researcher"
        text = (f.get("lesson") or "").strip()
        if len(text) < 10 or (agent, text) in seen:
            continue
        seen.add((agent, text))
        out.append({"agent": agent, "lesson": text[:400], "evidence": f"{f['grade']} from {f['from_agent']}"})
        if len(out) == 40:
            break
    return {"lessons": out}


for _role, _fn in {"orchestrator": orchestrator, "researcher": researcher, "researcher_wakeup": researcher_wakeup,
                   "analyzer": analyzer, "analyzer_findings": analyzer_findings, "evaluator": evaluator,
                   "lessons": lessons}.items():
    register_fake(_role, _fn)
