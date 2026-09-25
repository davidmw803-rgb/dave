"""Hot store (§6.3): SQLite in WAL mode, shared by the always-on services.

DuckDB allows one writing process at a time, and slow-loop jobs hold it for
minutes, so the fast loop never depends on it:

- ingestion writes events here;
- the executor reads strategies and reference data from here, and writes
  signals, orders, fills and positions;
- the watchdog reads everything here.

``flush_to_duck`` copies the fast loop's rows into the DuckDB ledger (which
the slow loop and reports read). ``sync_from_duck`` pushes frozen strategy
configs and point-in-time reference data the other way. Both are idempotent.
The paper broker keeps its own tables (``sim_*``) so that reconciliation
compares two independent records, as it would with a real broker.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import duckdb
import pandas as pd

from sloop import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, source TEXT, source_id TEXT, type TEXT, ticker TEXT,
  ts_published TEXT, ts_ingested TEXT, payload_json TEXT, seq INTEGER
);
CREATE INDEX IF NOT EXISTS events_seq ON events(seq);
CREATE TABLE IF NOT EXISTS strategies (
  strategy_id TEXT PRIMARY KEY, hypothesis_id TEXT, config_json TEXT, config_hash TEXT,
  state TEXT, allocation_pct REAL, synced_at TEXT
);
CREATE TABLE IF NOT EXISTS strategy_overrides (
  strategy_id TEXT, state TEXT, reason TEXT, ts TEXT, flushed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS refdata (
  ticker TEXT PRIMARY KEY, asof TEXT, sector TEXT, mcap REAL, cap_bucket TEXT,
  avg_dollar_vol_20d REAL, atr14 REAL, last_close REAL
);
CREATE TABLE IF NOT EXISTS market_state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS signals (
  signal_id TEXT PRIMARY KEY, strategy_id TEXT, event_id TEXT, ticker TEXT, ts TEXT,
  due_date TEXT, entry_window TEXT, status TEXT, action TEXT, skipped_reason TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY, client_order_id TEXT UNIQUE, signal_id TEXT, position_id TEXT,
  broker_order_id TEXT, strategy_id TEXT, ticker TEXT, side TEXT, qty REAL, type TEXT,
  "limit" REAL, stop REAL, take_profit REAL, mode TEXT, status TEXT, ts TEXT, details_json TEXT
);
CREATE TABLE IF NOT EXISTS fills (
  fill_id TEXT PRIMARY KEY, order_id TEXT, client_order_id TEXT, price REAL, qty REAL, ts TEXT, fees REAL
);
CREATE TABLE IF NOT EXISTS positions (
  position_id TEXT PRIMARY KEY, strategy_id TEXT, ticker TEXT, sector TEXT, qty REAL, avg_cost REAL,
  stop REAL, take_profit REAL, opened_at TEXT, max_exit_date TEXT, closed_at TEXT, exit_price REAL,
  pnl REAL, exit_reason TEXT
);
CREATE TABLE IF NOT EXISTS heartbeats (service TEXT PRIMARY KEY, ts TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS alerts (
  alert_id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, key TEXT, level TEXT, message TEXT, sent INTEGER
);
CREATE TABLE IF NOT EXISTS controls (key TEXT PRIMARY KEY, value TEXT, set_by TEXT, ts TEXT);
CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS wakeups (
  event_id TEXT PRIMARY KEY, fired_json TEXT, queued_at TEXT, status TEXT, done_at TEXT
);
CREATE TABLE IF NOT EXISTS sim_orders (
  client_order_id TEXT PRIMARY KEY, parent_id TEXT, ticker TEXT, side TEXT, qty REAL, type TEXT,
  price REAL, adv REAL, status TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sim_fills (
  fill_id TEXT PRIMARY KEY, client_order_id TEXT, ticker TEXT, side TEXT, qty REAL, price REAL,
  fees REAL, ts TEXT, seq INTEGER
);
CREATE TABLE IF NOT EXISTS sim_positions (ticker TEXT PRIMARY KEY, qty REAL);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def path() -> Path:
    import os
    return Path(os.environ["LOOP_HOT_PATH"]) if os.environ.get("LOOP_HOT_PATH") else config.data_dir() / "hot.sqlite"


def connect(p: str | Path | None = None) -> sqlite3.Connection:
    con = sqlite3.connect(str(p or path()), timeout=30, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=30000")
    con.executescript(SCHEMA)
    return con


@contextmanager
def tx(con: sqlite3.Connection):
    """An IMMEDIATE transaction (the connection is autocommit). Nested calls join the outer one."""
    if con.in_transaction:
        yield con
        return
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
    except BaseException:
        con.execute("ROLLBACK")
        raise
    con.execute("COMMIT")


def rows(con: sqlite3.Connection, q: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
    return [dict(r) for r in con.execute(q, tuple(params)).fetchall()]


def one(con: sqlite3.Connection, q: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
    r = con.execute(q, tuple(params)).fetchone()
    return dict(r) if r else None


# ---- controls, cursors, heartbeats ----------------------------------------------

def get_control(con: sqlite3.Connection, key: str) -> str | None:
    r = one(con, "SELECT value FROM controls WHERE key = ?", [key])
    return r["value"] if r else None


def set_control(con: sqlite3.Connection, key: str, value: str | None, by: str) -> None:
    if value is None:
        con.execute("DELETE FROM controls WHERE key = ?", [key])
    else:
        con.execute("INSERT OR REPLACE INTO controls VALUES (?, ?, ?, ?)", [key, value, by, utcnow()])


def get_cursor(con: sqlite3.Connection, name: str, default: str = "") -> str:
    r = one(con, "SELECT value FROM cursors WHERE name = ?", [name])
    return r["value"] if r else default


def set_cursor(con: sqlite3.Connection, name: str, value: str) -> None:
    con.execute("INSERT OR REPLACE INTO cursors VALUES (?, ?)", [name, value])


def heartbeat(con: sqlite3.Connection, service: str, status: str = "ok", ts: str | None = None) -> None:
    con.execute("INSERT OR REPLACE INTO heartbeats VALUES (?, ?, ?)", [service, ts or utcnow(), status])


# ---- events ------------------------------------------------------------------

def insert_events(con: sqlite3.Connection, df: pd.DataFrame) -> list[str]:
    """Insert new events; return the IDs that were actually new. ``seq`` orders them for the executor."""
    if df is None or df.empty:
        return []
    new = []
    with tx(con):
        base = (one(con, "SELECT coalesce(max(seq), 0) AS m FROM events") or {"m": 0})["m"]
        for r in df.to_dict("records"):
            cur = con.execute(
                "INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [r["event_id"], r["source"], r["source_id"], r["type"], r["ticker"],
                 pd.Timestamp(r["ts_published"]).isoformat(), pd.Timestamp(r["ts_ingested"]).isoformat(),
                 r["payload_json"] if isinstance(r["payload_json"], str) else json.dumps(r["payload_json"]),
                 base + len(new) + 1])
            if cur.rowcount:
                new.append(r["event_id"])
    return new


# ---- hot -> duck ---------------------------------------------------------------

def flush_to_duck(hot: sqlite3.Connection, duck: duckdb.DuckDBPyConnection) -> dict[str, int]:
    """Copy fast-loop rows into the ledger. Safe to repeat; rows are upserted by key."""
    from sloop.store.duck import audit, insert_df, upsert_df

    out = {}
    ev = pd.DataFrame(rows(hot, "SELECT event_id, source, source_id, type, ticker, ts_published, ts_ingested, payload_json FROM events"))
    if len(ev):
        ev["ts_published"] = pd.to_datetime(ev["ts_published"], utc=True)
        ev["ts_ingested"] = pd.to_datetime(ev["ts_ingested"], utc=True)
    out["events"] = upsert_df(duck, "events", ev)
    sig = pd.DataFrame(rows(hot, "SELECT signal_id, strategy_id, event_id, ts, action, skipped_reason FROM signals"))
    if len(sig):
        sig["ts"] = pd.to_datetime(sig["ts"], utc=True)
    out["signals"] = upsert_df(duck, "signals", sig)
    od = pd.DataFrame(rows(hot, 'SELECT order_id, client_order_id, signal_id, broker_order_id, side, qty, type, "limit", stop, '
                                'take_profit, mode, status, ts, details_json, strategy_id, ticker, position_id FROM orders'))
    if len(od):
        od["ts"] = pd.to_datetime(od["ts"], utc=True)
        duck.execute("DELETE FROM orders WHERE order_id IN (SELECT unnest(?))", [od["order_id"].tolist()])
    out["orders"] = insert_df(duck, "orders", od)
    fl = pd.DataFrame(rows(hot, "SELECT fill_id, order_id, price, qty, ts, fees FROM fills"))
    if len(fl):
        fl["ts"] = pd.to_datetime(fl["ts"], utc=True)
    out["fills"] = upsert_df(duck, "fills", fl)
    ps = pd.DataFrame(rows(hot, "SELECT * FROM positions"))
    duck.execute("DELETE FROM positions WHERE position_id IN (SELECT unnest(?))", [ps["position_id"].tolist() if len(ps) else []])
    if len(ps):
        for c in ("opened_at", "closed_at"):
            ps[c] = pd.to_datetime(ps[c], utc=True)
        ps["max_exit_date"] = pd.to_datetime(ps["max_exit_date"]).dt.date
    out["positions"] = insert_df(duck, "positions", ps)
    for r in rows(hot, "SELECT rowid, * FROM strategy_overrides WHERE flushed = 0"):
        duck.execute("UPDATE strategies SET state = ? WHERE strategy_id = ?", [r["state"], r["strategy_id"]])
        audit(duck, "executor", f"override:{r['state']}", r["strategy_id"], {"reason": r["reason"]})
        hot.execute("UPDATE strategy_overrides SET flushed = 1 WHERE rowid = ?", [r["rowid"]])
    hb = pd.DataFrame(rows(hot, "SELECT service, ts, status FROM heartbeats"))
    if len(hb):
        hb["ts"] = pd.to_datetime(hb["ts"], utc=True)
        duck.register("_hb", hb)
        duck.execute("""INSERT INTO heartbeats SELECT * FROM _hb h WHERE NOT EXISTS
                        (SELECT 1 FROM heartbeats x WHERE x.service = h.service AND x.ts = h.ts)""")
        duck.unregister("_hb")
    return out


# ---- duck -> hot ---------------------------------------------------------------

def sync_strategies(hot: sqlite3.Connection, duck: duckdb.DuckDBPyConnection) -> int:
    df = duck.execute("SELECT strategy_id, hypothesis_id, config_json, config_hash, state, allocation_pct FROM strategies").df()
    with tx(hot):
        for r in df.to_dict("records"):
            hot.execute("INSERT OR REPLACE INTO strategies VALUES (?, ?, ?, ?, ?, ?, ?)",
                        [r["strategy_id"], r["hypothesis_id"], r["config_json"], r["config_hash"], r["state"],
                         r["allocation_pct"], utcnow()])
    return len(df)


def export_refdata(hot: sqlite3.Connection, duck: duckdb.DuckDBPyConnection, asof: date | None = None) -> int:
    """Latest universe row and raw-price ATR/close per ticker, as of the last EOD.

    Everything here is known before the next session opens, so the executor's
    filters see what the harness saw: the prior day's values.
    """
    from sloop.harness.events import cap_bucket

    q_asof = "WHERE date <= ?" if asof else ""
    params = [asof] if asof else []
    uni = duck.execute(f"""SELECT ticker, arg_max(date, date) AS asof, arg_max(sector, date) AS sector,
                           arg_max(mcap, date) AS mcap, arg_max(avg_dollar_vol_20d, date) AS adv
                           FROM universe_pit {q_asof} GROUP BY ticker""", params).df()
    px = duck.execute(f"""
        WITH p AS (SELECT ticker, date, high, low, close, lag(close) OVER (PARTITION BY ticker ORDER BY date) AS pc,
                          row_number() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
                   FROM prices {q_asof})
        SELECT ticker, avg(greatest(high - low, abs(high - pc), abs(low - pc))) FILTER (WHERE rn <= 14) AS atr14,
               max(close) FILTER (WHERE rn = 1) AS last_close, max(date) AS last_date
        FROM p GROUP BY ticker""", params).df()
    df = uni.merge(px, on="ticker", how="outer")
    with tx(hot):
        for r in df.to_dict("records"):
            hot.execute("INSERT OR REPLACE INTO refdata VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        [r["ticker"], str(r.get("last_date") or r.get("asof")), r.get("sector"), _f(r.get("mcap")),
                         cap_bucket(_f(r.get("mcap"))), _f(r.get("adv")), _f(r.get("atr14")), _f(r.get("last_close"))])
    reg = duck.execute(f"SELECT regime_label FROM regimes {q_asof} ORDER BY date DESC LIMIT 1", params).fetchone()
    hot.execute("INSERT OR REPLACE INTO market_state VALUES ('regime', ?)", [reg[0] if reg else None])
    return len(df)


def _f(x: Any) -> float | None:
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None
