"""SEC EDGAR filings -> events.

Backfill reads the quarterly form index, which carries a filing *date* but not
an acceptance time. EDGAR dates anything accepted after 17:30 ET to the next
business day, so a date-only filing is stamped 17:30 ET on its filing date:
the latest it could have become public. The harness then enters at the next
open, never earlier than the filing could have been seen.

Fair access: declared User-Agent (SEC_USER_AGENT) and < 10 requests/second.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

import duckdb
import pandas as pd

from sloop import config
from sloop.ingest import http
from sloop.ingest.common import event_id
from sloop.store.duck import upsert_df

ET = ZoneInfo("America/New_York")
FORM_TYPES = {"8-K": "sec_8k", "4": "insider_form4", "S-1": "s1_424b_offering", "424B4": "s1_424b_offering",
              "SC 13D": "activist_13d", "SC 13G": "passive_13g"}
LATE_STAMP = time(17, 30)


def _headers() -> dict[str, str]:
    ua = os.environ.get("SEC_USER_AGENT")
    if not ua:
        raise RuntimeError("SEC_USER_AGENT must be set (name and contact email), per SEC fair-access rules")
    return {"User-Agent": ua, "Accept-Encoding": "identity"}


def _interval() -> float:
    return 1.0 / config.load("sources")["sources"]["edgar"]["max_requests_per_second"]


def cik_tickers() -> dict[int, str]:
    """CIK -> ticker. Current listings only: delisted issuers must come from a vendor map."""
    body = http.get_json("https://www.sec.gov/files/company_tickers.json", headers=_headers(), min_interval=_interval())
    return {int(v["cik_str"]): v["ticker"] for v in body.values()}


def parse_form_index(text: str) -> pd.DataFrame:
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith("---")) + 1
    header = lines[start - 2]
    cols = [header.index(h) for h in ("Form Type", "Company Name", "CIK", "Date Filed", "File Name")] + [None]
    recs = []
    for l in lines[start:]:
        if not l.strip():
            continue
        f = [l[cols[i]:cols[i + 1]].strip() for i in range(5)]
        recs.append({"form": f[0], "company": f[1], "cik": int(f[2]), "date_filed": f[3], "path": f[4]})
    return pd.DataFrame(recs)


def backfill_quarter(con: duckdb.DuckDBPyConnection, year: int, quarter: int, tickers: dict[int, str] | None = None) -> int:
    raw = http.get(f"https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{quarter}/form.idx",
                   headers=_headers(), min_interval=_interval()).decode("latin-1")
    idx = parse_form_index(raw)
    idx = idx[idx["form"].isin(FORM_TYPES)]
    tickers = tickers or cik_tickers()
    now = datetime.now(timezone.utc)
    rows = []
    for r in idx.itertuples(index=False):
        t = tickers.get(r.cik)
        if not t:
            continue
        pub = datetime.combine(datetime.fromisoformat(r.date_filed).date(), LATE_STAMP, ET).astimezone(timezone.utc)
        rows.append({"event_id": event_id("edgar", r.path), "source": "edgar", "source_id": r.path,
                     "type": FORM_TYPES[r.form], "ticker": t, "ts_published": pub, "ts_ingested": now,
                     "payload_json": json.dumps({"form": r.form, "cik": r.cik, "company": r.company, "path": r.path,
                                                 "time_precision": "date"})})
    return upsert_df(con, "events", pd.DataFrame(rows))
