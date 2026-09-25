"""Process supervision and the slow-loop schedule (§4, §14).

`loop install` writes and loads:
- one always-on unit per service (ingest, executor, watchdog), restarted on exit;
- one timer per enabled job in config/schedule.yaml, each calling `loop job <name>`.

launchd has no timezone support, so a job's plist fires at every local time
that could be its ET time (e.g. both 11:00 and 12:00 on a UTC host for a 07:00
ET job). :func:`due` then decides from the ET clock whether to run, and at most
once per ET day for ``at`` jobs. The same guard runs under systemd, whose
timers carry ``America/New_York`` directly. Jobs missed while the machine
slept run on wake if still within ``GRACE``.
"""
from __future__ import annotations

import os
import plistlib
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from sloop import clock, config

SERVICES = ("ingest", "executor", "watchdog")
LABEL = "com.strategyloop"
UNIT = "sloop"
GRACE = timedelta(minutes=45)
DAYS = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6}


@dataclass
class Job:
    name: str
    cmd: str
    at: str | None = None
    every_minutes: int | None = None
    window: list[str] | None = None
    days: list[int] = field(default_factory=lambda: list(range(7)))
    trading_day: bool = False
    months: list[int] | None = None
    day_of_month: int | None = None


def _days(spec) -> list[int]:
    if spec in (None, "all"):
        return list(range(7))
    if spec == "weekdays":
        return list(range(5))
    return [DAYS[d] for d in spec]


def jobs(include_disabled: bool = False) -> list[Job]:
    out = []
    for name, j in config.load("schedule")["jobs"].items():
        if not j.get("enabled", True) and not include_disabled:
            continue
        out.append(Job(name, j["cmd"], j.get("at"), j.get("every_minutes"), j.get("window"), _days(j.get("days")),
                       bool(j.get("trading_day")), j.get("months"), j.get("day_of_month")))
    return out


def get(name: str) -> Job:
    for j in jobs(include_disabled=True):
        if j.name == name:
            return j
    raise KeyError(name)


# ---- the guard ----------------------------------------------------------------------

def due(job: Job, now_et: datetime, last_run: str | None) -> tuple[bool, str]:
    """Should ``job`` run now? Returns (run, reason)."""
    d = now_et.date()
    if d.weekday() not in job.days:
        return False, "not a scheduled day"
    if job.trading_day and not clock.is_trading_day(d):
        return False, "market closed today"
    if job.months and d.month not in job.months:
        return False, "not a scheduled month"
    if job.day_of_month and d.day != job.day_of_month:
        return False, "not the scheduled day of month"
    if job.at:
        start = datetime.combine(d, time.fromisoformat(job.at), clock.ET)
        if not start <= now_et < start + GRACE:
            return False, f"outside {job.at} ET (+{int(GRACE.total_seconds() // 60)} min)"
        if last_run == d.isoformat():
            return False, "already ran today"
        return True, "due"
    if job.window:
        lo, hi = (time.fromisoformat(x) for x in job.window)
        inside = clock.within(now_et, job.window) if job.trading_day else lo <= now_et.time() <= hi
        if not inside:
            return False, f"outside {job.window[0]}-{job.window[1]} ET"
    return True, "due"


# ---- local times for launchd ------------------------------------------------------------

def local_zone() -> ZoneInfo:
    """The host's IANA zone: $TZ, else the /etc/localtime link, else UTC."""
    name = os.environ.get("TZ", "").lstrip(":")
    if not name:
        try:
            target = os.path.realpath("/etc/localtime")
            name = target.split("zoneinfo/", 1)[1] if "zoneinfo/" in target else ""
        except OSError:
            name = ""
    try:
        return ZoneInfo(name or "UTC")
    except (KeyError, ValueError):
        return ZoneInfo("UTC")


def local_slots(job: Job, tz: ZoneInfo, year: int | None = None) -> list[tuple[int, int, int]]:
    """(launchd weekday 0=Sun, hour, minute) for every local time the ET schedule can land on."""
    if not job.at:
        return []
    year = year or date.today().year
    hh, mm = map(int, job.at.split(":"))
    slots = set()
    for ref in (date(year, 1, 12), date(year, 7, 12)):  # a Monday-anchored week in EST and in EDT
        monday = ref - timedelta(days=ref.weekday())
        for wd in job.days:
            et_dt = datetime(monday.year, monday.month, monday.day, hh, mm, tzinfo=clock.ET) + timedelta(days=wd)
            loc = et_dt.astimezone(tz)
            slots.add(((loc.weekday() + 1) % 7, loc.hour, loc.minute))
    return sorted(slots)


# ---- unit generation ---------------------------------------------------------------------

def _argv(*args: str) -> list[str]:
    return [sys.executable, "-m", "sloop.cli", *args]


def _env() -> dict[str, str]:
    return {"PYTHONPATH": str(config.ROOT / "src"), "PYTHONUNBUFFERED": "1", "PATH": os.environ.get("PATH", "/usr/bin:/bin")}


def _logdir() -> Path:
    d = config.data_dir() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def launchd_units() -> dict[str, bytes]:
    tz, logs, out = local_zone(), _logdir(), {}

    def plist(name: str, args: list[str], extra: dict) -> bytes:
        body = {"Label": f"{LABEL}.{name}", "ProgramArguments": args, "WorkingDirectory": str(config.ROOT),
                "EnvironmentVariables": _env(), "StandardOutPath": str(logs / f"{name}.log"),
                "StandardErrorPath": str(logs / f"{name}.log"), "ProcessType": "Background", **extra}
        return plistlib.dumps(body)

    for s in SERVICES:
        out[f"{LABEL}.{s}.plist"] = plist(s, _argv("serve", s), {"RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10})
    for j in jobs():
        if j.at:
            sched = {"StartCalendarInterval": [{"Weekday": w, "Hour": h, "Minute": m} for w, h, m in local_slots(j, tz)]}
        else:
            sched = {"StartInterval": int(j.every_minutes) * 60}
        out[f"{LABEL}.job-{j.name}.plist"] = plist(f"job-{j.name}", _argv("job", j.name), sched)
    return out


def _oncalendar(j: Job) -> str:
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    days = ",".join(names[d] for d in j.days)
    if j.at:
        months = ",".join(f"{m:02d}" for m in j.months) if j.months else "*"
        dom = f"{j.day_of_month:02d}" if j.day_of_month else "*"
        return f"{days} *-{months}-{dom} {j.at}:00 America/New_York"
    lo, hi = (j.window or ["00:00", "23:59"])
    h0, h1 = int(lo[:2]), int(hi[:2])
    return f"{days} *-*-* {h0:02d}..{h1:02d}:00/{int(j.every_minutes):02d}:00 America/New_York"


def systemd_units() -> dict[str, str]:
    root, out = config.ROOT, {}
    env = " ".join(f'"{k}={v}"' for k, v in _env().items())
    for s in SERVICES:
        out[f"{UNIT}-{s}.service"] = f"""[Unit]
Description=strategy-loop {s} (always on)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={root}
Environment={env}
ExecStart={shlex.join(_argv("serve", s))}
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=default.target
"""
    for j in jobs():
        out[f"{UNIT}-job-{j.name}.service"] = f"""[Unit]
Description=strategy-loop job {j.name}

[Service]
Type=oneshot
WorkingDirectory={root}
Environment={env}
ExecStart={shlex.join(_argv("job", j.name))}
"""
        out[f"{UNIT}-job-{j.name}.timer"] = f"""[Unit]
Description=strategy-loop job {j.name} ({j.at + ' ET' if j.at else f'every {j.every_minutes} min'})

[Timer]
OnCalendar={_oncalendar(j)}
Persistent=true
AccuracySec=30s

[Install]
WantedBy=timers.target
"""
    return out


# ---- install / uninstall -----------------------------------------------------------------

def target_dir(platform: str) -> Path:
    home = Path.home()
    return home / "Library/LaunchAgents" if platform == "macos" else home / ".config/systemd/user"


def detect_platform() -> str:
    return "macos" if sys.platform == "darwin" else "linux"


def install(platform: str, out_dir: Path | None = None, load: bool = True) -> list[str]:
    """Write every unit (to ``out_dir`` or the platform's user dir) and optionally load them.

    Returns the commands run (or, with ``load=False``, the commands to run).
    """
    units = launchd_units() if platform == "macos" else systemd_units()
    dest = out_dir or target_dir(platform)
    dest.mkdir(parents=True, exist_ok=True)
    stale = [p for p in dest.glob(f"{LABEL}.*.plist" if platform == "macos" else f"{UNIT}-*") if p.name not in units]
    cmds: list[list[str]] = []
    if platform == "macos":
        uid = os.getuid()
        for p in stale:
            cmds.append(["launchctl", "bootout", f"gui/{uid}/{p.stem}"])
        for name in units:
            cmds.append(["launchctl", "bootout", f"gui/{uid}/{name[:-len('.plist')]}"])
            cmds.append(["launchctl", "bootstrap", f"gui/{uid}", str(dest / name)])
    else:
        for p in stale:
            if p.suffix in (".service", ".timer"):
                cmds.append(["systemctl", "--user", "disable", "--now", p.name])
        cmds.append(["systemctl", "--user", "daemon-reload"])
        cmds.append(["systemctl", "--user", "enable", "--now", *[n for n in units if n.endswith(".timer")],
                     *[f"{UNIT}-{s}.service" for s in SERVICES]])
    for p in stale:
        p.unlink()
    for name, body in units.items():
        (dest / name).write_bytes(body) if isinstance(body, bytes) else (dest / name).write_text(body)
    if load:
        for c in cmds:
            subprocess.run(c, check=False, capture_output=True)
    return [shlex.join(c) for c in cmds]


def uninstall(platform: str, out_dir: Path | None = None, load: bool = True) -> list[str]:
    dest = out_dir or target_dir(platform)
    files = sorted(dest.glob(f"{LABEL}.*.plist" if platform == "macos" else f"{UNIT}-*"))
    cmds: list[list[str]] = []
    if platform == "macos":
        cmds = [["launchctl", "bootout", f"gui/{os.getuid()}/{p.stem}"] for p in files]
    elif files:
        cmds = [["systemctl", "--user", "disable", "--now", *[p.name for p in files]], ["systemctl", "--user", "daemon-reload"]]
    if load:
        for c in cmds:
            subprocess.run(c, check=False, capture_output=True)
    for p in files:
        p.unlink()
    return [shlex.join(c) for c in cmds]
