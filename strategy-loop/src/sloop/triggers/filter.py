"""Trigger filter (§3.8): deterministic rules decide which events wake the researcher."""
from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import duckdb
import pandas as pd

from sloop import config
from sloop.harness.events import _passes, parse_filters


def matches(con: duckdb.DuckDBPyConnection, event: dict[str, Any], rules: list[dict] | None = None) -> list[str]:
    """IDs of the trigger rules this event fires. Pure over the store; no LLM."""
    rules = rules if rules is not None else config.load("triggers")["rules"]
    payload = event["payload_json"] if isinstance(event["payload_json"], dict) else json.loads(event["payload_json"] or "{}")
    uni_row = con.execute("SELECT * FROM universe_pit WHERE ticker = ? AND date < CAST(? AS DATE) ORDER BY date DESC LIMIT 1",
                          [event["ticker"], event["ts_published"]]).df()
    uni = uni_row.iloc[0].to_dict() if len(uni_row) else {}
    fired = []
    for r in rules:
        if r["event_type"] != event["type"]:
            continue
        if "when" in r and not _passes(parse_filters(r["when"]), payload, uni):
            continue
        if "min_count" in r:
            since = pd.Timestamp(event["ts_published"]) - timedelta(days=r["window_days"])
            n = con.execute("SELECT count(*) FROM events WHERE type = ? AND ticker = ? AND ts_published > ? AND ts_published <= ?",
                            [event["type"], event["ticker"], since, event["ts_published"]]).fetchone()[0]
            if n < r["min_count"]:
                continue
        fired.append(r["id"])
    return fired


def wakeups_left_today(con: duckdb.DuckDBPyConnection) -> int:
    cap = config.load("schedule")["llm"]["max_triggered_wakeups_per_day"]
    used = con.execute("SELECT count(*) FROM audit WHERE action = 'researcher_wakeup' AND ts >= current_date").fetchone()[0]
    return max(0, cap - used)
