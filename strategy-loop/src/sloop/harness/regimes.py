"""Daily regime labels (§8.5) from VIX, SPY/IWM trend and breadth.

Each label uses only that day's close and earlier. Backtests read the label as
of the day *before* the decision, so a same-day close never leaks in.
"""
from __future__ import annotations

import duckdb
import numpy as np
import pandas as pd

from sloop.store.duck import upsert_df


def _trend(close: pd.Series, window: int = 200) -> pd.Series:
    sma = close.rolling(window, min_periods=window // 2).mean()
    return pd.Series(np.where(close > sma, "up", "down"), index=close.index).where(sma.notna())


def compute(con: duckdb.DuckDBPyConnection, vix: str = "VIX", spy: str = "SPY", iwm: str = "IWM") -> pd.DataFrame:
    px = con.execute("SELECT ticker, date, close, adj_close FROM prices").df()
    if px.empty:
        return px
    px["adj"] = px["adj_close"].fillna(px["close"])
    wide = px.pivot(index="date", columns="ticker", values="adj").sort_index()
    out = pd.DataFrame(index=wide.index)
    if vix in wide:
        v = wide[vix]
    elif spy in wide:
        # No VIX series (e.g. Sharadar has no indices): SPY's 20-day realized
        # volatility, annualized in VIX points, stands in. Same buckets.
        v = np.log(wide[spy]).diff().rolling(20, min_periods=15).std() * np.sqrt(252) * 100
    else:
        v = None
    if v is not None:
        out["vix_bucket"] = pd.cut(v, [-np.inf, 15, 25, np.inf], labels=["vix_low", "vix_mid", "vix_high"], right=False).astype(object)
    else:
        out["vix_bucket"] = None
    out["spy_trend"] = _trend(wide[spy]) if spy in wide else None
    out["iwm_trend"] = _trend(wide[iwm]) if iwm in wide else None
    # Breadth: share of stocks (not ETFs/indices) above their own 50-day average.
    stocks = wide.drop(columns=[c for c in wide.columns if c in {vix, spy, iwm} or c.startswith("XL")], errors="ignore")
    above = (stocks > stocks.rolling(50, min_periods=25).mean()).where(stocks.notna())
    share = above.sum(axis=1) / above.notna().sum(axis=1).replace(0, np.nan)
    out["breadth_bucket"] = pd.cut(share, [-np.inf, 0.35, 0.65, np.inf], labels=["narrow", "mixed", "broad"]).astype(object)
    out["regime_label"] = out.apply(
        lambda r: None if pd.isna(r["vix_bucket"]) or pd.isna(r["spy_trend"]) else f"{r['vix_bucket']}|spy_{r['spy_trend']}",
        axis=1,
    )
    out = out.reset_index()
    upsert_df(con, "regimes", out[["date", "vix_bucket", "spy_trend", "iwm_trend", "breadth_bucket", "regime_label"]])
    return out
