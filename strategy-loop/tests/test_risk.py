import pytest

from sloop.executor import orders
from sloop.executor.risk import Intent, PortfolioState, Position, check_entry, strategy_drawdown_breached

EQ = 100_000.0


def state(**kw):
    base = dict(equity=EQ, strategy_state={"s1": "paper", "s2": "live_small"})
    base.update(kw)
    return PortfolioState(**base)


def intent(**kw):
    base = dict(strategy_id="s1", ticker="ABC", sector="Industrials", entry_price=50.0, stop_price=48.0)
    base.update(kw)
    return Intent(**base)


def pos(i, strategy="s2", ticker=None, sector="Energy", value=1000.0):
    return Position(strategy, ticker or f"T{i}", sector, value / 10, 10.0)


def test_risk_per_trade_sizes_the_position():
    d = check_entry(intent(), state())
    # Risk alone allows $250 / $2 = 125 shares, but the 5% size cap ($5,000 / $50) binds first.
    assert d.ok and d.qty == 100 and d.reason == "reduced_by_position_size"


def test_wide_stop_is_bound_by_risk_budget():
    d = check_entry(intent(stop_price=40.0), state())
    assert d.ok and d.qty == 25 and d.reason is None  # $250 / $10


def test_strategy_may_ask_for_less_risk_but_not_more():
    assert check_entry(intent(stop_price=40.0, risk_per_trade_pct=0.1), state()).qty == 10
    assert check_entry(intent(stop_price=40.0, risk_per_trade_pct=5.0), state()).qty == 25


@pytest.mark.parametrize("s,reason", [
    (dict(killed=True), "kill_switch"),
    (dict(realized_pnl_today=-2001.0), "daily_loss_halt"),
    (dict(realized_pnl_week=-5001.0), "weekly_loss_halt"),
    (dict(weekly_halt=True), "weekly_loss_halt"),
    (dict(strategy_state={"s1": "backtested"}), "strategy_not_tradeable"),
    (dict(positions=[pos(i, "s1") for i in range(3)]), "strategy_position_cap"),
    (dict(positions=[pos(i) for i in range(10)]), "portfolio_position_cap"),
    (dict(positions=[pos(0, ticker="ABC"), pos(1, ticker="ABC")]), "ticker_cap"),
    (dict(equity=20_000.0, day_trades_5d=3), "pdt_limit"),
])
def test_hard_blocks(s, reason):
    d = check_entry(intent(), state(**s))
    assert not d.ok and d.reason == reason


def test_daily_loss_just_inside_limit_still_trades():
    assert check_entry(intent(), state(realized_pnl_today=-1999.0)).ok


def test_gross_exposure_cap():
    full = [pos(i, value=12_250.0) for i in range(4)]  # 49% gross
    d = check_entry(intent(), state(positions=full))
    assert d.ok and d.qty == 20 and d.reason == "reduced_by_gross_exposure"  # $1,000 left
    d = check_entry(intent(), state(positions=[pos(i, value=12_500.0) for i in range(4)]))
    assert not d.ok and d.reason == "gross_exposure"


def test_sector_cap():
    ind = [pos(i, sector="Industrials", value=12_400.0) for i in range(2)]  # 24.8%
    d = check_entry(intent(), state(positions=ind))
    assert d.ok and d.qty == 4 and d.reason == "reduced_by_sector_cap"


def test_invalid_stop_rejected():
    assert check_entry(intent(stop_price=51.0), state()).reason == "invalid_stop"


def test_drawdown_demotion():
    assert not strategy_drawdown_breached(10_000, 10_500, 9_800)
    assert strategy_drawdown_breached(10_000, 10_500, 9_600)


def test_client_order_ids_are_deterministic():
    a = orders.client_order_id("stg_1", "ev_1", "entry")
    assert a == orders.client_order_id("stg_1", "ev_1", "entry")
    assert a != orders.client_order_id("stg_1", "ev_1", "stop")
    assert a != orders.client_order_id("stg_1", "ev_2", "entry")
    assert len(a) <= 32
