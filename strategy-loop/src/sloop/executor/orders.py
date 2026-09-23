"""Order construction and controls shared by the paper and live paths (§3.5, §9)."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from sloop import config


def client_order_id(strategy_id: str, event_id: str, leg: str) -> str:
    """Deterministic, so a retried submit can never create a second order.

    Brokers cap client IDs in length, so the readable parts are hashed.
    """
    digest = hashlib.sha256(f"{strategy_id}|{event_id}|{leg}".encode()).hexdigest()[:20]
    return f"sl-{leg[:4]}-{digest}"


@dataclass(frozen=True)
class Bracket:
    """Entry plus broker-side stop and take-profit, so positions stay protected if we go down."""

    client_order_id: str
    ticker: str
    qty: int
    limit: float
    stop: float
    take_profit: float | None


def build_bracket(strategy_id: str, event_id: str, ticker: str, qty: int, ref_price: float,
                  limit_offset_pct: float, stop: float, take_profit_pct: float | None) -> Bracket:
    limit = round(ref_price * (1 + limit_offset_pct / 100), 2)
    tp = round(ref_price * (1 + take_profit_pct / 100), 2) if take_profit_pct else None
    return Bracket(client_order_id(strategy_id, event_id, "entry"), ticker, qty, limit, round(stop, 2), tp)


def kill_file() -> Path:
    return config.ROOT / "KILL"


def killed() -> bool:
    """`touch KILL` in the project root stops new orders immediately."""
    return kill_file().exists()
