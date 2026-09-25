"""Broker reconciliation (§3.7): the broker's book vs the executor's, every minute in market hours."""
from __future__ import annotations

import sqlite3

from sloop.executor.broker import Broker
from sloop.store import hot

LIVE_ORDER = ("submitting", "open", "pending")


def diff(con: sqlite3.Connection, broker: Broker) -> list[str]:
    problems = []
    ours = {r["client_order_id"]: r["status"] for r in hot.rows(
        con, "SELECT client_order_id, status FROM orders WHERE status IN ('submitting','open','pending')")}
    theirs = {o.client_order_id: o.status for o in broker.open_orders()}
    for cid in sorted(set(ours) - set(theirs)):
        problems.append(f"order {cid} is {ours[cid]} here but not open at the broker")
    for cid in sorted(set(theirs) - set(ours)):
        problems.append(f"order {cid} is {theirs[cid]} at the broker but not open here")
    held: dict[str, float] = {}
    for p in hot.rows(con, "SELECT ticker, qty FROM positions WHERE closed_at IS NULL"):
        held[p["ticker"]] = held.get(p["ticker"], 0) + p["qty"]
    bpos = broker.positions()
    for t in sorted(set(held) | set(bpos)):
        if abs(held.get(t, 0) - bpos.get(t, 0)) > 1e-9:
            problems.append(f"{t}: executor holds {held.get(t, 0):g}, broker holds {bpos.get(t, 0):g}")
    return problems
