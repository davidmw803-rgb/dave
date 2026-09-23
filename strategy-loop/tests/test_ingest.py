from datetime import datetime, timezone

from sloop.ingest import edgar, uw

FORM_IDX = """Description:           Master Index of EDGAR Dissemination Feed by Form Type
Last Data Received:    March 31, 2024

Form Type   Company Name                                                  CIK         Date Filed  File Name
---------------------------------------------------------------------------------------------------------------------------------------------
8-K         ACME CORP                                                     1234567     2024-01-05  edgar/data/1234567/0001234567-24-000001.txt
4           ACME CORP                                                     1234567     2024-01-08  edgar/data/1234567/0001234567-24-000002.txt
"""


def test_form_index_parse():
    df = edgar.parse_form_index(FORM_IDX)
    assert list(df["form"]) == ["8-K", "4"] and df["cik"].iloc[0] == 1234567 and df["date_filed"].iloc[1] == "2024-01-08"


def test_uw_rows_become_stable_events():
    rows = [{"ticker": "abc", "firm": "F", "analyst_name": "A", "action": "initiated", "recommendation": "buy",
             "target": "42", "timestamp": "2024-03-06T12:01:00Z"}, {"ticker": None, "timestamp": "2024-01-01"}]
    now = datetime.now(timezone.utc)
    a, b = uw.to_events(rows, now), uw.to_events(rows, now)
    assert len(a) == 1 and a["type"].iloc[0] == "analyst_initiation" and a["ticker"].iloc[0] == "ABC"
    assert a["event_id"].iloc[0] == b["event_id"].iloc[0]
