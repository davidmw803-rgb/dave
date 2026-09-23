from __future__ import annotations

import hashlib


def event_id(source: str, source_id: str) -> str:
    """Stable ID so re-ingesting the same source row replaces rather than duplicates it."""
    return "ev_" + hashlib.sha256(f"{source}|{source_id}".encode()).hexdigest()[:20]
