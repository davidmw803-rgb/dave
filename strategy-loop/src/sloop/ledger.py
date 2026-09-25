"""Hypothesis ledger and the promotion ladder (§1.5, §1.6).

proposed -> backtested -> holdout_passed -> paper -> live_small -> live

- Only the harness moves a hypothesis to backtested / holdout_passed / failed.
- The orchestrator may move holdout_passed -> paper, nothing higher.
- paper -> live_small and every size increase need actor "david", which only
  the CLI's `approve` command supplies.
- A revision is a new child hypothesis; it starts again at proposed.
"""
from __future__ import annotations

import json
from typing import Any

import duckdb

from sloop.config import config_hash
from sloop.schemas import LADDER, Hypothesis, StrategyConfig
from sloop.store.duck import audit, new_id, now

HUMAN = "david"
_ALLOWED: dict[str, set[str]] = {
    "backtested": {"harness"},
    "holdout_passed": {"harness"},
    "failed": {"harness"},
    "paper": {"orchestrator", HUMAN},
    "live_small": {HUMAN},
    "live": {HUMAN},
    "killed": {"orchestrator", "evaluator", "executor", HUMAN},
}


class LadderError(PermissionError):
    pass


def register(con: duckdb.DuckDBPyConnection, hyp: Hypothesis, proposed_by: str,
             parent_id: str | None = None, trigger_event_id: str | None = None) -> tuple[str, str | None]:
    """Store a hypothesis. Returns (hypothesis_id, duplicate_of).

    A hypothesis whose family already exists is still stored (it is a trial and
    is counted) but ``duplicate_of`` names the earlier one so the orchestrator
    can refuse to queue it. Revisions (``parent_id`` set) are expected to share
    their parent's family and are not flagged.
    """
    fk = hyp.family_key()
    dup = None
    if parent_id is None:
        row = con.execute("SELECT hypothesis_id FROM hypotheses WHERE family_key = ? ORDER BY created_at LIMIT 1", [fk]).fetchone()
        dup = row[0] if row else None
    hid = new_id("hyp")
    t = now()
    con.execute(
        "INSERT INTO hypotheses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [hid, parent_id, fk, hyp.cell_key, proposed_by, trigger_event_id, t,
         hyp.model_dump_json(), hyp.mechanism, "proposed", t],
    )
    audit(con, proposed_by, "propose", hid, {"family_key": fk, "duplicate_of": dup, "parent_id": parent_id})
    return hid, dup


def get(con: duckdb.DuckDBPyConnection, hypothesis_id: str) -> dict[str, Any]:
    row = con.execute("SELECT * FROM hypotheses WHERE hypothesis_id = ?", [hypothesis_id]).df()
    if row.empty:
        raise KeyError(hypothesis_id)
    rec = row.iloc[0].to_dict()
    rec["spec"] = Hypothesis.model_validate_json(rec["spec_json"])
    return rec


def transition(con: duckdb.DuckDBPyConnection, hypothesis_id: str, to: str, actor: str, reason: str = "") -> None:
    cur = get(con, hypothesis_id)["status"]
    if actor not in _ALLOWED.get(to, set()):
        raise LadderError(f"{actor!r} may not move a hypothesis to {to!r}")
    if cur in ("killed", "failed"):
        raise LadderError(f"{hypothesis_id} is {cur}; revise it as a new child hypothesis")
    if to not in ("killed", "failed"):
        if cur not in LADDER or LADDER.index(to) != LADDER.index(cur) + 1:
            raise LadderError(f"{hypothesis_id}: {cur} -> {to} skips or reverses a rung")
    con.execute("UPDATE hypotheses SET status = ?, status_changed_at = ? WHERE hypothesis_id = ?", [to, now(), hypothesis_id])
    audit(con, actor, f"status:{cur}->{to}", hypothesis_id, {"reason": reason})


def freeze_strategy(con: duckdb.DuckDBPyConnection, hypothesis_id: str, variant: dict[str, Any],
                    expected: dict[str, float], allocation_pct: float) -> str:
    """Create the immutable executor config when a hypothesis reaches paper.

    The config is the hypothesis with the in-sample variant that passed, so the
    executor trades exactly what was tested.
    """
    from sloop.harness.run import apply_variant  # local: harness imports ledger

    hyp = apply_variant(get(con, hypothesis_id)["spec"], variant)
    sid = new_id("stg")
    cfg = StrategyConfig(
        strategy_id=sid, hypothesis_id=hypothesis_id, signal=hyp.signal,
        entry={"order_type": "limit", "limit_offset_pct": 0.5, **hyp.entry.model_dump()},
        exit={**hyp.exit.model_dump(), "max_hold_days": hyp.exit.horizon_days},
        regime_filter=hyp.regime_filter, expected=expected,
    )
    body = cfg.model_dump(mode="json")
    con.execute("INSERT INTO strategies VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [sid, hypothesis_id, json.dumps(body), config_hash(body), "paper", allocation_pct, None, None])
    audit(con, "orchestrator", "freeze_strategy", sid, {"hypothesis_id": hypothesis_id, "variant": variant})
    return sid


def approve_strategy(con: duckdb.DuckDBPyConnection, strategy_id: str, to: str, actor: str,
                     allocation_pct: float | None = None) -> None:
    """Human gate: paper -> live_small -> live, and allocation increases."""
    if actor != HUMAN:
        raise LadderError("only David can approve real-money rungs or size increases")
    row = con.execute("SELECT state, hypothesis_id, allocation_pct FROM strategies WHERE strategy_id = ?", [strategy_id]).fetchone()
    if not row:
        raise KeyError(strategy_id)
    state, hid, alloc = row
    order = ("paper", "live_small", "live")
    if to != state and (state not in order or to not in order or order.index(to) != order.index(state) + 1):
        raise LadderError(f"{strategy_id}: {state} -> {to} is not the next rung")
    if to != state:
        transition(con, hid, to, actor)
    con.execute("UPDATE strategies SET state = ?, allocation_pct = ?, approved_by = ?, approved_at = ? WHERE strategy_id = ?",
                [to, allocation_pct if allocation_pct is not None else alloc, actor, now(), strategy_id])
    audit(con, actor, "approve", strategy_id, {"from": state, "to": to, "allocation_pct": allocation_pct})
