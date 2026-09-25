import json
from datetime import date, datetime, time, timezone

import pandas as pd
import pytest

from sloop import clock, ledger
from sloop.executor import orders as order_ctl
from sloop.executor.broker import StaticQuotes
from sloop.executor.loop import Executor
from sloop.executor.paper_sim import PaperSim
from sloop.executor.portfolio import violations
from sloop.executor.replay import replay
from sloop.ingest import edgar
from sloop.ingest.service import Ingestor
from sloop.schemas import Hypothesis
from sloop.store import hot
from sloop.store.duck import upsert_df
from sloop.watchdog import reconcile
from sloop.watchdog.service import check

START = date(2026, 8, 3)  # two clean weeks in the synthetic calendar (no holidays)


@pytest.fixture
def hcon(tmp_path, monkeypatch):
    monkeypatch.setenv("LOOP_HOT_PATH", str(tmp_path / "hot.sqlite"))
    monkeypatch.setattr(order_ctl, "kill_file", lambda: tmp_path / "KILL")
    c = hot.connect()
    yield c
    c.close()


def paper_strategy(con, **exit_kw):
    h = Hypothesis.model_validate(dict(title="paper edge", mechanism="planted synthetic effect for executor validation",
                                       cell_key="synthetic_edge|all|all", signal={"event_type": "synthetic_edge"},
                                       exit={"horizon_days": 3, "stop_atr_mult": 2.0, "take_profit_pct": 8, **exit_kw}))
    hid, _ = ledger.register(con, h, "test")
    for to, who in (("backtested", "harness"), ("holdout_passed", "harness"), ("paper", "orchestrator")):
        ledger.transition(con, hid, to, who)
    return ledger.freeze_strategy(con, hid, {}, {"mean_ar": 0.02}, 50.0)


def add_events(con, n=40, seed=3):
    """Extra edge events in the replay window: pre-market, intraday and after-hours."""
    import numpy as np
    rng = np.random.default_rng(seed)
    tickers = con.execute("SELECT DISTINCT ticker FROM universe_pit WHERE date = '2026-07-31'").df()["ticker"].tolist()
    days = pd.bdate_range(START, periods=10)
    rows = []
    for k in range(n):
        d = days[k % 10].date()
        hhmm = ["07:00", "08:15", "11:30", "17:30"][k % 4]
        pub = datetime.combine(d, time.fromisoformat(hhmm), clock.ET).astimezone(timezone.utc)
        rows.append({"event_id": f"rp_{k}", "source": "synthetic", "source_id": f"rp{k}", "type": "synthetic_edge",
                     "ticker": tickers[int(rng.integers(len(tickers)))], "ts_published": pub, "ts_ingested": pub,
                     "payload_json": json.dumps({"score": 0.5})})
    upsert_df(con, "events", pd.DataFrame(rows))


# ---- Phase 3 exit criterion (replayed) ----------------------------------------------

def test_two_weeks_of_paper_trading_reconcile_with_a_forced_restart(con, hcon):
    paper_strategy(con)
    add_events(con)
    res = replay(con, hcon, START, 10, step_minutes=5, crash_at=(3, "09:30"))
    assert len(res.days) == 10 and res.restarts == 1
    assert res.watchdog_findings == []           # reconciled every tick, no limit violations
    assert violations(hcon) == []
    orders = hot.rows(hcon, "SELECT client_order_id FROM orders")
    assert len(orders) == len({o["client_order_id"] for o in orders})
    sim = hot.rows(hcon, "SELECT client_order_id FROM sim_orders")
    assert len(sim) == len({o["client_order_id"] for o in sim})   # the broker never got a duplicate
    closed = hot.rows(hcon, "SELECT * FROM positions WHERE closed_at IS NOT NULL")
    assert len(closed) >= 5
    assert {p["exit_reason"] for p in closed} <= {"stop", "take_profit", "time"}
    sigs = {r["status"] for r in hot.rows(hcon, "SELECT status FROM signals")}
    assert "entered" in sigs
    assert hot.get_control(hcon, "reconciliation") is None
    # The crash left an order the broker had but the executor hadn't recorded; recovery adopted it.
    assert all(o["status"] != "submitting" for o in hot.rows(hcon, "SELECT status FROM orders"))


def test_entries_follow_the_harness_timing(con, hcon):
    paper_strategy(con)
    add_events(con, n=8)
    replay(con, hcon, START, 3, step_minutes=5)
    for s in hot.rows(hcon, "SELECT s.*, e.ts_published FROM signals s JOIN events e USING (event_id) WHERE s.status = 'entered'"):
        local = pd.Timestamp(s["ts_published"]).tz_convert(clock.ET)
        if local.time() < time(9, 30):
            assert s["entry_window"] == "open" and s["due_date"] == local.date().isoformat()
        elif local.time() < time(15, 45):
            assert s["entry_window"] == "close" and s["due_date"] == local.date().isoformat()
        else:
            assert s["entry_window"] == "open" and s["due_date"] > local.date().isoformat()
    for o in hot.rows(hcon, "SELECT o.ts, s.entry_window FROM orders o JOIN signals s USING (signal_id) WHERE o.side = 'buy'"):
        t = pd.Timestamp(o["ts"]).tz_convert(clock.ET).time()
        assert (time(9, 30) <= t < time(9, 45)) if o["entry_window"] == "open" else (time(15, 45) <= t < time(15, 55))


# ---- paper broker ---------------------------------------------------------------

def _sim(hcon, when="2026-08-04 10:00"):
    clk = clock.SimClock(pd.Timestamp(when, tz="America/New_York").tz_convert("UTC").to_pydatetime())
    return PaperSim(hcon, clk), clk


def test_bracket_fills_and_oco(hcon):
    sim, clk = _sim(hcon)
    b = order_ctl.build_bracket("stg", "ev", "ABC", 10, 100.0, 0.5, 95.0, 8)
    sim.submit_bracket(b, 5e7)
    assert sim.submit_bracket(b, 5e7).client_order_id == b.client_order_id  # idempotent
    assert len(sim.open_orders()) == 3
    q = StaticQuotes()
    q.set("ABC", 100.0, clk.now())
    sim.tick(q.get(["ABC"]), clk.et())
    assert sim.positions() == {"ABC": 10}
    q.set("ABC", 94.0, clk.now())
    sim.tick(q.get(["ABC"]), clk.et())
    assert sim.positions() == {}
    st = {o["client_order_id"].split(":")[-1]: o["status"] for o in hot.rows(hcon, "SELECT * FROM sim_orders")}
    assert st["stop"] == "filled" and st["tp"] == "cancelled"
    stop_fill = hot.one(hcon, "SELECT price FROM sim_fills WHERE client_order_id LIKE '%:stop'")["price"]
    assert stop_fill < 94.0  # gap through the stop fills at the bid less slippage


def test_unfilled_day_orders_expire_at_close(hcon):
    sim, clk = _sim(hcon)
    b = order_ctl.build_bracket("stg", "ev2", "XYZ", 10, 50.0, 0.0, 45.0, None)
    sim.submit_bracket(b, 5e7)
    clk.set_et(date(2026, 8, 4), "16:01")
    sim.tick({}, clk.et())
    assert sim.open_orders() == []


# ---- executor controls ------------------------------------------------------------

def test_kill_switch_and_live_strategies_never_trade(con, hcon, tmp_path):
    sid = paper_strategy(con)
    add_events(con, n=8)
    (tmp_path / "KILL").touch()
    replay(con, hcon, START, 2)
    assert hot.rows(hcon, "SELECT * FROM orders") == []
    reasons = {r["skipped_reason"] for r in hot.rows(hcon, "SELECT skipped_reason FROM signals")}
    assert reasons <= {"halt:kill_switch", "missed_window"}
    (tmp_path / "KILL").unlink()
    ledger.approve_strategy(con, sid, "live_small", ledger.HUMAN)
    hcon.execute("DELETE FROM signals")
    hot.set_cursor(hcon, "executor_seq", "0")
    replay(con, hcon, START, 2)
    assert hot.rows(hcon, "SELECT * FROM orders") == []
    assert {r["skipped_reason"] for r in hot.rows(hcon, "SELECT skipped_reason FROM signals")} == {"live_broker_not_configured"}
    assert hot.one(hcon, "SELECT count(*) AS n FROM alerts WHERE key LIKE 'live_skip:%'")["n"] >= 1


def test_flatten_closes_everything(con, hcon):
    paper_strategy(con, horizon_days=10)
    add_events(con, n=12)
    replay(con, hcon, START, 2)
    assert hot.one(hcon, "SELECT count(*) AS n FROM positions WHERE closed_at IS NULL")["n"] > 0
    hot.set_control(hcon, "flatten", "requested", "david")
    replay(con, hcon, date(2026, 8, 5), 1)
    assert hot.one(hcon, "SELECT count(*) AS n FROM positions WHERE closed_at IS NULL")["n"] == 0
    assert hot.get_control(hcon, "flatten") is None
    assert "flatten" in {p["exit_reason"] for p in hot.rows(hcon, "SELECT exit_reason FROM positions")}


def test_reconciliation_mismatch_halts_after_two_checks(con, hcon):
    paper_strategy(con)
    add_events(con, n=8)
    replay(con, hcon, START, 1)
    sim, clk = _sim(hcon, "2026-08-04 11:00")
    hcon.execute("INSERT INTO sim_positions VALUES ('ROGUE', 5)")  # the broker holds something we don't know about
    assert any("ROGUE" in p for p in reconcile.diff(hcon, sim))
    hot.heartbeat(hcon, "executor", "ok", clk.now().isoformat())
    hot.heartbeat(hcon, "ingest", "ok", clk.now().isoformat())
    check(hcon, sim, clk)
    assert hot.get_control(hcon, "reconciliation") is None
    check(hcon, sim, clk)
    assert "ROGUE" in hot.get_control(hcon, "reconciliation")
    ex = Executor(hcon, sim, StaticQuotes(), clk)
    assert ex._halted(date(2026, 8, 4)) == "reconciliation"


def test_watchdog_flags_missing_heartbeats(hcon):
    clk = clock.SimClock(pd.Timestamp("2026-08-04 11:00", tz="America/New_York").tz_convert("UTC").to_pydatetime())
    found = check(hcon, None, clk)
    assert any("ingest heartbeat missing" in f for f in found) and any("executor heartbeat missing" in f for f in found)
    assert hot.one(hcon, "SELECT count(*) AS n FROM alerts")["n"] == 2
    check(hcon, None, clk)
    assert hot.one(hcon, "SELECT count(*) AS n FROM alerts")["n"] == 2  # deduplicated


# ---- ingestion + triggers ------------------------------------------------------------

def test_ingestor_dedupes_queues_triggers_and_survives_a_failing_source(hcon, monkeypatch):
    monkeypatch.setattr("sloop.triggers.filter.config.load",
                        lambda n, _r=__import__("sloop.config", fromlist=["load"]).load:
                        {"rules": [{"id": "big", "event_type": "contract_award", "when": {"award_to_mcap_min": 0.2}}]}
                        if n == "triggers" else _r(n))
    hcon.execute("INSERT INTO refdata VALUES ('ABC', '2026-08-03', 'Industrials', 1e9, 'small', 1e7, 1.0, 20.0)")
    now = datetime(2026, 8, 4, 14, tzinfo=timezone.utc)
    batch = pd.DataFrame([{"event_id": f"e{i}", "source": "fake", "source_id": str(i), "type": "contract_award",
                           "ticker": "ABC", "ts_published": now, "ts_ingested": now,
                           "payload_json": json.dumps({"award_amount": amt})} for i, amt in ((1, 5e8), (2, 1e7))])

    def broken(con):
        raise RuntimeError("HTTP 503")

    clk = clock.SimClock(now)
    ing = Ingestor(hcon, {"fake": lambda con: batch, "broken": broken}, clk)
    assert ing.tick() == {"fake": 2, "fake_triggers": 1}
    clk.advance(120)
    assert ing.tick() == {"fake": 0}
    assert [w["event_id"] for w in hot.rows(hcon, "SELECT * FROM wakeups")] == ["e1"]
    for _ in range(2):
        clk.advance(120)
        ing.tick()
    assert hot.one(hcon, "SELECT count(*) AS n FROM alerts WHERE key = 'source:broken'")["n"] == 1


def test_edgar_live_feed_parse():
    xml = """<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>8-K - ACME CORP (0001234567) (Filer)</title>
      <link href="https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm"/>
      <updated>2026-08-04T16:31:05-04:00</updated><id>urn:tag:sec.gov,2008:accession-number=0001234567-26-000001</id></entry>
    <entry><title>4 - Doe Jane (0009999999) (Reporting)</title><updated>2026-08-04T16:32:00-04:00</updated>
      <id>urn:tag:sec.gov,2008:accession-number=0001234567-26-000002</id></entry>
    <entry><title>4 - ACME CORP (0001234567) (Issuer)</title><updated>2026-08-04T16:32:00-04:00</updated>
      <id>urn:tag:sec.gov,2008:accession-number=0001234567-26-000002</id></entry>
    </feed>"""
    df = edgar.parse_current_feed(xml, {1234567: "ACME"})
    assert list(df["type"]) == ["sec_8k", "insider_form4"]
    assert str(df["ts_published"].iloc[0]) == "2026-08-04 20:31:05+00:00"
    assert df["source_id"].iloc[0] == "0001234567-26-000001"
    assert edgar.accession("edgar/data/1234567/0001234567-26-000001.txt") == "0001234567-26-000001"


def test_flush_copies_fast_loop_rows_into_the_ledger(con, hcon):
    from sloop import ops
    paper_strategy(con)
    add_events(con, n=8)
    replay(con, hcon, START, 2)
    out = ops.flush(hcon, con)
    assert out["orders"] > 0 and out["fills"] > 0
    assert con.execute("SELECT count(*) FROM orders").fetchone()[0] == hot.one(hcon, "SELECT count(*) AS n FROM orders")["n"]
    ops.flush(hcon, con)  # idempotent
    assert con.execute("SELECT count(*) FROM fills").fetchone()[0] == hot.one(hcon, "SELECT count(*) AS n FROM fills")["n"]


def test_early_close_windows():
    et = lambda s: pd.Timestamp(s, tz="America/New_York").to_pydatetime()
    assert clock.within(et("2026-11-27 12:50"), ["15:45", "15:55"])
    assert not clock.within(et("2026-11-27 15:50"), ["15:45", "15:55"])
    assert clock.within(et("2026-11-27 10:00"), ["09:25", "16:05"]) and not clock.within(et("2026-11-27 13:10"), ["09:25", "16:05"])
    assert not clock.is_trading_day(date(2026, 11, 26)) and clock.is_trading_day(date(2026, 11, 27))
