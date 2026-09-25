"""Evaluator step (§3.6), 06:30 before the orchestrator.

1. Code computes every statistic (evaluator/stats.py).
2. A hard risk breach (strategy drawdown past its limit) is killed by code
   immediately, with no agent involved.
3. Strategies with closed trades go to one batched LLM call for verdicts and
   attribution. Code then enforces the minimum-sample gate: before 20 closed
   trades or 30 trading days, any verdict but ``keep`` becomes ``keep``.
4. Verdicts are stored in ``evaluations`` for the orchestrator, which acts on
   revise/kill; lessons become feedback. Strategies meeting §8.6 paper ->
   live_small eligibility raise an alert for David. Nothing is promoted.
"""
from __future__ import annotations

import json
from datetime import date
from typing import Any

import duckdb

from sloop import ledger
from sloop.agents import feedback, llm
from sloop.evaluator import stats
from sloop.schemas import EvaluatorReport
from sloop.store.duck import audit, new_id

ATTRIBUTION = {
    "execution": "slippage, fills, timing, liquidity",
    "signal": "edge smaller than the backtest",
    "regime_decay": "depends on conditions that changed, or fading",
    "none": "nothing to explain",
}


def _record(con: duckdb.DuckDBPyConnection, st: dict, as_of: date, verdict: str, attribution: str, lesson: str,
            wrong: str | None, version: str | None) -> None:
    con.execute("INSERT INTO evaluations (eval_id, strategy_id, as_of, stats_json, regime_stats_json, verdict, attribution, "
                "lesson, wrong_assumption, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [new_id("evl"), st["strategy_id"], as_of, json.dumps(st, default=str), json.dumps(st.get("by_regime", {})),
                 verdict, attribution, lesson, wrong, version])


def _alert(message: str, key: str) -> None:
    try:
        from sloop.store import hot
        from sloop.watchdog.alerts import alert
        alert(hot.connect(), key, message, "info")
    except Exception:  # noqa: BLE001 - an alert failure must not fail the evaluation
        pass


def step(con: duckdb.DuckDBPyConnection, as_of: date, backend: str | None = None) -> dict[str, Any]:
    all_st = stats.all_stats(con, as_of)
    out: dict[str, Any] = {"evaluated": len(all_st), "killed": [], "verdicts": {}, "eligible": [], "gated": []}
    hyp_of = dict(con.execute("SELECT strategy_id, hypothesis_id FROM strategies").fetchall())

    for st in all_st:
        if st["hard_breach"]:
            sid = st["strategy_id"]
            con.execute("UPDATE strategies SET state = 'killed' WHERE strategy_id = ?", [sid])
            try:
                ledger.transition(con, hyp_of[sid], "killed", "evaluator", reason="hard risk breach: drawdown")
            except (ledger.LadderError, KeyError):
                pass
            _record(con, st, as_of, "kill", "execution", "hard risk breach: strategy drawdown beyond its limit",
                    f"drawdown {st['drawdown_of_allocation']:.1%} of allocation", None)
            audit(con, "evaluator", "kill_hard_breach", sid, {"drawdown": st["drawdown_of_allocation"]})
            _alert(f"{sid} killed: drawdown {st['drawdown_of_allocation']:.1%} of allocation", f"kill:{sid}")
            out["killed"].append(sid)
        if st.get("eligible_live_small"):
            out["eligible"].append(st["strategy_id"])
            audit(con, "evaluator", "eligible_live_small", st["strategy_id"], {"n_closed": st["n_closed"]})
            _alert(f"{st['strategy_id']} meets paper -> live_small eligibility (§8.6). Needs a live broker and "
                   f"`loop approve {st['strategy_id']} --to live_small`.", f"eligible:{st['strategy_id']}")

    candidates = [st for st in all_st if st["n_closed"] > 0 and not st["hard_breach"]]
    for st in all_st:
        if st["n_closed"] == 0:
            _record(con, st, as_of, "keep", "none", "no closed trades yet", None, None)
            out["verdicts"][st["strategy_id"]] = "keep"
    if not candidates:
        return out

    ctx = {"as_of": str(as_of), "strategies": candidates, "attribution_options": ATTRIBUTION,
           "lessons": feedback.lessons_for(con, "evaluator")}
    report, version = llm.run(con, "evaluator", "evaluator", ctx, EvaluatorReport, backend=backend, day=as_of)
    by_id = {v.strategy_id: v for v in report.verdicts}
    for st in candidates:
        sid = st["strategy_id"]
        v = by_id.get(sid)
        verdict, attribution = (v.verdict, v.attribution) if v else ("keep", "none")
        lesson, wrong = (v.lesson, v.wrong_assumption) if v else ("no verdict returned", None)
        if verdict != "keep" and not st["gate_open"]:
            out["gated"].append({"strategy_id": sid, "proposed": verdict})
            lesson = f"[gated: {st['n_closed']} trades, {st['trading_days']} days; agent proposed {verdict}] {lesson}"
            verdict = "keep"
        _record(con, st, as_of, verdict, attribution, lesson, wrong, version)
        out["verdicts"][sid] = verdict
        if v and v.lesson:
            to = "analyzer" if attribution in ("signal", "execution") else "orchestrator"
            feedback.write(con, "evaluator", to, hyp_of.get(sid), "bad" if verdict in ("revise", "kill") else "neutral", v.lesson)
    audit(con, "evaluator", "verdicts", None, out, version)
    return out


def latest(con: duckdb.DuckDBPyConnection) -> list[dict]:
    """Most recent verdict per strategy, for the orchestrator's context."""
    df = con.execute("""SELECT e.strategy_id, s.hypothesis_id, s.state, e.as_of, e.verdict, e.attribution, e.wrong_assumption,
                               e.lesson, json_extract(e.stats_json, '$.n_closed') AS n_closed,
                               json_extract(e.stats_json, '$.mean_ar') AS mean_ar,
                               json_extract(e.stats_json, '$.within_interval') AS within_interval
                        FROM evaluations e JOIN strategies s USING (strategy_id)
                        QUALIFY row_number() OVER (PARTITION BY e.strategy_id ORDER BY e.as_of DESC, e.eval_id DESC) = 1""").df()
    return json.loads(df.to_json(orient="records", date_format="iso")) if len(df) else []
