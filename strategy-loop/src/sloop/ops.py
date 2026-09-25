"""Scheduled jobs that bridge the hot store and the ledger (§4, §14)."""
from __future__ import annotations

import json
import logging
import shutil
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import pandas as pd

from sloop import clock, config
from sloop.store import hot
from sloop.store.duck import audit, export_parquet, upsert_df

log = logging.getLogger("sloop.ops")


def flush(hcon: sqlite3.Connection, con: duckdb.DuckDBPyConnection) -> dict:
    """hot -> ledger (events, signals, orders, fills, positions), then ledger -> hot (strategies)."""
    out = hot.flush_to_duck(hcon, con)
    out["strategies_synced"] = hot.sync_strategies(hcon, con)
    return out


def eod(hcon: sqlite3.Connection, con: duckdb.DuckDBPyConnection, day: date | None = None) -> dict:
    """16:30 ET: flush, refresh bars + universe snapshots for tickers in play, regimes, refdata."""
    import os

    from sloop.harness import regimes

    day = day or datetime.now(clock.ET).date()
    out = {"flush": flush(hcon, con)}
    from sloop.ingest.vendors.base import VendorNotConfigured, get_vendor, sync as vendor_sync
    try:
        vendor = get_vendor()
    except VendorNotConfigured:
        vendor = None
    if vendor is not None:
        # The vendor is the source of record for bars and the point-in-time universe.
        lookback = config.load("sources")["vendor"]["eod_lookback_days"]
        out["vendor"] = vendor_sync(con, vendor, day - timedelta(days=lookback), day)
    elif os.environ.get("UW_API_KEY"):
        from sloop.ingest import prices, uw

        since = datetime.now(timezone.utc) - timedelta(days=45)
        tickers = {r[0] for r in con.execute("SELECT DISTINCT ticker FROM events WHERE ts_published >= ?", [since]).fetchall()}
        tickers |= {r["ticker"] for r in hot.rows(hcon, "SELECT DISTINCT ticker FROM positions WHERE closed_at IS NULL")}
        rb = config.load("rules")["benchmarks"]
        tickers |= set(rb["sector_etfs"].values()) | {rb["fallback"], "IWM"}
        bars, snaps = [], []
        for t in sorted(x for x in tickers if x):
            try:
                bars.append(uw.daily_bars(t))
                s = uw.info_snapshot(t, day)
                if s:
                    snaps.append(s)
            except RuntimeError as e:
                log.warning("eod refresh %s: %s", t, e)
        px = pd.concat([b for b in bars if len(b)], ignore_index=True) if any(len(b) for b in bars) else pd.DataFrame()
        out["price_rows"] = upsert_df(con, "prices", px) if len(px) else 0
        if snaps:
            u = pd.DataFrame(snaps)
            adv = con.execute("""SELECT ticker, avg(close * volume) AS adv FROM (SELECT *, row_number() OVER
                                 (PARTITION BY ticker ORDER BY date DESC) rn FROM prices) WHERE rn <= 20 GROUP BY ticker""").df()
            u = u.merge(adv, on="ticker", how="left").rename(columns={"adv": "avg_dollar_vol_20d"})
            out["universe_rows"] = upsert_df(con, "universe_pit", u[["ticker", "date", "mcap", "sector", "industry",
                                                                     "avg_dollar_vol_20d", "listed"]])
    out["regimes"] = len(regimes.compute(con))
    out["refdata"] = hot.export_refdata(hcon, con)
    audit(con, "scheduler", "eod", None, out)
    return out


def drain_wakeups(hcon: sqlite3.Connection, con: duckdb.DuckDBPyConnection, backend: str | None = None,
                  day: date | None = None) -> list[dict]:
    """Run queued trigger wakeups through the researcher (capped per day)."""
    from sloop.agents import researcher
    from sloop.agents.llm import BudgetExceeded

    flush(hcon, con)
    done = []
    for w in hot.rows(hcon, "SELECT * FROM wakeups WHERE status = 'queued' ORDER BY queued_at"):
        ev = con.execute("SELECT * FROM events WHERE event_id = ?", [w["event_id"]]).df()
        if ev.empty:
            continue
        try:
            res = researcher.on_event(con, ev.iloc[0].to_dict(), backend=backend, day=day, fired=json.loads(w["fired_json"]))
            status = "done"
        except BudgetExceeded as e:
            res, status = str(e), "skipped_budget"
        hcon.execute("UPDATE wakeups SET status = ?, done_at = ? WHERE event_id = ?", [status, hot.utcnow(), w["event_id"]])
        done.append({"event_id": w["event_id"], "status": status, "result": res})
        if status != "done":
            break
    return done


def backup(con: duckdb.DuckDBPyConnection, dest: str | Path) -> Path:
    """Nightly (§14): parquet export of every table plus a copy of the hot store."""
    out = Path(dest) / datetime.now(timezone.utc).strftime("%Y-%m-%d")
    export_parquet(con, out)
    src = hot.path()
    if src.exists():
        tmp = sqlite3.connect(str(src))
        dst = sqlite3.connect(str(out / "hot.sqlite"))
        tmp.backup(dst)
        dst.close()
        tmp.close()
    for old in sorted(Path(dest).glob("20*"))[:-14]:
        shutil.rmtree(old, ignore_errors=True)
    return out
