import plistlib
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from sloop import clock, scheduler
from sloop.cli import main
from sloop.store import hot


def et(s):
    return pd.Timestamp(s, tz="America/New_York").to_pydatetime()


@pytest.mark.parametrize("name,when,last,expect", [
    ("orchestrator", "2026-09-28 07:00", None, True),          # Monday 07:00 ET
    ("orchestrator", "2026-09-28 07:44", None, True),          # launchd firing late after sleep: within grace
    ("orchestrator", "2026-09-28 07:46", None, False),         # past the grace window
    ("orchestrator", "2026-09-28 06:59", None, False),
    ("orchestrator", "2026-09-28 07:05", "2026-09-28", False),  # the other DST slot fired already
    ("orchestrator", "2026-09-26 07:00", None, False),         # Saturday
    ("eod", "2026-11-26 16:30", None, False),                  # Thanksgiving: trading-day job
    ("wakeups", "2026-09-28 10:10", None, True),
    ("wakeups", "2026-09-28 16:10", None, False),
    ("wakeups", "2026-11-27 13:10", None, False),              # early close
    ("flush", "2026-09-27 03:30", None, True),                 # Sunday night is fine for flush
    ("weekly_research", "2026-09-26 09:00", None, True),
    ("holdout_roll", "2026-10-01 06:10", None, True),
    ("holdout_roll", "2026-11-01 06:10", None, False),
])
def test_guard(name, when, last, expect):
    assert scheduler.due(scheduler.get(name), et(when), last)[0] is expect


def test_launchd_slots_cover_both_dst_offsets():
    job = scheduler.get("orchestrator")
    utc = scheduler.local_slots(job, ZoneInfo("UTC"), 2026)
    assert {(h, m) for _, h, m in utc} == {(11, 0), (12, 0)} and {w for w, _, _ in utc} == {1, 2, 3, 4, 5}
    ny = scheduler.local_slots(job, ZoneInfo("America/New_York"), 2026)
    assert ny == [(w, 7, 0) for w in (1, 2, 3, 4, 5)]
    tokyo = scheduler.local_slots(scheduler.get("eod"), ZoneInfo("Asia/Tokyo"), 2026)
    assert {w for w, _, _ in tokyo} == {2, 3, 4, 5, 6}  # 16:30 ET lands on the next local day


def test_units_are_well_formed(tmp_path, monkeypatch):
    monkeypatch.setenv("TZ", "UTC")
    mac = scheduler.launchd_units()
    assert set(mac) >= {f"com.strategyloop.{s}.plist" for s in scheduler.SERVICES}
    svc = plistlib.loads(mac["com.strategyloop.executor.plist"])
    assert svc["KeepAlive"] is True and svc["ProgramArguments"][-2:] == ["serve", "executor"]
    job = plistlib.loads(mac["com.strategyloop.job-orchestrator.plist"])
    assert len(job["StartCalendarInterval"]) == 10 and job["ProgramArguments"][-2:] == ["job", "orchestrator"]
    assert plistlib.loads(mac["com.strategyloop.job-wakeups.plist"])["StartInterval"] == 600
    assert "com.strategyloop.job-evaluator.plist" not in mac  # disabled until Phase 4
    lin = scheduler.systemd_units()
    assert "Restart=always" in lin["sloop-watchdog.service"]
    assert "OnCalendar=Mon,Tue,Wed,Thu,Fri *-*-* 07:00:00 America/New_York" in lin["sloop-job-orchestrator.timer"]
    assert "Persistent=true" in lin["sloop-job-eod.timer"]
    for body in list(lin.values()):
        assert "UW_API_KEY" not in body  # secrets stay in .env, read at runtime


def test_install_and_uninstall_write_and_remove_units(tmp_path):
    out = tmp_path / "units"
    (out).mkdir()
    (out / "sloop-job-retired.timer").write_text("[Timer]\n")
    cmds = scheduler.install("linux", out, load=False)
    assert not (out / "sloop-job-retired.timer").exists()
    assert any("disable --now sloop-job-retired.timer" in c for c in cmds)
    assert any(c.startswith("systemctl --user enable --now") and "sloop-executor.service" in c for c in cmds)
    assert len(list(out.iterdir())) == 3 + 2 * len(scheduler.jobs())
    scheduler.uninstall("linux", out, load=False)
    assert list(out.iterdir()) == []
    cmds = scheduler.install("macos", out, load=False)
    assert any("launchctl bootstrap gui/" in c for c in cmds) and len(list(out.glob("*.plist"))) == 3 + len(scheduler.jobs())


def test_job_command_runs_once_per_day(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("LOOP_HOT_PATH", str(tmp_path / "hot.sqlite"))
    db = str(tmp_path / "l.duckdb")
    now = [et("2026-09-28 23:00")]
    monkeypatch.setattr(clock.Clock, "et", lambda self: now[0])
    assert main(["--db", db, "job", "backup"]) == 0
    assert "run `loop backup`" in capsys.readouterr().out
    assert hot.get_cursor(hot.connect(), "job:backup") == "2026-09-28"
    now[0] = et("2026-09-28 23:10")
    main(["--db", db, "job", "backup"])
    assert "skip (already ran today)" in capsys.readouterr().out
    now[0] = et("2026-09-28 12:00")
    main(["--db", db, "job", "orchestrator"])
    assert "skip (outside 07:00 ET" in capsys.readouterr().out


def test_dotenv_is_loaded_without_overriding(tmp_path, monkeypatch):
    from sloop.cli import load_dotenv
    env = tmp_path / ".env"
    env.write_text('# comment\nUW_API_KEY="abc"\nSEC_USER_AGENT=\nLLM_BACKEND=api\n')
    monkeypatch.delenv("UW_API_KEY", raising=False)
    monkeypatch.setenv("LLM_BACKEND", "fake")
    load_dotenv(env)
    import os
    assert os.environ["UW_API_KEY"] == "abc" and os.environ["LLM_BACKEND"] == "fake"
    assert "SEC_USER_AGENT" not in os.environ or os.environ["SEC_USER_AGENT"]
