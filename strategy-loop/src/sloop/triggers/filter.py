"""Trigger filter (§3.8): deterministic rules decide which events wake the researcher.

The rule logic is store-agnostic. :func:`matches` reads the DuckDB ledger (slow
loop); :func:`matches_hot` reads the hot store (ingestion service, 24/7).
"""
from __future__ import annotations

import json
import sqlite3
from datetime import timedelta
from typing import Any, Callable

import duckdb
import pandas as pd

from sloop import config
from sloop.harness.events import _passes, parse_filters


def evaluate(event: dict[str, Any], rules: list[dict], uni: dict[str, Any],
             count_recent: Callable[[str, str, pd.Timestamp, pd.Timestamp], int]) -> list[str]:
    payload = event["payload_json"] if isinstance(event["payload_json"], dict) else json.loads(event["payload_json"] or "{}")
    fired = []
    for r in rules:
        if r["event_type"] != event["type"]:
            continue
        if "when" in r and not _passes(parse_filters(r["when"]), payload, uni):
            continue
        if "min_count" in r:
            end = pd.Timestamp(event["ts_published"])
            if count_recent(event["type"], event["ticker"], end - timedelta(days=r["window_days"]), end) < r["min_count"]:
                continue
        fired.append(r["id"])
    return fired


def matches(con: duckdb.DuckDBPyConnection, event: dict[str, Any], rules: list[dict] | None = None) -> list[str]:
    rules = rules if rules is not None else config.load("triggers")["rules"]
    uni_row = con.execute("SELECT * FROM universe_pit WHERE ticker = ? AND date < CAST(? AS DATE) ORDER BY date DESC LIMIT 1",
                          [event["ticker"], event["ts_published"]]).df()
    uni = uni_row.iloc[0].to_dict() if len(uni_row) else {}

    def count(typ, ticker, since, until):
        return con.execute("SELECT count(*) FROM events WHERE type = ? AND ticker = ? AND ts_published > ? AND ts_published <= ?",
                           [typ, ticker, since, until]).fetchone()[0]
    return evaluate(event, rules, uni, count)


def matches_hot(con: sqlite3.Connection, event: dict[str, Any], rules: list[dict] | None = None) -> list[str]:
    from sloop.store import hot

    rules = rules if rules is not None else config.load("triggers")["rules"]
    ref = hot.one(con, "SELECT * FROM refdata WHERE ticker = ?", [event["ticker"]]) or {}
    uni = {"mcap": ref.get("mcap"), "avg_dollar_vol_20d": ref.get("avg_dollar_vol_20d"), "sector": ref.get("sector"),
           "cap_bucket": ref.get("cap_bucket")}

    def count(typ, ticker, since, until):
        n = 0
        for r in hot.rows(con, "SELECT ts_published FROM events WHERE type = ? AND ticker = ?", [typ, ticker]):
            t = pd.Timestamp(r["ts_published"])
            n += since < t <= until
        return n
    return evaluate(event, rules, uni, count)


def wakeups_left_today(con: duckdb.DuckDBPyConnection) -> int:
    cap = config.load("schedule")["llm"]["max_triggered_wakeups_per_day"]
    used = con.execute("SELECT count(*) FROM audit WHERE action = 'researcher_wakeup' AND ts >= current_date").fetchone()[0]
    return max(0, cap - used)
