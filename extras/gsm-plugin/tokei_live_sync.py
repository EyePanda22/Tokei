"""
Tokei GSM live sessions exporter (helper module)

This module is intended to live next to GSM's user plugins file:
  %APPDATA%\\GameSentenceMiner\\tokei_live_sync.py

GSM's plugins.py can then import and call it from main().
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from datetime import datetime

try:
    # Newer GSM versions
    from GameSentenceMiner.util.logging_config import logger  # type: ignore
except Exception:
    try:
        # Older GSM versions
        from GameSentenceMiner.util.configuration import logger  # type: ignore
    except Exception:
        import logging

        logger = logging.getLogger("tokei.gsm_live")  # type: ignore

API_URL = "http://localhost:55000/api/today-stats"


def _default_db_path() -> str:
    tokei_root = (os.environ.get("TOKEI_USER_ROOT") or "").strip()
    if not tokei_root:
        appdata = (os.environ.get("APPDATA") or "").strip()
        tokei_root = os.path.join(appdata, "Tokei") if appdata else ""
    return os.path.join(tokei_root, "cache", "gsm_live.sqlite") if tokei_root else "gsm_live.sqlite"


DB_PATH = _default_db_path()


def _fetch_json(url: str, timeout_s: float = 2.5) -> dict:
    import urllib.request

    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        data = resp.read().decode("utf-8", errors="replace")
    payload = json.loads(data)
    return payload if isinstance(payload, dict) else {}


def _ensure_schema(con: sqlite3.Connection) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS gsm_sessions (
          session_key TEXT PRIMARY KEY,
          day TEXT NOT NULL,
          game_name TEXT NOT NULL,
          start_time REAL NOT NULL,
          end_time REAL NOT NULL,
          total_chars INTEGER NOT NULL,
          total_seconds REAL NOT NULL,
          last_seen REAL NOT NULL
        )
        """
    )
    con.execute("CREATE INDEX IF NOT EXISTS idx_gsm_sessions_day ON gsm_sessions(day)")


def _session_key(game_name: str, start_time: float) -> str:
    raw = f"{game_name}|{start_time}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def export_today_sessions_to_sqlite() -> None:
    try:
        payload = _fetch_json(API_URL)
    except Exception as e:
        logger.info(f"[Tokei] GSM today-stats not reachable: {e}")
        return

    sessions = payload.get("sessions")
    if not isinstance(sessions, list) or not sessions:
        return

    out_dir = os.path.dirname(DB_PATH)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    now = time.time()
    con = sqlite3.connect(DB_PATH)
    try:
        _ensure_schema(con)

        for s in sessions:
            if not isinstance(s, dict):
                continue

            game_name = str(s.get("gameName") or "")
            start_time = float(s.get("startTime") or 0)
            end_time = float(s.get("endTime") or 0)
            total_chars = int(s.get("totalChars") or 0)
            total_seconds = float(s.get("totalSeconds") or 0)

            if start_time <= 0 or end_time <= 0:
                continue

            # "today" here means the local date of the session start timestamp.
            day = datetime.fromtimestamp(start_time).date().isoformat()
            key = _session_key(game_name, start_time)

            con.execute(
                """
                INSERT INTO gsm_sessions(session_key, day, game_name, start_time, end_time, total_chars, total_seconds, last_seen)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_key) DO UPDATE SET
                  end_time = excluded.end_time,
                  total_chars = excluded.total_chars,
                  total_seconds = excluded.total_seconds,
                  last_seen = excluded.last_seen
                """,
                (key, day, game_name, start_time, end_time, total_chars, total_seconds, now),
            )

        con.commit()
        logger.info(f"[Tokei] Wrote GSM sessions to {DB_PATH}")
    finally:
        con.close()


def main() -> None:
    export_today_sessions_to_sqlite()

