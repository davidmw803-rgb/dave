"""DuckDB access: one file for the ledger and market data, parquet for backups."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd

from sloop import config
from sloop.store.schema import DDL


def connect(path: str | Path | None = None) -> duckdb.DuckDBPyConnection:
    """Open (and migrate) the store. ``":memory:"`` for tests."""
    target = str(path) if path is not None else str(config.data_dir() / "loop.duckdb")
    con = duckdb.connect(target)
    con.execute("SET TimeZone='UTC'")
    con.execute(DDL)
    return con


def now() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def upsert_df(con: duckdb.DuckDBPyConnection, table: str, df: pd.DataFrame) -> int:
    """Insert rows, replacing on primary-key conflict. Returns rows written."""
    if df.empty:
        return 0
    con.register("_upsert", df)
    cols = ", ".join(f'"{c}"' for c in df.columns)
    con.execute(f"INSERT OR REPLACE INTO {table} ({cols}) SELECT {cols} FROM _upsert")
    con.unregister("_upsert")
    return len(df)


def audit(con: duckdb.DuckDBPyConnection, actor: str, action: str, object_id: str | None,
          details: dict[str, Any] | None = None, prompt_version: str | None = None) -> None:
    con.execute(
        "INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?, ?)",
        [now(), actor, action, object_id, json.dumps(details or {}, default=str),
         prompt_version, config.rules_hash()],
    )


# ---- trial counter (§1.3: every test is counted) ---------------------------------

def bump_trials(con: duckdb.DuckDBPyConnection, n: int = 1) -> int:
    con.execute("UPDATE trial_counter SET total = total + ? WHERE id = 1", [n])
    return trial_count(con)


def trial_count(con: duckdb.DuckDBPyConnection) -> int:
    return int(con.execute("SELECT total FROM trial_counter WHERE id = 1").fetchone()[0])


def export_parquet(con: duckdb.DuckDBPyConnection, out_dir: str | Path) -> list[Path]:
    """Nightly backup: every table to <out_dir>/<table>.parquet."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for (table,) in con.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='main'").fetchall():
        p = out / f"{table}.parquet"
        con.execute(f"COPY {table} TO '{p}' (FORMAT PARQUET)")
        written.append(p)
    return written
