"""Null baseline (§8.4): placebo backtests on random tickers.

Each placebo run keeps the real test's entry dates, entry timing and exit
rules, and swaps every ticker for a random one from the same cap bucket as of
the same date. The real mean abnormal return is ranked against the placebo means.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from sloop.harness.events import cap_bucket
from sloop.harness.market import MarketData
from sloop.harness.returns import simulate
from sloop.schemas import Exit

MAX_REDRAWS = 5


class _Pool:
    def __init__(self, md: MarketData):
        u = md.universe
        if u.empty:
            self.dates = np.array([], "datetime64[D]")
            self.by_date = {}
            return
        u = u[u["listed"].fillna(True)].copy() if "listed" in u else u.copy()
        u["bucket"] = [cap_bucket(m) for m in u["mcap"]]
        self.dates = np.unique(u["date"].to_numpy("datetime64[D]"))
        self.by_date = {d: g for d, g in u.groupby(u["date"].to_numpy("datetime64[D]"))}
        self._cache: dict[tuple, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}

    def candidates(self, before: np.datetime64, bucket: str | None) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
        """(tickers, sectors, adv) listed in ``bucket`` on the last universe date before ``before``."""
        k = int(np.searchsorted(self.dates, before)) - 1
        if k < 0:
            return None
        key = (self.dates[k], bucket)
        if key not in self._cache:
            g = self.by_date[self.dates[k]]
            g = g[g["bucket"] == bucket] if bucket else g
            self._cache[key] = (g["ticker"].to_numpy(), g["sector"].to_numpy(), g["avg_dollar_vol_20d"].to_numpy(float))
        return self._cache[key]


def null_distribution(md: MarketData, trades: pd.DataFrame, ex: Exit, max_gap_pct: float,
                      n_placebos: int, seed: int) -> np.ndarray:
    """Mean net AR of each placebo run. ``trades`` needs decision_date, entry_date, entry_at, cap_bucket."""
    rng = np.random.default_rng(seed)
    pool = _Pool(md)
    means = np.full(n_placebos, math.nan)
    rows = list(trades[["decision_date", "entry_date", "entry_at", "cap_bucket"]].itertuples(index=False))
    for k in range(n_placebos):
        ars = []
        for r in rows:
            cands = pool.candidates(np.datetime64(r.decision_date, "D"), r.cap_bucket)
            if cands is None or not len(cands[0]):
                continue
            tickers, sectors, advs = cands
            for _ in range(MAX_REDRAWS):
                j = int(rng.integers(len(tickers)))
                t = simulate(md, tickers[j], np.datetime64(r.entry_date, "D"), r.entry_at, sectors[j],
                             advs[j], ex, max_gap_pct)
                if t.ok:
                    ars.append(t.net_ar)
                    break
        if ars:
            means[k] = float(np.mean(ars))
    return means


def percentile_of(real: float, null_means: np.ndarray) -> float:
    m = null_means[np.isfinite(null_means)]
    if not len(m) or not math.isfinite(real):
        return math.nan
    return float((m < real).mean() * 100)
