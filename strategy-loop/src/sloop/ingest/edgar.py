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
import re
import xml.etree.ElementTree as ET_XML
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


def accession(path_or_id: str) -> str:
    """Accession number (0001234567-24-000001) from an index path, URL or feed id."""
    m = re.search(r"(\d{10}-\d{2}-\d{6})", path_or_id)
    return m.group(1) if m else path_or_id


def parse_current_feed(xml: str, tickers: dict[int, str]) -> pd.DataFrame:
    """EDGAR 'getcurrent' Atom feed -> events stamped with the acceptance time.

    Form 4 appears once per reporting owner and once for the issuer; the issuer
    entry is kept so each filing becomes one event on the issuer's ticker.
    """
    ns = {"a": "http://www.w3.org/2005/Atom"}
    root = ET_XML.fromstring(xml)
    now = datetime.now(timezone.utc)
    out = []
    for e in root.findall("a:entry", ns):
        title = (e.findtext("a:title", default="", namespaces=ns) or "").strip()
        m = re.match(r"^(.+?) - (.+) \((\d{10})\) \((\w+)\)$", title)
        if not m:
            continue
        form, company, cik, role = m.group(1).strip(), m.group(2), int(m.group(3)), m.group(4)
        if form not in FORM_TYPES or (form == "4" and role != "Issuer"):
            continue
        t = tickers.get(cik)
        acc = accession(e.findtext("a:id", default="", namespaces=ns) or "")
        updated = e.findtext("a:updated", default="", namespaces=ns)
        if not t or not updated or not acc:
            continue
        pub = datetime.fromisoformat(updated).astimezone(timezone.utc)
        link = e.find("a:link", ns)
        out.append({"event_id": event_id("edgar", acc), "source": "edgar", "source_id": acc, "type": FORM_TYPES[form],
                    "ticker": t, "ts_published": pub, "ts_ingested": now,
                    "payload_json": json.dumps({"form": form, "cik": cik, "company": company, "accession": acc,
                                                "url": link.get("href") if link is not None else None,
                                                "time_precision": "second"})})
    return pd.DataFrame(out)


def fetch_current(form: str, tickers: dict[int, str]) -> pd.DataFrame:
    xml = http.get("https://www.sec.gov/cgi-bin/browse-edgar", headers=_headers(), min_interval=_interval(),
                   params={"action": "getcurrent", "type": form, "owner": "include", "count": 100, "output": "atom"})
    return parse_current_feed(xml.decode("utf-8", "replace"), tickers)


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
        acc = accession(r.path)
        rows.append({"event_id": event_id("edgar", acc), "source": "edgar", "source_id": acc,
                     "type": FORM_TYPES[r.form], "ticker": t, "ts_published": pub, "ts_ingested": now,
                     "payload_json": json.dumps({"form": r.form, "cik": r.cik, "company": r.company, "path": r.path,
                                                 "time_precision": "date"})})
    return upsert_df(con, "events", pd.DataFrame(rows))
