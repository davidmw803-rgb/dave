from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from sloop import ledger
from sloop.harness import events, holdout, run
from sloop.harness.market import MarketData
from sloop.harness.returns import simulate
from sloop.schemas import Hypothesis
from sloop.store.duck import trial_count
from tests.conftest import AS_OF

PLACEBOS = 40


def hyp(event_type, **kw):
    base = dict(title=f"test {event_type}", mechanism="planted synthetic effect for harness validation",
                cell_key=f"{event_type}|all|all", signal={"event_type": event_type}, exit={"horizon_days": 5})
    base.update(kw)
    return Hypothesis.model_validate(base)


def test_real_edge_passes_in_sample_and_holdout(con):
    hid, _ = ledger.register(con, hyp("synthetic_edge"), "test")
    r = run.backtest(con, hid, n_placebos=PLACEBOS, as_of=AS_OF)
    assert r["passed"], r["failed_checks"]
    assert r["mean_ar"] > 0.02 and r["null_percentile"] > 99
    assert ledger.get(con, hid)["status"] == "backtested"
    h = run.run_holdout(con, hid, as_of=AS_OF)
    assert h["passed"] and h["n_events"] > 50
    assert ledger.get(con, hid)["status"] == "holdout_passed"


def test_known_false_hypothesis_fails(con):
    hid, _ = ledger.register(con, hyp("synthetic_noise"), "test")
    r = run.backtest(con, hid, n_placebos=PLACEBOS, as_of=AS_OF)
    assert not r["passed"]
    assert abs(r["mean_ar"]) < 0.005
    assert ledger.get(con, hid)["status"] == "proposed"


def test_move_before_publication_is_not_capturable(con):
    """The leak's move happens between the open and the noon publication."""
    hid, _ = ledger.register(con, hyp("synthetic_leak"), "test")
    r = run.backtest(con, hid, n_placebos=PLACEBOS, as_of=AS_OF)
    assert not r["passed"] and abs(r["mean_ar"]) < 0.006

    # Sanity: the same events *would* look great if the harness entered at the open.
    hs = holdout.holdout_start(con, AS_OF)
    md = MarketData.load(con, end=hs)
    cands = events.select(con, md, hyp("synthetic_leak"), None, hs)
    assert set(cands["entry_at"]) == {"close"}
    cheat = [simulate(md, c.ticker, np.datetime64(c.entry_date, "D"), "open", c.sector, c.adv,
                      hyp("synthetic_leak").exit, 15) for c in cands.itertuples()]
    assert np.mean([t.net_ar for t in cheat if t.ok]) > 0.02


def test_forward_looking_filter_is_refused(con):
    hid, _ = ledger.register(con, hyp("synthetic_edge", signal={"event_type": "synthetic_edge",
                                                                "filters": {"fwd_return_5d_min": 0.0}}), "test")
    n0 = trial_count(con)
    with pytest.raises(events.LookAheadError):
        run.backtest(con, hid, n_placebos=PLACEBOS, as_of=AS_OF)
    assert trial_count(con) == n0  # refused before any data is touched


def test_in_sample_never_loads_holdout_data(con):
    hs = holdout.holdout_start(con, AS_OF)
    md = MarketData.load(con, end=hs)
    assert max(s.dates.max() for s in md.series.values()) < np.datetime64(hs, "D")
    assert md.universe["date"].max() < np.datetime64(hs, "D")
    full = MarketData.load(con)
    hid, _ = ledger.register(con, hyp("synthetic_edge"), "test")
    with pytest.raises(events.HoldoutViolation):
        run.backtest(con, hid, md=full, as_of=AS_OF)
    with pytest.raises(events.HoldoutViolation):
        events.guard_window(None, hs, "in")


def test_one_holdout_run_per_family(con):
    hid, _ = ledger.register(con, hyp("synthetic_edge"), "test")
    run.backtest(con, hid, n_placebos=PLACEBOS, as_of=AS_OF)
    run.run_holdout(con, hid, as_of=AS_OF)
    # A tweaked sibling in the same family can't take a second look.
    sib, dup = ledger.register(con, hyp("synthetic_edge", exit={"horizon_days": 4}), "test")
    assert dup == hid
    run.backtest(con, sib, n_placebos=PLACEBOS, as_of=AS_OF)
    with pytest.raises(holdout.HoldoutAlreadyUsed):
        run.run_holdout(con, sib, as_of=AS_OF)


def test_every_variant_and_segment_is_counted(con):
    hid, _ = ledger.register(con, hyp("synthetic_noise"), "test")
    n0 = trial_count(con)
    r = run.backtest(con, hid, n_placebos=5, as_of=AS_OF)
    assert trial_count(con) == n0 + 1 + len(r["segments"])
    assert len(r["segments"]) > 0
    segs = con.execute("SELECT count(*) FROM tests WHERE hypothesis_id = ? AND segment_key IS NOT NULL", [hid]).fetchone()[0]
    assert segs == len(r["segments"])


def test_variant_cap(con):
    hid, _ = ledger.register(con, hyp("synthetic_noise"), "test")
    for h in range(1, 13):
        run.backtest(con, hid, {"exit": {"horizon_days": h}}, n_placebos=2, as_of=AS_OF)
    with pytest.raises(run.VariantLimit):
        run.backtest(con, hid, {"exit": {"horizon_days": 13}}, n_placebos=2, as_of=AS_OF)


def test_delisted_names_stay_in_the_sample(con):
    hs = holdout.holdout_start(con, AS_OF)
    md = MarketData.load(con, end=hs)
    last = md.calendar[-1]
    delisted = [t for t, s in md.series.items() if t.startswith("S") and s.dates[-1] < last]
    assert delisted, "synthetic world should include delisted tickers"
    t = delisted[0]
    s = md.series[t]
    tr = simulate(md, t, s.dates[-3], "open", None, 1e9, hyp("x_y").exit, 50)
    assert tr.ok and tr.exit_reason == "delisted_or_data_end"


# ---- entry timing -------------------------------------------------------------

def _md_for_calendar(con):
    return MarketData.load(con, end=holdout.holdout_start(con, AS_OF))


@pytest.mark.parametrize("local,expect_day,expect_at", [
    ("2024-03-06 07:00", "2024-03-06", "open"),    # pre-market -> same-day open
    ("2024-03-06 12:00", "2024-03-06", "close"),   # intraday -> same-day close
    ("2024-03-06 15:50", "2024-03-07", "open"),    # after cutoff -> next open
    ("2024-03-06 18:00", "2024-03-07", "open"),    # after hours -> next open
    ("2024-03-09 10:00", "2024-03-11", "open"),    # Saturday -> Monday open
])
def test_entry_is_next_tradable_price(con, local, expect_day, expect_at):
    md = _md_for_calendar(con)
    ts = pd.Timestamp(local, tz="America/New_York").tz_convert("UTC")
    k, at = events.entry_point(md, ts, "next_tradable_after_publish")
    assert str(md.calendar[k]) == expect_day and at == expect_at


def test_backfilled_rows_use_modeled_latency():
    pub = pd.Timestamp("2024-03-06 12:00", tz="UTC")
    live = events.decision_time(pub, pub + pd.Timedelta(minutes=10), "edgar")
    back = events.decision_time(pub, pd.Timestamp(datetime(2026, 1, 1, tzinfo=timezone.utc)), "edgar")
    assert live == pub + pd.Timedelta(minutes=10)
    assert back == pub + pd.Timedelta(seconds=60)
