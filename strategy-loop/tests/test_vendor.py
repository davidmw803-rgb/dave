from datetime import date

import numpy as np
import pandas as pd
import pytest

from sloop.harness import regimes
from sloop.harness.market import MarketData
from sloop.ingest.vendors import base
from sloop.ingest.vendors.sharadar import Sharadar

DAYS = pd.bdate_range("2024-01-02", "2024-03-29")

TICKERS = pd.DataFrame([
    # table, permaticker, ticker, name, exchange, isdelisted, category, sector, industry, firstpricedate, lastpricedate, lastupdated
    ["SEP", 1, "ALIVE", "Alive Co", "NASDAQ", "N", "Domestic Common Stock", "Technology", "Software", "2010-01-04", "2024-03-29", "2024-03-29"],
    ["SEP", 2, "GONE", "Gone Inc", "NYSE", "Y", "Domestic Common Stock Primary Class", "Healthcare", "Biotech", "2015-01-02", "2024-02-15", "2024-02-16"],
    ["SEP", 3, "ADRX", "Some ADR", "NYSE", "N", "ADR Common Stock", "Energy", "Oil", "2012-01-03", "2024-03-29", "2024-03-29"],
    ["SFP", 4, "SPY", "SPDR S&P 500", "NYSEARCA", "N", "ETF", None, None, "1993-01-29", "2024-03-29", "2024-03-29"],
    ["SFP", 5, "XLK", "Tech SPDR", "NYSEARCA", "N", "ETF", None, None, "1998-12-22", "2024-03-29", "2024-03-29"],
], columns=["table", "permaticker", "ticker", "name", "exchange", "isdelisted", "category", "sector", "industry",
            "firstpricedate", "lastpricedate", "lastupdated"])


def _sep():
    rows = []
    rng = np.random.default_rng(1)
    for t, last in (("ALIVE", "2024-03-29"), ("GONE", "2024-02-15"), ("ADRX", "2024-03-29"), ("SPY", "2024-03-29"), ("XLK", "2024-03-29")):
        px = 100.0
        for d in DAYS[DAYS <= last]:
            px *= 1 + rng.normal(0, 0.01)
            split = 2.0 if (t == "ALIVE" and d < pd.Timestamp("2024-02-01")) else 1.0   # 2:1 split on Feb 1
            # SEP: history split-adjusted (divided by the ratio); closeunadj as traded.
            rows.append([t, d.strftime("%Y-%m-%d"), px * 0.99, px * 1.01, px * 0.98, px, 1_000_000.0,
                         px * 0.97, px * split])
    return pd.DataFrame(rows, columns=["ticker", "date", "open", "high", "low", "close", "volume", "closeadj", "closeunadj"])


SEP = _sep()
DAILY = SEP[SEP["ticker"].isin(["ALIVE", "GONE", "ADRX"])][["ticker", "date"]].assign(
    marketcap=lambda d: d["ticker"].map({"ALIVE": 1500.0, "GONE": 250.0, "ADRX": 30000.0}))  # USD millions


class FakeNDL:
    """Serves SHARADAR datatables the way the API does: filters, column selection, cursor paging."""

    def __init__(self, page=7):
        self.page, self.calls = page, []

    def __call__(self, url, params):
        self.calls.append((url, dict(params)))
        table = url.rsplit("/", 1)[1].split(".")[0]
        df = {"TICKERS": TICKERS, "DAILY": DAILY}.get(table)
        if table in ("SEP", "SFP"):
            funds = set(TICKERS[TICKERS["table"] == "SFP"]["ticker"])
            df = SEP[SEP["ticker"].isin(funds)] if table == "SFP" else SEP[~SEP["ticker"].isin(funds)]
        if "ticker" in params:
            df = df[df["ticker"].isin(params["ticker"].split(","))]
        if "table" in params:
            df = df[df["table"].isin(params["table"].split(","))]
        if "date.gte" in params:
            df = df[df["date"] >= params["date.gte"]]
        if "date.lte" in params:
            df = df[df["date"] <= params["date.lte"]]
        if "qopts.columns" in params:
            df = df[params["qopts.columns"].split(",")]
        start = int(params.get("qopts.cursor_id") or 0)
        chunk = df.iloc[start:start + self.page]
        nxt = str(start + self.page) if start + self.page < len(df) else None
        return {"datatable": {"data": chunk.values.tolist(), "columns": [{"name": c} for c in df.columns]},
                "meta": {"next_cursor_id": nxt}}


@pytest.fixture
def vendor():
    return Sharadar("test-key", get_json=FakeNDL(page=7), ticker_chunk=2)


def test_paging_and_ticker_chunks(vendor):
    df = vendor.table("SEP", ticker=["ALIVE", "GONE"])
    assert len(df) == len(SEP[SEP["ticker"].isin(["ALIVE", "GONE"])])
    assert all(p.get("api_key") == "test-key" for _, p in vendor.get_json.calls)
    px = vendor.prices(["ALIVE", "GONE", "ADRX"], date(2024, 1, 1), date(2024, 3, 31))
    assert set(px["ticker"]) == {"ALIVE", "GONE", "ADRX"}


def test_as_traded_prices_undo_the_split(vendor):
    px = vendor.prices(["ALIVE"], date(2024, 1, 1), date(2024, 3, 31)).set_index("date")
    src = SEP[SEP["ticker"] == "ALIVE"].set_index(pd.to_datetime(SEP[SEP["ticker"] == "ALIVE"]["date"]).dt.date)
    pre = date(2024, 1, 10)
    assert px.loc[pre, "close"] == pytest.approx(src.loc[pre, "close"] * 2)      # traded at twice the adjusted price
    assert px.loc[pre, "volume"] == pytest.approx(src.loc[pre, "volume"] / 2)
    assert px.loc[pre, "close"] * px.loc[pre, "volume"] == pytest.approx(src.loc[pre, "close"] * src.loc[pre, "volume"])
    assert px.loc[pre, "adj_close"] == pytest.approx(src.loc[pre, "closeadj"])


def test_securities_map_sectors_and_keep_delisted(vendor):
    s = vendor.securities().set_index("ticker")
    assert s.loc["ALIVE", "sector"] == "Information Technology" and s.loc["GONE", "sector"] == "Health Care"
    assert bool(s.loc["GONE", "delisted"]) and not bool(s.loc["ALIVE", "delisted"])
    assert bool(s.loc["SPY", "is_fund"])
    kept = set(base.research_universe(s.reset_index())["ticker"])
    assert kept == {"ALIVE", "GONE"}   # ADR and ETFs are not research equities


def test_marketcap_units(vendor):
    mc = vendor.market_caps(["ALIVE"], date(2024, 1, 1), date(2024, 3, 31))
    assert mc["mcap"].iloc[0] == pytest.approx(1.5e9)   # millions detected and scaled
    v2 = Sharadar("k", get_json=FakeNDL(), marketcap_unit=1.0)
    assert v2.market_caps(["ALIVE"], date(2024, 1, 1), date(2024, 3, 31))["mcap"].iloc[0] == pytest.approx(1500.0)


def test_sync_builds_a_point_in_time_universe(mem, vendor):
    out = base.sync(mem, vendor, date(2024, 2, 1), date(2024, 3, 29))
    assert out["universe_pit"] > 0 and out["delisted_in_universe"] == 1
    u = mem.execute("SELECT * FROM universe_pit ORDER BY ticker, date").df()
    assert set(u["ticker"]) == {"ALIVE", "GONE"}
    assert (pd.to_datetime(u["date"]).dt.dayofweek == 4).mean() > 0.8          # weekly snapshots (Fridays)
    gone = u[u["ticker"] == "GONE"]
    assert pd.to_datetime(gone["date"]).max() <= pd.Timestamp("2024-02-16")   # no rows after delisting
    assert u["avg_dollar_vol_20d"].notna().all() and (u["mcap"] > 1e8).all()
    assert u[u["ticker"] == "ALIVE"]["sector"].iloc[0] == "Information Technology"
    # Benchmarks came along; delisted history stays in prices for survivorship-free backtests.
    tick = set(mem.execute("SELECT DISTINCT ticker FROM prices").df()["ticker"])
    assert {"SPY", "XLK", "GONE"} <= tick and "ADRX" not in tick
    assert mem.execute("SELECT count(*) FROM securities WHERE delisted").fetchone()[0] == 1
    base.sync(mem, vendor, date(2024, 2, 1), date(2024, 3, 29))   # idempotent
    assert len(mem.execute("SELECT * FROM universe_pit").df()) == len(u)
    md = MarketData.load(mem)
    s = md.series["ALIVE"]
    assert s.c[-1] == pytest.approx(s.raw_c[-1] * 0.97)   # adjusted series = raw x (closeadj / closeunadj)


def test_regimes_fall_back_to_realized_vol_without_vix(mem, vendor):
    base.sync(mem, vendor, date(2024, 1, 2), date(2024, 3, 29))
    r = regimes.compute(mem)
    assert r["vix_bucket"].notna().sum() > 20


def test_no_key_is_a_clear_error(monkeypatch):
    monkeypatch.delenv("NASDAQ_DATA_LINK_API_KEY", raising=False)
    with pytest.raises(base.VendorNotConfigured, match="NASDAQ_DATA_LINK_API_KEY"):
        base.get_vendor("sharadar")
