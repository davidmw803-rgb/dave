"""A synthetic market with known answers, for harness self-tests (§16 Phase 1 exit).

Event types:
- ``synthetic_edge``: published pre-market; the stock drifts up ``edge`` over
  the next 5 sessions. The harness should find it and pass it.
- ``synthetic_noise``: no effect. The harness should fail it.
- ``synthetic_leak``: published at noon; the whole move happens between that
  day's open and the publication. Only a look-ahead entry (at the open) could
  capture it, so an honest harness should find nothing.

Some tickers are delisted part-way through to exercise survivorship handling.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timezone

import duckdb
import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

from sloop import config
from sloop.store.duck import upsert_df

ET = ZoneInfo("America/New_York")


def build(con: duckdb.DuckDBPyConnection, start: str = "2019-01-02", end: str = "2026-09-01",
          n_tickers: int = 250, n_edge: int = 500, n_noise: int = 500, n_leak: int = 400,
          edge: float = 0.03, seed: int = 11) -> dict:
    rng = np.random.default_rng(seed)
    days = pd.bdate_range(start, end)
    T = len(days)
    sectors = list(config.load("rules")["benchmarks"]["sector_etfs"])
    etf_of = config.load("rules")["benchmarks"]["sector_etfs"]

    mkt = rng.normal(0.0003, 0.010, T)
    sec_f = {s: rng.normal(0, 0.006, T) for s in sectors}
    tickers = [f"S{i:03d}" for i in range(n_tickers)]
    t_sector = {t: sectors[rng.integers(len(sectors))] for t in tickers}
    t_mcap0 = {t: float(np.exp(rng.uniform(np.log(4e8), np.log(5e10)))) for t in tickers}
    t_end = {t: T for t in tickers}
    for t in rng.choice(tickers, size=max(1, n_tickers // 12), replace=False):
        t_end[t] = int(rng.integers(T // 3, T - 60))  # delisted

    idio = rng.normal(0, 0.02, (n_tickers, T))
    overnight = rng.normal(0, 0.003, (n_tickers, T))

    # ---- plant events ---------------------------------------------------------
    events = []

    def pick(margin: int) -> tuple[int, int]:
        while True:
            k = int(rng.integers(len(tickers)))
            d = int(rng.integers(260, T - margin))
            if d + margin < t_end[tickers[k]]:
                return k, d

    for n in range(n_edge):
        k, d = pick(10)
        idio[k, d:d + 5] += edge / 5
        events.append(("synthetic_edge", k, d, time(7, 0), {"score": float(rng.uniform(0, 1))}))
    for n in range(n_noise):
        k, d = pick(10)
        events.append(("synthetic_noise", k, d, time(7, 0), {"score": float(rng.uniform(0, 1))}))
    for n in range(n_leak):
        k, d = pick(10)
        # The whole move is open -> noon on day d: the open doesn't carry it, the close does.
        idio[k, d] += edge
        events.append(("synthetic_leak", k, d, time(12, 0), {"score": float(rng.uniform(0, 1))}))

    # ---- prices ----------------------------------------------------------------
    rows = []
    for k, t in enumerate(tickers):
        n = t_end[t]
        r = mkt[:n] + sec_f[t_sector[t]][:n] + idio[k, :n]
        close = 20 * np.exp(np.cumsum(r))
        prev = np.concatenate([[20.0], close[:-1]])
        open_ = prev * np.exp(overnight[k, :n])
        hi = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.008, n)))
        lo = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.008, n)))
        mcap = t_mcap0[t] * close / 20
        vol = mcap * 0.004 / close * np.exp(rng.normal(0, 0.3, n))
        rows.append(pd.DataFrame({"ticker": t, "date": days[:n].date, "open": open_, "high": hi, "low": lo,
                                  "close": close, "volume": vol, "adj_close": close, "_mcap": mcap}))

    def index(name: str, rets: np.ndarray, level: float = 100.0) -> pd.DataFrame:
        c = level * np.exp(np.cumsum(rets))
        prev = np.concatenate([[level], c[:-1]])
        return pd.DataFrame({"ticker": name, "date": days.date, "open": prev, "high": np.maximum(prev, c) * 1.003,
                             "low": np.minimum(prev, c) * 0.997, "close": c, "volume": 1e8, "adj_close": c, "_mcap": np.nan})
    rows.append(index("SPY", mkt))
    rows.append(index("IWM", mkt * 1.2))
    for s in sectors:
        rows.append(index(etf_of[s], mkt + sec_f[s]))
    vix = np.clip(18 + np.cumsum(rng.normal(0, 0.8, T)) * 0.2, 10, 45)
    rows.append(pd.DataFrame({"ticker": "VIX", "date": days.date, "open": vix, "high": vix, "low": vix,
                              "close": vix, "volume": 0.0, "adj_close": vix, "_mcap": np.nan}))
    px = pd.concat(rows, ignore_index=True)
    upsert_df(con, "prices", px.drop(columns="_mcap"))

    stocks = px[px["ticker"].isin(tickers)].copy()
    stocks["dollar_vol"] = stocks["close"] * stocks["volume"]
    stocks["avg_dollar_vol_20d"] = stocks.groupby("ticker")["dollar_vol"].transform(lambda s: s.rolling(20, min_periods=5).mean())
    uni = pd.DataFrame({"ticker": stocks["ticker"], "date": stocks["date"], "mcap": stocks["_mcap"],
                        "sector": stocks["ticker"].map(t_sector), "industry": None,
                        "avg_dollar_vol_20d": stocks["avg_dollar_vol_20d"], "listed": True})
    upsert_df(con, "universe_pit", uni)

    ingested = datetime(2026, 9, 2, tzinfo=timezone.utc)  # a backfill: long after publication
    ev = []
    for n, (typ, k, d, tm, payload) in enumerate(events):
        pub = datetime.combine(days[d].date(), tm, ET).astimezone(timezone.utc)
        ev.append({"event_id": f"ev_{n:05d}", "source": "synthetic", "source_id": str(n), "type": typ,
                   "ticker": tickers[k], "ts_published": pub, "ts_ingested": ingested, "payload_json": json.dumps(payload)})
    upsert_df(con, "events", pd.DataFrame(ev))
    return {"tickers": tickers, "days": T, "events": len(ev), "as_of": date.fromisoformat(end)}
