"""Researcher (§3.2): proposes hypotheses for assigned coverage cells, and on
trigger-filter wakeups.

Code-side checks before a proposal enters the ledger:
- schema validation (a mechanism is required, extra fields rejected);
- the event type must exist in the store (no data, no test);
- a hypothesis in a family that already exists is stored (it counts as a
  trial) but flagged as a duplicate, which the orchestrator will not queue.
"""
from __future__ import annotations

from datetime import date
from typing import Any

import duckdb

from sloop import ledger
from sloop.agents import context, feedback, llm, tasks
from sloop.schemas import Hypothesis, ResearcherOutput
from sloop.store.duck import audit
from sloop.triggers import filter as triggers


def _admit(con: duckdb.DuckDBPyConnection, hyps: list[Hypothesis], proposed_by: str, version: str,
           trigger_event_id: str | None = None) -> list[dict[str, Any]]:
    known = {r[0] for r in con.execute("SELECT DISTINCT type FROM events").fetchall()}
    out = []
    for h in hyps:
        if h.signal.event_type not in known:
            feedback.write(con, "harness", "researcher", None, "bad",
                           f"'{h.title}' refused: no events of type {h.signal.event_type} in the store")
            out.append({"title": h.title, "refused": "unknown event type"})
            continue
        hid, dup = ledger.register(con, h, proposed_by, trigger_event_id=trigger_event_id)
        audit(con, proposed_by, "proposal", hid, {"duplicate_of": dup}, version)
        if dup:
            feedback.write(con, "harness", "researcher", hid, "bad",
                           f"'{h.title}' duplicates family {h.family_key()} already in the ledger ({dup})")
        out.append({"hypothesis_id": hid, "family_key": h.family_key(), "duplicate_of": dup})
    return out


def step(con: duckdb.DuckDBPyConnection, as_of: date, backend: str | None = None) -> list[dict[str, Any]]:
    ctx = context.researcher(con, as_of)
    res, version = llm.run(con, "researcher", "researcher", ctx, ResearcherOutput, backend=backend, day=as_of)
    admitted = _admit(con, res.hypotheses, "researcher", version)
    tasks.close(con, "research", note=f"{len(admitted)} proposals")
    return admitted


def on_event(con: duckdb.DuckDBPyConnection, event: dict[str, Any], backend: str | None = None,
             day: date | None = None, rules: list[dict] | None = None) -> list[dict[str, Any]]:
    """Event-triggered wakeup. The trigger filter has already matched; this asks
    whether the bundle suggests a new or existing hypothesis."""
    fired = triggers.matches(con, event, rules)
    if not fired:
        return []
    if triggers.wakeups_left_today(con) <= 0:
        audit(con, "trigger", "wakeup_skipped_cap", event["event_id"], {"fired": fired})
        return []
    audit(con, "trigger", "researcher_wakeup", event["event_id"], {"fired": fired})
    ctx = context.wakeup(con, event, fired)
    res, version = llm.run(con, "researcher_wakeup", "researcher_wakeup", ctx, ResearcherOutput, backend=backend, day=day)
    return _admit(con, res.hypotheses, "researcher", version, trigger_event_id=event["event_id"])
