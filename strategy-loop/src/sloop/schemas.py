"""Structured I/O for every agent (spec §7, §11).

Agent output is validated against these models before anything reads it.
Free-text fields (title, mechanism, lesson...) are stored and displayed only:
never executed, never used as paths, commands or SQL.
"""
from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Status = Literal["proposed", "backtested", "holdout_passed", "paper", "live_small", "live", "failed", "killed"]
LADDER: tuple[str, ...] = ("proposed", "backtested", "holdout_passed", "paper", "live_small", "live")

_SAFE_KEY = re.compile(r"^[a-z0-9_]{1,64}$")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Signal(_Strict):
    event_type: str = Field(pattern=r"^[a-z0-9_]{1,64}$")
    # Keys are "<field>_min", "<field>_max", "<field>_in" or "<field>_eq".
    filters: dict[str, Any] = Field(default_factory=dict)

    @field_validator("filters")
    @classmethod
    def _keys_are_identifiers(cls, v: dict[str, Any]) -> dict[str, Any]:
        for k in v:
            if not _SAFE_KEY.match(k):
                raise ValueError(f"filter key {k!r} is not a plain identifier")
        return v


class Entry(_Strict):
    timing: Literal["next_tradable_after_publish", "next_open"] = "next_tradable_after_publish"
    max_gap_pct: float = Field(default=15, gt=0, le=100)


class Exit(_Strict):
    horizon_days: int = Field(ge=1, le=60)
    stop_atr_mult: float | None = Field(default=None, gt=0, le=10)
    take_profit_pct: float | None = Field(default=None, gt=0, le=200)


class Expected(_Strict):
    direction: Literal["long"] = "long"  # v1 is long-only (§17)
    min_abnormal_return_5d: float = 0.0


class Hypothesis(_Strict):
    """Researcher output (§7.1)."""

    title: str = Field(min_length=5, max_length=200)
    mechanism: str = Field(min_length=20, max_length=2000)
    cell_key: str = Field(pattern=r"^[a-z0-9_]+\|[^|]+\|[a-z]+$")
    signal: Signal
    universe: str = "us_equities"
    entry: Entry = Field(default_factory=Entry)
    exit: Exit
    expected: Expected = Field(default_factory=Expected)
    sources: list[str] = Field(default_factory=list)
    regime_filter: str | None = None

    def family_key(self) -> str:
        """Hypotheses differing only in numeric thresholds share a family.

        The family is the event type plus the *set* of filter fields and the
        cell. Variants (different thresholds, exits) are trials within it and
        share one holdout run.
        """
        fields = sorted({k.rsplit("_", 1)[0] for k in self.signal.filters})
        return f"{self.signal.event_type}|{','.join(fields)}|{self.cell_key}|{self.regime_filter or '-'}"


class StrategyConfig(_Strict):
    """Executor input, frozen and hashed at promotion (§7.2)."""

    strategy_id: str
    hypothesis_id: str
    signal: Signal
    entry: dict[str, Any]
    exit: dict[str, Any]
    sizing: dict[str, Any] = Field(default_factory=lambda: {"method": "fixed_fraction", "risk_per_trade_pct": 0.25})
    regime_filter: str | None = None
    expected: dict[str, float]

    model_config = ConfigDict(extra="forbid", frozen=True)


# ---- orchestrator output (§3.1) -------------------------------------------------

class ResearchTask(_Strict):
    source: str
    question: str = Field(max_length=1000)
    cell_key: str | None = None
    priority: int = Field(ge=1, le=5)


class Revision(_Strict):
    parent_id: str
    change: str = Field(max_length=1000)


class FeedbackItem(_Strict):
    agent: Literal["researcher", "analyzer", "evaluator"]
    hypothesis_id: str | None = None
    grade: Literal["good", "bad", "neutral"]
    lesson: str = Field(max_length=500)


class OrchestratorPlan(_Strict):
    research_tasks: list[ResearchTask] = Field(default_factory=list)
    test_queue: list[str] = Field(default_factory=list)
    # Orchestrator may only promote holdout_passed -> paper. Higher rungs are human-gated.
    promotions: list[str] = Field(default_factory=list)
    kills: list[str] = Field(default_factory=list)
    revisions: list[Revision] = Field(default_factory=list)
    feedback: list[FeedbackItem] = Field(default_factory=list)


class ResearcherOutput(_Strict):
    hypotheses: list[Hypothesis] = Field(default_factory=list, max_length=5)


class AnalyzerFindings(_Strict):
    hypothesis_id: str
    variants: list[dict[str, Any]] = Field(max_length=12)
    interpretation: str = Field(max_length=3000)
    suspected_confounds: list[str] = Field(default_factory=list)


class EvaluatorVerdict(_Strict):
    strategy_id: str
    verdict: Literal["keep", "resize", "revise", "kill"]
    attribution: Literal["execution", "signal", "regime_decay", "none"]
    wrong_assumption: str | None = Field(default=None, max_length=500)
    lesson: str = Field(max_length=500)

    @model_validator(mode="after")
    def _needs_reason(self) -> "EvaluatorVerdict":
        if self.verdict != "keep" and not self.wrong_assumption:
            raise ValueError("non-keep verdicts must name the wrong parameter or assumption")
        return self
