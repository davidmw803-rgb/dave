"""Always-on service entry points (`loop serve <name>`), run under launchd/systemd.

Each service loops until SIGTERM/SIGINT and heartbeats every iteration. A
crash exits non-zero so the supervisor restarts it; the executor recovers its
state from the broker on the next start.
"""
from __future__ import annotations

import logging
import signal
import time

from sloop import clock, config
from sloop.store import hot

log = logging.getLogger("sloop.services")
_stop = False


def _handle(signum, frame) -> None:  # noqa: ARG001
    global _stop
    _stop = True
    log.info("signal %s: stopping after this iteration", signum)


def _setup() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)


def _sleep(seconds: float) -> None:
    end = time.monotonic() + seconds
    while not _stop and time.monotonic() < end:
        time.sleep(min(1.0, end - time.monotonic()))


def paper_broker(con, clk=None):
    if config.load("risk")["executor"]["broker"] != "paper_sim":
        raise SystemExit("executor.broker must be paper_sim: this codebase has no live broker")
    from sloop.executor.paper_sim import PaperSim
    return PaperSim(con, clk)


def serve(name: str) -> None:
    _setup()
    period = config.load("schedule")["fast_loop_seconds"]
    con = hot.connect()
    if name == "ingest":
        from sloop.ingest.service import Ingestor
        svc = Ingestor(con)
        if not svc.sources:
            log.warning("no sources configured (UW_API_KEY / SEC_USER_AGENT); heartbeating only")
        step = svc.tick
    elif name == "executor":
        from sloop.executor.broker import quote_source
        from sloop.executor.loop import Executor
        broker = paper_broker(con)

        def adv(t):
            r = hot.one(con, "SELECT avg_dollar_vol_20d FROM refdata WHERE ticker = ?", [t])
            return r["avg_dollar_vol_20d"] if r else None
        ex = Executor(con, broker, quote_source(adv))
        mh = config.load("schedule")["market_hours"]

        def step():
            if clock.within(clock.Clock().et(), [mh["start"], mh["end"]]):
                return ex.tick()
            hot.heartbeat(con, "executor", "idle")
            return "idle"
    elif name == "watchdog":
        from sloop.watchdog.service import check
        broker = paper_broker(con)
        period = 60

        def step():
            return check(con, broker, clock.Clock())
    else:
        raise SystemExit(f"unknown service {name!r}")
    log.info("%s started (every %ss)", name, period)
    while not _stop:
        try:
            step()
        except Exception:  # noqa: BLE001
            log.exception("%s iteration failed", name)
            hot.heartbeat(con, name, "error")
        _sleep(period)
    log.info("%s stopped", name)
