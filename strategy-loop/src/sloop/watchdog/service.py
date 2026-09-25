"""Watchdog (§3.7): heartbeats, data staleness, reconciliation, limit invariants.

Reconciliation halts new entries only after ``reconcile_mismatches_to_halt``
consecutive mismatching checks, since a fill can land between the broker's
book and the executor's next sync. The halt is sticky until `loop resume`.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

from sloop import clock, config
from sloop.executor import portfolio
from sloop.executor.broker import Broker
from sloop.store import hot
from sloop.watchdog import reconcile
from sloop.watchdog.alerts import alert

ALWAYS_ON = ("ingest",)
MARKET_HOURS = ("executor",)


def _market_window(now_et: datetime) -> bool:
    mh = config.load("schedule")["market_hours"]
    return clock.within(now_et, [mh["start"], mh["end"]])


def check(con: sqlite3.Connection, broker: Broker | None, clk: clock.Clock) -> list[str]:
    now = clk.now()
    now_et = now.astimezone(clock.ET)
    wcfg = config.load("risk")["watchdog"]
    found: list[str] = []
    hot.heartbeat(con, "watchdog", "ok", now.isoformat())
    in_market = _market_window(now_et)

    # Heartbeats.
    beats = {r["service"]: datetime.fromisoformat(r["ts"]) for r in hot.rows(con, "SELECT * FROM heartbeats")}
    for svc in ALWAYS_ON + (MARKET_HOURS if in_market else ()):
        last = beats.get(svc)
        if last is None or (now - last).total_seconds() > wcfg["heartbeat_max_age_seconds"]:
            msg = f"{svc} heartbeat missing" + (f" since {last.isoformat()}" if last else "")
            found.append(msg)
            alert(con, f"heartbeat:{svc}", msg, "error", now)

    # Source staleness (only meaningful while sources are expected to publish).
    if in_market:
        for src, cfg in config.load("sources")["sources"].items():
            if src == "prices" or cfg.get("expected_interval_minutes") is None:
                continue
            last = hot.one(con, "SELECT max(ts_ingested) AS t FROM events WHERE source = ?", [src])
            if last is None or last["t"] is None:
                continue  # source not configured on this host
            age = now - datetime.fromisoformat(last["t"])
            if age > timedelta(minutes=cfg["expected_interval_minutes"]):
                msg = f"no {src} events for {age}"
                found.append(msg)
                alert(con, f"stale:{src}", msg, "warn", now)

    # Reconciliation.
    if broker is not None and in_market:
        if not broker.ping():
            hot.set_control(con, "broker_down", now.isoformat(), "watchdog")
            alert(con, "broker_down", f"{broker.name} unreachable: new entries halted", "error", now)
            found.append("broker down")
        else:
            problems = reconcile.diff(con, broker)
            streak = int(hot.get_cursor(con, "reconcile_streak", "0"))
            streak = streak + 1 if problems else 0
            hot.set_cursor(con, "reconcile_streak", str(streak))
            if streak >= wcfg["reconcile_mismatches_to_halt"]:
                hot.set_control(con, "reconciliation", "; ".join(problems)[:500], "watchdog")
                alert(con, "reconciliation", "entries halted: " + "; ".join(problems[:5]), "error", now)
            found += problems

    for v in portfolio.violations(con):
        found.append(v)
        alert(con, "limit_violation", v, "error", now)
    return found
