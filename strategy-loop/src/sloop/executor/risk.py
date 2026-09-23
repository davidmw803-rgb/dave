"""Hard risk limits (spec §9). Deterministic; limits come only from config/risk.yaml.

``check_entry`` is the single gate every new order passes through. It returns
the allowed quantity (possibly reduced to fit a cap) or a skip reason. Nothing
an agent produces reaches this module except through a frozen strategy config.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from sloop import config


@dataclass(frozen=True)
class Position:
    strategy_id: str
    ticker: str
    sector: str | None
    qty: float
    price: float  # current mark

    @property
    def value(self) -> float:
        return abs(self.qty * self.price)


@dataclass
class PortfolioState:
    equity: float
    positions: list[Position] = field(default_factory=list)
    realized_pnl_today: float = 0.0
    realized_pnl_week: float = 0.0
    weekly_halt: bool = False  # sticky until David resumes
    killed: bool = False
    day_trades_5d: int = 0
    strategy_state: dict[str, str] = field(default_factory=dict)  # strategy_id -> paper|live_small|live


@dataclass(frozen=True)
class Intent:
    strategy_id: str
    ticker: str
    sector: str | None
    entry_price: float
    stop_price: float
    allocation_pct: float = 100.0  # of account, for this strategy
    risk_per_trade_pct: float | None = None  # strategy's own setting, capped by the hard limit


@dataclass(frozen=True)
class Decision:
    ok: bool
    qty: int = 0
    reason: str | None = None


def _limits() -> dict[str, Any]:
    return config.load("risk")


def check_entry(intent: Intent, s: PortfolioState, limits: dict[str, Any] | None = None) -> Decision:
    L = limits or _limits()
    pt, ps, pf, acct = L["per_trade"], L["per_strategy"], L["portfolio"], L["account"]
    eq = s.equity
    if eq <= 0:
        return Decision(False, reason="no_equity")
    if s.killed:
        return Decision(False, reason="kill_switch")
    if s.weekly_halt or s.realized_pnl_week <= -pf["max_weekly_loss_pct"] / 100 * eq:
        return Decision(False, reason="weekly_loss_halt")
    if s.realized_pnl_today <= -pf["max_daily_loss_pct"] / 100 * eq:
        return Decision(False, reason="daily_loss_halt")
    if s.strategy_state.get(intent.strategy_id) not in ("paper", "live_small", "live"):
        return Decision(False, reason="strategy_not_tradeable")
    if not (intent.entry_price > 0 and 0 < intent.stop_price < intent.entry_price):
        return Decision(False, reason="invalid_stop")  # long-only: stop must sit below entry

    if sum(p.strategy_id == intent.strategy_id for p in s.positions) >= ps["max_open_positions"]:
        return Decision(False, reason="strategy_position_cap")
    if len(s.positions) >= pf["max_open_positions"]:
        return Decision(False, reason="portfolio_position_cap")
    if sum(p.ticker == intent.ticker for p in s.positions) >= pf["max_positions_per_ticker"]:
        return Decision(False, reason="ticker_cap")
    if acct.get("pdt_applies") and eq < acct["pdt_min_equity"] and s.day_trades_5d >= acct["pdt_max_day_trades_5d"]:
        # A broker-side stop could fill the same day and make one more day trade.
        return Decision(False, reason="pdt_limit")

    risk_pct = min(pt["max_risk_pct"], intent.risk_per_trade_pct or pt["max_risk_pct"])
    per_share_risk = intent.entry_price - intent.stop_price
    by_risk = risk_pct / 100 * eq / per_share_risk
    by_size = pt["max_position_pct"] / 100 * eq / intent.entry_price
    gross = sum(p.value for p in s.positions)
    by_gross = (pf["max_gross_exposure_pct"] / 100 * eq - gross) / intent.entry_price
    sector_val = sum(p.value for p in s.positions if intent.sector and p.sector == intent.sector)
    by_sector = (pf["max_sector_pct"] / 100 * eq - sector_val) / intent.entry_price if intent.sector else math.inf
    strat_val = sum(p.value for p in s.positions if p.strategy_id == intent.strategy_id)
    by_alloc = (intent.allocation_pct / 100 * eq - strat_val) / intent.entry_price

    caps = {"risk": by_risk, "position_size": by_size, "gross_exposure": by_gross,
            "sector_cap": by_sector, "allocation": by_alloc}
    binding = min(caps, key=caps.get)
    qty = int(math.floor(max(0.0, caps[binding])))
    if qty < 1:
        return Decision(False, reason=binding)
    return Decision(True, qty=qty, reason=None if binding == "risk" else f"reduced_by_{binding}")


def strategy_drawdown_breached(allocation_value: float, peak_value: float, current_value: float,
                               limits: dict[str, Any] | None = None) -> bool:
    """True when a strategy has lost more than the limit (as % of its allocation) from its peak."""
    L = limits or _limits()
    if allocation_value <= 0:
        return False
    return (peak_value - current_value) > L["per_strategy"]["max_drawdown_pct_of_allocation"] / 100 * allocation_value


def weekly_halt_triggered(realized_pnl_week: float, equity: float, limits: dict[str, Any] | None = None) -> bool:
    L = limits or _limits()
    return realized_pnl_week <= -L["portfolio"]["max_weekly_loss_pct"] / 100 * equity
