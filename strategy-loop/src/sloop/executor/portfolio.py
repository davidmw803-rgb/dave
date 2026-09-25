"""Portfolio state for the risk gate (§9), built from the executor's own records.

Open entry orders count as positions at their limit price, so a burst of
signals in one tick cannot exceed a cap before anything fills.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta

from sloop import clock, config
from sloop.executor import orders as order_ctl
from sloop.executor.broker import Quote
from sloop.executor.risk import PortfolioState, Position
from sloop.store import hot

ENTRY_OPEN = ("submitting", "open")


def _et_date(ts: str) -> date:
    return datetime.fromisoformat(ts).astimezone(clock.ET).date()


def realized(con: sqlite3.Connection, today: date) -> tuple[float, float, float]:
    """(today, this ISO week, all time) realized P&L from closed positions."""
    t = w = total = 0.0
    week = today.isocalendar()[:2]
    for p in hot.rows(con, "SELECT closed_at, pnl FROM positions WHERE closed_at IS NOT NULL"):
        d = _et_date(p["closed_at"])
        total += p["pnl"] or 0.0
        if d == today:
            t += p["pnl"] or 0.0
        if d.isocalendar()[:2] == week:
            w += p["pnl"] or 0.0
    return t, w, total


def day_trades_5d(con: sqlite3.Connection, today: date) -> int:
    start = today - timedelta(days=7)
    n = 0
    for p in hot.rows(con, "SELECT opened_at, closed_at FROM positions WHERE closed_at IS NOT NULL"):
        o, c = _et_date(p["opened_at"]), _et_date(p["closed_at"])
        if o == c and c >= start:
            n += 1
    return n


def open_exposure(con: sqlite3.Connection, quotes: dict[str, Quote]) -> list[Position]:
    out = []
    for p in hot.rows(con, "SELECT * FROM positions WHERE closed_at IS NULL"):
        q = quotes.get(p["ticker"])
        out.append(Position(p["strategy_id"], p["ticker"], p["sector"], p["qty"], q.last if q else p["avg_cost"]))
    for o in hot.rows(con, "SELECT * FROM orders WHERE side = 'buy' AND status IN ('submitting','open')"):
        d = json.loads(o["details_json"] or "{}")
        out.append(Position(o["strategy_id"], o["ticker"], d.get("sector"), o["qty"], o["limit"]))
    return out


def unrealized(con: sqlite3.Connection, quotes: dict[str, Quote]) -> float:
    u = 0.0
    for p in hot.rows(con, "SELECT * FROM positions WHERE closed_at IS NULL"):
        q = quotes.get(p["ticker"])
        if q:
            u += (q.last - p["avg_cost"]) * p["qty"]
    return u


def build(con: sqlite3.Connection, quotes: dict[str, Quote], today: date) -> PortfolioState:
    t, w, total = realized(con, today)
    equity = config.load("risk")["executor"]["paper_equity"] + total + unrealized(con, quotes)
    return PortfolioState(
        equity=equity,
        positions=open_exposure(con, quotes),
        realized_pnl_today=t,
        realized_pnl_week=w,
        weekly_halt=hot.get_control(con, "weekly_halt") is not None,
        killed=order_ctl.killed() or hot.get_control(con, "halt") is not None,
        day_trades_5d=day_trades_5d(con, today),
        strategy_state={r["strategy_id"]: r["state"] for r in hot.rows(con, "SELECT strategy_id, state FROM strategies")},
    )


def violations(con: sqlite3.Connection) -> list[str]:
    """Hard-limit invariants over what the executor actually did (checked by the watchdog and tests)."""
    L = config.load("risk")
    out = []
    openp = hot.rows(con, "SELECT strategy_id, ticker FROM positions WHERE closed_at IS NULL")
    if len(openp) > L["portfolio"]["max_open_positions"]:
        out.append(f"{len(openp)} open positions > {L['portfolio']['max_open_positions']}")
    for key, cap, label in (("strategy_id", L["per_strategy"]["max_open_positions"], "strategy"),
                            ("ticker", L["portfolio"]["max_positions_per_ticker"], "ticker")):
        counts: dict[str, int] = {}
        for p in openp:
            counts[p[key]] = counts.get(p[key], 0) + 1
        out += [f"{label} {k} has {n} open positions > {cap}" for k, n in counts.items() if n > cap]
    for o in hot.rows(con, "SELECT client_order_id, details_json FROM orders WHERE side = 'buy'"):
        d = json.loads(o["details_json"] or "{}")
        eq = d.get("equity") or 0
        if eq and d.get("risk_amount", 0) > L["per_trade"]["max_risk_pct"] / 100 * eq * 1.0001:
            out.append(f"{o['client_order_id']}: risk {d['risk_amount']:.2f} > {L['per_trade']['max_risk_pct']}% of {eq:.0f}")
        if eq and d.get("notional", 0) > L["per_trade"]["max_position_pct"] / 100 * eq * 1.0001:
            out.append(f"{o['client_order_id']}: notional {d['notional']:.2f} > {L['per_trade']['max_position_pct']}% of {eq:.0f}")
    return out
