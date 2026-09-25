"""Executor (§3.5): deterministic, always on during market hours, paper only.

Each tick:
 1. heartbeat; nothing else on a non-trading day
 2. broker check (down -> entries halted, alert)
 3. quotes for everything open or due; advance the paper broker
 4. sync broker fills and statuses into the executor's records
 5. flatten, if requested
 6. time exits for positions past their holding period
 7. loss halts and strategy drawdown checks
 8. turn new events into signals for tradeable strategies
 9. enter due signals through the risk gate, as bracket orders with
    deterministic client IDs (a retry can never create a second order)

Signals enter when the harness assumed they would (see config/risk.yaml
``executor``), so paper results are comparable to the backtest.
Strategies approved for live_small/live are skipped with an alert: there is
no live broker in this codebase.
"""
from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from datetime import date, datetime, time
from typing import Any

import pandas as pd

from sloop import clock, config
from sloop.executor import orders as order_ctl
from sloop.executor import portfolio, risk
from sloop.executor.broker import Broker, Quote, QuoteSource
from sloop.harness import events as ev_rules
from sloop.harness.costs import one_way_bps
from sloop.schemas import StrategyConfig
from sloop.store import hot
from sloop.watchdog.alerts import alert

log = logging.getLogger("sloop.executor")
TRADEABLE = ('paper', "live_small", "live")
HALT_CONTROLS = ("halt", "weekly_halt", "reconciliation", "broker_down")


def _hash(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


class Executor:
    def __init__(self, con: sqlite3.Connection, broker: Broker, quotes: QuoteSource, clk: clock.Clock | None = None):
        self.con, self.broker, self.quotes = con, broker, quotes
        self.clock = clk or clock.Clock()
        self.cfg = config.load("risk")["executor"]
        self.recovered = False

    # ---- helpers ------------------------------------------------------------------

    def _now(self) -> str:
        return self.clock.now().isoformat()

    def _ref(self, ticker: str) -> dict | None:
        return hot.one(self.con, "SELECT * FROM refdata WHERE ticker = ?", [ticker])

    def _strategies(self) -> list[dict]:
        out = []
        for r in hot.rows(self.con, "SELECT * FROM strategies WHERE state IN ('paper','live_small','live')"):
            r["cfg"] = StrategyConfig.model_validate_json(r["config_json"])
            out.append(r)
        return out

    def _halted(self, today: date) -> str | None:
        if order_ctl.killed():
            return "kill_switch"
        for k in HALT_CONTROLS:
            if hot.get_control(self.con, k) is not None:
                return k
        dh = hot.get_control(self.con, "daily_halt")
        if dh == today.isoformat():
            return "daily_halt"
        return None

    def _fresh(self, qs: dict[str, Quote]) -> dict[str, Quote]:
        now, max_age = self.clock.now(), self.cfg["quote_max_age_seconds"]
        return {t: q for t, q in qs.items() if (now - q.ts).total_seconds() <= max_age}

    # ---- the tick -------------------------------------------------------------------

    def tick(self) -> str:
        now_et = self.clock.et()
        today = now_et.date()
        hot.heartbeat(self.con, "executor", "ok", self._now())
        if not clock.is_trading_day(today):
            return "closed"
        if not self.recovered:
            self.recover()
        if not self.broker.ping():
            hot.set_control(self.con, "broker_down", self._now(), "executor")
            alert(self.con, "broker_down", f"{self.broker.name} unreachable: new entries halted", "error", self.clock.now())
            return "broker_down"
        if hot.get_control(self.con, "broker_down"):
            hot.set_control(self.con, "broker_down", None, "executor")

        self.scan_events(now_et)
        tickers = sorted({r["ticker"] for r in hot.rows(self.con, "SELECT ticker FROM positions WHERE closed_at IS NULL")}
                         | {o.ticker for o in self.broker.open_orders()}
                         | {s["ticker"] for s in self._due(now_et)})
        qs = self._fresh(self.quotes.get(tickers)) if tickers else {}
        self.broker.tick(qs, now_et)
        self.sync()
        if hot.get_control(self.con, "flatten"):
            self.flatten(qs)
            return "flatten"
        self.time_exits(now_et, qs)
        self.loss_checks(today, qs)
        self.enter_due(now_et, qs)
        self.expire_signals(now_et)
        return "ok"

    # ---- signals ----------------------------------------------------------------------

    def _entry_slot(self, decided: pd.Timestamp, timing: str) -> tuple[date, str]:
        """Same rule as the harness (harness/events.entry_point), on the live calendar."""
        local = decided.tz_convert(clock.ET)
        d, t = local.date(), local.time()
        cutoff = time.fromisoformat(config.load("rules")["backtest"]["same_day_close_cutoff"])
        if clock.is_trading_day(d) and t < clock.OPEN:
            return d, "open"
        if clock.is_trading_day(d) and timing == "next_tradable_after_publish" and t < cutoff:
            return d, "close"
        return clock.next_trading_day(d), "open"

    def scan_events(self, now_et: datetime) -> int:
        cursor = int(hot.get_cursor(self.con, "executor_seq", "0"))
        new = hot.rows(self.con, "SELECT * FROM events WHERE seq > ? ORDER BY seq", [cursor])
        if not new:
            return 0
        strategies = self._strategies()
        regime = (hot.one(self.con, "SELECT value FROM market_state WHERE key = 'regime'") or {}).get("value")
        n = 0
        for e in new:
            for s in strategies:
                cfg: StrategyConfig = s["cfg"]
                if cfg.signal.event_type != e["type"]:
                    continue
                ref = self._ref(e["ticker"])
                sid = "sig_" + _hash(s["strategy_id"], e["event_id"])
                base = [sid, s["strategy_id"], e["event_id"], e["ticker"], self._now()]
                if ref is None:
                    self.con.execute("INSERT OR IGNORE INTO signals VALUES (?, ?, ?, ?, ?, NULL, NULL, 'skipped', 'skip', 'no_refdata')", base)
                    continue
                uni = {"mcap": ref["mcap"], "avg_dollar_vol_20d": ref["avg_dollar_vol_20d"], "sector": ref["sector"],
                       "industry": None, "cap_bucket": ref["cap_bucket"]}
                if not ev_rules._passes(ev_rules.parse_filters(cfg.signal.filters), json.loads(e["payload_json"] or "{}"), uni):
                    continue
                if cfg.regime_filter and regime != cfg.regime_filter:
                    self.con.execute("INSERT OR IGNORE INTO signals VALUES (?, ?, ?, ?, ?, NULL, NULL, 'skipped', 'skip', 'regime')", base)
                    continue
                if s["state"] != "paper":
                    self.con.execute("INSERT OR IGNORE INTO signals VALUES (?, ?, ?, ?, ?, NULL, NULL, 'skipped', 'skip', "
                                     "'live_broker_not_configured')", base)
                    alert(self.con, f"live_skip:{s['strategy_id']}", f"{s['strategy_id']} is {s['state']} but no live broker "
                          "exists; signal skipped", "error", self.clock.now())
                    continue
                pub = pd.Timestamp(e["ts_published"])
                decided = ev_rules.decision_time(pub, pd.Timestamp(e["ts_ingested"]), e["source"])
                due, window = self._entry_slot(decided, cfg.entry.get("timing", "next_tradable_after_publish"))
                self.con.execute("INSERT OR IGNORE INTO signals VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)",
                                 base + [due.isoformat(), window])
                n += 1
            hot.set_cursor(self.con, "executor_seq", str(e["seq"]))
        return n

    def _window(self, name: str) -> list[str]:
        return self.cfg["open_entry_window"] if name == "open" else self.cfg["close_entry_window"]

    def _due(self, now_et: datetime) -> list[dict]:
        return [s for s in hot.rows(self.con, "SELECT * FROM signals WHERE status = 'pending' AND due_date = ?",
                                    [now_et.date().isoformat()]) if clock.within(now_et, self._window(s["entry_window"]))]

    def _skip(self, signal_id: str, reason: str) -> None:
        self.con.execute("UPDATE signals SET status = 'skipped', action = 'skip', skipped_reason = ? WHERE signal_id = ?",
                         [reason, signal_id])

    def expire_signals(self, now_et: datetime) -> None:
        today = now_et.date().isoformat()
        for s in hot.rows(self.con, "SELECT * FROM signals WHERE status = 'pending'"):
            late = s["due_date"] < today
            if s["due_date"] == today:
                hi = datetime.combine(now_et.date(), time.fromisoformat(self._window(s["entry_window"])[1]), clock.ET)
                late = now_et >= hi and not clock.within(now_et, self._window(s["entry_window"]))
            if late:
                self._skip(s["signal_id"], "missed_window")

    # ---- entries ------------------------------------------------------------------------

    def enter_due(self, now_et: datetime, qs: dict[str, Quote]) -> None:
        due = self._due(now_et)
        if not due:
            return
        halted = self._halted(now_et.date())
        strategies = {s["strategy_id"]: s for s in self._strategies()}
        for s in due:
            if halted:
                self._skip(s["signal_id"], f"halt:{halted}")
                continue
            st = strategies.get(s["strategy_id"])
            if st is None:
                self._skip(s["signal_id"], "strategy_not_tradeable")
                continue
            q = qs.get(s["ticker"])
            if q is None:
                continue  # try again next tick while the window is open
            self._enter(s, st, q, qs, now_et)

    def _enter(self, s: dict, st: dict, q: Quote, qs: dict[str, Quote], now_et: datetime) -> None:
        cfg: StrategyConfig = st["cfg"]
        ref = self._ref(s["ticker"]) or {}
        prev, atr, adv = ref.get("last_close"), ref.get("atr14"), ref.get("avg_dollar_vol_20d")
        gap_cap = float(cfg.entry.get("max_gap_pct", 15))
        if prev and abs(q.last / prev - 1) * 100 > gap_cap:
            return self._skip(s["signal_id"], "gap")
        if not atr:
            return self._skip(s["signal_id"], "no_atr")
        offset = float(cfg.entry.get("limit_offset_pct", 0.5))
        limit = round(q.ask * (1 + offset / 100), 2)
        # Size on the exact (cent-rounded) prices the broker will get, or rounding can push risk over the cap.
        stop = round(limit - float(cfg.exit.get("stop_atr_mult") or self.cfg["default_stop_atr_mult"]) * atr, 2)
        state = portfolio.build(self.con, qs, now_et.date())
        d = risk.check_entry(risk.Intent(s["strategy_id"], s["ticker"], ref.get("sector"), limit, stop,
                                         st["allocation_pct"] or 100.0, cfg.sizing.get("risk_per_trade_pct")), state)
        if not d.ok:
            return self._skip(s["signal_id"], d.reason or "risk")
        qty = d.qty
        adv_cap = config.load("rules")["backtest"]["max_pct_of_adv"] * (adv or 0)
        if adv_cap and qty * limit > adv_cap:
            qty = int(adv_cap // limit)
        if qty < 1:
            return self._skip(s["signal_id"], "capacity")
        b = order_ctl.build_bracket(s["strategy_id"], s["event_id"], s["ticker"], qty, q.ask, offset, stop,
                                    cfg.exit.get("take_profit_pct"))
        horizon = int(cfg.exit.get("max_hold_days") or cfg.exit.get("horizon_days") or 5)
        max_exit = clock.add_trading_days(now_et.date(), horizon - 1 if s["entry_window"] == "open" else horizon)
        details = {"equity": state.equity, "risk_amount": qty * (b.limit - b.stop), "notional": qty * b.limit,
                   "sector": ref.get("sector"), "max_exit_date": max_exit.isoformat(), "adv": adv,
                   "binding_cap": d.reason, "window": s["entry_window"],
                   # For the evaluator's slippage-vs-model check (§3.6).
                   "ref_price": q.last, "model_one_way_bps": one_way_bps(adv)}
        ts = self._now()
        with hot.tx(self.con):  # record intent before touching the broker: a crash here is recoverable
            self.con.execute("INSERT OR IGNORE INTO orders VALUES (?, ?, ?, ?, NULL, ?, ?, 'buy', ?, 'limit', ?, ?, ?, 'paper', "
                             "'submitting', ?, ?)", ["ord_" + _hash(b.client_order_id), b.client_order_id, s["signal_id"],
                                                    b.client_order_id, s["strategy_id"], s["ticker"], qty, b.limit, b.stop,
                                                    b.take_profit, ts, json.dumps(details)])
            for leg, typ, px in (("stop", "stop", b.stop), ("tp", "take_profit", b.take_profit)):
                if px is None:
                    continue
                cid = f"{b.client_order_id}:{leg}"
                self.con.execute("INSERT OR IGNORE INTO orders VALUES (?, ?, ?, ?, NULL, ?, ?, 'sell', ?, ?, ?, NULL, NULL, "
                                 "'paper', 'pending', ?, NULL)", ["ord_" + _hash(cid), cid, s["signal_id"], b.client_order_id,
                                                                  s["strategy_id"], s["ticker"], qty, typ, px, ts])
        bo = self.broker.submit_bracket(b, adv)
        with hot.tx(self.con):
            self.con.execute("UPDATE orders SET status = 'open', broker_order_id = ? WHERE client_order_id = ? AND status = 'submitting'",
                             [bo.client_order_id, b.client_order_id])
            self.con.execute("UPDATE signals SET status = 'entered', action = 'enter' WHERE signal_id = ?", [s["signal_id"]])
        log.info("entry %s %s x%d limit %.2f stop %.2f", s["strategy_id"], s["ticker"], qty, b.limit, b.stop)

    # ---- broker sync --------------------------------------------------------------------

    def sync(self) -> int:
        cursor = int(hot.get_cursor(self.con, "broker_fill_seq", "0"))
        n = 0
        for f in self.broker.fills_after(cursor):
            o = hot.one(self.con, "SELECT * FROM orders WHERE client_order_id = ?", [f.client_order_id])
            with hot.tx(self.con):
                if o is None:
                    alert(self.con, f"unknown_fill:{f.client_order_id}", f"broker fill for unknown order {f.client_order_id}",
                          "error", self.clock.now())
                    hot.set_control(self.con, "reconciliation", f"unknown fill {f.client_order_id}", "executor")
                else:
                    self.con.execute("INSERT OR IGNORE INTO fills VALUES (?, ?, ?, ?, ?, ?, ?)",
                                     [f.fill_id, o["order_id"], f.client_order_id, f.price, f.qty, f.ts, f.fees])
                    self.con.execute("UPDATE orders SET status = 'filled' WHERE order_id = ?", [o["order_id"]])
                    if f.side == "buy":
                        self._open_position(o, f)
                    else:
                        self._close_position(o, f)
                hot.set_cursor(self.con, "broker_fill_seq", str(f.seq))
            n += 1
        # Mirror non-fill status changes (expiry, cancels, legs going live).
        for o in hot.rows(self.con, "SELECT * FROM orders WHERE status IN ('open','pending')"):
            bo = self.broker.order(o["client_order_id"])
            if bo and bo.status != o["status"] and bo.status in ("open", 'pending', "cancelled", "expired"):
                self.con.execute("UPDATE orders SET status = ? WHERE order_id = ?", [bo.status, o["order_id"]])
        return n

    def _open_position(self, o: dict, f) -> None:
        d = json.loads(o["details_json"] or "{}")
        self.con.execute("INSERT OR IGNORE INTO positions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)",
                         [o["client_order_id"], o["strategy_id"], o["ticker"], d.get("sector"), f.qty, f.price, o["stop"],
                          o["take_profit"], f.ts, d.get("max_exit_date")])

    def _close_position(self, o: dict, f) -> None:
        pos = hot.one(self.con, "SELECT * FROM positions WHERE position_id = ?", [o["position_id"]])
        if pos is None:
            return
        reason = {"stop": "stop", "take_profit": "take_profit"}.get(o["type"]) or o["client_order_id"].rsplit(":", 1)[-1]
        pnl = (f.price - pos["avg_cost"]) * f.qty - (f.fees or 0)
        self.con.execute("UPDATE positions SET closed_at = ?, exit_price = ?, pnl = ?, exit_reason = ? WHERE position_id = ?",
                         [f.ts, f.price, pnl, reason, pos["position_id"]])
        self.con.execute("UPDATE orders SET status = 'cancelled' WHERE position_id = ? AND side = 'sell' "
                         "AND status IN ('open','pending') AND order_id <> ?", [pos["position_id"], o["order_id"]])

    # ---- exits, halts -----------------------------------------------------------------

    def _close(self, pos: dict, reason: str) -> None:
        cid = f"{pos['position_id']}:{reason}"
        if hot.one(self.con, "SELECT 1 AS x FROM orders WHERE client_order_id = ?", [cid]):
            return
        ref = self._ref(pos["ticker"]) or {}
        with hot.tx(self.con):
            self.con.execute("INSERT INTO orders VALUES (?, ?, NULL, ?, NULL, ?, ?, 'sell', ?, 'market', NULL, NULL, NULL, "
                             "'paper', 'submitting', ?, NULL)", ["ord_" + _hash(cid), cid, pos["position_id"],
                                                                  pos["strategy_id"], pos["ticker"], pos["qty"], self._now()])
        self.broker.close(cid, pos["ticker"], pos["qty"], ref.get("avg_dollar_vol_20d"), parent=pos["position_id"])
        self.con.execute("UPDATE orders SET status = 'open' WHERE client_order_id = ?", [cid])
        self.con.execute("UPDATE orders SET status = 'cancelled' WHERE position_id = ? AND type IN ('stop','take_profit') "
                         "AND status IN ('open','pending')", [pos["position_id"]])

    def time_exits(self, now_et: datetime, qs: dict[str, Quote]) -> None:
        if not clock.within(now_et, [self.cfg["time_exit_at"], "16:00"]):
            return
        for p in hot.rows(self.con, "SELECT * FROM positions WHERE closed_at IS NULL AND max_exit_date <= ?",
                          [now_et.date().isoformat()]):
            self._close(p, "time")

    def flatten(self, qs: dict[str, Quote]) -> None:
        """Close everything. Entries stay halted afterwards until `loop resume`."""
        if hot.get_control(self.con, "halt") is None:
            hot.set_control(self.con, "halt", "flatten", "executor")
        for o in hot.rows(self.con, "SELECT * FROM orders WHERE side = 'buy' AND status IN ('submitting','open')"):
            self.broker.cancel(o["client_order_id"])
            self.con.execute("UPDATE orders SET status = 'cancelled' WHERE position_id = ? AND status IN "
                             "('submitting','open','pending')", [o["position_id"]])
        for p in hot.rows(self.con, "SELECT * FROM positions WHERE closed_at IS NULL"):
            self._close(p, "flatten")
        still = hot.one(self.con, "SELECT count(*) AS n FROM positions WHERE closed_at IS NULL")["n"]
        if still == 0:
            hot.set_control(self.con, "flatten", None, "executor")
            alert(self.con, "flattened", "all positions closed", "info", self.clock.now())

    def loss_checks(self, today: date, qs: dict[str, Quote]) -> None:
        L = config.load("risk")
        state = portfolio.build(self.con, qs, today)
        if state.realized_pnl_today <= -L["portfolio"]["max_daily_loss_pct"] / 100 * state.equity:
            if hot.get_control(self.con, "daily_halt") != today.isoformat():
                hot.set_control(self.con, "daily_halt", today.isoformat(), "executor")
                alert(self.con, "daily_halt", f"realized loss {state.realized_pnl_today:.0f} today: entries halted for the day",
                      "error", self.clock.now())
        if risk.weekly_halt_triggered(state.realized_pnl_week, state.equity) and not hot.get_control(self.con, "weekly_halt"):
            hot.set_control(self.con, "weekly_halt", today.isoformat(), "executor")
            alert(self.con, "weekly_halt", f"realized loss {state.realized_pnl_week:.0f} this week: entries halted until "
                  "`loop resume`", "error", self.clock.now())
        for s in self._strategies():
            alloc = (s["allocation_pct"] or 0) / 100 * state.equity
            pos = hot.rows(self.con, "SELECT * FROM positions WHERE strategy_id = ?", [s["strategy_id"]])
            value = alloc + sum((p["pnl"] or 0) if p["closed_at"] else
                                ((qs[p["ticker"]].last if p["ticker"] in qs else p["avg_cost"]) - p["avg_cost"]) * p["qty"]
                                for p in pos)
            key = f"peak:{s['strategy_id']}"
            peak = max(float(hot.get_cursor(self.con, key, str(value))), value)
            hot.set_cursor(self.con, key, str(peak))
            if risk.strategy_drawdown_breached(alloc, peak, value):
                if s["state"] in ("live_small", "live"):
                    self.con.execute("INSERT INTO strategy_overrides VALUES (?, 'paper', 'drawdown', ?, 0)", [s["strategy_id"], self._now()])
                    self.con.execute("UPDATE strategies SET state = 'paper' WHERE strategy_id = ?", [s["strategy_id"]])
                alert(self.con, f"drawdown:{s['strategy_id']}", f"{s['strategy_id']} drawdown beyond limit "
                      f"({peak - value:.0f} on allocation {alloc:.0f})", "error", self.clock.now())

    # ---- restart recovery -------------------------------------------------------------

    def recover(self) -> dict[str, Any]:
        """After a crash: adopt what the broker has, drop what it never got, then sync."""
        out = {"adopted": 0, "dropped": 0}
        for o in hot.rows(self.con, "SELECT * FROM orders WHERE status = 'submitting'"):
            bo = self.broker.order(o["client_order_id"])
            if bo:
                self.con.execute("UPDATE orders SET status = ?, broker_order_id = ? WHERE order_id = ?",
                                 [bo.status, bo.client_order_id, o["order_id"]])
                if o["side"] == "buy":
                    self.con.execute("UPDATE signals SET status = 'entered', action = 'enter' WHERE signal_id = ?", [o["signal_id"]])
                out["adopted"] += 1
            else:
                self.con.execute("UPDATE orders SET status = 'failed' WHERE position_id = ? AND status IN ('submitting','pending')",
                                 [o["position_id"]])
                if o["side"] == "buy":
                    self._skip(o["signal_id"], "restart_before_submit")
                out["dropped"] += 1
        self.sync()
        known = {r["client_order_id"] for r in hot.rows(self.con, "SELECT client_order_id FROM orders")}
        stray = [o.client_order_id for o in self.broker.open_orders() if o.client_order_id not in known]
        if stray:
            hot.set_control(self.con, "reconciliation", f"{len(stray)} broker orders unknown to executor", "executor")
            alert(self.con, "reconciliation", f"broker has orders the executor doesn't: {stray[:5]}", "error", self.clock.now())
        self.recovered = True
        return out
