import pytest

from sloop import ledger
from sloop.schemas import Hypothesis


def _h(**kw):
    base = dict(title="small cap contract awards", mechanism="material news in thinly covered names is under-reacted to",
                cell_key="contract_award|all|small",
                signal={"event_type": "contract_award", "filters": {"award_to_mcap_min": 0.2}}, exit={"horizon_days": 5})
    base.update(kw)
    return Hypothesis.model_validate(base)


def test_duplicate_family_is_flagged(mem):
    a, dup_a = ledger.register(mem, _h(), "researcher")
    b, dup_b = ledger.register(mem, _h(signal={"event_type": "contract_award", "filters": {"award_to_mcap_min": 0.3}}), "researcher")
    assert dup_a is None and dup_b == a
    c, dup_c = ledger.register(mem, _h(), "researcher", parent_id=a)
    assert dup_c is None  # revisions are expected to share the family


def test_ladder_cannot_skip_or_be_climbed_by_agents(mem):
    hid, _ = ledger.register(mem, _h(), "researcher")
    with pytest.raises(ledger.LadderError):
        ledger.transition(mem, hid, "backtested", "orchestrator")  # only the harness grades
    with pytest.raises(ledger.LadderError):
        ledger.transition(mem, hid, "holdout_passed", "harness")  # skips a rung
    ledger.transition(mem, hid, "backtested", "harness")
    ledger.transition(mem, hid, "holdout_passed", "harness")
    ledger.transition(mem, hid, "paper", "orchestrator")
    with pytest.raises(ledger.LadderError):
        ledger.transition(mem, hid, "live_small", "orchestrator")  # human gate


def test_real_money_needs_david(mem):
    hid, _ = ledger.register(mem, _h(), "researcher")
    for to, who in (("backtested", "harness"), ("holdout_passed", "harness"), ("paper", "orchestrator")):
        ledger.transition(mem, hid, to, who)
    sid = ledger.freeze_strategy(mem, hid, {}, {"mean_ar_5d": 0.02}, 5.0)
    with pytest.raises(ledger.LadderError):
        ledger.approve_strategy(mem, sid, "live_small", "orchestrator")
    with pytest.raises(ledger.LadderError):
        ledger.approve_strategy(mem, sid, "live", ledger.HUMAN)  # skips live_small
    ledger.approve_strategy(mem, sid, "live_small", ledger.HUMAN, 2.0)
    assert mem.execute("SELECT state, approved_by FROM strategies").fetchone() == ("live_small", "david")
    assert ledger.get(mem, hid)["status"] == "live_small"


def test_killed_hypothesis_cannot_be_revived(mem):
    hid, _ = ledger.register(mem, _h(), "researcher")
    ledger.transition(mem, hid, "killed", "orchestrator")
    with pytest.raises(ledger.LadderError):
        ledger.transition(mem, hid, "backtested", "harness")


def test_frozen_config_is_hashed(mem):
    hid, _ = ledger.register(mem, _h(), "researcher")
    for to, who in (("backtested", "harness"), ("holdout_passed", "harness"), ("paper", "orchestrator")):
        ledger.transition(mem, hid, to, who)
    sid = ledger.freeze_strategy(mem, hid, {}, {"mean_ar_5d": 0.02}, 5.0)
    h = mem.execute("SELECT config_hash FROM strategies WHERE strategy_id = ?", [sid]).fetchone()[0]
    assert len(h) == 16
