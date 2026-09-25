"""Replay recorded sessions through the real executor, paper broker and watchdog.

Used for the Phase 3 checks before (and alongside) live paper trading:
historical events are fed in as if they were arriving live, intraday quotes
are drawn from each day's bar (open -> low -> high -> close, or open -> high ->
low -> close on a down day), and the clock steps through the session. After
every tick the watchdog reconciles and checks the hard limits.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone

import duckdb
import numpy as np
import pandas as pd

from sloop import clock
from sloop.executor.broker import StaticQuotes
from sloop.executor.loop import Executor
from sloop.executor.paper_sim import PaperSim
from sloop.store import hot
from sloop.watchdog import service as watchdog

KNOTS = (time(9, 30), time(11, 0), time(13, 0), time(16, 0))


@dataclass
class ReplayResult:
    days: list[str] = field(default_factory=list)
    ticks: int = 0
    watchdog_findings: list[str] = field(default_factory=list)
    restarts: int = 0


def _path_price(bar: dict, t: time) -> float:
    o, h, l, c = bar["open"], bar["high"], bar["low"], bar["close"]
    pts = (o, l, h, c) if c >= o else (o, h, l, c)
    secs = [k.hour * 3600 + k.minute * 60 for k in KNOTS]
    x = t.hour * 3600 + t.minute * 60 + t.second
    return float(np.interp(x, secs, pts))


def replay(duck: duckdb.DuckDBPyConnection, hcon, start: date, days: int, step_minutes: int = 5,
           crash_at: tuple[int, str] | None = None) -> ReplayResult:
    """Replay ``days`` trading sessions from ``start``.

    ``crash_at=(day_index, "HH:MM")`` kills the executor mid-session: the next
    bracket submission reaches the broker but the executor dies before
    recording it, and a fresh executor takes over from the database.
    """
    clk = clock.SimClock(datetime.combine(start, time(9, 0), clock.ET).astimezone(timezone.utc))
    broker, quotes = PaperSim(hcon, clk), StaticQuotes()
    ex = Executor(hcon, broker, quotes, clk)
    hot.sync_strategies(hcon, duck)
    res = ReplayResult()
    d = clock.next_trading_day(start, inclusive=True)
    for i in range(days):
        prev = clock.next_trading_day(d - timedelta(days=7))
        while clock.next_trading_day(prev) < d:
            prev = clock.next_trading_day(prev)
        hot.export_refdata(hcon, duck, asof=prev)
        bars = {r["ticker"]: r for r in duck.execute("SELECT * FROM prices WHERE date = ?", [d]).df().to_dict("records")}
        since = datetime.combine(prev, time(16, 0), clock.ET)
        until = datetime.combine(d, time(16, 0), clock.ET)
        ev = duck.execute("SELECT * FROM events WHERE ts_published > ? AND ts_published <= ? ORDER BY ts_published",
                          [since, until]).df()
        pending = ev.to_dict("records")
        t = datetime.combine(d, time(9, 0), clock.ET)
        end = datetime.combine(d, time(16, 5), clock.ET)
        while t <= end:
            clk.t = t.astimezone(timezone.utc)
            arrived = [e for e in pending if pd.Timestamp(e["ts_published"]) + pd.Timedelta(seconds=60) <= pd.Timestamp(clk.t)]
            if arrived:
                df = pd.DataFrame(arrived)
                df["ts_ingested"] = pd.to_datetime(df["ts_published"], utc=True) + pd.Timedelta(seconds=60)
                hot.insert_events(hcon, df)
                pending = [e for e in pending if e not in arrived]
            local = t.time()
            if time(9, 30) <= local <= time(16, 0):
                for tk, bar in bars.items():
                    quotes.set(tk, _path_price(bar, min(local, time(16, 0))), clk.t)
            if crash_at and crash_at[0] == i and local.strftime("%H:%M") == crash_at[1]:
                _arm_crash(broker)  # fires on the next submission from here on
            try:
                ex.tick()
            except _Crash:
                res.restarts += 1
                ex = Executor(hcon, broker, quotes, clk)  # a fresh process: recovers from the stores
                ex.tick()
            hot.heartbeat(hcon, "ingest", "ok", clk.t.isoformat())
            res.watchdog_findings += [f"{d} {local}: {x}" for x in watchdog.check(hcon, broker, clk)]
            res.ticks += 1
            t += timedelta(minutes=step_minutes)
        res.days.append(d.isoformat())
        d = clock.next_trading_day(d)
    return res


class _Crash(RuntimeError):
    pass


def _arm_crash(broker: PaperSim) -> None:
    real = broker.submit_bracket

    def submit_then_die(b, adv):
        broker.submit_bracket = real
        real(b, adv)
        raise _Crash("executor killed after the broker accepted the order")
    broker.submit_bracket = submit_then_die
