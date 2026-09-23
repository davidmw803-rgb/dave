"""Price and point-in-time universe import.

The price vendor is not chosen yet (open question). Until it is, bars and
universe snapshots are imported from files with these columns:

- prices:   ticker, date, open, high, low, close, volume[, adj_close]
- universe: ticker, date, mcap, sector[, industry, listed]

The universe file must include delisted, acquired and bankrupt names with their
history, and ``mcap``/``sector`` as they were on ``date`` (not today).
"""
from __future__ import annotations

from pathlib import Path

import duckdb
import pandas as pd

from sloop.store.duck import upsert_df

PRICE_COLS = ["ticker", "date", "open", "high", "low", "close", "volume", "adj_close"]


def _read(path: str | Path) -> pd.DataFrame:
    p = Path(path)
    return pd.read_parquet(p) if p.suffix == ".parquet" else pd.read_csv(p)


def import_prices(con: duckdb.DuckDBPyConnection, path: str | Path) -> int:
    df = _read(path)
    if "adj_close" not in df:
        df["adj_close"] = df["close"]
    df["date"] = pd.to_datetime(df["date"]).dt.date
    df["ticker"] = df["ticker"].str.upper()
    return upsert_df(con, "prices", df[PRICE_COLS])


def import_universe(con: duckdb.DuckDBPyConnection, path: str | Path) -> int:
    """Load snapshots and derive 20-day average dollar volume from raw prices as of each date."""
    u = _read(path)
    u["date"] = pd.to_datetime(u["date"]).dt.date
    u["ticker"] = u["ticker"].str.upper()
    for c, default in (("industry", None), ("listed", True)):
        if c not in u:
            u[c] = default
    con.register("_u", u[["ticker", "date", "mcap", "sector", "industry", "listed"]])
    df = con.execute("""
        WITH dv AS (
          SELECT ticker, date, avg(close * volume) OVER (PARTITION BY ticker ORDER BY date
                 ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS adv FROM prices)
        SELECT u.ticker, u.date, u.mcap, u.sector, u.industry, dv.adv AS avg_dollar_vol_20d, u.listed
        FROM _u u LEFT JOIN dv ON dv.ticker = u.ticker AND dv.date = u.date""").df()
    con.unregister("_u")
    return upsert_df(con, "universe_pit", df)
