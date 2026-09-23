"""Event selection with point-in-time timing (spec §6.2).

Every event gets a *decision time*: the earliest moment the system could
realistically have acted on it. For live-ingested rows that is
``max(ts_published, ts_ingested)``; for backfilled rows (ingested long after
publication) ``ts_ingested`` is meaningless, so it is replaced by
``ts_published + source latency`` from config/sources.yaml. Entry is the next
tradable price strictly after the decision time.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import duckdb
import numpy as np
import pandas as pd

from sloop import config
from sloop.harness.market import MarketData
from sloop.schemas import Hypothesis

ET = ZoneInfo("America/New_York")
OPEN = time(9, 30)


class LookAheadError(ValueError):
    """A config asked for information not available at decision time."""


class HoldoutViolation(PermissionError):
    """An in-sample query reached into the locked holdout."""


# Filter fields that would describe what happened *after* the event.
_FORWARD = re.compile(r"^(fwd|future|forward|post|next|ret|return|outcome|realized)(_|$)|_(after|fwd|forward|future)(_|$)")
# Fields resolved from universe_pit (as of the prior day), not the payload.
_UNIVERSE_FIELDS = {"mcap": "mcap", "avg_dollar_vol": "avg_dollar_vol_20d", "sector": "sector",
                    "industry": "industry", "cap_bucket": "cap_bucket"}
_OPS = ("min", "max", "in", "eq")


def cap_bucket(mcap: float | None) -> str | None:
    if mcap is None or not np.isfinite(mcap):
        return None
    for name, (lo, hi) in config.load("coverage")["cap_buckets"].items():
        if float(lo) <= mcap < float(hi):
            return name
    return None


def parse_filters(filters: dict[str, Any]) -> list[tuple[str, str, Any]]:
    """Split {'mcap_max': 2e9} into [('mcap', 'max', 2e9)] and refuse forward-looking fields."""
    out = []
    for key, val in filters.items():
        field, _, op = key.rpartition("_")
        if op not in _OPS or not field:
            raise ValueError(f"filter {key!r} must end in one of {_OPS}")
        if _FORWARD.search(field):
            raise LookAheadError(f"filter {key!r} references post-event information")
        out.append((field, op, val))
    return out


def _resolve(field: str, payload: dict, uni: dict) -> Any:
    if field in _UNIVERSE_FIELDS:
        return uni.get(_UNIVERSE_FIELDS[field])
    if field.endswith("_to_mcap"):
        base = field[: -len("_to_mcap")]
        num = payload.get(f"{base}_amount", payload.get(base))
        mcap = uni.get("mcap")
        try:
            return float(num) / float(mcap) if num is not None and mcap else None
        except (TypeError, ValueError):
            return None
    return payload.get(field)


def _passes(filters: list[tuple[str, str, Any]], payload: dict, uni: dict) -> bool:
    for field, op, want in filters:
        got = _resolve(field, payload, uni)
        if got is None:
            return False
        try:
            if op == "min" and not float(got) >= float(want):
                return False
            if op == "max" and not float(got) <= float(want):
                return False
        except (TypeError, ValueError):
            return False
        if op == "in" and got not in want:
            return False
        if op == "eq" and got != want:
            return False
    return True


def decision_time(ts_published: pd.Timestamp, ts_ingested: pd.Timestamp | None, source: str) -> pd.Timestamp:
    srcs = config.load("sources")
    latency = timedelta(seconds=srcs["sources"].get(source, {}).get("latency_seconds", 300))
    backfill = timedelta(hours=srcs["backfill_threshold_hours"])
    modeled = ts_published + latency
    if ts_ingested is None or pd.isna(ts_ingested) or ts_ingested - ts_published > backfill:
        return modeled
    return max(modeled, ts_ingested)


def entry_point(md: MarketData, decided: pd.Timestamp, timing: str) -> tuple[int, str] | None:
    """(calendar index, 'open'|'close') of the first tradable price after ``decided``."""
    local = decided.tz_convert(ET)
    d = np.datetime64(local.date(), "D")
    cutoff = time.fromisoformat(config.load("rules")["backtest"]["same_day_close_cutoff"])
    k = md.next_trading_day(d, inclusive=True)
    if k >= len(md.calendar):
        return None
    is_today = md.calendar[k] == d
    t = local.time()
    if is_today and t < OPEN:
        return k, "open"
    if is_today and timing == "next_tradable_after_publish" and t < cutoff:
        return k, "close"
    k = md.next_trading_day(d, inclusive=False)
    return (k, "open") if k < len(md.calendar) else None


def guard_window(end: date | None, holdout_start: date, sample: str) -> None:
    if sample == "in" and (end is None or end > holdout_start):
        raise HoldoutViolation(f"in-sample window must end on or before holdout_start={holdout_start}")


def select(con: duckdb.DuckDBPyConnection, md: MarketData, hyp: Hypothesis,
           start: date | None, end: date) -> pd.DataFrame:
    """Events matching the hypothesis, with point-in-time features and entry points.

    Only events whose decision date is in [start, end) are returned; ``end``
    must already have been checked by :func:`guard_window`.
    """
    filters = parse_filters(hyp.signal.filters)
    params: list[Any] = [hyp.signal.event_type, datetime.combine(end, time()) + timedelta(days=1)]
    q = "SELECT event_id, source, ticker, ts_published, ts_ingested, payload_json FROM events WHERE type = ? AND ts_published < ?"
    if start is not None:
        q += " AND ts_published >= ?"
        params.append(datetime.combine(start, time()) - timedelta(days=2))
    ev = con.execute(q + " ORDER BY ts_published", params).df()

    rows = []
    for r in ev.itertuples(index=False):
        pub = pd.Timestamp(r.ts_published)
        pub = pub.tz_localize("UTC") if pub.tzinfo is None else pub
        ing = pd.Timestamp(r.ts_ingested) if r.ts_ingested is not None and not pd.isna(r.ts_ingested) else None
        if ing is not None and ing.tzinfo is None:
            ing = ing.tz_localize("UTC")
        decided = decision_time(pub, ing, r.source)
        ddate = decided.tz_convert(ET).date()
        if ddate >= end or (start is not None and ddate < start):
            continue
        ep = entry_point(md, decided, hyp.entry.timing)
        if ep is None:
            continue
        k, at = ep
        entry_day = md.calendar[k]
        # Features must be known before the decision: universe row dated before the decision day.
        uni = md.universe_asof(r.ticker, np.datetime64(ddate, "D"))
        if uni is None:
            continue
        uni["cap_bucket"] = cap_bucket(uni.get("mcap"))
        if uni["date"] >= np.datetime64(ddate, "D"):
            raise LookAheadError(f"universe row {uni['date']} not before decision {ddate}")
        payload = r.payload_json if isinstance(r.payload_json, dict) else json.loads(r.payload_json or "{}")
        if not _passes(filters, payload, uni):
            continue
        regime = md.regime_asof(np.datetime64(ddate, "D"))
        if hyp.regime_filter and regime != hyp.regime_filter:
            continue
        rows.append({
            "event_id": r.event_id, "ticker": r.ticker, "decided": decided, "decision_date": np.datetime64(ddate, "D"),
            "cal_idx": k, "entry_date": entry_day, "entry_at": at,
            "sector": uni.get("sector"), "cap_bucket": uni["cap_bucket"], "mcap": uni.get("mcap"),
            "adv": uni.get("avg_dollar_vol_20d"), "regime": regime,
        })
    return pd.DataFrame(rows)
