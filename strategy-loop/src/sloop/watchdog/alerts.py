"""Alerts (§14): hot-store row + log line, plus a push to ``LOOP_ALERT_WEBHOOK`` if set.

The webhook gets a JSON POST ``{"title", "message", "level"}``; an ntfy.sh topic
URL or a Slack/Discord-compatible relay both work. The same key is sent at
most once per ``alert_dedupe_minutes``.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import urllib.request
from datetime import datetime, timedelta, timezone

from sloop import config
from sloop.store import hot

log = logging.getLogger("sloop.alerts")


def alert(con: sqlite3.Connection, key: str, message: str, level: str = "warn", now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    window = timedelta(minutes=config.load("risk")["watchdog"]["alert_dedupe_minutes"])
    last = hot.one(con, "SELECT ts FROM alerts WHERE key = ? ORDER BY alert_id DESC LIMIT 1", [key])
    if last and datetime.fromisoformat(last["ts"]) > now - window:
        return False
    sent = _push(key, message, level)
    con.execute("INSERT INTO alerts (ts, key, level, message, sent) VALUES (?, ?, ?, ?, ?)",
                [now.isoformat(), key, level, message[:2000], int(sent)])
    log.warning("ALERT [%s] %s: %s", level, key, message)
    try:
        with open(config.data_dir() / "alerts.log", "a") as f:
            f.write(f"{now.isoformat()} {level} {key} {message}\n")
    except OSError:
        pass
    return True


def _push(key: str, message: str, level: str) -> bool:
    url = os.environ.get("LOOP_ALERT_WEBHOOK")
    if not url:
        return False
    body = json.dumps({"title": f"strategy-loop: {key}", "message": message, "level": level}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10):
            return True
    except OSError:
        return False
