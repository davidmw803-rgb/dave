import json
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import pytest

import sloop.agents.fake  # noqa: F401
from sloop import clock, ledger
from sloop.agents import context, cycle, evaluator, lessons, llm, scores
from sloop.evaluator import stats
from sloop.executor import orders as order_ctl
from sloop.executor.replay import replay
from sloop.report import reports
from sloop.schemas import Hypothesis
from sloop.store import hot
from sloop.store.duck import insert_df
from tests.test_fast_loop import START, add_events, paper_strategy


@pytest.fixture
def hcon(tmp_path, monkeypatch):
    monkeypatch.setenv("LOOP_HOT_PATH", str(tmp_path / "hot.sqlite"))
    monkeypatch.setenv("LOOP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(order_ctl, "kill_file", lambda: tmp_path / "KILL")
    c = hot.connect()
    yield c
    c.close()


def strategy_with_trades(con, rets, start=date(2026, 3, 2), every=2, expected=None, alloc=10.0):
    """A paper strategy whose closed trades have the given returns (one every `every` trading days)."""
    h = Hypothesis.model_validate(dict(title="hand-built trades", mechanism="fixture for evaluator statistics tests",
                                       cell_key=f"synthetic_edge|all|all", signal={"event_type": "synthetic_edge"},
                                       exit={"horizon_days": 5}))
    hid, _ = ledger.register(con, h, "researcher")
    for to, who in (("backtested", "harness"), ("holdout_passed", "harness"), ("paper", "orchestrator")):
        ledger.transition(con, hid, to, who)
    sid = ledger.freeze_strategy(con, hid, {}, expected or {"mean_ar": 0.02, "hit_rate": 0.6, "ar_std": 0.05}, alloc)
    rows, d = [], start
    for k, r in enumerate(rets):
        d0 = d
        d1 = clock.add_trading_days(d0, 3)
        opened = datetime.combine(d0, datetime.min.time().replace(hour=14), timezone.utc)
        closed = datetime.combine(d1, datetime.min.time().replace(hour=19), timezone.utc)
        # Exit so the trade's *abnormal* return (vs the sector ETF, as the evaluator measures it) is r.
        b0 = stats._close_on_or_before(con, "XLI", d0 - timedelta(days=1))
        b1 = stats._close_on_or_before(con, "XLI", d1)
        ret = r + (b1 / b0 - 1.0)
        rows.append({"position_id": f"{sid}-p{k}", "strategy_id": sid, "ticker": "S001", "sector": "Industrials", "qty": 100.0,
                     "avg_cost": 50.0, "opened_at": opened, "closed_at": closed, "exit_price": 50.0 * (1 + ret),
                     "pnl": 100 * 50.0 * ret, "exit_reason": "time"})
        d = clock.add_trading_days(d, every)
    insert_df(con, "positions", pd.DataFrame(rows))
    return sid, hid


# ---- stats on real (replayed) paper trading ---------------------------------------

def test_stats_from_replayed_paper_trading(con, hcon):
    from sloop import ops
    sid = paper_strategy(con)
    add_events(con)
    replay(con, hcon, START, 10)
    ops.flush(hcon, con)
    s = next(x for x in stats.all_stats(con, date(2026, 8, 14)) if x["strategy_id"] == sid)
    assert s["n_closed"] >= 5 and s["trading_days"] >= 9
    assert s["slippage"]["n"] >= 5 and s["slippage"]["model_bps"] > 0
    assert s["slippage"]["realized_bps"] > s["slippage"]["model_bps"]   # paper pays model slippage + half-spread
    assert 0 < s["fill_rate"] <= 1 and s["by_regime"] and s["rolling20_hit_rate"] is not None
    assert s["gate_open"] is False and s["eligible_live_small"] is False


# ---- the minimum-sample gate and verdicts -------------------------------------------

def test_small_sample_verdicts_are_gated_to_keep(con, monkeypatch):
    sid, _ = strategy_with_trades(con, [-0.03] * 8, alloc=50.0)   # 2.4% drawdown: bad but no hard breach
    monkeypatch.setitem(llm._FAKES, "evaluator", lambda ctx, s: {"verdicts": [
        {"strategy_id": sid, "verdict": "kill", "attribution": "signal", "wrong_assumption": "edge", "lesson": "looks dead already"}]})
    out = evaluator.step(con, date(2026, 4, 1), backend="fake")
    assert out["verdicts"][sid] == "keep" and out["gated"] == [{"strategy_id": sid, "proposed": "kill"}]
    row = con.execute("SELECT verdict, lesson FROM evaluations WHERE strategy_id = ?", [sid]).fetchone()
    assert row[0] == "keep" and row[1].startswith("[gated: 8 trades")


def test_enough_evidence_lets_a_revise_through(con):
    sid, hid = strategy_with_trades(con, [0.004, -0.006] * 13)   # 26 trades, mean far below the 2% expected
    out = evaluator.step(con, date(2026, 5, 29), backend="fake")
    assert out["verdicts"][sid] == "revise"
    ev = con.execute("SELECT verdict, attribution, wrong_assumption FROM evaluations WHERE strategy_id = ?", [sid]).fetchone()
    assert ev[0] == "revise" and ev[2]
    fb = con.execute("SELECT to_agent, grade FROM feedback WHERE from_agent = 'evaluator'").fetchall()
    assert fb and fb[0][1] == "bad"
    octx = context.orchestrator(con, date(2026, 6, 1))
    assert octx["evaluator_verdicts"][0]["verdict"] == "revise"   # the orchestrator acts on it


def test_hard_breach_is_killed_by_code(con, monkeypatch, hcon):
    calls = []
    monkeypatch.setitem(llm._FAKES, "evaluator", lambda ctx, s: calls.append(1) or {"verdicts": []})
    sid, hid = strategy_with_trades(con, [-0.10, -0.10], alloc=10.0)    # $1,000 lost on a $10k allocation: 10% > 8%
    out = evaluator.step(con, date(2026, 3, 20), backend="fake")
    assert out["killed"] == [sid] and calls == []
    assert con.execute("SELECT state FROM strategies WHERE strategy_id = ?", [sid]).fetchone()[0] == "killed"
    assert ledger.get(con, hid)["status"] == "killed"
    assert hot.one(hcon, "SELECT count(*) AS n FROM alerts WHERE key = ?", [f"kill:{sid}"])["n"] == 1


def test_eligibility_is_flagged_not_acted_on(con, hcon):
    rets = [0.03, -0.01] * 12   # 24 trades, mean 1% vs 2% +/- 1.28*5%/sqrt(24)
    sid, hid = strategy_with_trades(con, rets, every=2)
    s = next(x for x in stats.all_stats(con, date(2026, 5, 29)) if x["strategy_id"] == sid)
    assert s["within_interval"] and s["n_closed"] >= 20 and s["trading_days"] >= 30
    out = evaluator.step(con, date(2026, 5, 29), backend="fake")
    assert out["eligible"] == [sid]
    assert con.execute("SELECT state FROM strategies WHERE strategy_id = ?", [sid]).fetchone()[0] == "paper"
    assert hot.one(hcon, "SELECT message FROM alerts WHERE key = ?", [f"eligible:{sid}"])["message"].startswith(sid)


def test_no_trades_means_no_llm_call(con):
    before = con.execute("SELECT count(*) FROM llm_usage").fetchone()[0]
    paper_strategy(con)
    out = evaluator.step(con, date(2026, 8, 3), backend="fake")
    assert set(out["verdicts"].values()) == {"keep"}
    assert con.execute("SELECT count(*) FROM llm_usage").fetchone()[0] == before


# ---- scorecards, lessons, reports --------------------------------------------------

def test_agent_scores_and_weights(con):
    strategy_with_trades(con, [0.02] * 3)              # researcher, synthetic source, profitable
    h = Hypothesis.model_validate(dict(title="another one", mechanism="noise proposal that never passes anything",
                                       cell_key="synthetic_noise|all|all", signal={"event_type": "synthetic_noise"},
                                       exit={"horizon_days": 5}, sources=["uw"]))
    ledger.register(con, h, "researcher")
    df = scores.compute(con, date(2026, 6, 1))
    allw = df[df["window"] == "all"].set_index("source")
    assert allw.loc["synthetic", "profitable_live"] == 1 and allw.loc["uw", "passed_insample"] == 0
    assert allw.loc["synthetic", "score"] > allw.loc["uw", "score"]
    w = scores.research_weights(con)
    assert sum(w.values()) == pytest.approx(1.0) and min(w.values()) >= 0.2 / len(w) - 1e-9


def test_lessons_compaction(con, hcon, tmp_path):
    from sloop.agents import feedback
    for i in range(3):
        feedback.write(con, "harness", "researcher", None, "bad", "Contract awards under 5% of market cap show nothing.")
    feedback.write(con, "evaluator", "analyzer", None, "bad", "Paper slippage runs about twice the cost model in micro caps.")
    out = lessons.compact(con, date(2026, 9, 26), backend="fake")
    text = (tmp_path / "data" / "lessons.md").read_text()
    assert out["lessons"] == 2 and "## researcher" in text and "## analyzer" in text and len(text) <= lessons.CAP_CHARS
    assert feedback.digest() == text   # what researcher/analyzer prompts now carry
    assert lessons.compact(con, date(2026, 10, 3), backend="fake") == {"skipped": "no new feedback since the last compaction"}
    feedback.write(con, "harness", "researcher", None, "good", "Pre-market 8-K contract awards drift for a week.")
    lessons.compact(con, date(2026, 10, 3), backend="fake")
    assert (tmp_path / "data" / "lessons.2026-10-03.md").exists()


def test_reports(con, hcon, tmp_path):
    from sloop import ops
    paper_strategy(con)
    add_events(con)
    replay(con, hcon, START, 10)
    ops.flush(hcon, con)
    evaluator.step(con, date(2026, 8, 14), backend="fake")
    scores.compute(con, date(2026, 8, 14))
    p = reports.write("daily", con, hcon, date(2026, 8, 14))
    body = p.read_text()
    assert "# Daily report — 2026-08-14" in body and "## Trading (paper)" in body and "## Evaluator" in body
    w = reports.write("weekly", con, hcon, date(2026, 8, 15)).read_text()
    assert "Program criteria" in w and "Agent scorecards" in w and "| 3 months |" in w
    assert hot.one(hcon, "SELECT count(*) AS n FROM alerts WHERE key LIKE 'report:%'")["n"] == 2


def test_cycle_runs_the_evaluator_first(con):
    out = cycle.run_cycle(con, date(2026, 9, 1), backend="fake", n_placebos=3)
    assert list(out)[:4] == ["evaluator", "orchestrator", "researcher", "analyzer"]
    assert out["evaluator"]["evaluated"] == 0
