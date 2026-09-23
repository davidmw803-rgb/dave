"""Minimal HTTP with a per-host pacer and retry on 429/5xx. Keys never appear in logs."""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

_lock = threading.Lock()
_next_slot: dict[str, float] = {}


def get(url: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
        min_interval: float = 0.12, retries: int = 4, timeout: float = 30) -> bytes:
    if params:
        q = {k: v for k, v in params.items() if v not in (None, "")}
        url = f"{url}?{urllib.parse.urlencode(q)}"
    host = urllib.parse.urlparse(url).netloc
    for attempt in range(retries + 1):
        with _lock:
            at = max(time.monotonic(), _next_slot.get(host, 0.0))
            _next_slot[host] = at + min_interval
        time.sleep(max(0.0, at - time.monotonic()))
        req = urllib.request.Request(url, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise RuntimeError(f"GET {urllib.parse.urlparse(url).path} -> HTTP {e.code}") from None
            retry_after = e.headers.get("Retry-After")
            time.sleep(min(float(retry_after), 30) if retry_after and retry_after.isdigit() else 0.5 * 2 ** attempt)
    raise AssertionError("unreachable")


def get_json(url: str, **kw: Any) -> Any:
    return json.loads(get(url, **kw))
