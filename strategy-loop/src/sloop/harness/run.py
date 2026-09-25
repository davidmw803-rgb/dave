"""Harness entry points. The analyzer gets :func:`backtest`; only the
orchestrator's code path calls :func:`run_holdout`.
"""
from __future__ import annotations

import copy
import json
import math
from collections import Counter
from datetime import date
from typing import Any

import duckdb
import numpy as np
import pandas as pd

from sloop import config, ledger
from sloop.harness import events, holdout, nulls, rules, segments, stats
from sloop.harness.market import MarketData
from sloop.harness.returns import simulate
from sloop.schemas import Hypothesis
from sloop.store.duck import audit, bump_trials, new_id, now


class VariantLimit(RuntimeError):
    pass


def apply_variant(hyp: Hypothesis, variant: dict[str, Any] | None) -> Hypothesis:
    """Overlay a variant ({'signal': {'filters': {...}}, 'exit': {...}, ...}) and re-validate."""
    if not variant:
        return hyp
    base = hyp.model_dump()

    def merge(a: dict, b: dict) -> dict:
        for k, v in b.items():
            a[k] = merge(a.get(k, {}) or {}, v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
        return a

    return Hypothesis.model_validate(merge(copy.deepcopy(base), variant))


def _trades(md: MarketData, cands: pd.DataFrame, hyp: Hypothesis) -> tuple[pd.DataFrame, Counter]:
    horizons = tuple(config.load("rules")["backtest"]["horizons"])
    rows, skips = [], Counter()
    for r in cands.itertuples(index=False):
        t = simulate(md, r.ticker, np.datetime64(r.entry_date, "D"), r.entry_at, r.sector, r.adv,
                     hyp.exit, hyp.entry.max_gap_pct, horizons)
        if not t.ok:
            skips[t.skip] += 1
            continue
        row = r._asdict()
        row.update(net_ar=t.net_ar, gross=t.gross, bench=t.bench, exit_date=t.exit_date, exit_reason=t.exit_reason,
                   **{f"ar_{h}d": (t.ar_h or {}).get(h, math.nan) for h in horizons})
        rows.append(row)
    return pd.DataFrame(rows), skips


def _summary(tr: pd.DataFrame) -> dict[str, Any]:
    if tr.empty:
        return {"n_events": 0, "n_dates": 0, "mean_ar": math.nan, "hit_rate": math.nan, "p_clustered": math.nan, "sharpe": math.nan}
    mean, se, p = stats.clustered_mean_test(tr["net_ar"].to_numpy(), tr["decision_date"].to_numpy(), tr["ticker"].to_numpy())
    return {"n_events": len(tr), "n_dates": int(tr["decision_date"].nunique()), "mean_ar": mean, "se": se,
            "hit_rate": float((tr["net_ar"] > 0).mean()), "p_clustered": p, "sharpe": stats.sharpe(tr["net_ar"].to_numpy())}


def _persist(con, hypothesis_id: str, variant: Any, sample: str, segment_key: str | None,
             r: dict[str, Any], details: dict[str, Any]) -> str:
    tid = new_id("tst")
    con.execute(
        "INSERT INTO tests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [tid, hypothesis_id, json.dumps(variant or {}), sample, segment_key, r.get("n_events"), r.get("n_dates"),
         _f(r.get("mean_ar")), _f(r.get("hit_rate")), _f(r.get("p_clustered")), _f(r.get("sharpe")),
         _f(r.get("deflated_sharpe")), _f(r.get("null_percentile")), r.get("half1_pass"), r.get("half2_pass"),
         r.get("passed"), now(), json.dumps(details, default=str)],
    )
    return tid


def _f(x: Any) -> float | None:
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else float(x)


def backtest(con: duckdb.DuckDBPyConnection, hypothesis_id: str, variant: dict[str, Any] | None = None,
             md: MarketData | None = None, n_placebos: int | None = None, as_of: date | None = None) -> dict[str, Any]:
    """In-sample test of one variant. The only harness call the analyzer can make.

    Data after ``holdout_start`` is never loaded.
    """
    rec = ledger.get(con, hypothesis_id)
    hyp = apply_variant(rec["spec"], variant)
    n_prior = con.execute("SELECT count(*) FROM tests WHERE hypothesis_id = ? AND sample = 'in' AND segment_key IS NULL",
                          [hypothesis_id]).fetchone()[0]
    if n_prior >= config.load("rules")["analyzer"]["max_variants_per_hypothesis"]:
        raise VariantLimit(f"{hypothesis_id} already has {n_prior} variants")

    hs = holdout.holdout_start(con, as_of)
    events.parse_filters(hyp.signal.filters)  # refuse look-ahead before touching data
    events.guard_window(hs, hs, "in")
    if md is None:
        md = MarketData.load(con, end=hs)
    elif md.end is None or md.end > hs:
        raise events.HoldoutViolation("market data passed to an in-sample test extends into the holdout")

    cands = events.select(con, md, hyp, None, hs)
    tr, skips = _trades(md, cands, hyp) if not cands.empty else (pd.DataFrame(), Counter())
    n_trials = bump_trials(con, 1)
    r = _summary(tr)

    if r["n_events"] >= 3:
        first = stats.split_halves(tr["decision_date"].to_numpy())
        for name, mask in (("half1", first), ("half2", ~first)):
            h = _summary(tr[mask])
            r[f"{name}_pass"] = rules.half_passes(r["mean_ar"], h["mean_ar"], h["p_clustered"])
            r[f"{name}_mean_ar"], r[f"{name}_p"] = h["mean_ar"], h["p_clustered"]
        past = con.execute("SELECT sharpe FROM tests WHERE sample = 'in' AND segment_key IS NULL AND sharpe IS NOT NULL").df()["sharpe"].to_numpy()
        r["deflated_sharpe"], r["dsr_prob"] = stats.deflated_sharpe(tr["net_ar"].to_numpy(), n_trials, past)
        nc = config.load("rules")["nulls"]
        null_means = nulls.null_distribution(md, tr, hyp.exit, hyp.entry.max_gap_pct,
                                             n_placebos or nc["n_placebos"], nc["seed"])
        r["null_percentile"] = nulls.percentile_of(r["mean_ar"], null_means)
        r["null_mean"] = float(np.nanmean(null_means)) if np.isfinite(null_means).any() else math.nan
    else:
        r.update(half1_pass=False, half2_pass=False, deflated_sharpe=math.nan, null_percentile=math.nan)

    r["passed"], r["failed_checks"] = rules.in_sample(r)
    r["trial_counter"] = n_trials
    r["skips"] = dict(skips)
    r["raw_ar"] = {c: _f(tr[c].mean()) for c in tr.columns if c.startswith("ar_")} if not tr.empty else {}
    # Recorded so an audit can prove no in-sample test touched the holdout.
    r["holdout_start"] = str(hs)
    r["max_exit_date"] = str(tr["exit_date"].max()) if not tr.empty else None
    details = {k: v for k, v in r.items() if k not in ("n_events", "n_dates", "mean_ar", "hit_rate", "p_clustered", "sharpe")}
    r["test_id"] = _persist(con, hypothesis_id, variant, "in", None, r, details)

    segs = segments.breakdown(tr) if not tr.empty else []
    if segs:
        bump_trials(con, len(segs))
        for s in segs:
            _persist(con, hypothesis_id, variant, "in", s["segment_key"], s, {"parent_test_id": r["test_id"]})
    r["segments"] = segs

    if r["passed"] and rec["status"] == "proposed":
        ledger.transition(con, hypothesis_id, "backtested", "harness", reason=r["test_id"])
    audit(con, "harness", "backtest", hypothesis_id, {"test_id": r["test_id"], "passed": r["passed"], "variant": variant})
    return r


def run_holdout(con: duckdb.DuckDBPyConnection, hypothesis_id: str, as_of: date | None = None) -> dict[str, Any]:
    """The single holdout run for this hypothesis's family. Not an analyzer tool."""
    rec = ledger.get(con, hypothesis_id)
    if rec["status"] != "backtested":
        raise ledger.LadderError(f"{hypothesis_id} is {rec['status']}, not backtested")
    holdout.check_unused(con, rec["family_key"])
    best = con.execute(
        """SELECT test_id, variant_json, mean_ar FROM tests WHERE hypothesis_id = ? AND sample = 'in'
           AND segment_key IS NULL AND passed ORDER BY mean_ar DESC LIMIT 1""", [hypothesis_id]).fetchone()
    if not best:
        raise ledger.LadderError(f"{hypothesis_id} has no passing in-sample test")
    variant = json.loads(best[1]) if isinstance(best[1], str) else best[1]
    hyp = apply_variant(rec["spec"], variant)

    hs = holdout.holdout_start(con, as_of)
    md = MarketData.load(con)
    today = as_of or date.today()
    cands = events.select(con, md, hyp, hs, today)
    tr, skips = _trades(md, cands, hyp) if not cands.empty else (pd.DataFrame(), Counter())
    bump_trials(con, 1)
    r = _summary(tr)
    r["passed"], r["failed_checks"] = rules.holdout(r, best[2])
    r["skips"] = dict(skips)
    r["test_id"] = _persist(con, hypothesis_id, variant, "holdout", None, r,
                            {"in_sample_test_id": best[0], "failed_checks": r["failed_checks"], "skips": r["skips"]})
    ledger.transition(con, hypothesis_id, "holdout_passed" if r["passed"] else "failed", "harness", reason=r["test_id"])
    return r
