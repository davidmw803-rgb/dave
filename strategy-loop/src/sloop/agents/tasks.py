"""Work handed between slow-loop steps (orchestrator -> researcher / analyzer)."""
from __future__ import annotations

import json
from typing import Any

import duckdb

from sloop.store.duck import new_id, now


def add(con: duckdb.DuckDBPyConnection, kind: str, ref: str | None, payload: dict[str, Any], by: str) -> str:
    tid = new_id("task")
    con.execute("INSERT INTO tasks VALUES (?, ?, ?, ?, 'open', ?, ?, NULL, NULL)",
                [tid, kind, ref, json.dumps(payload, default=str), by, now()])
    return tid


def open_refs(con: duckdb.DuckDBPyConnection, kind: str) -> list[str]:
    return [r[0] for r in con.execute("SELECT ref FROM tasks WHERE kind = ? AND status = 'open' ORDER BY created_at",
                                      [kind]).fetchall()]


def close(con: duckdb.DuckDBPyConnection, kind: str, ref: str | None = None, note: str = "", status: str = "done") -> None:
    q = "UPDATE tasks SET status = ?, done_at = ?, note = ? WHERE kind = ? AND status = 'open'"
    params: list[Any] = [status, now(), note[:500], kind]
    if ref is not None:
        q += " AND ref = ?"
        params.append(ref)
    con.execute(q, params)
