"""What each agent is allowed to see. Code builds it; agents never query anything.

Holdout discipline in agent context:
- No agent sees prices, returns or test statistics from the holdout period.
- The orchestrator sees only whether a family's holdout run passed or failed.
- The analyzer sees in-sample results only.
- The researcher sees event *counts* (including recent events, which the fast
  loop needs) but never outcomes. Raw event text reaches an agent only
  inside :func:`llm.quote_untrusted`.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta
from typing import Any

import duckdb
import pandas as pd

from sloop import config
from sloop.agents import feedback, scores
from sloop.agents.evaluator import latest as evaluator_latest
from sloop.coverage import map as cov
from sloop.harness import holdout
from sloop.store.duck import trial_count

FILTER_SYNTAX = {
    "keys": "<field>_min | <field>_max | <field>_in | <field>_eq",
    "universe_fields": ["mcap", "avg_dollar_vol", "sector", "industry", "cap_bucket"],
    "derived": "<x>_to_mcap = payload['<x>_amount'] (or payload['<x>']) / mcap as of the prior day",
    "payload_fields": "any key listed under event_types[...].payload_fields",
    "refused": "anything describing post-event information (fwd_*, ret_*, *_after, future_*, ...)",
}


def _records(df: pd.DataFrame) -> list[dict]:
    return json.loads(df.to_json(orient="records", date_format="iso")) if len(df) else []


def _hyp_rows(con: duckdb.DuckDBPyConnection, status: str | tuple[str, ...], limit: int = 30) -> list[dict]:
    statuses = [status] if isinstance(status, str) else list(status)
    df = con.execute("""
        SELECT h.hypothesis_id, h.parent_id, h.family_key, h.cell_key, h.proposed_by, h.status,
               CAST(h.created_at AS VARCHAR) AS created_at, json_extract_string(h.spec_json, '$.title') AS title,
               (SELECT min(h2.hypothesis_id) FROM hypotheses h2 WHERE h2.family_key = h.family_key
                  AND h2.created_at < h.created_at AND h.parent_id IS NULL) AS duplicate_of,
               (SELECT count(*) FROM tests t WHERE t.hypothesis_id = h.hypothesis_id AND t.sample = 'in'
                  AND t.segment_key IS NULL) AS n_variants_tested
        FROM hypotheses h WHERE h.status IN (SELECT unnest(?)) ORDER BY h.created_at DESC LIMIT ?""",
                     [statuses, limit]).df()
    return _records(df)


def _best_in_sample(con: duckdb.DuckDBPyConnection, hypothesis_id: str) -> dict | None:
    df = con.execute("""
        SELECT test_id, variant_json, n_events, n_dates, mean_ar, hit_rate, p_clustered, deflated_sharpe,
               null_percentile, half1_pass, half2_pass, passed
        FROM tests WHERE hypothesis_id = ? AND sample = 'in' AND segment_key IS NULL
        ORDER BY passed DESC, mean_ar DESC NULLS LAST LIMIT 1""", [hypothesis_id]).df()
    return _records(df)[0] if len(df) else None


def _budget(con: duckdb.DuckDBPyConnection, day: date) -> dict:
    llm = config.load("schedule")["llm"]
    spent = con.execute("SELECT coalesce(sum(cost_est),0) FROM llm_usage WHERE day >= ? AND day <= ?",
                        [day.replace(day=1), day]).fetchone()[0]
    return {"monthly_budget_usd": llm["monthly_budget_usd"], "spent_this_month_usd": round(float(spent), 2)}


def orchestrator(con: duckdb.DuckDBPyConnection, as_of: date) -> dict[str, Any]:
    backtested = _hyp_rows(con, "backtested")
    for h in backtested:
        h["best_in_sample"] = _best_in_sample(con, h["hypothesis_id"])
    holdout_done = con.execute("""
        SELECT h.hypothesis_id, h.family_key, h.status, t.passed AS holdout_passed
        FROM tests t JOIN hypotheses h USING (hypothesis_id) WHERE t.sample = 'holdout'
        ORDER BY t.run_at DESC LIMIT 20""").df()
    findings = con.execute("""
        SELECT hypothesis_id, interpretation, confounds_json AS suspected_confounds, CAST(created_at AS VARCHAR) AS created_at
        FROM findings ORDER BY created_at DESC LIMIT 15""").df()
    strategies = con.execute("SELECT strategy_id, hypothesis_id, state, allocation_pct FROM strategies").df()
    rules = config.load("rules")
    return {
        "as_of": str(as_of),
        "trial_counter": trial_count(con),
        "budget": _budget(con, as_of),
        "allocation_rule": config.load("coverage")["allocation"],
        "limits": {"max_research_tasks": rules["orchestrator"]["max_research_tasks"],
                   "max_test_queue": rules["analyzer"]["max_hypotheses_per_cycle"]},
        "coverage": {
            "summary": _records(cov.summary(con)),
            "follow_up_cells": _records(cov.follow_ups(con)),
            "untested_cells": _records(cov.untested_cells(con, 15)[["cell_key", "est_event_count"]]),
            "cells_touched": cov.touched(con),
        },
        "hypotheses": {
            "proposed_untested": [h for h in _hyp_rows(con, "proposed") if h["n_variants_tested"] == 0],
            "proposed_failed_in_sample": [h for h in _hyp_rows(con, "proposed") if h["n_variants_tested"] > 0][:10],
            "backtested_awaiting_holdout": backtested,
            "holdout_passed_awaiting_paper": _hyp_rows(con, "holdout_passed"),
        },
        # Pass/fail only: the orchestrator never sees holdout statistics.
        "recent_holdout_results": _records(holdout_done),
        "recent_findings": _records(findings),
        "strategies": _records(strategies),
        # §3.1 inputs: evaluator verdicts (act on revise/kill) and agent scorecards (§10).
        "evaluator_verdicts": evaluator_latest(con),
        "agent_scorecards": _records(scores.table(con)),
        "research_weights_by_source": scores.research_weights(con),
        "open_tasks": _records(con.execute("SELECT task_id, kind, ref FROM tasks WHERE status = 'open'").df()),
    }


def event_types(con: duckdb.DuckDBPyConnection, as_of: date) -> list[dict]:
    """Per event type: counts before as_of, last 90 days, and payload keys (from a sample)."""
    cutoff = datetime.combine(as_of, time())
    df = con.execute("""
        SELECT type, count(*) AS n_total, count(*) FILTER (WHERE ts_published >= ?) AS n_last_90d,
               CAST(min(ts_published) AS DATE) AS first_seen, CAST(max(ts_published) AS DATE) AS last_seen
        FROM events WHERE ts_published < ? GROUP BY type ORDER BY n_total DESC""",
                     [cutoff - timedelta(days=90), cutoff]).df()
    out = _records(df)
    for row in out:
        sample = con.execute("SELECT payload_json FROM events WHERE type = ? AND ts_published < ? LIMIT 50",
                             [row["type"], cutoff]).fetchall()
        keys: set[str] = set()
        for (p,) in sample:
            try:
                keys |= set((json.loads(p) if isinstance(p, str) else p or {}).keys())
            except (TypeError, ValueError):
                pass
        row["payload_fields"] = sorted(k for k in keys if k.isidentifier())[:30]
    return out


def researcher(con: duckdb.DuckDBPyConnection, as_of: date) -> dict[str, Any]:
    tasks = con.execute("SELECT task_id, ref AS cell_key, payload_json FROM tasks WHERE kind = 'research' AND status = 'open' "
                        "ORDER BY created_at").df()
    task_list = []
    for t in tasks.itertuples(index=False):
        p = json.loads(t.payload_json) if isinstance(t.payload_json, str) else (t.payload_json or {})
        task_list.append({"task_id": t.task_id, "cell_key": t.cell_key, "question": p.get("question"), "priority": p.get("priority")})
    families = [r[0] for r in con.execute("SELECT DISTINCT family_key FROM hypotheses").fetchall()]
    return {
        "as_of": str(as_of),
        "assigned_tasks": task_list,
        "event_types": event_types(con, as_of),
        "untested_cells": _records(cov.untested_cells(con, 15)[["cell_key", "est_event_count"]]),
        "existing_families": families,
        "filter_syntax": FILTER_SYNTAX,
        "cap_buckets": config.load("coverage")["cap_buckets"],
        "lessons": feedback.lessons_for(con, "researcher"),
        "lessons_digest": feedback.digest(),
        "scorecard": feedback.scorecard(con, "researcher"),
        "research_weights_by_source": scores.research_weights(con),
    }


def analyzer_plan(con: duckdb.DuckDBPyConnection, as_of: date, hypothesis_ids: list[str]) -> dict[str, Any]:
    from sloop import ledger

    items = []
    for hid in hypothesis_ids:
        rec = ledger.get(con, hid)
        items.append({"hypothesis_id": hid, "family_key": rec["family_key"], "spec": rec["spec"].model_dump(mode="json"),
                      "variants_already_tested": _records(con.execute(
                          "SELECT variant_json, passed FROM tests WHERE hypothesis_id = ? AND sample = 'in' AND segment_key IS NULL",
                          [hid]).df())})
    rules = config.load("rules")
    return {
        "as_of": str(as_of),
        "holdout_start": str(holdout.holdout_start(con, as_of)),
        "queue": items,
        "max_variants_per_hypothesis": rules["analyzer"]["max_variants_per_hypothesis"],
        "variant_overlay_syntax": {
            "example": {"exit": {"horizon_days": 10, "stop_atr_mult": 2.0}, "signal": {"filters": {"mcap_max": 2e9}}},
            "rule": "overlays may change thresholds, exits and entry timing but not the event type or the set of filter fields",
        },
        "filter_syntax": FILTER_SYNTAX,
        "trial_counter": trial_count(con),
        "lessons": feedback.lessons_for(con, "analyzer"),
    }


def analyzer_findings(results: dict[str, list[dict]]) -> dict[str, Any]:
    """In-sample numbers only, trimmed to what interpretation needs."""
    keep = ("variant", "n_events", "n_dates", "mean_ar", "hit_rate", "p_clustered", "deflated_sharpe",
            "null_percentile", "half1_pass", "half2_pass", "passed", "failed_checks", "skips", "raw_ar")
    out = {}
    for hid, rs in results.items():
        out[hid] = [{**{k: r.get(k) for k in keep},
                     "segments": sorted(r.get("segments", []), key=lambda s: -(s.get("mean_ar") or 0))[:6]} for r in rs]
    return {"results": out, "note": "pass/fail is decided by code; interpret, do not re-grade"}


def wakeup(con: duckdb.DuckDBPyConnection, event: dict, fired: list[str]) -> dict[str, Any]:
    from sloop.agents.llm import quote_untrusted

    payload = event["payload_json"] if isinstance(event["payload_json"], str) else json.dumps(event["payload_json"])
    families = [r[0] for r in con.execute("SELECT DISTINCT family_key FROM hypotheses").fetchall()]
    return {
        "event": {"event_id": event["event_id"], "type": event["type"], "ticker": event["ticker"],
                  "source": event["source"], "ts_published": str(event["ts_published"])},
        "triggers_fired": fired,
        "payload": quote_untrusted(event["source"], payload, 3000),
        "existing_families": families,
        "filter_syntax": FILTER_SYNTAX,
        "lessons": feedback.lessons_for(con, "researcher", 10),
    }
