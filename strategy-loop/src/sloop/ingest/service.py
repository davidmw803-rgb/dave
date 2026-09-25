"""Always-on ingestion (§2 fast loop, 24/7). Zero LLM calls.

Each loop: poll every source that is due, insert new events into the hot
store (``ts_ingested`` = now, so live rows carry their real latency), run the
trigger filter on each new event and queue matches for the researcher. The
queue is drained by `loop wakeups`, which the scheduler runs during market
hours, so wakeups outside market hours wait (§4).
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import time as _time
from datetime import datetime, timedelta, timezone
from typing import Callable

import pandas as pd

from sloop import clock, config
from sloop.store import hot
from sloop.triggers import filter as triggers
from sloop.watchdog.alerts import alert

log = logging.getLogger("sloop.ingest")
FAILS_BEFORE_ALERT = 3


def _uw(con: sqlite3.Connection) -> pd.DataFrame:
    from sloop.ingest import http, uw

    since = hot.get_cursor(con, "uw_analysts_since", (datetime.now(timezone.utc) - timedelta(days=1)).isoformat())
    body = http.get_json(f"{uw._base()}/api/screener/analysts", headers=uw._headers(),
                         params={"newer_than": since, "limit": 500}, retries=2)
    df = uw.to_events(body.get("data") or [], datetime.now(timezone.utc))
    if len(df):
        hot.set_cursor(con, "uw_analysts_since", pd.Timestamp(df["ts_published"].max()).isoformat())
    return df


_TICKERS: dict = {}


def _edgar(con: sqlite3.Connection) -> pd.DataFrame:
    from sloop.ingest import edgar

    if not _TICKERS or _TICKERS.get("_at", datetime.min.replace(tzinfo=timezone.utc)) < datetime.now(timezone.utc) - timedelta(days=1):
        _TICKERS.clear()
        _TICKERS.update(edgar.cik_tickers())
        _TICKERS["_at"] = datetime.now(timezone.utc)
    frames = [edgar.fetch_current(f, _TICKERS) for f in config.load("sources")["sources"]["edgar"]["live_forms"]]
    return pd.concat([f for f in frames if len(f)], ignore_index=True) if any(len(f) for f in frames) else pd.DataFrame()


def configured_sources() -> dict[str, Callable[[sqlite3.Connection], pd.DataFrame]]:
    out: dict[str, Callable[[sqlite3.Connection], pd.DataFrame]] = {}
    if os.environ.get("UW_API_KEY"):
        out["uw"] = _uw
    if os.environ.get("SEC_USER_AGENT"):
        out["edgar"] = _edgar
    return out


def queue_triggers(con: sqlite3.Connection, event_ids: list[str], now: datetime) -> int:
    n = 0
    for eid in event_ids:
        ev = hot.one(con, "SELECT * FROM events WHERE event_id = ?", [eid])
        fired = triggers.matches_hot(con, ev) if ev else []
        if fired:
            con.execute("INSERT OR IGNORE INTO wakeups VALUES (?, ?, ?, 'queued', NULL)", [eid, json.dumps(fired), now.isoformat()])
            n += 1
    return n


class Ingestor:
    def __init__(self, con: sqlite3.Connection, sources: dict | None = None, clk: clock.Clock | None = None):
        self.con = con
        self.sources = configured_sources() if sources is None else sources
        self.clock = clk or clock.Clock()
        self.next_at: dict[str, datetime] = {}
        self.fails: dict[str, int] = {}

    def tick(self) -> dict[str, int]:
        now = self.clock.now()
        hot.heartbeat(self.con, "ingest", "ok" if self.sources else "no_sources", now.isoformat())
        out = {}
        cfg = config.load("sources")["sources"]
        for name, fetch in self.sources.items():
            if self.next_at.get(name, now) > now:
                continue
            self.next_at[name] = now + timedelta(seconds=cfg.get(name, {}).get("poll_seconds", 60))
            try:
                new = hot.insert_events(self.con, fetch(self.con))
                self.fails[name] = 0
            except Exception as e:  # noqa: BLE001 - a source failing must not stop the others
                self.fails[name] = self.fails.get(name, 0) + 1
                log.warning("%s poll failed: %s", name, e)
                if self.fails[name] >= FAILS_BEFORE_ALERT:
                    alert(self.con, f"source:{name}", f"{name} failed {self.fails[name]} polls in a row: {e}", "warn", now)
                continue
            out[name] = len(new)
            if new:
                out[f"{name}_triggers"] = queue_triggers(self.con, new, now)
        return out


def serve(stop: Callable[[], bool], loop_seconds: float | None = None) -> None:
    con = hot.connect()
    ing = Ingestor(con)
    if not ing.sources:
        log.warning("no sources configured (set UW_API_KEY and/or SEC_USER_AGENT); heartbeating only")
    period = loop_seconds or config.load("schedule")["fast_loop_seconds"]
    while not stop():
        ing.tick()
        _time.sleep(period)
