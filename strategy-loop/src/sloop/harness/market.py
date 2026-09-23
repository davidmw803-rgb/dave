"""In-memory market data for backtests, loaded once per run.

Prices are loaded only up to ``end`` (exclusive). An in-sample run passes
``end=holdout_start``, so holdout-period prices are not merely filtered, they
are never in memory.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

import duckdb
import numpy as np
import pandas as pd

from sloop import config


@dataclass
class Series:
    """One ticker's daily bars. o/h/l/c are split-adjusted; raw_* are as traded."""

    dates: np.ndarray  # datetime64[D], sorted
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    raw_o: np.ndarray
    raw_c: np.ndarray
    vol: np.ndarray

    def index_of(self, d: np.datetime64) -> int:
        """Index of the bar on date d, or -1 if the ticker didn't trade that day."""
        i = int(np.searchsorted(self.dates, d))
        return i if i < len(self.dates) and self.dates[i] == d else -1

    def atr(self, i: int, window: int) -> float:
        """ATR from bars strictly before i (known before a decision on day i)."""
        lo = max(1, i - window)
        if i - lo < 2:
            return float("nan")
        h, l, pc = self.h[lo:i], self.l[lo:i], self.c[lo - 1:i - 1]
        tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
        return float(tr.mean())


@dataclass
class MarketData:
    series: dict[str, Series]
    calendar: np.ndarray  # trading days (datetime64[D])
    universe: pd.DataFrame  # universe_pit, sorted by (ticker, date)
    regimes: pd.Series  # date -> regime_label
    end: date | None
    _uni_by_ticker: dict[str, pd.DataFrame] = field(default_factory=dict, repr=False)

    @classmethod
    def load(cls, con: duckdb.DuckDBPyConnection, end: date | None = None,
             tickers: list[str] | None = None) -> "MarketData":
        where, params = [], []
        if end is not None:
            where.append("date < ?")
            params.append(end)
        if tickers is not None:
            where.append("ticker IN (SELECT unnest(?))")
            params.append(tickers)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        px = con.execute(
            f"SELECT ticker, date, open, high, low, close, volume, adj_close FROM prices {clause} ORDER BY ticker, date",
            params,
        ).df()
        series: dict[str, Series] = {}
        for t, g in px.groupby("ticker", sort=False):
            raw_c = g["close"].to_numpy(float)
            adj = g["adj_close"].fillna(g["close"]).to_numpy(float)
            f = np.where(raw_c > 0, adj / np.where(raw_c > 0, raw_c, 1), 1.0)
            series[t] = Series(
                dates=g["date"].to_numpy("datetime64[D]"),
                o=g["open"].to_numpy(float) * f, h=g["high"].to_numpy(float) * f,
                l=g["low"].to_numpy(float) * f, c=adj,
                raw_o=g["open"].to_numpy(float), raw_c=raw_c, vol=g["volume"].to_numpy(float),
            )
        cal_ticker = config.load("rules")["benchmarks"]["fallback"]
        if cal_ticker in series:
            calendar = series[cal_ticker].dates
        else:
            calendar = np.unique(px["date"].to_numpy("datetime64[D]")) if len(px) else np.array([], "datetime64[D]")

        uclause = "WHERE date < ?" if end is not None else ""
        uni = con.execute(f"SELECT * FROM universe_pit {uclause} ORDER BY ticker, date",
                          [end] if end is not None else []).df()
        if len(uni):
            uni["date"] = uni["date"].to_numpy("datetime64[D]")
        rg = con.execute(f"SELECT date, regime_label FROM regimes {uclause} ORDER BY date",
                         [end] if end is not None else []).df()
        regimes = pd.Series(rg["regime_label"].to_numpy(), index=rg["date"].to_numpy("datetime64[D]")) if len(rg) else pd.Series(dtype=object)
        return cls(series=series, calendar=calendar, universe=uni, regimes=regimes, end=end)

    # ---- point-in-time lookups ---------------------------------------------------

    def universe_asof(self, ticker: str, before: np.datetime64) -> dict | None:
        """Latest universe_pit row for ticker dated strictly before ``before``."""
        if ticker not in self._uni_by_ticker:
            self._uni_by_ticker[ticker] = self.universe[self.universe["ticker"] == ticker]
        u = self._uni_by_ticker[ticker]
        if u.empty:
            return None
        k = int(np.searchsorted(u["date"].to_numpy("datetime64[D]"), before)) - 1
        return None if k < 0 else u.iloc[k].to_dict()

    def regime_asof(self, before: np.datetime64) -> str | None:
        if self.regimes.empty:
            return None
        k = int(np.searchsorted(self.regimes.index.to_numpy("datetime64[D]"), before)) - 1
        return None if k < 0 else str(self.regimes.iloc[k])

    def next_trading_day(self, d: np.datetime64, inclusive: bool) -> int:
        """Calendar index of the first trading day >= d (inclusive) or > d."""
        return int(np.searchsorted(self.calendar, d, side="left" if inclusive else "right"))
