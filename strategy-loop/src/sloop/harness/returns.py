"""Trade simulation on daily bars and sector-ETF-adjusted abnormal returns (§8.1).

Conventions
- Entry at the open of day i covers day i's range; entry at the close of day i
  starts exposure on day i+1.
- ``horizon_days`` counts closes after entry: open-entry exits at the close of
  i+H-1, close-entry at the close of i+H.
- Stops and targets are checked on daily high/low. If both could have hit on
  the same bar the stop is assumed (conservative). Gaps through a level fill at
  the open.
- A ticker that stops trading (delisted, acquired, bankrupt) exits at its last
  available close. Survivors are not special-cased.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from sloop import config
from sloop.harness import costs
from sloop.harness.market import MarketData, Series
from sloop.schemas import Exit


@dataclass
class Trade:
    ok: bool
    skip: str | None = None
    gross: float = math.nan
    bench: float = math.nan
    net_ar: float = math.nan
    exit_date: np.datetime64 | None = None
    exit_reason: str | None = None
    ar_h: dict[int, float] | None = None  # plain abnormal return at fixed horizons, before costs


def benchmark_for(sector: str | None) -> str:
    b = config.load("rules")["benchmarks"]
    return b["sector_etfs"].get(sector or "", b["fallback"])


def _bench_series(md: MarketData, sector: str | None) -> Series | None:
    s = md.series.get(benchmark_for(sector))
    return s if s is not None else md.series.get(config.load("rules")["benchmarks"]["fallback"])


def _ret(s: Series, i: int, at: str, j: int) -> float:
    p0 = s.o[i] if at == "open" else s.c[i]
    return s.c[j] / p0 - 1.0


def simulate(md: MarketData, ticker: str, entry_date: np.datetime64, at: str, sector: str | None,
             adv: float | None, ex: Exit, max_gap_pct: float, horizons: tuple[int, ...] = ()) -> Trade:
    s = md.series.get(ticker)
    if s is None:
        return Trade(False, "no_prices")
    i = s.index_of(entry_date)
    if i < 1:
        return Trade(False, "halted_or_no_bar")
    if s.vol[i] <= 0:
        return Trade(False, "halted_or_no_bar")
    if not costs.capacity_ok(adv):
        return Trade(False, "capacity")
    raw_entry = s.raw_o[i] if at == "open" else s.raw_c[i]
    gap = abs(raw_entry / s.raw_c[i - 1] - 1.0) * 100 if s.raw_c[i - 1] > 0 else math.inf
    if gap > max_gap_pct:
        return Trade(False, "gap")

    p0 = s.o[i] if at == "open" else s.c[i]
    first = i if at == "open" else i + 1
    last_planned = i + ex.horizon_days - (1 if at == "open" else 0)
    last = min(last_planned, len(s.dates) - 1)
    if last < last_planned and len(md.calendar) and s.dates[-1] >= md.calendar[-1]:
        # Still trading when the loaded window ends: the outcome is unknown, not a delisting.
        return Trade(False, "window_end")
    if last < first:
        return Trade(False, "no_forward_bars")

    stop = tp = None
    if ex.stop_atr_mult:
        atr = s.atr(i, config.load("rules")["backtest"]["atr_window"])
        if not math.isfinite(atr):
            return Trade(False, "no_atr")
        stop = p0 - ex.stop_atr_mult * atr
    if ex.take_profit_pct:
        tp = p0 * (1 + ex.take_profit_pct / 100)

    px_exit, j_exit, reason = s.c[last], last, "horizon" if last == last_planned else "delisted_or_data_end"
    for j in range(first, last + 1):
        if stop is not None and s.l[j] <= stop:
            px_exit, j_exit, reason = (min(s.o[j], stop) if j > i else stop), j, "stop"
            break
        if tp is not None and s.h[j] >= tp:
            px_exit, j_exit, reason = (max(s.o[j], tp) if j > i else tp), j, "take_profit"
            break

    gross = px_exit / p0 - 1.0
    b = _bench_series(md, sector)
    exit_day = s.dates[j_exit]
    bench = 0.0
    if b is not None:
        bi, bj = b.index_of(entry_date), int(np.searchsorted(b.dates, exit_day, side="right")) - 1
        if bi >= 0 and bj >= bi:
            bench = _ret(b, bi, at, bj)
    net_ar = gross - costs.round_trip_cost(adv, p0) - bench

    ar_h: dict[int, float] = {}
    for h in horizons:
        j = i + h - (1 if at == "open" else 0)
        if j < len(s.dates) and b is not None:
            bi = b.index_of(entry_date)
            bj = int(np.searchsorted(b.dates, s.dates[j], side="right")) - 1
            if bi >= 0 and bj >= bi:
                ar_h[h] = _ret(s, i, at, j) - _ret(b, bi, at, bj)
    return Trade(True, None, gross, bench, net_ar, exit_day, reason, ar_h)
