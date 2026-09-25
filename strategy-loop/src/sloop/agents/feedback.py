"""Feedback rows and lessons (§10).

Every agent prompt carries its last ~20 lessons. Two writers:
- the orchestrator's plan (its judgement on proposals and findings), and
- the harness path, which grades each tested hypothesis from the numbers alone,
  so a proposer always learns the outcome even if the orchestrator says nothing.
"""
from __future__ import annotations

import duckdb
import pandas as pd

from sloop import config
from sloop.store.duck import new_id, now

N_LESSONS = 20


def write(con: duckdb.DuckDBPyConnection, from_agent: str, to_agent: str, hypothesis_id: str | None,
          grade: str, lesson: str) -> str:
    fid = new_id("fb")
    con.execute("INSERT INTO feedback VALUES (?, ?, ?, ?, ?, ?, ?)",
                [fid, from_agent, to_agent, hypothesis_id, grade, lesson[:500], now()])
    return fid


def lessons_for(con: duckdb.DuckDBPyConnection, agent: str, n: int = N_LESSONS) -> list[dict]:
    df = con.execute("SELECT created_at, from_agent, hypothesis_id, grade, lesson FROM feedback "
                     "WHERE to_agent = ? ORDER BY created_at DESC LIMIT ?", [agent, n]).df()
    return df.assign(created_at=df["created_at"].astype(str)).to_dict("records") if len(df) else []


def digest() -> str | None:
    """lessons.md, the weekly-compacted digest, if one exists (capped)."""
    p = config.data_dir() / "lessons.md"
    return p.read_text()[:6000] if p.exists() else None


def scorecard(con: duckdb.DuckDBPyConnection, agent: str) -> dict:
    """Proposal outcomes for one proposer: the numbers §10 weights research by."""
    r = con.execute("""
        SELECT count(*) AS proposed,
               count(*) FILTER (WHERE status IN ('backtested','holdout_passed','paper','live_small','live')) AS passed_insample,
               count(*) FILTER (WHERE status IN ('holdout_passed','paper','live_small','live')) AS passed_holdout,
               count(*) FILTER (WHERE hypothesis_id IN (SELECT hypothesis_id FROM tests)) AS tested
        FROM hypotheses WHERE proposed_by = ?""", [agent]).df().iloc[0].to_dict()
    return {k: int(v) for k, v in r.items()}


def grade_from_tests(con: duckdb.DuckDBPyConnection, hypothesis_id: str, results: list[dict]) -> None:
    """Deterministic feedback to the proposer once the harness has graded a hypothesis."""
    rec = con.execute("SELECT proposed_by FROM hypotheses WHERE hypothesis_id = ?", [hypothesis_id]).fetchone()
    if not rec or not results:
        return
    to = "researcher" if rec[0].startswith("researcher") else rec[0]
    passed = [r for r in results if r.get("passed")]
    if passed:
        best = max(passed, key=lambda r: r["mean_ar"])
        write(con, "harness", to, hypothesis_id, "good",
              f"passed in-sample: n={best['n_events']} mean_ar={best['mean_ar']:+.4f} null_pct={best['null_percentile']:.0f}")
        return
    best = max(results, key=lambda r: (r.get("n_events") or 0, r.get("mean_ar") or -1))
    fails = pd.Series([c for r in results for c in r.get("failed_checks", [])]).value_counts()
    common = ", ".join(f"{k} ({v}/{len(results)})" for k, v in fails.head(4).items())
    write(con, "harness", to, hypothesis_id, "bad",
          f"failed all {len(results)} variants; best n={best.get('n_events')} mean_ar={best.get('mean_ar') or float('nan'):+.4f}; "
          f"most common failures: {common}")
