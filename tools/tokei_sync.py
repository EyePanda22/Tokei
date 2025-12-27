from __future__ import annotations

import base64
import json
import os
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib import error, parse, request

from tokei_errors import ApiError, ConfigError

try:
    from zoneinfo import ZoneInfo
    from zoneinfo import ZoneInfoNotFoundError
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore
    ZoneInfoNotFoundError = Exception  # type: ignore


@dataclass(frozen=True)
class Config:
    anki_profile: str
    timezone: str
    theme: str
    one_page: bool
    toggl_start_date: date
    toggl_refresh_days_back: int
    toggl_refresh_buffer_days: int
    toggl_chunk_days: int
    toggl_baseline_seconds: int
    ankimorphs_known_interval_days: int
    mokuro_volume_data_path: str
    gsm_db_path: str


class TogglMinStartDateError(RuntimeError):
    def __init__(self, min_day: date):
        super().__init__(min_day.isoformat())
        self.min_day = min_day


def _load_config(path: Path) -> Config:
    raw = json.loads(path.read_text(encoding="utf-8"))
    tz = str(raw.get("timezone") or "America/Los_Angeles")
    theme = str(raw.get("theme") or "midnight")
    one_page = bool(raw.get("one_page", True))
    anki_profile = str(raw.get("anki_profile") or "User 1")

    toggl = raw.get("toggl") or {}
    start_date_raw = str(toggl.get("start_date") or "auto")
    if start_date_raw.lower() == "auto":
        start_date = date(1970, 1, 1)
    else:
        start_date = date.fromisoformat(start_date_raw)
    refresh_days_back = int(toggl.get("refresh_days_back") or 3)
    refresh_buffer_days = int(toggl.get("refresh_buffer_days") or 2)
    chunk_days = int(toggl.get("chunk_days") or 7)
    baseline_hours = float(toggl.get("baseline_hours") or 0)
    baseline_seconds = int(round(baseline_hours * 3600.0))

    ankimorphs = raw.get("ankimorphs") or {}
    known_interval = int(ankimorphs.get("known_interval_days") or 21)

    mokuro = raw.get("mokuro") or {}
    mokuro_volume_data_path = str(mokuro.get("volume_data_path") or "")

    gsm = raw.get("gsm") or {}
    gsm_db_path = str(gsm.get("db_path") or "auto")

    return Config(
        anki_profile=anki_profile,
        timezone=tz,
        theme=theme,
        one_page=one_page,
        toggl_start_date=start_date,
        toggl_refresh_days_back=refresh_days_back,
        toggl_refresh_buffer_days=refresh_buffer_days,
        toggl_chunk_days=chunk_days,
        toggl_baseline_seconds=baseline_seconds,
        ankimorphs_known_interval_days=known_interval,
        mokuro_volume_data_path=mokuro_volume_data_path,
        gsm_db_path=gsm_db_path,
    )


def _get_api_token(config_dir: Path) -> str:
    token = os.environ.get("TOGGL_API_TOKEN")
    if token and token.strip():
        return token.strip()

    token_path = config_dir / "toggl-token.txt"
    if token_path.exists():
        try:
            v = token_path.read_text(encoding="utf-8-sig").strip()
        except Exception:
            v = token_path.read_text(encoding="utf-8", errors="replace").strip()
        v = v.lstrip("\ufeff")
        if v:
            return v

    raise ConfigError(
        "No Toggl API token found. Set TOGGL_API_TOKEN or create toggl-token.txt."
    )


def _basic_auth_header(api_token: str) -> str:
    token_bytes = f"{api_token}:api_token".encode("utf-8")
    basic = base64.b64encode(token_bytes).decode("ascii")
    return f"Basic {basic}"


def _fetch_json(url: str, api_token: str) -> Any:
    req = request.Request(
        url,
        headers={
            "Authorization": _basic_auth_header(api_token),
            "User-Agent": "tokei/1.0",
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            if resp.status != 200:
                raise ApiError(f"Toggl API request failed: {resp.status} {body}")
    except error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise ApiError(f"Toggl API HTTP error: {e.code} {body}") from e
    except error.URLError as e:
        raise ApiError(f"Toggl API connection error: {e.reason}") from e

    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        raise ApiError(f"Failed to parse Toggl API JSON: {e}\n{body}") from e


def _parse_iso_dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _day_bounds(day: date, tz: Any) -> tuple[datetime, datetime]:
    start = datetime.combine(day, time.min, tzinfo=tz)
    end = start + timedelta(days=1)
    return start, end


def _fetch_time_entries(api_token: str, start_dt: datetime, end_dt: datetime) -> list[dict[str, Any]]:
    url = "https://api.track.toggl.com/api/v9/me/time_entries"
    params = {"start_date": start_dt.isoformat(), "end_date": end_dt.isoformat()}
    full_url = f"{url}?{parse.urlencode(params)}"
    try:
        data = _fetch_json(full_url, api_token)
        return data if isinstance(data, list) else []
    except ApiError as e:
        # Toggl sometimes limits how far back /me/time_entries can query.
        # Example: "start_date must not be earlier than 2025-09-25"
        msg = str(e)
        min_day = _parse_toggl_min_start_date(msg)
        if min_day is None:
            raise
        raise TogglMinStartDateError(min_day) from e


def _parse_toggl_min_start_date(message: str) -> date | None:
    needle = "start_date must not be earlier than "
    if needle not in message:
        return None
    try:
        after = message.split(needle, 1)[1]
        token = after.strip().strip('"').split()[0]
        return date.fromisoformat(token)
    except Exception:
        return None


def _summarize_entries_by_day(
    entries: list[dict[str, Any]],
    tz: Any,
) -> tuple[dict[date, int], dict[date, dict[str, int]]]:
    total_by_day: dict[date, int] = defaultdict(int)
    by_desc_by_day: dict[date, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        duration = entry.get("duration", 0)
        if not isinstance(duration, (int, float)) or duration <= 0:
            continue
        start_s = entry.get("start")
        if not isinstance(start_s, str) or not start_s:
            continue
        try:
            start_dt = _parse_iso_dt(start_s).astimezone(tz)
        except Exception:
            continue
        day = start_dt.date()
        desc = entry.get("description") or "No Description"
        if not isinstance(desc, str) or not desc.strip():
            desc = "No Description"
        seconds = int(duration)
        total_by_day[day] += seconds
        by_desc_by_day[day][desc] += seconds

    return dict(total_by_day), {d: dict(m) for d, m in by_desc_by_day.items()}


def _ensure_schema(con: sqlite3.Connection) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS toggl_daily (
          day TEXT PRIMARY KEY,
          total_seconds INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS toggl_daily_desc (
          day TEXT NOT NULL,
          description TEXT NOT NULL,
          seconds INTEGER NOT NULL,
          PRIMARY KEY (day, description)
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS snapshots (
          run_id INTEGER PRIMARY KEY AUTOINCREMENT,
          generated_at TEXT NOT NULL,
          report_day TEXT NOT NULL,
          timezone TEXT NOT NULL,
          theme TEXT NOT NULL,
          toggl_lifetime_seconds INTEGER NOT NULL,
          toggl_today_seconds INTEGER NOT NULL,
          toggl_today_breakdown_json TEXT NOT NULL,
          known_lemmas INTEGER NOT NULL,
          known_inflections INTEGER NOT NULL,
          manga_chars_total INTEGER NOT NULL,
          gsm_chars_total INTEGER NOT NULL,
          anki_total_reviews INTEGER NOT NULL,
          anki_reviews INTEGER NOT NULL,
          anki_true_retention REAL NOT NULL,
          warnings_json TEXT NOT NULL DEFAULT '[]'
        )
        """
    )

    # lightweight migration for older DBs
    cols = {row[1] for row in con.execute("PRAGMA table_info(snapshots)").fetchall()}
    if "manga_chars_total" not in cols:
        con.execute("ALTER TABLE snapshots ADD COLUMN manga_chars_total INTEGER NOT NULL DEFAULT 0;")
    if "gsm_chars_total" not in cols:
        con.execute("ALTER TABLE snapshots ADD COLUMN gsm_chars_total INTEGER NOT NULL DEFAULT 0;")
    if "warnings_json" not in cols:
        con.execute("ALTER TABLE snapshots ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]';")


def _get_meta(con: sqlite3.Connection, key: str) -> str | None:
    row = con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row and row[0] is not None else None


def _set_meta(con: sqlite3.Connection, key: str, value: str) -> None:
    con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", (key, value))


def _reset_toggl_cache(con: sqlite3.Connection) -> None:
    con.execute("DELETE FROM toggl_daily_desc;")
    con.execute("DELETE FROM toggl_daily;")
    con.execute(
        """
        DELETE FROM meta
        WHERE key IN ('toggl_api_min_start_date', 'toggl_baseline_through_day', 'toggl_cache_start_day')
        """
    )


def _update_toggl_cache(con: sqlite3.Connection, cfg: Config, api_token: str, tz: Any) -> None:
    now = datetime.now(tz)
    today = now.date()

    stored_tz = _get_meta(con, "timezone")
    stored_start = _get_meta(con, "toggl_start_date")
    if stored_tz and stored_tz != cfg.timezone:
        _reset_toggl_cache(con)
    if stored_start and stored_start != cfg.toggl_start_date.isoformat():
        _reset_toggl_cache(con)

    _set_meta(con, "timezone", cfg.timezone)
    _set_meta(con, "toggl_start_date", cfg.toggl_start_date.isoformat())
    _set_meta(con, "toggl_baseline_seconds", str(int(cfg.toggl_baseline_seconds)))

    row = con.execute("SELECT MAX(day) FROM toggl_daily").fetchone()
    max_day = date.fromisoformat(row[0]) if row and row[0] else None

    refresh_start = cfg.toggl_start_date
    baseline_through: date | None = None
    baseline_through_raw = _get_meta(con, "toggl_baseline_through_day")
    if baseline_through_raw:
        try:
            baseline_through = date.fromisoformat(baseline_through_raw)
        except Exception:
            baseline_through = None

    if max_day is None and cfg.toggl_start_date == date(1970, 1, 1):
        if baseline_through is None:
            baseline_through = today - timedelta(days=1)
            _set_meta(con, "toggl_baseline_through_day", baseline_through.isoformat())
            _set_meta(con, "toggl_cache_start_day", today.isoformat())
        refresh_start = today
    elif max_day is not None:
        # Adaptive refresh: avoid re-fetching the full window every run.
        # Refresh at least `refresh_buffer_days` recent days (to pick up edits),
        # and enough days to cover any gap since the last report, capped by refresh_days_back.
        last_report_raw = _get_meta(con, "last_report_day")
        if not last_report_raw:
            row2 = con.execute("SELECT MAX(report_day) FROM snapshots").fetchone()
            last_report_raw = str(row2[0]) if row2 and row2[0] else None
        last_report_day: date | None = None
        if last_report_raw:
            try:
                last_report_day = date.fromisoformat(last_report_raw)
            except Exception:
                last_report_day = None

        buffer_days = max(0, int(cfg.toggl_refresh_buffer_days))
        max_days = max(1, int(cfg.toggl_refresh_days_back))

        if last_report_day is None:
            # Fallback: behave like before for this run.
            days_to_refresh = max_days
        else:
            gap_days = max(0, (today - last_report_day).days)
            days_to_refresh = min(max_days, gap_days + buffer_days)
            days_to_refresh = max(1, days_to_refresh)

        refresh_start = max(cfg.toggl_start_date, today - timedelta(days=days_to_refresh - 1))

    api_min_start: date | None = None
    api_min_start_raw = _get_meta(con, "toggl_api_min_start_date")
    if api_min_start_raw:
        try:
            api_min_start = date.fromisoformat(api_min_start_raw)
        except Exception:
            api_min_start = None
    if api_min_start is not None:
        refresh_start = max(refresh_start, api_min_start)

    chunk_days = max(1, cfg.toggl_chunk_days)
    cursor = refresh_start
    while cursor <= today:
        chunk_start = cursor
        chunk_end = min(today + timedelta(days=1), chunk_start + timedelta(days=chunk_days))
        start_dt, _ = _day_bounds(chunk_start, tz)
        end_dt, _ = _day_bounds(chunk_end, tz)

        try:
            entries = _fetch_time_entries(api_token, start_dt=start_dt, end_dt=end_dt)
        except TogglMinStartDateError as e:
            api_min_start = e.min_day
            _set_meta(con, "toggl_api_min_start_date", api_min_start.isoformat())
            cursor = max(cursor, api_min_start)
            continue
        totals, by_desc = _summarize_entries_by_day(entries, tz=tz)

        updated_at = datetime.now(tz).isoformat()
        day = chunk_start
        while day < chunk_end:
            day_s = day.isoformat()
            total_seconds = int(totals.get(day, 0))
            con.execute(
                "INSERT OR REPLACE INTO toggl_daily(day, total_seconds, updated_at) VALUES(?, ?, ?)",
                (day_s, total_seconds, updated_at),
            )
            con.execute("DELETE FROM toggl_daily_desc WHERE day=?", (day_s,))
            for desc, seconds in (by_desc.get(day, {}) or {}).items():
                con.execute(
                    "INSERT OR REPLACE INTO toggl_daily_desc(day, description, seconds) VALUES(?, ?, ?)",
                    (day_s, desc, int(seconds)),
                )
            day += timedelta(days=1)

        cursor = chunk_end

    _set_meta(con, "last_report_day", today.isoformat())


def _read_hashi_stats(cfg: Config, warnings: list[str] | None = None) -> tuple[int, int, float]:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        if warnings is not None:
            warnings.append("Could not read Hashi stats: APPDATA is not set.")
        return 0, 0, 0.0

    profile_dir = Path(appdata) / "Anki2" / cfg.anki_profile
    output_dir = "hashi_exports"
    rules_path = Path(appdata) / "Anki2" / "addons21" / "Hashi" / "rules.json"
    if rules_path.exists():
        try:
            parsed = json.loads(rules_path.read_text(encoding="utf-8"))
            settings = parsed.get("settings") if isinstance(parsed, dict) else None
            if isinstance(settings, dict):
                od = settings.get("output_dir")
                if isinstance(od, str) and od.strip():
                    output_dir = od.strip()
        except Exception:
            pass

    stats_path = Path(output_dir) / "anki_stats_snapshot.json"
    if not stats_path.is_absolute():
        stats_path = profile_dir / output_dir / "anki_stats_snapshot.json"

    if not stats_path.exists():
        if warnings is not None:
            warnings.append(
                f"Hashi stats not found: {stats_path} (run Hashi export in Anki, or check anki_profile)."
            )
        return 0, 0, 0.0
    try:
        raw = json.loads(stats_path.read_text(encoding="utf-8"))
    except Exception as e:
        if warnings is not None:
            warnings.append(f"Failed to read Hashi stats JSON: {stats_path} ({type(e).__name__}).")
        return 0, 0, 0.0
    totals = raw.get("totals") or {}
    cards_studied = int(totals.get("cards_studied") or 0)
    reviews = int(totals.get("reviews") or 0)
    true_retention = float(totals.get("true_retention") or 0.0)
    return cards_studied, reviews, true_retention


def _read_ankimorphs_known_counts(cfg: Config, warnings: list[str] | None = None) -> tuple[int, int]:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        if warnings is not None:
            warnings.append("Could not read AnkiMorphs counts: APPDATA is not set.")
        return 0, 0
    db_path = Path(appdata) / "Anki2" / cfg.anki_profile / "ankimorphs.db"
    if not db_path.exists():
        if warnings is not None:
            warnings.append(f"AnkiMorphs DB not found: {db_path}.")
        return 0, 0
    interval = int(cfg.ankimorphs_known_interval_days)
    con = sqlite3.connect(str(db_path))
    try:
        known_lemmas = con.execute(
            """
            SELECT COUNT(DISTINCT lemma)
            FROM Morphs
            WHERE highest_inflection_learning_interval >= ?
            """,
            (interval,),
        ).fetchone()[0]
        known_inflections = con.execute(
            """
            SELECT COUNT(*)
            FROM Morphs
            WHERE highest_inflection_learning_interval >= ?
            """,
            (interval,),
        ).fetchone()[0]
        return int(known_lemmas or 0), int(known_inflections or 0)
    except sqlite3.Error as e:
        if warnings is not None:
            warnings.append(f"Failed to query AnkiMorphs DB: {db_path} ({type(e).__name__}).")
        return 0, 0
    finally:
        con.close()


def _read_mokuro_manga_chars(cfg: Config, warnings: list[str] | None = None) -> int:
    p = cfg.mokuro_volume_data_path.strip()
    if not p:
        return 0
    path = Path(p)
    if not path.exists():
        if warnings is not None:
            warnings.append(f"Mokuro volume-data.json not found: {path}.")
        return 0
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        if warnings is not None:
            warnings.append(f"Failed to parse Mokuro volume-data.json: {path}.")
        return 0
    if not isinstance(parsed, dict):
        if warnings is not None:
            warnings.append(f"Mokuro volume-data.json is not a JSON object: {path}.")
        return 0
    total = 0
    for v in parsed.values():
        if isinstance(v, dict):
            chars = v.get("chars")
            if isinstance(chars, (int, float)):
                total += int(chars)
    return int(total)


def _read_gsm_chars(cfg: Config, warnings: list[str] | None = None) -> int:
    p = (cfg.gsm_db_path or "").strip()
    if p.lower() == "off":
        return 0
    if p.lower() == "auto" or not p:
        appdata = os.environ.get("APPDATA")
        if not appdata:
            if warnings is not None:
                warnings.append("Could not read GSM chars: APPDATA is not set.")
            return 0
        p = str(Path(appdata) / "GameSentenceMiner" / "gsm.db")
    db_path = Path(p)
    if not db_path.exists():
        if warnings is not None:
            warnings.append(f"GSM DB not found: {db_path}.")
        return 0
    try:
        con = sqlite3.connect(str(db_path))
        try:
            row = con.execute(
                """
                SELECT SUM(CAST(total_characters AS INTEGER)) AS lifetime_chars
                FROM daily_stats_rollup
                WHERE total_characters IS NOT NULL AND total_characters != ''
                """
            ).fetchone()
            if not row or row[0] is None:
                return 0
            return int(row[0] or 0)
        finally:
            con.close()
    except sqlite3.Error as e:
        if warnings is not None:
            warnings.append(f"Failed to query GSM DB: {db_path} ({type(e).__name__}).")
        return 0


def _ordinal_suffix(day: int) -> str:
    j = day % 10
    k = day % 100
    if j == 1 and k != 11:
        return "st"
    if j == 2 and k != 12:
        return "nd"
    if j == 3 and k != 13:
        return "rd"
    return "th"


def _generated_label(now: datetime) -> str:
    day = now.day
    suffix = _ordinal_suffix(day)
    month_name = now.strftime("%B")
    year = now.year
    hh = f"{now.hour:02d}"
    mm = f"{now.minute:02d}"
    return f"{month_name} {day}{suffix} {year} at {hh}:{mm}"


def _build_report_model(
    cfg: Config,
    run_id: int,
    now: datetime,
    warnings: list[str],
    lifetime_seconds: int,
    today_seconds: int,
    today_breakdown: list[dict[str, Any]],
    known_lemmas: int,
    known_inflections: int,
    anki_total_reviews: int,
    anki_total_reviews_delta: int,
    retention_rate: float,
    retention_delta: float,
    total_immersion_delta_hours: float,
    immersion_log: list[dict[str, Any]],
    avg_immersion_seconds: int,
    avg_immersion_delta_seconds: int,
    known_words_delta: int,
    known_inflections_delta: int,
    manga_chars_total: int,
    manga_chars_delta: int,
    gsm_chars_total: int,
    gsm_chars_delta: int,
) -> dict[str, Any]:
    return {
        "report_no": run_id,
        "generated_label": _generated_label(now),
        "theme": cfg.theme,
        "one_page": bool(cfg.one_page),
        "warnings": list(warnings),
        "total_immersion_hours": lifetime_seconds / 3600.0,
        "total_immersion_delta_hours": total_immersion_delta_hours,
        "known_words": known_lemmas,
        "known_words_delta": known_words_delta,
        "known_inflections": known_inflections,
        "known_inflections_delta": known_inflections_delta,
        "today_immersion": {
            "total_seconds": int(today_seconds),
            "entries": today_breakdown,
        },
        "avg_immersion_seconds": int(avg_immersion_seconds),
        "avg_immersion_delta_seconds": int(avg_immersion_delta_seconds),
        "retention_rate": float(retention_rate),
        "retention_delta": float(retention_delta),
        "total_reviews": int(anki_total_reviews),
        "total_reviews_delta": int(anki_total_reviews_delta),
        "manga_chars_total": int(manga_chars_total),
        "manga_chars_delta": int(manga_chars_delta),
        "gsm_chars_total": int(gsm_chars_total),
        "gsm_chars_delta": int(gsm_chars_delta),
        "immersion_log": immersion_log,
    }


def _compute_immersion_windows(
    con: sqlite3.Connection,
    tz: Any,
    today: date,
    today_seconds: int,
    avg_window_days: int = 7,
) -> tuple[list[dict[str, Any]], int, int]:
    # Heatmap should grow over time: one cell per calendar day starting from the
    # first ever Tokei report day (earliest snapshot), up through today.
    row = con.execute("SELECT MIN(report_day) FROM snapshots").fetchone()
    if not row or not row[0]:
        # First run: the snapshot insert happens later in the workflow, so there
        # are no snapshots yet. Still show today's square so the heatmap isn't empty.
        hours = int(today_seconds) / 3600.0
        label = today.strftime("%b %-d") if os.name != "nt" else today.strftime("%b %#d")
        return [{"label": label, "hours": hours}], int(today_seconds), 0

    try:
        start_day = date.fromisoformat(str(row[0]))
    except Exception:
        return [], 0, 0

    day_rows = con.execute(
        """
        SELECT day, total_seconds
        FROM toggl_daily
        WHERE day >= ? AND day <= ?
        """,
        (start_day.isoformat(), today.isoformat()),
    ).fetchall()
    seconds_by_day: dict[date, int] = {
        date.fromisoformat(str(d)): int(s or 0) for (d, s) in day_rows
    }

    # Ensure we use the freshest "today" value (even if toggl_daily is stale).
    seconds_by_day[today] = int(today_seconds)

    log: list[dict[str, Any]] = []
    cursor = start_day
    while cursor <= today:
        seconds = int(seconds_by_day.get(cursor, 0))
        label = cursor.strftime("%b %-d") if os.name != "nt" else cursor.strftime("%b %#d")
        log.append({"label": label, "hours": seconds / 3600.0})
        cursor += timedelta(days=1)

    # Average immersion based on the most recent avg_window_days (calendar days),
    # excluding zero days (matches APL "nonzero average" feel).
    avg_window_days = max(1, int(avg_window_days))
    recent_start = today - timedelta(days=avg_window_days - 1)
    prev_start = recent_start - timedelta(days=avg_window_days)
    prev_end = recent_start - timedelta(days=1)

    def nonzero_seconds_in_range(a: date, b: date) -> list[int]:
        out: list[int] = []
        c = a
        while c <= b:
            s = int(seconds_by_day.get(c, 0))
            if s > 0:
                out.append(s)
            c += timedelta(days=1)
        return out

    cur_nonzero = nonzero_seconds_in_range(recent_start, today)
    cur_avg = int(sum(cur_nonzero) / len(cur_nonzero)) if cur_nonzero else 0

    prev_nonzero = nonzero_seconds_in_range(prev_start, prev_end) if prev_end >= prev_start else []
    prev_avg = int(sum(prev_nonzero) / len(prev_nonzero)) if prev_nonzero else 0
    delta = cur_avg - prev_avg

    return log, cur_avg, delta


def main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-same-day", action="store_true")
    parser.add_argument(
        "--overwrite-today",
        action="store_true",
        help="If a report already exists for today, overwrite that snapshot instead of creating a new one.",
    )
    args = parser.parse_args(argv[1:])

    env_root = os.environ.get("TOKEI_USER_ROOT")
    root = Path(env_root).resolve() if env_root else Path(__file__).resolve().parents[1]
    config_path = root / "config.json"
    cache_dir = root / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    db_path = cache_dir / "tokei_cache.sqlite"
    out_stats_path = cache_dir / "latest_stats.json"

    cfg = _load_config(config_path)
    api_token = _get_api_token(root)

    local_tz = datetime.now().astimezone().tzinfo
    if local_tz is None:
        raise ConfigError("Could not determine local timezone from the OS.")

    tz: Any
    if cfg.timezone.lower() in ("local", "system"):
        tz = local_tz
    else:
        if ZoneInfo is None:
            tz = local_tz
        else:
            try:
                tz = ZoneInfo(cfg.timezone)
            except ZoneInfoNotFoundError:
                # Common on Windows when the Python install doesn't have IANA tzdata.
                # Fall back to local timezone so Tokei works out-of-the-box.
                tz = local_tz

    # Ensure token works and /me is reachable (user requested /me usage).
    _fetch_json("https://api.track.toggl.com/api/v9/me", api_token)

    con = sqlite3.connect(str(db_path))
    try:
        con.execute("PRAGMA journal_mode=DELETE;")
        con.execute("PRAGMA synchronous=NORMAL;")
        _ensure_schema(con)

        now = datetime.now(tz)
        today = now.date()

        prev_today = con.execute(
            """
            SELECT run_id, generated_at
            FROM snapshots
            WHERE report_day = ?
            ORDER BY run_id DESC
            LIMIT 1
            """,
            (today.isoformat(),),
        ).fetchone()
        if prev_today and not args.allow_same_day and not args.overwrite_today:
            payload = {
                "status": "already_generated",
                "report_no": int(prev_today[0]),
                "generated_at": str(prev_today[1]),
                "report_day": today.isoformat(),
            }
            print(json.dumps(payload, ensure_ascii=False))
            return 2

        _update_toggl_cache(con, cfg, api_token=api_token, tz=tz)
        con.commit()

        sum_start = cfg.toggl_start_date
        if cfg.toggl_start_date == date(1970, 1, 1):
            cache_start_raw = _get_meta(con, "toggl_cache_start_day")
            if cache_start_raw:
                try:
                    sum_start = date.fromisoformat(cache_start_raw)
                except Exception:
                    sum_start = cfg.toggl_start_date

        lifetime_seconds = int(
            con.execute(
                "SELECT COALESCE(SUM(total_seconds), 0) FROM toggl_daily WHERE day >= ? AND day <= ?",
                (sum_start.isoformat(), today.isoformat()),
            ).fetchone()[0]
            or 0
        )
        lifetime_seconds += int(cfg.toggl_baseline_seconds)
        today_seconds = int(
            con.execute(
                "SELECT COALESCE(total_seconds, 0) FROM toggl_daily WHERE day=?",
                (today.isoformat(),),
            ).fetchone()[0]
            or 0
        )
        breakdown_rows = con.execute(
            """
            SELECT description, seconds
            FROM toggl_daily_desc
            WHERE day=?
            ORDER BY seconds DESC, description
            """,
            (today.isoformat(),),
        ).fetchall()
        today_breakdown = [
            {"desc": str(desc), "seconds": int(sec or 0)} for (desc, sec) in breakdown_rows
        ]

        warnings: list[str] = []
        known_lemmas, known_inflections = _read_ankimorphs_known_counts(cfg, warnings=warnings)
        manga_chars_total = _read_mokuro_manga_chars(cfg, warnings=warnings)
        gsm_chars_total = _read_gsm_chars(cfg, warnings=warnings)
        anki_total, anki_reviews, anki_true_retention = _read_hashi_stats(cfg, warnings=warnings)

        # For deltas, compare against the previous report before the one we are generating.
        # If overwriting today's report, exclude that row itself.
        if args.overwrite_today and prev_today:
            prev = con.execute(
                """
                SELECT toggl_lifetime_seconds, known_lemmas, known_inflections, manga_chars_total, gsm_chars_total,
                       anki_total_reviews, anki_true_retention
                FROM snapshots
                WHERE run_id < ?
                ORDER BY run_id DESC
                LIMIT 1
                """,
                (int(prev_today[0]),),
            ).fetchone()
        else:
            prev = con.execute(
                """
                SELECT toggl_lifetime_seconds, known_lemmas, known_inflections, manga_chars_total, gsm_chars_total,
                       anki_total_reviews, anki_true_retention
                FROM snapshots
                ORDER BY run_id DESC
                LIMIT 1
                """
            ).fetchone()

        prev_lifetime = int(prev[0]) if prev else lifetime_seconds
        prev_known_lemmas = int(prev[1]) if prev else known_lemmas
        prev_known_inflections = int(prev[2]) if prev else known_inflections
        prev_manga_chars = int(prev[3]) if prev else manga_chars_total
        prev_gsm_chars = int(prev[4]) if prev else gsm_chars_total
        prev_anki_total = int(prev[5]) if prev else anki_total
        prev_retention_rate = (float(prev[6]) * 100.0) if prev else (anki_true_retention * 100.0)

        retention_rate = anki_true_retention * 100.0
        retention_delta = round(retention_rate - prev_retention_rate, 2)

        anki_total_delta = int(anki_total - prev_anki_total)
        known_words_delta = int(known_lemmas - prev_known_lemmas)
        known_inflections_delta = int(known_inflections - prev_known_inflections)
        manga_chars_delta = int(manga_chars_total - prev_manga_chars)
        gsm_chars_delta = int(gsm_chars_total - prev_gsm_chars)
        total_immersion_delta_hours = round((lifetime_seconds - prev_lifetime) / 3600.0, 2)

        immersion_log, avg_seconds, avg_delta_seconds = _compute_immersion_windows(
            con, tz=tz, today=today, today_seconds=today_seconds, avg_window_days=7
        )

        if args.overwrite_today and prev_today:
            run_id = int(prev_today[0])
            con.execute(
                """
                UPDATE snapshots
                SET generated_at=?,
                    report_day=?,
                    timezone=?,
                    theme=?,
                    toggl_lifetime_seconds=?,
                    toggl_today_seconds=?,
                    toggl_today_breakdown_json=?,
                    known_lemmas=?,
                    known_inflections=?,
                    manga_chars_total=?,
                    gsm_chars_total=?,
                    anki_total_reviews=?,
                    anki_reviews=?,
                    anki_true_retention=?,
                    warnings_json=?
                WHERE run_id=?
                """,
                (
                    now.isoformat(),
                    today.isoformat(),
                    cfg.timezone,
                    cfg.theme,
                    int(lifetime_seconds),
                    int(today_seconds),
                    json.dumps(today_breakdown, ensure_ascii=False),
                    int(known_lemmas),
                    int(known_inflections),
                    int(manga_chars_total),
                    int(gsm_chars_total),
                    int(anki_total),
                    int(anki_reviews),
                    float(anki_true_retention),
                    json.dumps(warnings, ensure_ascii=False),
                    run_id,
                ),
            )
        else:
            cur = con.execute(
                """
                INSERT INTO snapshots(
                  generated_at, report_day, timezone, theme,
                  toggl_lifetime_seconds, toggl_today_seconds, toggl_today_breakdown_json,
                  known_lemmas, known_inflections, manga_chars_total, gsm_chars_total,
                  anki_total_reviews, anki_reviews, anki_true_retention, warnings_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    now.isoformat(),
                    today.isoformat(),
                    cfg.timezone,
                    cfg.theme,
                    int(lifetime_seconds),
                    int(today_seconds),
                    json.dumps(today_breakdown, ensure_ascii=False),
                    int(known_lemmas),
                    int(known_inflections),
                    int(manga_chars_total),
                    int(gsm_chars_total),
                    int(anki_total),
                    int(anki_reviews),
                    float(anki_true_retention),
                    json.dumps(warnings, ensure_ascii=False),
                ),
            )
            run_id = int(cur.lastrowid)
        con.commit()

        model = _build_report_model(
            cfg=cfg,
            run_id=run_id,
            now=now,
            warnings=warnings,
            lifetime_seconds=lifetime_seconds,
            today_seconds=today_seconds,
            today_breakdown=today_breakdown,
            known_lemmas=known_lemmas,
            known_inflections=known_inflections,
            anki_total_reviews=anki_total,
            anki_total_reviews_delta=anki_total_delta,
            retention_rate=retention_rate,
            retention_delta=retention_delta,
            total_immersion_delta_hours=total_immersion_delta_hours,
            immersion_log=immersion_log,
            avg_immersion_seconds=avg_seconds,
            avg_immersion_delta_seconds=avg_delta_seconds,
            known_words_delta=known_words_delta,
            known_inflections_delta=known_inflections_delta,
            manga_chars_total=manga_chars_total,
            manga_chars_delta=manga_chars_delta,
            gsm_chars_total=gsm_chars_total,
            gsm_chars_delta=gsm_chars_delta,
        )

        out_stats_path.write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
        print(str(out_stats_path))
        return 0
    finally:
        con.close()


if __name__ == "__main__":  # pragma: no cover
    try:
        raise SystemExit(main(sys.argv))
    except (ApiError, ConfigError) as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(e.exit_code)
