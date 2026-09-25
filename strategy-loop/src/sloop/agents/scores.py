"""Agent scorecards (§10), rebuilt nightly.

Per proposer and source: how many proposals passed in-sample, the holdout,
and were profitable once traded (paper or live). Research effort is then
weighted by score with a 20% exploration floor, so a source that has not
paid off yet still gets tried.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

import duckdb
import pandas as pd

from sloop.store.duck import audit

PASSED_IN = ("backtested", "holdout_passed", "paper", "live_small", "live")
PASSED_HO = ("holdout_passed", "paper", "live_small", "live")
EXPLORATION_FLOOR = 0.20
WINDOWS = {"all": None, "90d": 90}


def _source(con: duckdb.DuckDBPyConnection, spec: dict) -> str:
    srcs = spec.get("sources") or []
    if srcs:
        return str(srcs[0])
    et = (spec.get("signal") or {}).get("event_type")
    r = con.execute("SELECT source FROM events WHERE type = ? GROUP BY source ORDER BY count(*) DESC LIMIT 1", [et]).fetchone()
    return r[0] if r else "unknown"


def score(proposed: int, passed_in: int, passed_ho: int, profitable: int) -> float:
    """Later rungs count more; +5 in the denominator keeps a lucky first proposal from dominating."""
    return (passed_in + 2 * passed_ho + 4 * profitable) / (proposed + 5)


def compute(con: duckdb.DuckDBPyConnection, as_of: date | None = None) -> pd.DataFrame:
    as_of = as_of or date.today()
    h = con.execute("SELECT hypothesis_id, proposed_by, created_at, status, spec_json FROM hypotheses").df()
    if h.empty:
        con.execute("DELETE FROM agent_scores")
        return pd.DataFrame()
    pnl = dict(con.execute("""SELECT s.hypothesis_id, sum(p.pnl) FROM positions p JOIN strategies s USING (strategy_id)
                              WHERE p.closed_at IS NOT NULL GROUP BY 1""").fetchall())
    h["source"] = [_source(con, json.loads(x) if isinstance(x, str) else x) for x in h["spec_json"]]
    h["agent"] = h["proposed_by"].fillna("unknown")
    h["created"] = pd.to_datetime(h["created_at"], utc=True).dt.date
    rows = []
    for window, days in WINDOWS.items():
        w = h if days is None else h[h["created"] >= as_of - timedelta(days=days)]
        for (agent, src), g in w.groupby(["agent", "source"]):
            p_in = int(g["status"].isin(PASSED_IN).sum())
            p_ho = int(g["status"].isin(PASSED_HO).sum())
            prof = int(sum(1 for hid in g["hypothesis_id"] if (pnl.get(hid) or 0) > 0))
            rows.append({"agent": agent, "source": src, "window": window, "proposed": len(g), "passed_insample": p_in,
                         "passed_holdout": p_ho, "profitable_live": prof, "score": score(len(g), p_in, p_ho, prof)})
    df = pd.DataFrame(rows)
    con.execute("DELETE FROM agent_scores")
    if len(df):
        con.register("_s", df)
        con.execute('INSERT INTO agent_scores SELECT agent, source, "window", proposed, passed_insample, passed_holdout, '
                    "profitable_live, score FROM _s")
        con.unregister("_s")
    audit(con, "scheduler", "agent_scores", None, {"rows": len(df)})
    return df


def research_weights(con: duckdb.DuckDBPyConnection) -> dict[str, float]:
    """Share of research effort per source: 80% by score, 20% spread evenly."""
    df = con.execute("""SELECT source, sum(score) AS s FROM agent_scores WHERE "window" = 'all' GROUP BY source""").df()
    if df.empty:
        return {}
    n, total = len(df), float(df["s"].sum())
    return {r.source: round((1 - EXPLORATION_FLOOR) * ((r.s / total) if total > 0 else 1 / n) + EXPLORATION_FLOOR / n, 4)
            for r in df.itertuples(index=False)}


def table(con: duckdb.DuckDBPyConnection, window: str = "all") -> pd.DataFrame:
    return con.execute('SELECT * FROM agent_scores WHERE "window" = ? ORDER BY score DESC', [window]).df()
