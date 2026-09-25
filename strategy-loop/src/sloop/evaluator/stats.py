"""Evaluator statistics (§3.6): live/paper results against what the backtest promised.

Everything here is code; the evaluator agent only interprets these numbers.
Per strategy:
- realized trade returns and sector-ETF-adjusted abnormal returns (same
  benchmark rule as the harness), hit rate, average win/loss;
- realized mean vs the backtest's 80% interval for that many trades;
- entry slippage vs the cost model, fill rate;
- rolling 20-trade hit rate, drawdown on the strategy's allocation;
- results by regime at entry;
- §8.6 paper -> live_small eligibility, and the §3.6 minimum-sample gate.
"""
from __future__ import annotations

import json
import math
from datetime import date, timedelta
from typing import Any

import duckdb
import numpy as np
import pandas as pd

from sloop import clock, config
from sloop.harness.returns import benchmark_for

Z80 = 1.2815515655446004  # two-sided 80% interval


def _json(x: Any) -> dict:
    if isinstance(x, dict):
        return x
    try:
        return json.loads(x) if x else {}
    except (TypeError, ValueError):
        return {}


def _close_on_or_before(con: duckdb.DuckDBPyConnection, ticker: str, d: date) -> float | None:
    r = con.execute("SELECT adj_close FROM prices WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1", [ticker, d]).fetchone()
    return float(r[0]) if r and r[0] is not None else None


def trades(con: duckdb.DuckDBPyConnection, strategy_id: str) -> pd.DataFrame:
    """Closed trades with realized return, benchmark return, abnormal return and regime at entry."""
    df = con.execute("""SELECT position_id, ticker, sector, qty, avg_cost, opened_at, closed_at, exit_price, pnl, exit_reason
                        FROM positions WHERE strategy_id = ? AND closed_at IS NOT NULL ORDER BY closed_at""", [strategy_id]).df()
    if df.empty:
        return df
    rows = []
    for t in df.itertuples(index=False):
        ret = (t.exit_price / t.avg_cost - 1.0) if t.avg_cost else math.nan
        d0 = pd.Timestamp(t.opened_at).tz_convert(clock.ET).date()
        d1 = pd.Timestamp(t.closed_at).tz_convert(clock.ET).date()
        etf = benchmark_for(t.sector)
        # Benchmarked from the last close before the entry day (daily prices only; the
        # harness does the same for open entries, and it is within a day for close entries).
        b0 = _close_on_or_before(con, etf, d0 - timedelta(days=1))
        b1 = _close_on_or_before(con, etf, d1)
        bench = (b1 / b0 - 1.0) if b0 and b1 else math.nan
        reg = con.execute("SELECT regime_label FROM regimes WHERE date < ? ORDER BY date DESC LIMIT 1", [d0]).fetchone()
        rows.append({**t._asdict(), "ret": ret, "bench": bench,
                     "ar": ret - bench if not math.isnan(bench) else ret, "bench_missing": math.isnan(bench),
                     "entry_date": d0, "exit_date": d1, "regime": reg[0] if reg else None})
    return pd.DataFrame(rows)


def drawdown(pnl: pd.Series, allocation: float) -> float:
    """Worst peak-to-trough of cumulative P&L, as a fraction of the allocation."""
    if pnl.empty or allocation <= 0:
        return 0.0
    cum = pnl.cumsum()
    return float((cum.cummax().clip(lower=0) - cum).max() / allocation)


def slippage(con: duckdb.DuckDBPyConnection, strategy_id: str) -> dict[str, Any]:
    """Entry fills vs the reference quote, in bps, against the harness's modelled one-way cost."""
    rows = con.execute("""SELECT o.details_json, f.price FROM orders o JOIN fills f ON f.order_id = o.order_id
                          WHERE o.strategy_id = ? AND o.side = 'buy'""", [strategy_id]).fetchall()
    real, model = [], []
    for d, px in rows:
        d = _json(d)
        if d.get("ref_price") and d.get("model_one_way_bps") is not None:
            real.append((px / d["ref_price"] - 1.0) * 1e4)
            model.append(d["model_one_way_bps"])
    if not real:
        return {"n": 0, "realized_bps": None, "model_bps": None, "ratio": None}
    r, m = float(np.mean(real)), float(np.mean(model))
    return {"n": len(real), "realized_bps": r, "model_bps": m, "ratio": (r / m) if m > 0 else None}


def fill_rate(con: duckdb.DuckDBPyConnection, strategy_id: str) -> float | None:
    r = con.execute("""SELECT count(*) FILTER (WHERE status = 'filled'), count(*) FILTER (WHERE status IN ('filled','expired','cancelled'))
                       FROM orders WHERE strategy_id = ? AND side = 'buy'""", [strategy_id]).fetchone()
    return (r[0] / r[1]) if r and r[1] else None


def trading_days_between(d0: date, d1: date) -> int:
    n, d = 0, d0
    while d <= d1:
        n += clock.is_trading_day(d)
        d = d + timedelta(days=1)
    return n


def strategy_stats(con: duckdb.DuckDBPyConnection, s: dict, as_of: date) -> dict[str, Any]:
    cfg = _json(s["config_json"])
    exp = cfg.get("expected", {})
    tr = trades(con, s["strategy_id"])
    eq = config.load("risk")["executor"]["paper_equity"]
    alloc = (s.get("allocation_pct") or 0) / 100 * eq
    first = con.execute("SELECT CAST(min(opened_at) AS VARCHAR) FROM positions WHERE strategy_id = ?", [s["strategy_id"]]).fetchone()[0]
    days_live = trading_days_between(pd.Timestamp(first).tz_convert(clock.ET).date(), as_of) if first is not None else 0
    out: dict[str, Any] = {"strategy_id": s["strategy_id"], "state": s["state"], "as_of": str(as_of),
                           "n_closed": int(len(tr)), "trading_days": days_live, "expected": exp,
                           "open_positions": int(con.execute("SELECT count(*) FROM positions WHERE strategy_id = ? "
                                                             "AND closed_at IS NULL", [s["strategy_id"]]).fetchone()[0])}
    if tr.empty:
        out.update(slippage=slippage(con, s["strategy_id"]), fill_rate=fill_rate(con, s["strategy_id"]))
        return out | {"gate_open": False, "hard_breach": False, "eligible_live_small": False}
    ar = tr["ar"].astype(float)
    wins, losses = tr.loc[tr["pnl"] > 0, "ret"], tr.loc[tr["pnl"] <= 0, "ret"]
    roll = (tr["pnl"] > 0).astype(float).rolling(20, min_periods=min(20, len(tr))).mean()
    out.update({
        "mean_ret": float(tr["ret"].mean()), "mean_ar": float(ar.mean()), "ar_std": float(ar.std(ddof=1)) if len(ar) > 1 else None,
        "hit_rate": float((tr["pnl"] > 0).mean()), "avg_win": float(wins.mean()) if len(wins) else None,
        "avg_loss": float(losses.mean()) if len(losses) else None, "total_pnl": float(tr["pnl"].sum()),
        "rolling20_hit_rate": float(roll.iloc[-1]) if roll.notna().any() else None,
        "drawdown_of_allocation": drawdown(tr["pnl"], alloc), "bench_missing": int(tr["bench_missing"].sum()),
        "exit_reasons": tr["exit_reason"].value_counts().to_dict(),
        "slippage": slippage(con, s["strategy_id"]), "fill_rate": fill_rate(con, s["strategy_id"]),
    })
    if exp.get("mean_ar") is not None and exp.get("ar_std"):
        half = Z80 * exp["ar_std"] / math.sqrt(len(ar))
        out["expected_interval_80"] = [exp["mean_ar"] - half, exp["mean_ar"] + half]
        out["within_interval"] = bool(out["expected_interval_80"][0] <= out["mean_ar"] <= out["expected_interval_80"][1])
    else:
        out["expected_interval_80"], out["within_interval"] = None, None
    out["by_regime"] = {str(k): {"n": int(len(g)), "mean_ar": float(g["ar"].mean()), "hit_rate": float((g["pnl"] > 0).mean())}
                        for k, g in tr.groupby(tr["regime"].fillna("unknown"))}

    rules, risk = config.load("rules")["paper_to_live_small"], config.load("risk")
    # §3.6: no verdict but keep before 20 closed trades or 30 trading days, unless a hard risk limit broke.
    out["gate_open"] = out["n_closed"] >= rules["min_closed_trades"] or days_live >= rules["min_trading_days"]
    out["hard_breach"] = out["drawdown_of_allocation"] * 100 > risk["per_strategy"]["max_drawdown_pct_of_allocation"]
    slip_ok = out["slippage"]["ratio"] is None or out["slippage"]["ratio"] <= rules["max_slippage_vs_model"]
    out["eligible_live_small"] = bool(s["state"] == "paper" and out["n_closed"] >= rules["min_closed_trades"]
                                      and days_live >= rules["min_trading_days"] and out["within_interval"] is True and slip_ok)
    return out


def all_stats(con: duckdb.DuckDBPyConnection, as_of: date) -> list[dict[str, Any]]:
    strategies = con.execute("SELECT * FROM strategies WHERE state IN ('paper','live_small','live')").df().to_dict("records")
    return [strategy_stats(con, s, as_of) for s in strategies]
