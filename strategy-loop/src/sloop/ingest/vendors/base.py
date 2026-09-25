"""Price + point-in-time universe vendors, and the vendor-agnostic sync into the ledger.

A vendor supplies three frames; everything point-in-time is derived here, so a
second vendor only has to implement the interface:

- ``securities()``: one row per ticker ever listed, delisted names included.
  ``ticker, name, category, exchange, sector (GICS level 1), industry, is_fund,
  delisted, first_date, last_date, vendor_id``
- ``prices(tickers, start, end)``: daily bars. ``open/high/low/close/volume``
  are **as traded** (unadjusted); ``adj_close`` is split- and dividend-adjusted.
- ``market_caps(tickers, start, end)``: ``ticker, date, mcap`` in USD, as known
  on that date.
"""
from __future__ import annotations

import os
from datetime import date
from typing import Protocol

import duckdb
import pandas as pd

from sloop import config
from sloop.store.duck import audit, now, upsert_df

SEC_COLS = ["ticker", "name", "category", "exchange", "sector", "industry", "is_fund", "delisted",
            "first_date", "last_date", "vendor_id"]
PX_COLS = ["ticker", "date", "open", "high", "low", "close", "volume", "adj_close"]


class VendorNotConfigured(RuntimeError):
    pass


class Vendor(Protocol):
    name: str

    def securities(self) -> pd.DataFrame: ...

    def prices(self, tickers: list[str] | None, start: date, end: date) -> pd.DataFrame: ...

    def market_caps(self, tickers: list[str] | None, start: date, end: date) -> pd.DataFrame: ...


def get_vendor(name: str | None = None) -> Vendor:
    cfg = config.load("sources")["vendor"]
    name = name or cfg["name"]
    if name == "sharadar":
        from sloop.ingest.vendors.sharadar import Sharadar
        key = os.environ.get(cfg["api_key_env"])
        if not key:
            raise VendorNotConfigured(f"set {cfg['api_key_env']} in strategy-loop/.env (Nasdaq Data Link key with "
                                      "the Sharadar Core US Equities bundle)")
        return Sharadar(key, **cfg.get("sharadar", {}))
    raise VendorNotConfigured(f"unknown or disabled vendor {name!r}")


def research_universe(secs: pd.DataFrame) -> pd.DataFrame:
    """Equities kept for research: configured categories, delisted names included."""
    prefixes = tuple(config.load("sources")["vendor"]["equity_categories_prefix"])
    return secs[~secs["is_fund"].astype(bool) & secs["category"].fillna("").str.startswith(prefixes)]


def benchmark_tickers() -> list[str]:
    b = config.load("rules")["benchmarks"]
    return sorted({*b["sector_etfs"].values(), b["fallback"], "IWM"})


def snapshot_dates(trading_days: pd.Series, how: str) -> set[pd.Timestamp]:
    """Last trading day of each week (or every day)."""
    d = pd.Series(pd.to_datetime(trading_days).unique()).sort_values()
    if how == "daily":
        return set(d)
    return set(d.groupby(d.dt.to_period("W-FRI")).max())


def build_universe(px: pd.DataFrame, mc: pd.DataFrame, secs: pd.DataFrame, how: str) -> pd.DataFrame:
    """universe_pit rows: mcap as of the date, 20d average dollar volume through the date,
    sector, and whether the ticker was listed on that date."""
    if px.empty or mc.empty:
        return pd.DataFrame(columns=["ticker", "date", "mcap", "sector", "industry", "avg_dollar_vol_20d", "listed"])
    p = px[["ticker", "date", "close", "volume"]].copy()
    p["date"] = pd.to_datetime(p["date"])
    p = p.sort_values(["ticker", "date"])
    p["dv"] = p["close"] * p["volume"]
    p["avg_dollar_vol_20d"] = p.groupby("ticker")["dv"].transform(lambda s: s.rolling(20, min_periods=5).mean())
    keep = snapshot_dates(p["date"], how)
    p = p[p["date"].isin(keep)]
    m = mc.copy()
    m["date"] = pd.to_datetime(m["date"])
    u = p.merge(m[["ticker", "date", "mcap"]], on=["ticker", "date"], how="inner")
    s = secs.set_index("ticker")
    u["sector"] = u["ticker"].map(s["sector"])
    u["industry"] = u["ticker"].map(s["industry"])
    first = pd.to_datetime(u["ticker"].map(s["first_date"]))
    last = pd.to_datetime(u["ticker"].map(s["last_date"]))
    u["listed"] = (first.isna() | (u["date"] >= first)) & (last.isna() | (u["date"] <= last))
    u["date"] = u["date"].dt.date
    return u[["ticker", "date", "mcap", "sector", "industry", "avg_dollar_vol_20d", "listed"]]


def sync(con: duckdb.DuckDBPyConnection, vendor: Vendor, start: date, end: date,
         tickers: list[str] | None = None) -> dict:
    """Pull securities, bars and market caps for [start, end] and write prices,
    universe_pit and securities. Idempotent: rows are upserted by key.

    The ADV window needs history before ``start``, so bars are pulled from 40
    calendar days earlier; universe rows are only written from ``start``.
    """
    cfg = config.load("sources")["vendor"]
    secs = vendor.securities()
    universe = research_universe(secs)
    eq = sorted(set(tickers) & set(universe["ticker"])) if tickers else None
    lead = start - pd.Timedelta(days=40).to_pytimedelta()
    px = vendor.prices(eq, lead, end)
    if tickers is None:
        px = px[px["ticker"].isin(set(universe["ticker"]))]
    bench = vendor.prices(benchmark_tickers(), lead, end)
    mc = vendor.market_caps(eq, start, end)
    uni = build_universe(px, mc, secs, cfg["universe_snapshot"])
    uni = uni[pd.to_datetime(uni["date"]) >= pd.Timestamp(start)]

    out = {"securities": 0, "prices": 0, "universe_pit": 0}
    sec = secs[SEC_COLS].copy()
    sec["vendor"] = vendor.name
    sec["updated_at"] = now()
    out["securities"] = upsert_df(con, "securities", sec)
    allpx = pd.concat([px, bench], ignore_index=True)
    allpx = allpx[pd.to_datetime(allpx["date"]) >= pd.Timestamp(start)] if len(allpx) else allpx
    out["prices"] = upsert_df(con, "prices", allpx[PX_COLS]) if len(allpx) else 0
    out["universe_pit"] = upsert_df(con, "universe_pit", uni) if len(uni) else 0
    out["delisted_in_universe"] = int(universe["delisted"].astype(bool).sum())
    audit(con, "vendor", f"sync:{vendor.name}", None, {"start": str(start), "end": str(end), **out})
    return out
