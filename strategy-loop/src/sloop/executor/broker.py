"""Broker interface and quotes.

The executor talks to a broker only through :class:`Broker`. The only
implementation in this codebase is :class:`sloop.executor.paper_sim.PaperSim`;
there is no live broker, so nothing here can place a real order.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

from sloop.executor.orders import Bracket


@dataclass(frozen=True)
class Quote:
    ticker: str
    last: float
    bid: float
    ask: float
    ts: datetime


@dataclass(frozen=True)
class BrokerOrder:
    client_order_id: str
    parent_id: str | None
    ticker: str
    side: str
    qty: float
    type: str  # limit | stop | take_profit | market
    price: float | None
    status: str  # open | pending (bracket leg awaiting parent fill) | filled | cancelled | expired


@dataclass(frozen=True)
class BrokerFill:
    fill_id: str
    client_order_id: str
    ticker: str
    side: str
    qty: float
    price: float
    fees: float
    ts: str
    seq: int


class Broker(Protocol):
    name: str

    def ping(self) -> bool: ...

    def submit_bracket(self, b: Bracket, adv: float | None) -> BrokerOrder:
        """Idempotent on ``b.client_order_id``: a repeat returns the existing order."""

    def close(self, client_order_id: str, ticker: str, qty: float, adv: float | None,
              parent: str | None = None) -> BrokerOrder:
        """Market sell; cancels the open bracket legs of ``parent`` (the entry order) first."""

    def cancel(self, client_order_id: str) -> None: ...

    def order(self, client_order_id: str) -> BrokerOrder | None: ...

    def open_orders(self) -> list[BrokerOrder]: ...

    def positions(self) -> dict[str, float]:
        """Shares held per ticker (a broker knows nothing about strategies)."""

    def fills_after(self, seq: int) -> list[BrokerFill]: ...

    def tick(self, quotes: dict[str, Quote], now_et: datetime) -> None:
        """Advance simulated fills (paper only; a real broker does this itself)."""


class QuoteSource(Protocol):
    def get(self, tickers: list[str]) -> dict[str, Quote]: ...


class UWQuotes:
    """Last trade from Unusual Whales' /api/stock/{ticker}/quote.

    UW returns the last trade, not the NBBO, so bid/ask are modelled around it
    with the harness's one-way cost for the ticker's liquidity bucket. Paper
    fills then pay the same spread the backtest charged.
    """

    def __init__(self, adv_lookup) -> None:
        self.adv_lookup = adv_lookup

    def get(self, tickers: list[str]) -> dict[str, Quote]:
        from sloop.harness.costs import one_way_bps
        from sloop.ingest import http
        from sloop.ingest.uw import _base, _headers

        out = {}
        for t in tickers:
            try:
                body = http.get_json(f"{_base()}/api/stock/{t}/quote", headers=_headers(), retries=1, timeout=10)
            except RuntimeError:
                continue
            lt = (body.get("data") or {}).get("last_trade") or {}
            try:
                px, ms = float(lt["price"]), float(lt["time"])
            except (KeyError, TypeError, ValueError):
                continue
            half = one_way_bps(self.adv_lookup(t)) / 1e4
            out[t] = Quote(t, px, px * (1 - half), px * (1 + half), datetime.fromtimestamp(ms / 1000, timezone.utc))
        return out


class StaticQuotes:
    """Quotes set by hand or by a replay (tests, simulations)."""

    def __init__(self) -> None:
        self.q: dict[str, Quote] = {}

    def set(self, ticker: str, last: float, ts: datetime, half_spread: float = 0.001) -> None:
        self.q[ticker] = Quote(ticker, last, last * (1 - half_spread), last * (1 + half_spread), ts)

    def get(self, tickers: list[str]) -> dict[str, Quote]:
        return {t: self.q[t] for t in tickers if t in self.q}


def quote_source(adv_lookup) -> QuoteSource:
    if os.environ.get("UW_API_KEY"):
        return UWQuotes(adv_lookup)
    raise RuntimeError("no quote source: set UW_API_KEY")
