"""Wall clock and NYSE session calendar (ET). A settable clock drives replays and tests."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

from sloop import config

ET = ZoneInfo("America/New_York")
OPEN, CLOSE, EARLY_CLOSE = time(9, 30), time(16, 0), time(13, 0)


class Clock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def et(self) -> datetime:
        return self.now().astimezone(ET)


@dataclass
class SimClock(Clock):
    t: datetime

    def now(self) -> datetime:
        return self.t

    def set_et(self, d: date, hhmm: str) -> None:
        self.t = datetime.combine(d, time.fromisoformat(hhmm), ET).astimezone(timezone.utc)

    def advance(self, seconds: float) -> None:
        self.t += timedelta(seconds=seconds)


@lru_cache(maxsize=1)
def _cal() -> tuple[frozenset[date], frozenset[date]]:
    c = config.load("market_calendar")
    return frozenset(c["holidays"]), frozenset(c["early_closes"])


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in _cal()[0]


def session_close(d: date) -> time:
    return EARLY_CLOSE if d in _cal()[1] else CLOSE


def is_open(now_et: datetime) -> bool:
    d = now_et.date()
    return is_trading_day(d) and OPEN <= now_et.time() < session_close(d)


def next_trading_day(d: date, inclusive: bool = False) -> date:
    d = d if inclusive else d + timedelta(days=1)
    while not is_trading_day(d):
        d += timedelta(days=1)
    return d


def add_trading_days(d: date, n: int) -> date:
    for _ in range(n):
        d = next_trading_day(d)
    return d


def within(now_et: datetime, window: list[str]) -> bool:
    """Is ``now_et`` inside an [HH:MM, HH:MM) window of a trading day?

    On an early-close day, an afternoon window keeps its position relative to
    the close (15:45-15:55 becomes 12:45-12:55); a window that starts in the
    morning just ends as far past the early close as it would past 16:00.
    """
    d = now_et.date()
    lo, hi = (datetime.combine(d, time.fromisoformat(x)) for x in window)
    close = datetime.combine(d, session_close(d))
    normal_close = datetime.combine(d, CLOSE)
    if hi > close and close < normal_close:
        if lo.time() >= time(12, 0):
            shift = normal_close - close
            lo, hi = lo - shift, hi - shift
        else:
            hi = close + max(hi - normal_close, timedelta(0))
    return is_trading_day(d) and lo.time() <= now_et.time() < hi.time()
