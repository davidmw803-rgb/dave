"""Daily (17:00) and weekly (Saturday) reports to David (§4, §12).

Markdown files in data/reports/, plus a short summary pushed through the alert
channel (`LOOP_ALERT_WEBHOOK`). Numbers come straight from the ledger and hot
store; no LLM is involved.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import duckdb
import pandas as pd

from sloop import clock, config
from sloop.agents import scores
from sloop.store import hot


def _md(df: pd.DataFrame, empty: str = "_none_") -> str:
    if df is None or df.empty:
        return empty
    cols = list(df.columns)
    out = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in df.itertuples(index=False):
        out.append("| " + " | ".join("" if pd.isna(v) else (f"{v:,.4g}" if isinstance(v, float) else str(v)) for v in r) + " |")
    return "\n".join(out)


def _window(day: date, days: int) -> tuple[datetime, datetime]:
    end = datetime.combine(day + timedelta(days=1), time(), clock.ET)
    return end - timedelta(days=days), end


def _trading(con: duckdb.DuckDBPyConnection, start: datetime, end: datetime) -> dict:
    closed = con.execute("""SELECT strategy_id, ticker, exit_reason, round(pnl, 2) AS pnl, closed_at FROM positions
                            WHERE closed_at >= ? AND closed_at < ? ORDER BY closed_at""", [start, end]).df()
    opened = con.execute("SELECT count(*) FROM positions WHERE opened_at >= ? AND opened_at < ?", [start, end]).fetchone()[0]
    open_now = con.execute("SELECT strategy_id, ticker, qty, round(avg_cost, 2) AS avg_cost, max_exit_date FROM positions "
                           "WHERE closed_at IS NULL").df()
    total = con.execute("SELECT coalesce(sum(pnl), 0) FROM positions WHERE closed_at IS NOT NULL").fetchone()[0]
    skips = con.execute("""SELECT skipped_reason, count(*) AS n FROM signals WHERE ts >= ? AND ts < ? AND action = 'skip'
                           GROUP BY 1 ORDER BY 2 DESC""", [start, end]).df()
    entered = con.execute("SELECT count(*) FROM signals WHERE ts >= ? AND ts < ? AND action = 'enter'", [start, end]).fetchone()[0]
    return {"closed": closed, "opened": opened, "open_now": open_now, "realized": float(closed["pnl"].sum()) if len(closed) else 0.0,
            "realized_total": float(total), "skips": skips, "entered": entered}


def _research(con: duckdb.DuckDBPyConnection, start: datetime, end: datetime) -> dict:
    return {
        "proposed": con.execute("SELECT count(*) FROM hypotheses WHERE created_at >= ? AND created_at < ?", [start, end]).fetchone()[0],
        "tests": con.execute("""SELECT count(*), count(*) FILTER (WHERE passed) FROM tests WHERE run_at >= ? AND run_at < ?
                                AND sample = 'in' AND segment_key IS NULL""", [start, end]).fetchone(),
        "holdouts": con.execute("""SELECT t.hypothesis_id, h.family_key, t.passed FROM tests t JOIN hypotheses h USING (hypothesis_id)
                                   WHERE t.sample = 'holdout' AND t.run_at >= ? AND t.run_at < ?""", [start, end]).df(),
        "status_changes": con.execute("""SELECT object_id AS hypothesis_id, action, actor FROM audit WHERE action LIKE 'status:%'
                                         AND ts >= ? AND ts < ? ORDER BY ts""", [start, end]).df(),
        "llm": con.execute("""SELECT role, count(*) AS calls, round(sum(cost_est), 3) AS usd FROM llm_usage
                              WHERE ts >= ? AND ts < ? GROUP BY 1 ORDER BY 1""", [start, end]).df(),
        "trials": con.execute("SELECT total FROM trial_counter WHERE id = 1").fetchone()[0],
    }


def _evaluations(con: duckdb.DuckDBPyConnection, start: datetime, end: datetime) -> pd.DataFrame:
    return con.execute("""SELECT strategy_id, as_of, verdict, attribution, wrong_assumption,
                                 json_extract(stats_json, '$.n_closed') AS trades,
                                 round(CAST(json_extract(stats_json, '$.mean_ar') AS DOUBLE), 4) AS mean_ar,
                                 json_extract(stats_json, '$.within_interval') AS within_80
                          FROM evaluations WHERE as_of >= ? AND as_of < ? ORDER BY as_of, strategy_id""",
                       [start.date(), end.date()]).df()


def _alerts(hcon: sqlite3.Connection | None, start: datetime, end: datetime) -> pd.DataFrame:
    if hcon is None:
        return pd.DataFrame()
    return pd.DataFrame(hot.rows(hcon, "SELECT ts, level, key, message FROM alerts WHERE ts >= ? AND ts < ? ORDER BY ts",
                                 [start.astimezone(timezone.utc).isoformat(), end.astimezone(timezone.utc).isoformat()]))


def _eligible(con: duckdb.DuckDBPyConnection, start: datetime, end: datetime) -> list[str]:
    return [r[0] for r in con.execute("SELECT DISTINCT object_id FROM audit WHERE action = 'eligible_live_small' "
                                      "AND ts >= ? AND ts < ?", [start, end]).fetchall()]


def daily(con: duckdb.DuckDBPyConnection, hcon: sqlite3.Connection | None, day: date) -> tuple[str, str]:
    start, end = _window(day, 1)
    tr, rs = _trading(con, start, end), _research(con, start, end)
    controls = {r["key"]: r["value"] for r in hot.rows(hcon, "SELECT key, value FROM controls")} if hcon else {}
    elig = _eligible(con, start, end)
    tests_n, tests_pass = rs["tests"]
    summary = (f"{day}: {len(tr['closed'])} closed (${tr['realized']:,.0f}), {len(tr['open_now'])} open, "
               f"{tr['entered']} entries; {rs['proposed']} proposed, {tests_pass}/{tests_n} tests passed; "
               f"LLM ${float(rs['llm']['usd'].sum()) if len(rs['llm']) else 0:.2f}"
               + (f"; HALTS: {', '.join(controls)}" if controls else "") + (f"; ELIGIBLE: {', '.join(elig)}" if elig else ""))
    body = f"""# Daily report — {day}

{summary}

## Trading (paper)
- Realized today: **${tr['realized']:,.2f}** · all-time realized: ${tr['realized_total']:,.2f}
- Entries: {tr['entered']} · positions opened: {tr['opened']}
- Controls in force: {', '.join(f'{k}={v}' for k, v in controls.items()) or 'none'}

### Closed today
{_md(tr['closed'])}

### Open positions
{_md(tr['open_now'])}

### Skipped signals
{_md(tr['skips'])}

## Evaluator
{_md(_evaluations(con, start, end))}

**Awaiting David (paper → live_small eligible):** {', '.join(elig) or 'none'}

## Research
- Hypotheses proposed: {rs['proposed']} · in-sample tests: {tests_n} ({tests_pass} passed) · trial counter: {rs['trials']}

### Holdout runs
{_md(rs['holdouts'])}

### Ladder moves
{_md(rs['status_changes'])}

### LLM usage
{_md(rs['llm'])}

## Alerts
{_md(_alerts(hcon, start, end))}
"""
    return summary, body


def program_criteria(con: duckdb.DuckDBPyConnection, day: date) -> pd.DataFrame:
    """§12 checkpoints, measured from the first ledger activity."""
    first = con.execute("SELECT CAST(min(created_at) AS VARCHAR) FROM hypotheses").fetchone()[0]
    months = ((day - pd.Timestamp(first).date()).days / 30.4) if first is not None else 0.0
    paper = con.execute("SELECT count(*) FROM strategies WHERE state IN ('paper','live_small','live')").fetchone()[0]
    cells = con.execute("SELECT count(*) FROM coverage WHERE n_tests > 0").fetchone()[0]
    elig = con.execute("SELECT count(DISTINCT object_id) FROM audit WHERE action = 'eligible_live_small'").fetchone()[0]
    live_pnl = con.execute("""SELECT coalesce(sum(p.pnl), 0) FROM positions p JOIN strategies s USING (strategy_id)
                              WHERE s.state IN ('live_small','live') AND p.closed_at IS NOT NULL""").fetchone()[0]
    return pd.DataFrame([
        {"checkpoint": "3 months", "criterion": ">=1 strategy in paper, or 'no edge' across >=20 cells",
         "status": f"{paper} in paper; {cells} cells tested", "met": paper >= 1 or cells >= 20},
        {"checkpoint": "6 months", "criterion": ">=1 strategy eligible for live_small",
         "status": f"{elig} eligible so far", "met": elig >= 1},
        {"checkpoint": "12 months", "criterion": "live net positive vs IWM, risk-adjusted",
         "status": f"live realized ${live_pnl:,.0f} (IWM comparison needs live history)", "met": None},
    ]).assign(months_elapsed=round(months, 1))


def weekly(con: duckdb.DuckDBPyConnection, hcon: sqlite3.Connection | None, day: date) -> tuple[str, str]:
    start, end = _window(day, 7)
    tr, rs = _trading(con, start, end), _research(con, start, end)
    tests_n, tests_pass = rs["tests"]
    cov = con.execute("SELECT state, count(*) AS cells, sum(n_tests) AS tests FROM coverage GROUP BY 1 ORDER BY 1").df()
    lessons = config.data_dir() / "lessons.md"
    summary = (f"week to {day}: {len(tr['closed'])} closed (${tr['realized']:,.0f}); {rs['proposed']} proposed, "
               f"{tests_pass}/{tests_n} tests passed; LLM ${float(rs['llm']['usd'].sum()) if len(rs['llm']) else 0:.2f}")
    body = f"""# Weekly report — week to {day}

{summary}

## Program criteria (§12)
{_md(program_criteria(con, day))}

## Trading (paper)
- Realized this week: **${tr['realized']:,.2f}** · all-time realized: ${tr['realized_total']:,.2f}

{_md(tr['closed'])}

## Strategy verdicts this week
{_md(_evaluations(con, start, end))}

## Research
- Proposed: {rs['proposed']} · in-sample tests: {tests_n} ({tests_pass} passed) · trial counter: {rs['trials']}

### Coverage map
{_md(cov)}

### Agent scorecards (§10)
{_md(scores.table(con))}

Research weights by source (20% exploration floor): {json.dumps(scores.research_weights(con))}

### LLM usage
{_md(rs['llm'])}

## Lessons digest
{lessons.read_text() if lessons.exists() else '_not compacted yet_'}
"""
    return summary, body


def write(kind: str, con: duckdb.DuckDBPyConnection, hcon: sqlite3.Connection | None, day: date) -> Path:
    summary, body = (daily if kind == "daily" else weekly)(con, hcon, day)
    out = config.data_dir() / "reports"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{day}-{kind}.md"
    path.write_text(body)
    if hcon is not None:
        from sloop.watchdog.alerts import alert
        alert(hcon, f"report:{kind}:{day}", f"{summary}\n{path}", "info")
    return path
