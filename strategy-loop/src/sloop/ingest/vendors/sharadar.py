"""Sharadar (Nasdaq Data Link) adapter: TICKERS, SEP, SFP, DAILY.

- TICKERS covers every security Sharadar has priced, delisted included
  (``isdelisted``), with first/last price dates. Its sector is the latest
  classification, not a history: the one part of the universe that is not
  strictly point-in-time. Sector changes are rare; the alternative (SIC codes
  by filing date) is a later refinement.
- SEP (stocks) / SFP (funds): ``open/high/low/close/volume`` are adjusted for
  splits and stock dividends, ``closeunadj`` is as traded, ``closeadj`` also
  adjusts for cash dividends and spinoffs. As-traded OHLCV is rebuilt with the
  split factor ``closeunadj / close``.
- DAILY: ``marketcap`` per ticker per day, as reported on that date.

API: ``GET {base_url}/{TABLE}.json?api_key=..&ticker=A,B&date.gte=..&date.lte=..``,
paged with ``qopts.cursor_id`` / ``meta.next_cursor_id``.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Callable

import numpy as np
import pandas as pd

from sloop.ingest import http

# Sharadar sectors (Morningstar-style) -> GICS level 1, which config/ and the
# sector-ETF benchmarks use.
SECTOR_TO_GICS = {
    "Technology": "Information Technology",
    "Healthcare": "Health Care",
    "Financial Services": "Financials",
    "Consumer Cyclical": "Consumer Discretionary",
    "Consumer Defensive": "Consumer Staples",
    "Basic Materials": "Materials",
    "Communication Services": "Communication Services",
    "Energy": "Energy",
    "Industrials": "Industrials",
    "Real Estate": "Real Estate",
    "Utilities": "Utilities",
}


def _yes(v: Any) -> bool:
    return v is True or str(v).strip().upper() in ("Y", "YES", "TRUE", "1")


class Sharadar:
    name = "sharadar"

    def __init__(self, api_key: str, base_url: str = "https://data.nasdaq.com/api/v3/datatables/SHARADAR",
                 page_rows: int = 10000, ticker_chunk: int = 100, marketcap_unit: str | float = "auto",
                 get_json: Callable[..., Any] | None = None):
        self.key, self.base = api_key, base_url.rstrip("/")
        self.page_rows, self.chunk, self.mc_unit = page_rows, ticker_chunk, marketcap_unit
        self.get_json = get_json or (lambda url, params: http.get_json(url, params=params, min_interval=0.25, timeout=60))

    # ---- transport ------------------------------------------------------------------

    def table(self, name: str, **filters: Any) -> pd.DataFrame:
        """All rows of a datatable matching ``filters``, following the cursor."""
        params: dict[str, Any] = {"api_key": self.key, "qopts.per_page": self.page_rows}
        for k, v in filters.items():
            if v is None:
                continue
            params[k.replace("__", ".")] = ",".join(v) if isinstance(v, (list, tuple)) else v
        frames, cursor = [], None
        while True:
            if cursor:
                params["qopts.cursor_id"] = cursor
            body = self.get_json(f"{self.base}/{name}.json", params)
            dt = body.get("datatable") or {}
            cols = [c["name"] for c in dt.get("columns", [])]
            frames.append(pd.DataFrame(dt.get("data") or [], columns=cols))
            cursor = (body.get("meta") or {}).get("next_cursor_id")
            if not cursor:
                break
        return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

    def _chunked(self, name: str, tickers: list[str] | None, **filters: Any) -> pd.DataFrame:
        if tickers is None:
            return self.table(name, **filters)
        parts = [self.table(name, ticker=tickers[i:i + self.chunk], **filters) for i in range(0, len(tickers), self.chunk)]
        parts = [p for p in parts if len(p)]
        return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()

    # ---- interface --------------------------------------------------------------------

    def securities(self) -> pd.DataFrame:
        t = self.table("TICKERS", table=["SEP", "SFP"])
        if t.empty:
            return pd.DataFrame(columns=["ticker", "name", "category", "exchange", "sector", "industry", "is_fund",
                                         "delisted", "first_date", "last_date", "vendor_id"])
        t = t.sort_values("lastupdated").drop_duplicates("ticker", keep="last") if "lastupdated" in t else t
        return pd.DataFrame({
            "ticker": t["ticker"].str.upper(),
            "name": t.get("name"),
            "category": t.get("category"),
            "exchange": t.get("exchange"),
            "sector": t.get("sector").map(lambda s: SECTOR_TO_GICS.get(s, s)) if "sector" in t else None,
            "industry": t.get("industry"),
            "is_fund": (t["table"] == "SFP") if "table" in t else False,
            "delisted": t["isdelisted"].map(_yes) if "isdelisted" in t else False,
            "first_date": pd.to_datetime(t.get("firstpricedate"), errors="coerce").dt.date,
            "last_date": pd.to_datetime(t.get("lastpricedate"), errors="coerce").dt.date,
            "vendor_id": t.get("permaticker").astype(str) if "permaticker" in t else None,
        })

    def prices(self, tickers: list[str] | None, start: date, end: date) -> pd.DataFrame:
        cols = "ticker,date,open,high,low,close,volume,closeadj,closeunadj"
        frames = []
        for tbl in ("SEP", "SFP"):
            f = self._chunked(tbl, tickers, **{"date__gte": str(start), "date__lte": str(end), "qopts__columns": cols})
            if len(f):
                frames.append(f)
        if not frames:
            return pd.DataFrame(columns=["ticker", "date", "open", "high", "low", "close", "volume", "adj_close"])
        return self.as_traded(pd.concat(frames, ignore_index=True))

    @staticmethod
    def as_traded(df: pd.DataFrame) -> pd.DataFrame:
        """Split-adjusted SEP/SFP rows -> as-traded OHLCV plus total-return adj_close."""
        close = df["close"].astype(float)
        raw = df["closeunadj"].astype(float)
        f = np.where(close > 0, raw / close.where(close > 0, 1.0), 1.0)
        return pd.DataFrame({
            "ticker": df["ticker"].str.upper(),
            "date": pd.to_datetime(df["date"]).dt.date,
            "open": df["open"].astype(float) * f,
            "high": df["high"].astype(float) * f,
            "low": df["low"].astype(float) * f,
            "close": raw,
            "volume": df["volume"].astype(float) / np.where(f > 0, f, 1.0),
            "adj_close": df["closeadj"].astype(float),
        })

    def market_caps(self, tickers: list[str] | None, start: date, end: date) -> pd.DataFrame:
        d = self._chunked("DAILY", tickers, **{"date__gte": str(start), "date__lte": str(end),
                                               "qopts__columns": "ticker,date,marketcap"})
        if d.empty:
            return pd.DataFrame(columns=["ticker", "date", "mcap"])
        mc = d["marketcap"].astype(float)
        return pd.DataFrame({"ticker": d["ticker"].str.upper(), "date": pd.to_datetime(d["date"]).dt.date,
                             "mcap": mc * self.marketcap_scale(mc)}).dropna(subset=["mcap"])

    def marketcap_scale(self, mc: pd.Series) -> float:
        """DAILY.marketcap is documented in USD millions; verify from the data unless configured.

        A US common-stock universe has a median market cap far above $1M, so a
        median below 1e5 can only mean the column is in millions.
        """
        if self.mc_unit not in ("auto", None):
            return float(self.mc_unit)
        med = float(mc.dropna().median()) if mc.notna().any() else 0.0
        return 1e6 if 0 < med < 1e5 else 1.0

    def ping(self) -> dict:
        """One tiny request, for `loop vendor check`."""
        t = self.table("TICKERS", ticker="AAPL", table="SEP")
        return {"ok": not t.empty, "columns": list(t.columns)[:12], "rows": len(t)}
