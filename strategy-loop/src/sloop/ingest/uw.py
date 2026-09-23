"""Unusual Whales analyst ratings -> events.

Endpoint: GET /api/screener/analysts (newest first, <= 500 rows per call),
paged backwards with ``older_than``. Same endpoint the web app uses
(lib/uw/client.ts).
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import duckdb
import pandas as pd

from sloop.ingest import http
from sloop.ingest.common import event_id
from sloop.store.duck import upsert_df

ACTION_TYPES = {"initiated": "analyst_initiation", "upgraded": "analyst_upgrade", "downgraded": "analyst_downgrade",
                "reiterated": "analyst_reiteration", "maintained": "analyst_maintained"}


def _headers() -> dict[str, str]:
    key = os.environ.get("UW_API_KEY")
    if not key:
        raise RuntimeError("UW_API_KEY is not set")
    return {"Authorization": f"Bearer {key}", "Accept": "application/json"}


def _base() -> str:
    return os.environ.get("UW_API_BASE_URL", "https://api.unusualwhales.com").rstrip("/")


def to_events(rows: list[dict], ingested: datetime) -> pd.DataFrame:
    out = []
    for r in rows:
        ts, ticker = r.get("timestamp"), r.get("ticker")
        if not ts or not ticker:
            continue
        pub = pd.Timestamp(ts)
        pub = pub.tz_localize("UTC") if pub.tzinfo is None else pub.tz_convert("UTC")
        action = (r.get("action") or "").lower()
        sid = f"{ticker}|{r.get('firm')}|{r.get('analyst_name')}|{action}|{pub.isoformat()}"
        payload = {k: r.get(k) for k in ("firm", "analyst_name", "recommendation", "action", "target", "sector")}
        try:
            payload["target"] = float(payload["target"]) if payload["target"] not in (None, "") else None
        except (TypeError, ValueError):
            payload["target"] = None
        out.append({"event_id": event_id("uw", sid), "source": "uw", "source_id": sid,
                    "type": ACTION_TYPES.get(action, f"analyst_{action or 'unknown'}"), "ticker": ticker.upper(),
                    "ts_published": pub.to_pydatetime(), "ts_ingested": ingested, "payload_json": json.dumps(payload)})
    return pd.DataFrame(out)


def backfill_analysts(con: duckdb.DuckDBPyConnection, newer_than: str, older_than: str | None = None,
                      action: str | None = None, max_pages: int = 1000) -> int:
    written, cursor = 0, older_than
    for _ in range(max_pages):
        body = http.get_json(f"{_base()}/api/screener/analysts", headers=_headers(),
                             params={"newer_than": newer_than, "older_than": cursor, "action": action, "limit": 500})
        rows = body.get("data") or []
        if not rows:
            break
        written += upsert_df(con, "events", to_events(rows, datetime.now(timezone.utc)))
        oldest = min(r["timestamp"] for r in rows if r.get("timestamp"))
        if oldest == cursor or len(rows) < 500:
            break
        cursor = oldest
    return written
