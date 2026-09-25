"""Paper broker (§3.5): fills simulated orders against live quotes.

State lives in the hot store's ``sim_*`` tables, separate from the executor's
own records, so reconciliation compares two independent books and a restarted
executor finds its orders where it left them.

Fill model
- Entry: DAY limit buy; fills when ask <= limit, at the ask plus slippage.
  Unfilled entries expire at the close.
- Bracket legs (stop, take-profit) activate when the entry fills; one filling
  cancels the other (OCO).
- Stop: fills when bid <= stop, at min(bid, stop) less slippage (gaps fill worse).
- Take-profit: fills when bid >= target, at the target.
- Market sell: fills at the bid less slippage on the next tick in session.
- Slippage per side is the harness's one-way cost for the ticker's liquidity
  bucket, the same number the backtest charged.

Note: legs only trigger while something calls :meth:`tick` (the executor
does, every loop). A real broker holds brackets server-side even when this
machine is down; this simulator cannot.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from sloop import clock
from sloop.executor.broker import BrokerFill, BrokerOrder, Quote
from sloop.executor.orders import Bracket
from sloop.harness.costs import one_way_bps
from sloop.store import hot


class PaperSim:
    name = "paper_sim"

    def __init__(self, con: sqlite3.Connection, clk: clock.Clock | None = None) -> None:
        self.con = con
        self.clock = clk or clock.Clock()

    def now(self) -> str:
        return self.clock.now().astimezone(timezone.utc).isoformat()

    # ---- queries ------------------------------------------------------------------

    def ping(self) -> bool:
        return True

    def _row(self, r: dict) -> BrokerOrder:
        return BrokerOrder(r["client_order_id"], r["parent_id"], r["ticker"], r["side"], r["qty"], r["type"],
                           r["price"], r["status"])

    def order(self, client_order_id: str) -> BrokerOrder | None:
        r = hot.one(self.con, "SELECT * FROM sim_orders WHERE client_order_id = ?", [client_order_id])
        return self._row(r) if r else None

    def open_orders(self) -> list[BrokerOrder]:
        return [self._row(r) for r in hot.rows(self.con, "SELECT * FROM sim_orders WHERE status IN ('open','pending')")]

    def positions(self) -> dict[str, float]:
        return {r["ticker"]: r["qty"] for r in hot.rows(self.con, "SELECT * FROM sim_positions WHERE qty <> 0")}

    def fills_after(self, seq: int) -> list[BrokerFill]:
        return [BrokerFill(**r) for r in hot.rows(self.con, "SELECT * FROM sim_fills WHERE seq > ? ORDER BY seq", [seq])]

    # ---- commands -----------------------------------------------------------------

    def _insert(self, cid: str, parent: str | None, ticker: str, side: str, qty: float, typ: str,
                price: float | None, adv: float | None, status: str) -> None:
        t = self.now()
        self.con.execute("INSERT OR IGNORE INTO sim_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                         [cid, parent, ticker, side, qty, typ, price, adv, status, t, t])

    def submit_bracket(self, b: Bracket, adv: float | None) -> BrokerOrder:
        existing = self.order(b.client_order_id)
        if existing:
            return existing
        with hot.tx(self.con):
            self._insert(b.client_order_id, None, b.ticker, "buy", b.qty, "limit", b.limit, adv, "open")
            self._insert(b.client_order_id + ":stop", b.client_order_id, b.ticker, "sell", b.qty, "stop", b.stop, adv, "pending")
            if b.take_profit:
                self._insert(b.client_order_id + ":tp", b.client_order_id, b.ticker, "sell", b.qty, "take_profit",
                             b.take_profit, adv, "pending")
        return self.order(b.client_order_id)

    def cancel(self, client_order_id: str) -> None:
        self.con.execute("UPDATE sim_orders SET status = 'cancelled', updated_at = ? WHERE status IN ('open','pending') "
                         "AND (client_order_id = ? OR parent_id = ?)", [self.now(), client_order_id, client_order_id])

    def close(self, client_order_id: str, ticker: str, qty: float, adv: float | None, parent: str | None = None) -> BrokerOrder:
        existing = self.order(client_order_id)
        if existing:
            return existing
        with hot.tx(self.con):
            if parent:
                self.con.execute("UPDATE sim_orders SET status = 'cancelled', updated_at = ? WHERE parent_id = ? "
                                 "AND status IN ('open','pending')", [self.now(), parent])
            self._insert(client_order_id, parent, ticker, "sell", qty, "market", None, adv, "open")
        return self.order(client_order_id)

    # ---- simulation ---------------------------------------------------------------

    def _fill(self, o: dict, price: float, ts: str) -> None:
        seq = (hot.one(self.con, "SELECT coalesce(max(seq),0) AS m FROM sim_fills") or {"m": 0})["m"] + 1
        signed = o["qty"] if o["side"] == "buy" else -o["qty"]
        with hot.tx(self.con):
            self.con.execute("INSERT INTO sim_fills VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                             [f"sf_{seq:08d}", o["client_order_id"], o["ticker"], o["side"], o["qty"], round(price, 4), 0.0, ts, seq])
            self.con.execute("UPDATE sim_orders SET status = 'filled', updated_at = ? WHERE client_order_id = ?", [ts, o["client_order_id"]])
            self.con.execute("INSERT INTO sim_positions VALUES (?, ?) ON CONFLICT(ticker) DO UPDATE SET qty = qty + excluded.qty",
                             [o["ticker"], signed])
            if o["side"] == "buy":  # activate the bracket legs
                self.con.execute("UPDATE sim_orders SET status = 'open', updated_at = ? WHERE parent_id = ? AND status = 'pending'",
                                 [ts, o["client_order_id"]])
            elif o["parent_id"]:    # OCO: the sibling leg is cancelled
                self.con.execute("UPDATE sim_orders SET status = 'cancelled', updated_at = ? WHERE parent_id = ? "
                                 "AND client_order_id <> ? AND status IN ('open','pending')", [ts, o["parent_id"], o["client_order_id"]])

    def tick(self, quotes: dict[str, Quote], now_et: datetime) -> None:
        ts = now_et.astimezone(timezone.utc).isoformat()
        session = clock.is_open(now_et)
        for o in hot.rows(self.con, "SELECT * FROM sim_orders WHERE status = 'open' ORDER BY created_at"):
            q = quotes.get(o["ticker"])
            if not session or q is None:
                continue
            slip = one_way_bps(o["adv"]) / 1e4
            if o["type"] == "limit" and q.ask <= o["price"]:
                self._fill(o, q.ask * (1 + slip), ts)
            elif o["type"] == "stop" and q.bid <= o["price"]:
                self._fill(o, min(q.bid, o["price"]) * (1 - slip), ts)
            elif o["type"] == "take_profit" and q.bid >= o["price"]:
                self._fill(o, o["price"], ts)
            elif o["type"] == "market":
                self._fill(o, q.bid * (1 - slip), ts)
        close = clock.session_close(now_et.date())
        if clock.is_trading_day(now_et.date()) and now_et.time() >= close:
            self.con.execute("UPDATE sim_orders SET status = 'expired', updated_at = ? WHERE type = 'limit' AND side = 'buy' "
                             "AND status = 'open' AND created_at < ?", [ts, ts])
            self.con.execute("UPDATE sim_orders SET status = 'cancelled', updated_at = ? WHERE status = 'pending' AND parent_id IN "
                             "(SELECT client_order_id FROM sim_orders WHERE status = 'expired')", [ts])
