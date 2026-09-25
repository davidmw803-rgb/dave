"""Weekly lessons.md compaction (§10).

Feedback accumulates daily; once a week one LLM call merges it with the
current digest into at most 40 one-line lessons, which researcher and analyzer
prompts carry (``feedback.digest()``, capped at 6,000 characters). The previous
digest is kept as lessons.<date>.md.
"""
from __future__ import annotations

from datetime import date

import duckdb

from sloop import config
from sloop.agents import feedback, llm
from sloop.schemas import LessonsDigest
from sloop.store.duck import audit

MAX_FEEDBACK = 300
CAP_CHARS = 6000


def _since(con: duckdb.DuckDBPyConnection):
    r = con.execute("SELECT CAST(max(ts) AS VARCHAR) FROM audit WHERE action = 'lessons_compact'").fetchone()
    return r[0] if r else None


def render(d: LessonsDigest, day: date) -> str:
    lines = [f"# Lessons (compacted {day})", ""]
    for agent in ("researcher", "analyzer", "orchestrator", "evaluator"):
        items = [x for x in d.lessons if x.agent == agent]
        if not items:
            continue
        lines += [f"## {agent}", ""]
        lines += [f"- {x.lesson}" + (f" _({x.evidence})_" if x.evidence else "") for x in items]
        lines.append("")
    text = "\n".join(lines)
    return text if len(text) <= CAP_CHARS else text[: CAP_CHARS - 20].rsplit("\n", 1)[0] + "\n\n(truncated)\n"


def compact(con: duckdb.DuckDBPyConnection, day: date | None = None, backend: str | None = None) -> dict:
    day = day or date.today()
    since = _since(con)
    q = "SELECT from_agent, to_agent, hypothesis_id, grade, lesson, CAST(created_at AS VARCHAR) AS at FROM feedback"
    rows = con.execute(q + (" WHERE created_at > CAST(? AS TIMESTAMPTZ)" if since else "") + " ORDER BY created_at DESC LIMIT ?",
                       ([since] if since else []) + [MAX_FEEDBACK]).df()
    if rows.empty and feedback.digest() is not None:
        return {"skipped": "no new feedback since the last compaction"}
    ctx = {"as_of": str(day), "current_digest": feedback.digest() or "(none yet)",
           "new_feedback": rows.to_dict("records"), "max_lessons": 40}
    digest, version = llm.run(con, "lessons", "lessons", ctx, LessonsDigest, backend=backend, day=day)
    path = config.data_dir() / "lessons.md"
    if path.exists():
        path.rename(path.with_name(f"lessons.{day}.md"))
    path.write_text(render(digest, day))
    audit(con, "scheduler", "lessons_compact", None, {"lessons": len(digest.lessons), "feedback_rows": len(rows)}, version)
    return {"lessons": len(digest.lessons), "feedback_rows": len(rows), "path": str(path)}
