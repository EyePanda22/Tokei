from __future__ import annotations

import base64
import csv
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import unicodedata
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
    mokuro_volume_data_path: str
    gsm_db_path: str
    phase2_csv_rule_id: str


class TogglMinStartDateError(RuntimeError):
    def __init__(self, min_day: date):
        super().__init__(min_day.isoformat())
        self.min_day = min_day


_SPACY_NLP: Any | None = None


def _normalize_surface_for_identity(surface: str) -> str:
    s = str(surface or "").strip()
    s = unicodedata.normalize("NFC", s)
    s = re.sub(r"\s+", " ", s)
    return s


def _content_key_for_lexeme(normalized_surface: str, rule_id: str) -> str:
    rid = str(rule_id or "").strip()
    if not rid:
        raise ValueError("rule_id must be non-empty")
    src = f"{normalized_surface}::{rid}"
    return hashlib.sha256(src.encode("utf-8")).hexdigest()


def _load_spacy_ja_model() -> Any | None:
    global _SPACY_NLP
    if _SPACY_NLP is not None:
        return _SPACY_NLP
    # spaCy's dependency stack is not currently compatible with Python 3.14+.
    if sys.version_info >= (3, 14):
        return None
    try:
        import spacy  # type: ignore
    except Exception:
        return None
    try:
        _SPACY_NLP = spacy.load("ja_core_news_md")
    except Exception:
        _SPACY_NLP = None
    return _SPACY_NLP


def _spacy_lemma_for_surface(nlp: Any, surface: str) -> str:
    doc = nlp(surface)
    for tok in doc:
        if (
            getattr(tok, "is_space", False)
            or getattr(tok, "is_punct", False)
            or getattr(tok, "is_stop", False)
        ):
            continue
        lemma = str(getattr(tok, "lemma_", "") or "").strip()
        lemma = unicodedata.normalize("NFC", lemma)
        if lemma:
            return lemma
        break
    # Deterministic fallback for empty/degenerate cases.
    return _normalize_surface_for_identity(surface)


def _ensure_words_schema(con: sqlite3.Connection) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS lexemes (
          id INTEGER PRIMARY KEY,
          content_key TEXT UNIQUE NOT NULL,
          surface TEXT NOT NULL,
          normalized_surface TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          first_seen DATE NOT NULL,
          last_seen DATE NOT NULL
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS lemmas (
          id INTEGER PRIMARY KEY,
          lemma TEXT NOT NULL,
          reading TEXT,
          rule_id TEXT NOT NULL,
          UNIQUE (lemma, rule_id)
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS lexeme_lemmas (
          lexeme_id INTEGER NOT NULL,
          lemma_id INTEGER NOT NULL,
          PRIMARY KEY (lexeme_id, lemma_id)
        )
        """
    )


def _upsert_lexeme(
    con: sqlite3.Connection,
    *,
    content_key: str,
    surface: str,
    normalized_surface: str,
    rule_id: str,
    first_seen: str,
    last_seen: str,
) -> None:
    con.execute(
        """
        INSERT INTO lexemes(content_key, surface, normalized_surface, rule_id, first_seen, last_seen)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_key) DO UPDATE SET
          first_seen = CASE WHEN lexemes.first_seen < excluded.first_seen THEN lexemes.first_seen ELSE excluded.first_seen END,
          last_seen = CASE WHEN lexemes.last_seen > excluded.last_seen THEN lexemes.last_seen ELSE excluded.last_seen END
        """,
        (content_key, surface, normalized_surface, rule_id, first_seen, last_seen),
    )


def _resolve_hashi_known_words_db(cfg: Config) -> Path | None:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None

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

    base = Path(output_dir)
    if not base.is_absolute():
        base = Path(appdata) / "Anki2" / cfg.anki_profile / output_dir
    db_path = base / "known_words.sqlite"
    return db_path if db_path.exists() else None


def _phase2_import_hashi_lexemes(
    con: sqlite3.Connection,
    *,
    cfg: Config,
    today: date,
) -> int:
    src_db = _resolve_hashi_known_words_db(cfg)
    if src_db is None:
        return 0

    imported = 0
    src_con = sqlite3.connect(f"file:{src_db}?mode=ro", uri=True)
    try:
        rows = src_con.execute(
            "SELECT content_key, surface, normalized_surface, rule_id, first_seen, last_seen FROM lexemes"
        ).fetchall()
        for content_key, surface, normalized_surface, rule_id, first_seen, last_seen in rows:
            _upsert_lexeme(
                con,
                content_key=str(content_key),
                surface=str(surface),
                normalized_surface=str(normalized_surface),
                rule_id=str(rule_id),
                first_seen=str(first_seen or today.isoformat()),
                last_seen=str(last_seen or today.isoformat()),
            )
            imported += 1
    finally:
        src_con.close()
    return imported


def _phase2_ingest_known_csv(
    con: sqlite3.Connection,
    *,
    root: Path,
    today: date,
    rule_id: str,
) -> int:
    data_dir = root / "data"
    csv_paths: list[Path] = []
    if data_dir.is_dir():
        csv_paths = sorted([p for p in data_dir.glob("*.csv") if p.is_file()])

    if not csv_paths:
        legacy_candidates = [
            root / "data" / "known.csv",
            root / "data" / "csv" / "known.csv",
            root / "known.csv",
        ]
        csv_paths = [p for p in legacy_candidates if p.exists()]

    if not csv_paths:
        return 0

    inserted = 0
    for csv_path in csv_paths:
        try:
            with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
                reader = csv.reader(f)
                rows = list(reader)
        except Exception:
            continue

        def _has_japanese_chars(value: str) -> bool:
            return bool(re.search(r"[\u3040-\u30ff\u3400-\u9fff]", value))

        def _next_nonempty_first(start: int) -> str:
            for r in rows[start:]:
                cell = _normalize_surface_for_identity(r[0] if r else "")
                if cell:
                    return cell
            return ""

        def _looks_like_header_row(idx: int) -> bool:
            r = rows[idx]
            first = _normalize_surface_for_identity(r[0] if r else "")
            if not first:
                return False

            first_lc = first.lower()
            header_words = {
                "word",
                "words",
                "surface",
                "expression",
                "lexeme",
                "lemma",
                "lemmas",
                "dictform",
                "dict_form",
                "dictionaryform",
            }
            if first_lc in header_words:
                return True

            if re.search(r"[a-z]", first_lc) and any(
                k in first_lc
                for k in (
                    "word",
                    "surface",
                    "expression",
                    "lexeme",
                    "lemma",
                    "morph",
                    "dictform",
                    "dict_form",
                    "hascard",
                    "reading",
                    "translation",
                )
            ):
                return True

            if len(r) > 1:
                rest = _normalize_surface_for_identity(" ".join(str(x or "") for x in r[1:]))
                if (
                    re.search(r"[A-Za-z]", first)
                    and re.search(r"[A-Za-z]", rest)
                    and not _has_japanese_chars(first)
                    and not _has_japanese_chars(rest)
                ):
                    return True

            if re.search(r"[A-Za-z]", first) and not _has_japanese_chars(first):
                next_first = _next_nonempty_first(idx + 1)
                if next_first and _has_japanese_chars(next_first):
                    return True

            return False

        start_idx = 0
        while start_idx < len(rows) and _looks_like_header_row(start_idx):
            header_surface = _normalize_surface_for_identity(
                rows[start_idx][0] if rows[start_idx] else ""
            )
            if header_surface:
                try:
                    header_key = _content_key_for_lexeme(header_surface, rule_id)
                    row = con.execute(
                        "SELECT id FROM lexemes WHERE content_key=? LIMIT 1", (header_key,)
                    ).fetchone()
                    if row:
                        lexeme_id = int(row[0])
                        con.execute("DELETE FROM lexeme_lemmas WHERE lexeme_id=?", (lexeme_id,))
                        con.execute("DELETE FROM lexemes WHERE id=?", (lexeme_id,))
                except Exception:
                    pass
            start_idx += 1

        day_s = today.isoformat()
        for row in rows[start_idx:]:
            surface_raw = row[0] if row else ""
            surface = _normalize_surface_for_identity(surface_raw)
            if not surface:
                continue
            key = _content_key_for_lexeme(surface, rule_id)
            _upsert_lexeme(
                con,
                content_key=key,
                surface=surface,
                normalized_surface=surface,
                rule_id=rule_id,
                first_seen=day_s,
                last_seen=day_s,
            )
            inserted += 1

    return inserted


def _phase2_build_lemmas(
    con: sqlite3.Connection,
    *,
    rebuild: bool,
) -> int:
    if rebuild:
        con.execute("DELETE FROM lexeme_lemmas;")
        con.execute("DELETE FROM lemmas;")

    nlp = _load_spacy_ja_model()
    if nlp is None:
        return 0

    if rebuild:
        lexeme_rows = con.execute("SELECT id, surface, rule_id FROM lexemes ORDER BY id").fetchall()
    else:
        lexeme_rows = con.execute(
            """
            SELECT l.id, l.surface, l.rule_id
            FROM lexemes l
            LEFT JOIN lexeme_lemmas ll ON ll.lexeme_id = l.id
            WHERE ll.lexeme_id IS NULL
            ORDER BY l.id
            """
        ).fetchall()

    linked = 0
    for lexeme_id, surface, rule_id in lexeme_rows:
        lemma = _spacy_lemma_for_surface(nlp, str(surface))
        lemma = _normalize_surface_for_identity(lemma)
        rid = str(rule_id)
        con.execute(
            "INSERT OR IGNORE INTO lemmas(lemma, reading, rule_id) VALUES(?, ?, ?)",
            (lemma, None, rid),
        )
        lemma_id = con.execute(
            "SELECT id FROM lemmas WHERE lemma=? AND rule_id=?",
            (lemma, rid),
        ).fetchone()[0]
        con.execute(
            "INSERT OR IGNORE INTO lexeme_lemmas(lexeme_id, lemma_id) VALUES(?, ?)",
            (int(lexeme_id), int(lemma_id)),
        )
        linked += 1

    return linked


def _run_external_lemma_builder(root: Path, words_db_path: Path, rebuild: bool) -> bool:
    exe = os.environ.get("TOKEI_PHASE2_PYTHON_EXE")
    if exe and exe.strip():
        py = exe.strip()
    else:
        candidates = [
            root / ".venv-lemmas" / "Scripts" / "python.exe",
            Path(__file__).resolve().parents[1] / ".venv-lemmas" / "Scripts" / "python.exe",
        ]
        py = ""
        for c in candidates:
            if c.exists():
                py = str(c)
                break

    if not py:
        return False

    script = Path(__file__).resolve().with_name("tokei_phase2_lemmas.py")
    if not script.exists():
        return False

    cmd = [py, str(script), str(words_db_path)]
    if rebuild:
        cmd.append("--rebuild")
    r = subprocess.run(cmd, cwd=str(root), capture_output=True, text=True)
    if r.returncode != 0:
        err = (r.stderr or "").strip()
        msg = err or (r.stdout or "").strip() or "unknown error"
        print(f"Phase 2 external lemma builder failed: {msg}", file=sys.stderr)
        return False
    return True
def _load_config(path: Path) -> Config:
    # Windows PowerShell's default "UTF8" encoding writes a BOM, which breaks json.loads
    # unless we decode with utf-8-sig.
    try:
        text = path.read_text(encoding="utf-8-sig")
    except Exception:
        text = path.read_text(encoding="utf-8", errors="replace")
    text = text.lstrip("\ufeff")
    raw = json.loads(text)
    tz = str(raw.get("timezone") or "America/Los_Angeles")
    theme = str(raw.get("theme") or "dark-graphite")
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

    mokuro = raw.get("mokuro") or {}
    mokuro_volume_data_path = str(mokuro.get("volume_data_path") or "")

    gsm = raw.get("gsm") or {}
    gsm_db_path = str(gsm.get("db_path") or "auto")

    phase2 = raw.get("phase2") or {}
    phase2_csv_rule_id = str(phase2.get("csv_rule_id") or "default").strip() or "default"

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
        mokuro_volume_data_path=mokuro_volume_data_path,
        gsm_db_path=gsm_db_path,
        phase2_csv_rule_id=phase2_csv_rule_id,
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
    if "tokei_surface_words" not in cols:
        con.execute("ALTER TABLE snapshots ADD COLUMN tokei_surface_words INTEGER NOT NULL DEFAULT 0;")


def _read_tokei_surface_words(root: Path) -> int:
    words_db = root / "cache" / "tokei_words.sqlite"
    if not words_db.exists():
        return 0
    con = sqlite3.connect(f"file:{words_db}?mode=ro", uri=True)
    try:
        row = con.execute("SELECT COUNT(DISTINCT normalized_surface) FROM lexemes").fetchone()
        return int(row[0] or 0) if row else 0
    except sqlite3.Error:
        return 0
    finally:
        con.close()


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


def _resolve_gsm_db_path(cfg: Config, warnings: list[str] | None = None) -> Path | None:
    p = (cfg.gsm_db_path or "").strip()
    if p.lower() == "off":
        return None
    if p.lower() == "auto" or not p:
        appdata = os.environ.get("APPDATA")
        if not appdata:
            if warnings is not None:
                warnings.append("Could not read GSM chars: APPDATA is not set.")
            return None
        p = str(Path(appdata) / "GameSentenceMiner" / "gsm.db")
    db_path = Path(p)
    if not db_path.exists():
        if warnings is not None:
            warnings.append(f"GSM DB not found: {db_path}.")
        return None
    return db_path


def _read_gsm_db_lifetime_chars(con: sqlite3.Connection) -> int:
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


def _detect_gsm_rollup_day_column(
    con: sqlite3.Connection,
) -> tuple[str, str, bool] | None:
    """
    Detect the day/date column in GSM's daily_stats_rollup.

    Returns:
      (column_name, kind, is_likely_day_column)

    kind:
      - "iso_text": ISO-ish day strings (YYYY-MM-DD...) stored as TEXT
      - "text": other TEXT values; still treat as "day-like" if the column name suggests it
      - "ymd_int": YYYYMMDD integer values
      - "unix_s": unix seconds
      - "unix_ms": unix milliseconds
    """
    cols = con.execute("PRAGMA table_info(daily_stats_rollup)").fetchall()
    if not cols:
        return None

    col_types: dict[str, str] = {str(name): str(tp or "") for (_cid, name, tp, _nn, _d, _pk) in cols}
    if "total_characters" not in col_types:
        return None

    preferred = ["day", "date", "report_day", "stat_day", "stat_date", "day_ts", "day_timestamp"]
    candidates = [c for c in preferred if c in col_types]
    candidates += [c for c in col_types.keys() if c not in candidates and ("day" in c.lower() or "date" in c.lower())]

    for day_col in candidates:
        tp = col_types.get(day_col, "").upper()
        is_likely_day_col = ("day" in day_col.lower()) or ("date" in day_col.lower())

        if "TEXT" in tp:
            sample = con.execute(
                f"SELECT {day_col} FROM daily_stats_rollup WHERE {day_col} IS NOT NULL LIMIT 1"
            ).fetchone()
            sample_s = str(sample[0]) if sample and sample[0] is not None else ""
            sample_s = sample_s.strip()
            if sample_s:
                try:
                    date.fromisoformat(sample_s[:10])
                    return (day_col, "iso_text", True)
                except Exception:
                    pass
            return (day_col, "text", is_likely_day_col)

        # Try numeric day columns.
        sample = con.execute(
            f"SELECT {day_col} FROM daily_stats_rollup WHERE {day_col} IS NOT NULL LIMIT 1"
        ).fetchone()
        if not sample:
            continue
        try:
            v = float(sample[0])
        except Exception:
            continue

        if 20_000_101 <= v <= 20_991_231:
            return (day_col, "ymd_int", True)
        if v > 10_000_000_000:  # ~year 2286 in seconds
            return (day_col, "unix_ms", True)
        return (day_col, "unix_s", True)

    return None


def _read_gsm_db_day_chars(
    con: sqlite3.Connection,
    *,
    today: date,
    tz: Any,
    day_col: str,
    kind: str,
) -> int:
    day_str = today.isoformat()

    if kind in ("iso_text", "text"):
        row = con.execute(
            f"""
            SELECT SUM(CAST(total_characters AS INTEGER))
            FROM daily_stats_rollup
            WHERE {day_col} = ? OR {day_col} LIKE ?
            """,
            (day_str, day_str + "%"),
        ).fetchone()
        # If there's no row for this day yet, treat as 0 (rollup missing).
        return int(row[0] or 0) if row and row[0] is not None else 0

    if kind == "ymd_int":
        ymd_int = int(today.strftime("%Y%m%d"))
        row = con.execute(
            f"""
            SELECT SUM(CAST(total_characters AS INTEGER))
            FROM daily_stats_rollup
            WHERE CAST({day_col} AS INTEGER) = ?
            """,
            (ymd_int,),
        ).fetchone()
        return int(row[0] or 0) if row and row[0] is not None else 0

    # unix timestamps
    start_dt = datetime.combine(today, time.min, tzinfo=tz)
    end_dt = start_dt + timedelta(days=1)
    start_ts = start_dt.timestamp()
    end_ts = end_dt.timestamp()
    if kind == "unix_ms":
        start_ts *= 1000.0
        end_ts *= 1000.0
    row = con.execute(
        f"""
        SELECT SUM(CAST(total_characters AS INTEGER))
        FROM daily_stats_rollup
        WHERE {day_col} >= ? AND {day_col} < ?
        """,
        (start_ts, end_ts),
    ).fetchone()
    return int(row[0] or 0) if row and row[0] is not None else 0


def _try_read_gsm_db_today_chars(
    con: sqlite3.Connection,
    *,
    today: date,
    tz: Any,
) -> int | None:
    detected = _detect_gsm_rollup_day_column(con)
    if detected is None:
        return None
    day_col, kind, is_likely_day_col = detected
    if not is_likely_day_col:
        return None
    return _read_gsm_db_day_chars(con, today=today, tz=tz, day_col=day_col, kind=kind)
    return None


def _read_gsm_live_today_chars(
    *,
    root: Path,
    today: date,
    warnings: list[str] | None = None,
) -> int | None:
    live_db = root / "cache" / "gsm_live.sqlite"
    if not live_db.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{live_db}?mode=ro", uri=True)
        try:
            row = con.execute(
                "SELECT COALESCE(SUM(total_chars), 0) FROM gsm_sessions WHERE day = ?",
                (today.isoformat(),),
            ).fetchone()
            return int(row[0] or 0) if row else 0
        finally:
            con.close()
    except sqlite3.Error as e:
        if warnings is not None:
            warnings.append(f"Failed to query GSM live DB: {live_db} ({type(e).__name__}).")
        return None


def _read_gsm_live_window_chars(
    *,
    root: Path,
    days: list[date],
    warnings: list[str] | None = None,
) -> dict[date, int] | None:
    live_db = root / "cache" / "gsm_live.sqlite"
    if not live_db.exists():
        return None

    days_by_iso = {d.isoformat(): d for d in days}
    placeholders = ", ".join(["?"] * len(days_by_iso))
    sql = f"""
      SELECT day, COALESCE(SUM(total_chars), 0)
      FROM gsm_sessions
      WHERE day IN ({placeholders})
      GROUP BY day
    """

    totals: dict[date, int] = {d: 0 for d in days}
    try:
        con = sqlite3.connect(f"file:{live_db}?mode=ro", uri=True)
        try:
            rows = con.execute(sql, tuple(days_by_iso.keys())).fetchall()
        finally:
            con.close()
        for day_s, total in rows:
            d = days_by_iso.get(str(day_s))
            if d is not None:
                totals[d] = int(total or 0)
        return totals
    except sqlite3.Error as e:
        if warnings is not None:
            warnings.append(f"Failed to query GSM live DB: {live_db} ({type(e).__name__}).")
        return None


def _read_gsm_chars(
    cfg: Config,
    *,
    root: Path,
    today: date,
    tz: Any,
    warnings: list[str] | None = None,
) -> int:
    # Window used to reconcile gsm.db rollup with gsm_live.sqlite.
    # We replace gsm.db totals for these days with max(db, live) to avoid double-counting.
    GSM_LIVE_WINDOW_DAYS = 3

    db_path = _resolve_gsm_db_path(cfg, warnings=warnings)
    if db_path is None:
        return 0
    try:
        con = sqlite3.connect(str(db_path))
        try:
            lifetime_db = _read_gsm_db_lifetime_chars(con)
            day_col_info = _detect_gsm_rollup_day_column(con)
            days = [today - timedelta(days=(GSM_LIVE_WINDOW_DAYS - 1 - i)) for i in range(GSM_LIVE_WINDOW_DAYS)]

            if day_col_info is None or not day_col_info[2]:
                today_live = _read_gsm_live_today_chars(root=root, today=today, warnings=warnings)
                if today_live is not None and warnings is not None:
                    warnings.append(
                        "GSM live session export detected, but could not locate a usable day column in gsm.db daily_stats_rollup to de-duplicate; using gsm.db lifetime as-is."
                    )
                return int(lifetime_db)

            live_totals = _read_gsm_live_window_chars(root=root, days=days, warnings=warnings)
            if live_totals is None:
                return int(lifetime_db)

            day_col, kind, _is_likely_day_col = day_col_info
            db_totals = {d: _read_gsm_db_day_chars(con, today=d, tz=tz, day_col=day_col, kind=kind) for d in days}

            db_window = sum(db_totals.values())
            merged_totals = {d: max(db_totals[d], live_totals[d]) for d in days}
            merged_window = sum(merged_totals.values())

            if warnings is not None:
                for d in days:
                    if live_totals[d] > db_totals[d]:
                        warnings.append(
                            f"GSM live sessions exceed gsm.db rollup for {d.isoformat()}: live={live_totals[d]}, db={db_totals[d]}. Using live sessions for that day."
                        )

            corrected = int(lifetime_db - int(db_window) + int(merged_window))
            return corrected
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
    tokei_surface_words: int,
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
        "known_words": int(tokei_surface_words),
        "known_words_delta": known_words_delta,
        "known_lemmas": int(known_lemmas),
        "known_lemmas_delta": int(known_words_delta),
        "known_inflections": known_inflections,
        "known_inflections_delta": known_inflections_delta,
        "tokei_surface_words": int(tokei_surface_words),
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
    # excluding zero days (nonzero-day average).
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
    parser.add_argument(
        "--rebuild-lemmas",
        action="store_true",
        help="Clear derived lemma tables and rebuild them from lexeme surfaces.",
    )
    parser.add_argument(
        "--phase2-only",
        action="store_true",
        help="Run Phase 2 (lexemes/lemmas/CSV) only and exit without generating a report.",
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

    # Phase 2: derived lemma system (idempotent, does not affect report JSON behavior).
    try:
        today_for_phase2 = datetime.now(tz).date()
        words_db_path = cache_dir / "tokei_words.sqlite"
        words_con = sqlite3.connect(str(words_db_path))
        try:
            words_con.execute("PRAGMA journal_mode=DELETE;")
            words_con.execute("PRAGMA synchronous=NORMAL;")
            _ensure_words_schema(words_con)
            _phase2_import_hashi_lexemes(words_con, cfg=cfg, today=today_for_phase2)
            _phase2_ingest_known_csv(
                words_con,
                root=root,
                today=today_for_phase2,
                rule_id=cfg.phase2_csv_rule_id,
            )

            missing_lemmas = int(
                words_con.execute(
                    """
                    SELECT COUNT(*)
                    FROM lexemes l
                    LEFT JOIN lexeme_lemmas ll ON ll.lexeme_id = l.id
                    WHERE ll.lexeme_id IS NULL
                    """
                ).fetchone()[0]
                or 0
            )
            if args.rebuild_lemmas or missing_lemmas:
                linked = _phase2_build_lemmas(words_con, rebuild=bool(args.rebuild_lemmas))
                if linked == 0 and (args.rebuild_lemmas or missing_lemmas):
                    words_con.commit()
                    _run_external_lemma_builder(
                        root, words_db_path=words_db_path, rebuild=bool(args.rebuild_lemmas)
                    )
            words_con.commit()
        finally:
            words_con.close()
    except Exception as e:
        print(f"Phase 2 skipped due to error: {type(e).__name__}", file=sys.stderr)

    if args.phase2_only:
        return 0

    api_token = _get_api_token(root)

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
        tokei_surface_words = _read_tokei_surface_words(root)
        known_lemmas = int(tokei_surface_words)
        known_inflections = int(tokei_surface_words)
        manga_chars_total = _read_mokuro_manga_chars(cfg, warnings=warnings)
        gsm_chars_total = _read_gsm_chars(cfg, root=root, today=today, tz=tz, warnings=warnings)
        anki_total, anki_reviews, anki_true_retention = _read_hashi_stats(cfg, warnings=warnings)

        # For deltas, compare against the previous report before the one we are generating.
        # If overwriting today's report, exclude that row itself.
        if args.overwrite_today and prev_today:
            prev = con.execute(
                """
                SELECT toggl_lifetime_seconds, known_lemmas, known_inflections, manga_chars_total, gsm_chars_total,
                       anki_total_reviews, anki_true_retention, tokei_surface_words
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
                       anki_total_reviews, anki_true_retention, tokei_surface_words
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
        prev_tokei_surface_words = int(prev[7]) if prev else tokei_surface_words

        retention_rate = anki_true_retention * 100.0
        retention_delta = round(retention_rate - prev_retention_rate, 2)

        anki_total_delta = int(anki_total - prev_anki_total)
        known_words_delta = int(tokei_surface_words - prev_tokei_surface_words)
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
                    tokei_surface_words=?,
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
                    int(tokei_surface_words),
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
                  known_lemmas, known_inflections, tokei_surface_words, manga_chars_total, gsm_chars_total,
                  anki_total_reviews, anki_reviews, anki_true_retention, warnings_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    int(tokei_surface_words),
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
            tokei_surface_words=tokei_surface_words,
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
