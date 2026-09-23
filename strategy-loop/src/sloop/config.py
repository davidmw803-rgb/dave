"""Config loading. Files under config/ are read-only to agents (spec §8.6, §9)."""
from __future__ import annotations

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = Path(os.environ.get("LOOP_CONFIG_DIR", ROOT / "config"))


def data_dir() -> Path:
    d = Path(os.environ.get("LOOP_DATA_DIR") or ROOT / "data")
    d.mkdir(parents=True, exist_ok=True)
    return d


@lru_cache(maxsize=None)
def load(name: str) -> dict[str, Any]:
    """Load config/<name>.yaml. Cached; callers must not mutate the result."""
    with open(CONFIG_DIR / f"{name}.yaml") as f:
        return yaml.safe_load(f)


def config_hash(obj: Any) -> str:
    """Stable short hash for configs and audit rows."""
    blob = json.dumps(obj, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def rules_hash() -> str:
    return config_hash({n: load(n) for n in ("rules", "risk")})
