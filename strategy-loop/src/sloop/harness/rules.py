"""Pass/fail against config/rules.yaml (§8.6). Agents never decide this."""
from __future__ import annotations

import math
from typing import Any

from sloop import config


def _ok(x: float, pred) -> bool:
    return x is not None and not (isinstance(x, float) and math.isnan(x)) and pred(x)


def in_sample(r: dict[str, Any]) -> tuple[bool, list[str]]:
    c = config.load("rules")["in_sample"]
    checks = {
        "n_events": _ok(r["n_events"], lambda v: v > c["min_events"]),
        "n_dates": _ok(r["n_dates"], lambda v: v > c["min_dates"]),
        "mean_ar": _ok(r["mean_ar"], lambda v: v > c["min_mean_ar"]),
        "hit_rate": _ok(r["hit_rate"], lambda v: v > c["min_hit_rate"]),
        "p_clustered": _ok(r["p_clustered"], lambda v: v < c["max_p"]),
        "half1": bool(r["half1_pass"]),
        "half2": bool(r["half2_pass"]),
        "deflated_sharpe": _ok(r["deflated_sharpe"], lambda v: v > c["min_deflated_sharpe"]),
        "null_percentile": _ok(r["null_percentile"], lambda v: v > c["min_null_percentile"]),
    }
    return all(checks.values()), [k for k, v in checks.items() if not v]


def half_passes(mean_full: float, mean_half: float, p_half: float) -> bool:
    c = config.load("rules")["in_sample"]
    return (_ok(mean_half, lambda v: math.copysign(1, v) == math.copysign(1, mean_full))
            and _ok(p_half, lambda v: v < c["half_max_p"]))


def holdout(r: dict[str, Any], insample_mean: float) -> tuple[bool, list[str]]:
    c = config.load("rules")["holdout_pass"]
    checks = {
        "n_events": _ok(r["n_events"], lambda v: v > c["min_events"]),
        "same_sign": _ok(r["mean_ar"], lambda v: math.copysign(1, v) == math.copysign(1, insample_mean)),
        "mean_ar": _ok(r["mean_ar"], lambda v: v > c["min_mean_ar"]),
        "p_clustered": _ok(r["p_clustered"], lambda v: v < c["max_p"]),
    }
    return all(checks.values()), [k for k, v in checks.items() if not v]
