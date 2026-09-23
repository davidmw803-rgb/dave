"""Locked holdout (§6.4): the most recent 12 months are invisible to agents."""
from __future__ import annotations

from datetime import date

import duckdb
import pandas as pd

from sloop import config
from sloop.store.duck import audit, now


class HoldoutAlreadyUsed(PermissionError):
    """A hypothesis family gets exactly one holdout run."""


def holdout_start(con: duckdb.DuckDBPyConnection, today: date | None = None) -> date:
    """The stored boundary, initialised to today - N months on first use.

    It only moves when :func:`roll` is called (quarterly), so a boundary never
    drifts day by day into data an agent has already been shown.
    """
    row = con.execute("SELECT holdout_start FROM holdout_state WHERE id = 1").fetchone()
    if row:
        return row[0]
    start = _months_back(today or date.today())
    con.execute("INSERT INTO holdout_state VALUES (1, ?, ?)", [start, now()])
    return start


def roll(con: duckdb.DuckDBPyConnection, today: date | None = None) -> date:
    start = _months_back(today or date.today())
    con.execute("INSERT OR REPLACE INTO holdout_state VALUES (1, ?, ?)", [start, now()])
    audit(con, "scheduler", "holdout_roll", None, {"holdout_start": str(start)})
    return start


def _months_back(d: date) -> date:
    months = config.load("rules")["holdout"]["months"]
    return (pd.Timestamp(d) - pd.DateOffset(months=months)).date()


def check_unused(con: duckdb.DuckDBPyConnection, family_key: str) -> None:
    used = con.execute(
        """SELECT t.test_id FROM tests t JOIN hypotheses h USING (hypothesis_id)
           WHERE t.sample = 'holdout' AND h.family_key = ? LIMIT 1""",
        [family_key],
    ).fetchone()
    if used:
        raise HoldoutAlreadyUsed(f"family {family_key!r} already used its holdout run ({used[0]})")
