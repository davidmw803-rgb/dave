import json
from datetime import date, datetime, timezone

import pandas as pd

from sloop.coverage import map as cov
from sloop.store.duck import upsert_df


def test_event_counts_use_the_as_of_universe(mem):
    upsert_df(mem, "universe_pit", pd.DataFrame([
        {"ticker": "ABC", "date": date(2024, 1, 2), "mcap": 1e9, "sector": "Energy", "industry": None, "avg_dollar_vol_20d": 1e7, "listed": True},
        {"ticker": "ABC", "date": date(2024, 6, 3), "mcap": 5e9, "sector": "Energy", "industry": None, "avg_dollar_vol_20d": 1e7, "listed": True},
    ]))
    ev = [{"event_id": f"e{i}", "source": "uw", "source_id": str(i), "type": "analyst_initiation", "ticker": "ABC",
           "ts_published": datetime(2024, m, 10, 15, tzinfo=timezone.utc), "ts_ingested": None, "payload_json": json.dumps({})}
          for i, m in enumerate((3, 4, 7))]
    upsert_df(mem, "events", pd.DataFrame(ev))
    counts = cov.estimate_event_counts(mem)
    assert counts[("analyst_initiation", "Energy", "small")] == 2  # March, April: $1B then
    assert counts[("analyst_initiation", "Energy", "mid")] == 1    # July: $5B by then
    assert counts[("analyst_initiation", "all", "all")] == 3
    assert cov.seed(mem) > 0 and cov.seed(mem) == 0  # idempotent


def test_record_test_updates_state(mem):
    cov.seed(mem)
    key = cov.cell_key("insider_buy")
    cov.record_test(mem, key, "tst_1", False, -0.01)
    assert mem.execute("SELECT state, n_tests FROM coverage WHERE cell_key = ?", [key]).fetchone() == ("tested_fail", 1)
