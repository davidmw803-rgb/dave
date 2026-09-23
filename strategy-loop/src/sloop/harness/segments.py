"""Automatic segment breakdowns (§8.3).

Every reported segment is a trial and increments the trial counter. A strong
segment is only ever a lead: it must come back as a child hypothesis and pass
on its own before promotion.
"""
from __future__ import annotations

import pandas as pd

from sloop.harness import stats

DIMENSIONS = ("sector", "cap_bucket", "regime")
MIN_SEGMENT_N = 20


def breakdown(trades: pd.DataFrame) -> list[dict]:
    out = []
    for dim in DIMENSIONS:
        for val, g in trades.groupby(dim, dropna=True):
            if len(g) < MIN_SEGMENT_N:
                continue
            mean, _, p = stats.clustered_mean_test(g["net_ar"].to_numpy(), g["decision_date"].to_numpy(), g["ticker"].to_numpy())
            out.append({
                "segment_key": f"{dim}={val}", "n_events": len(g), "n_dates": int(g["decision_date"].nunique()),
                "mean_ar": mean, "hit_rate": float((g["net_ar"] > 0).mean()), "p_clustered": p,
                "sharpe": stats.sharpe(g["net_ar"].to_numpy()),
            })
    return out
