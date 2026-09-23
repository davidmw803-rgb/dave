"""Cost model applied to every backtest (spec §8.2)."""
from __future__ import annotations

import math

from sloop import config


def one_way_bps(adv: float | None) -> float:
    buckets = config.load("rules")["costs"]["liquidity_buckets"]
    a = adv if adv is not None and math.isfinite(adv) else 0.0
    for b in buckets:
        if a < float(b["max_adv"]):
            return float(b["one_way_bps"])
    return float(buckets[-1]["one_way_bps"])


def round_trip_cost(adv: float | None, entry_price: float) -> float:
    """Round-trip cost as a fraction of entry notional."""
    c = config.load("rules")["costs"]
    spread = 2 * one_way_bps(adv) / 1e4
    sec = c["sec_fee_bps_on_sell"] / 1e4
    per_share = c["fee_per_share"] * 2 / entry_price if entry_price > 0 else 0.0
    return spread + sec + per_share


def capacity_ok(adv: float | None) -> bool:
    """Skip entries where the position would exceed max_pct_of_adv of 20d $ volume."""
    bt = config.load("rules")["backtest"]
    if adv is None or not math.isfinite(adv) or adv <= 0:
        return False
    return bt["notional_per_trade"] <= bt["max_pct_of_adv"] * adv
