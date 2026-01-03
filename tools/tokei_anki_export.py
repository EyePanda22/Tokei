from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import tempfile
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import shutil


@dataclass(frozen=True)
class AnkiSnapshotRule:
    rule_id: str
    deck_paths: list[str]
    include_subdecks: bool
    note_types: list[str]
    target_field: str
    mature_interval_days: int


@dataclass(frozen=True)
class AnkiSnapshotConfig:
    enabled: bool
    stats_range_days: int | None
    output_dir: str
    rules: list[AnkiSnapshotRule]


def _utc_now_iso() -> str:
    return (
        datetime.now(tz=timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _utc_iso_from_epoch_ms(epoch_ms: int) -> str:
    return (
        datetime.fromtimestamp(epoch_ms / 1000.0, tz=timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _json_dump_atomic(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tokei-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass


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


def _load_config(root: Path) -> tuple[str, AnkiSnapshotConfig]:
    config_path = root / "config.json"
    raw = json.loads(config_path.read_text(encoding="utf-8-sig").lstrip("\ufeff"))
    anki_profile = str(raw.get("anki_profile") or "User 1")

    snap_raw = raw.get("anki_snapshot") or {}
    enabled = bool(snap_raw.get("enabled", False))
    stats_range_days_raw = snap_raw.get("stats_range_days")
    stats_range_days = int(stats_range_days_raw) if isinstance(stats_range_days_raw, int) else None
    output_dir = str(snap_raw.get("output_dir") or "hashi_exports").strip() or "hashi_exports"

    rules: list[AnkiSnapshotRule] = []
    rules_raw = snap_raw.get("rules")
    if isinstance(rules_raw, list) and rules_raw:
        for item in rules_raw:
            if not isinstance(item, dict):
                continue
            rule_id = str(item.get("rule_id") or "").strip() or "default"
            deck_paths_raw = item.get("deck_paths")
            deck_paths = (
                [str(s).strip() for s in deck_paths_raw if isinstance(s, str) and str(s).strip()]
                if isinstance(deck_paths_raw, list)
                else []
            )
            include_subdecks = bool(item.get("include_subdecks", True))
            note_types_raw = item.get("note_types")
            note_types = (
                [str(s).strip() for s in note_types_raw if isinstance(s, str) and str(s).strip()]
                if isinstance(note_types_raw, list)
                else []
            )
            target_field = str(item.get("target_field") or "").strip()
            mature_interval_days = int(item.get("mature_interval_days") or 21)
            if deck_paths and target_field:
                rules.append(
                    AnkiSnapshotRule(
                        rule_id=rule_id,
                        deck_paths=deck_paths,
                        include_subdecks=include_subdecks,
                        note_types=note_types,
                        target_field=target_field,
                        mature_interval_days=mature_interval_days,
                    )
                )
    else:
        # Back-compat: single-rule config fields.
        rule_id = str(snap_raw.get("rule_id") or "default").strip() or "default"
        deck_path = str(snap_raw.get("deck_path") or "").strip()
        include_subdecks = bool(snap_raw.get("include_subdecks", True))
        note_type = str(snap_raw.get("note_type") or "").strip()
        target_field = str(snap_raw.get("target_field") or "").strip()
        mature_interval_days = int(snap_raw.get("mature_interval_days") or 21)
        if deck_path and target_field:
            rules.append(
                AnkiSnapshotRule(
                    rule_id=rule_id,
                    deck_paths=[deck_path],
                    include_subdecks=include_subdecks,
                    note_types=[note_type] if note_type else [],
                    target_field=target_field,
                    mature_interval_days=mature_interval_days,
                )
            )

    cfg = AnkiSnapshotConfig(
        enabled=enabled,
        stats_range_days=stats_range_days,
        output_dir=output_dir,
        rules=rules,
    )
    return anki_profile, cfg


def _resolve_output_dir(appdata: str, profile: str, output_dir: str) -> Path:
    base = Path(output_dir)
    if base.is_absolute():
        return base
    return Path(appdata) / "Anki2" / profile / output_dir


def _resolve_collection_db(appdata: str, profile: str) -> Path:
    return Path(appdata) / "Anki2" / profile / "collection.anki2"

def _to_deck_path(storage_name: str) -> str:
    return str(storage_name or "").replace("\x1f", "::")


def _connect_sqlite_ro(db_path: Path, *, busy_timeout_ms: int) -> sqlite3.Connection:
    con = sqlite3.connect(
        f"file:{db_path}?mode=ro",
        uri=True,
        timeout=max(0.1, busy_timeout_ms / 1000.0),
    )
    try:
        # Anki's collection DB uses custom collations (notably "unicase") in its schema.
        # When opening the DB outside of Anki, those collations are not registered and
        # any query that compares such columns can fail with:
        #   sqlite3.OperationalError: no such collation sequence: unicase
        def _unicase_cmp(a: Any, b: Any) -> int:
            sa = "" if a is None else str(a)
            sb = "" if b is None else str(b)
            fa = sa.casefold()
            fb = sb.casefold()
            if fa < fb:
                return -1
            if fa > fb:
                return 1
            return 0

        con.create_collation("unicase", _unicase_cmp)
        con.execute(f"PRAGMA busy_timeout={int(max(0, busy_timeout_ms))};")
        con.execute("PRAGMA query_only=ON;")
    except sqlite3.Error:
        pass
    return con


def _is_busy_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return (
        "database is locked" in msg
        or "database is busy" in msg
        or "locked" in msg
        or "busy" in msg
    )


def _copy_collection_to_temp(collection_path: Path) -> Path:
    tmp_dir = Path(tempfile.mkdtemp(prefix="tokei-anki-"))
    dst = tmp_dir / collection_path.name
    shutil.copy2(collection_path, dst)
    for suffix in ("-wal", "-shm"):
        src_sidecar = collection_path.with_name(collection_path.name + suffix)
        if src_sidecar.exists():
            try:
                shutil.copy2(src_sidecar, tmp_dir / src_sidecar.name)
            except Exception:
                pass
    return dst


class _CollectionDbRo:
    def __init__(self, collection_path: Path, *, busy_timeout_ms: int):
        self._collection_path = collection_path
        self._busy_timeout_ms = int(busy_timeout_ms)
        self._tmp_root: Path | None = None
        self._con: sqlite3.Connection | None = None

    def __enter__(self) -> sqlite3.Connection:
        self._con = None
        self._tmp_root = None

        try:
            con = _connect_sqlite_ro(self._collection_path, busy_timeout_ms=self._busy_timeout_ms)
            con.execute("SELECT 1 FROM decks LIMIT 1").fetchone()
            self._con = con
            return con
        except sqlite3.Error as e:
            try:
                con.close()  # type: ignore[has-type]
            except Exception:
                pass
            if not _is_busy_error(e):
                raise

        copied_path = _copy_collection_to_temp(self._collection_path)
        self._tmp_root = copied_path.parent
        con2 = _connect_sqlite_ro(copied_path, busy_timeout_ms=self._busy_timeout_ms)
        self._con = con2
        return con2

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        try:
            if self._con is not None:
                try:
                    self._con.close()
                except Exception:
                    pass
        finally:
            if self._tmp_root is not None:
                try:
                    shutil.rmtree(self._tmp_root, ignore_errors=True)
                except Exception:
                    pass
        return False


def _resolve_deck_ids(con: sqlite3.Connection, deck_paths: list[str], include_subdecks: bool) -> list[int]:
    if not deck_paths:
        return []
    want_storage = [p.replace("::", "\x1f") for p in deck_paths]
    rows = con.execute("SELECT id, name FROM decks ORDER BY id").fetchall()
    want: list[int] = []
    for did, name in rows:
        name_s = str(name or "")
        for idx in range(len(deck_paths)):
            p = deck_paths[idx]
            ps = want_storage[idx]
            if name_s == p or name_s == ps:
                want.append(int(did))
                break
            if include_subdecks and (name_s.startswith(p + "::") or name_s.startswith(ps + "\x1f")):
                want.append(int(did))
                break
    return sorted(set(want))

def _resolve_note_type_ids(con: sqlite3.Connection, note_types: list[str]) -> list[int]:
    out: list[int] = []
    for nt in note_types:
        row = con.execute("SELECT id FROM notetypes WHERE name=? LIMIT 1", (str(nt),)).fetchone()
        if row and row[0] is not None:
            out.append(int(row[0]))
    return sorted(set(out))


def _field_ord_by_mid(con: sqlite3.Connection, mids: list[int], field_name: str) -> dict[int, int]:
    if not mids:
        return {}
    placeholders = ",".join("?" for _ in mids)
    rows = con.execute(
        f"SELECT ntid, ord FROM fields WHERE ntid IN ({placeholders}) AND name=?",
        (*[int(m) for m in mids], str(field_name)),
    ).fetchall()
    return {int(ntid): int(ord_) for ntid, ord_ in rows if ntid is not None and ord_ is not None}


def _ensure_known_words_schema(con: sqlite3.Connection) -> None:
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
        CREATE TABLE IF NOT EXISTS lexeme_snapshots (
          lexeme_id INTEGER NOT NULL,
          snapshot_date DATE NOT NULL,
          PRIMARY KEY (lexeme_id, snapshot_date)
        )
        """
    )


def _phase1_process_lexemes(
    con: sqlite3.Connection,
    *,
    raw_rows: list[str],
    rule_id: str,
    snapshot_date: str,
) -> int:
    _ensure_known_words_schema(con)
    inserted = 0
    con.execute("BEGIN")
    try:
        for surface in raw_rows:
            normalized = _normalize_surface_for_identity(surface)
            if not normalized:
                continue
            content_key = _content_key_for_lexeme(normalized, rule_id)
            row = con.execute(
                """
                INSERT INTO lexemes (
                  content_key, surface, normalized_surface, rule_id, first_seen, last_seen
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(content_key) DO UPDATE SET
                  last_seen = excluded.last_seen
                RETURNING id
                """,
                (content_key, surface, normalized, rule_id, snapshot_date, snapshot_date),
            ).fetchone()
            if not row:
                raise RuntimeError("Failed to upsert lexeme row")
            lexeme_id = int(row[0])
            con.execute(
                """
                INSERT OR IGNORE INTO lexeme_snapshots(lexeme_id, snapshot_date)
                VALUES(?, ?)
                """,
                (lexeme_id, snapshot_date),
            )
            inserted += 1
        con.commit()
        return inserted
    except Exception:
        try:
            con.rollback()
        except Exception:
            pass
        raise


def _mature_lexeme_surfaces(
    con: sqlite3.Connection,
    *,
    deck_ids: list[int],
    note_type_ids: list[int] | None,
    field_ord_by_mid: dict[int, int],
    mature_interval_days: int,
) -> list[str]:
    if not deck_ids:
        return []
    did_placeholders = ",".join("?" for _ in deck_ids)
    params: list[Any] = [*deck_ids, int(mature_interval_days)]

    mid_filter = ""
    if note_type_ids:
        mid_placeholders = ",".join("?" for _ in note_type_ids)
        mid_filter = f" AND n.mid IN ({mid_placeholders})"
        params.extend([int(m) for m in note_type_ids])

    rows = con.execute(
        f"""
        SELECT n.mid, n.flds
        FROM cards c
        JOIN notes n ON n.id = c.nid
        WHERE c.did IN ({did_placeholders})
          AND c.ivl >= ?
          {mid_filter}
        ORDER BY c.id
        """,
        params,
    ).fetchall()
    out: list[str] = []
    for mid, flds in rows:
        mid_i = int(mid)
        field_ord = field_ord_by_mid.get(mid_i)
        if field_ord is None:
            continue
        flds_s = flds if isinstance(flds, str) else ""
        parts = flds_s.split("\x1f")
        surface = parts[field_ord] if 0 <= field_ord < len(parts) else ""
        out.append(str(surface or "").strip())
    return out


def _distinct_note_type_ids_in_decks(con: sqlite3.Connection, deck_ids: list[int]) -> list[int]:
    if not deck_ids:
        return []
    did_placeholders = ",".join("?" for _ in deck_ids)
    rows = con.execute(
        f"""
        SELECT DISTINCT n.mid
        FROM cards c
        JOIN notes n ON n.id = c.nid
        WHERE c.did IN ({did_placeholders})
        """,
        (*[int(d) for d in deck_ids],),
    ).fetchall()
    return sorted({int(mid) for (mid,) in rows if mid is not None})


def _count_true_reviews(
    con: sqlite3.Connection,
    *,
    deck_ids: list[int],
    start_ms: int | None,
    end_ms: int,
    mature_interval_days: int,
) -> tuple[int, int, int | None]:
    if not deck_ids:
        return 0, 0, None

    did_placeholders = ",".join("?" for _ in deck_ids)
    params: list[Any] = [*deck_ids, int(mature_interval_days)]

    time_filter = ""
    if start_ms is not None:
        time_filter = " AND r.id >= ? AND r.id <= ?"
        params.extend([int(start_ms), int(end_ms)])

    row = con.execute(
        f"""
        SELECT
          SUM(CASE WHEN r.ease != 1 THEN 1 ELSE 0 END) AS correct,
          COUNT(*) AS total
        FROM revlog r
        JOIN cards c ON c.id = r.cid
        WHERE r.type = 1
          AND c.did IN ({did_placeholders})
          AND c.ivl >= ?
          {time_filter}
        """,
        params,
    ).fetchone()
    correct = int(row[0] or 0) if row else 0
    total = int(row[1] or 0) if row else 0

    used_start_ms: int | None
    if start_ms is not None:
        used_start_ms = int(start_ms)
    else:
        min_row = con.execute(
            f"""
            SELECT MIN(r.id)
            FROM revlog r
            JOIN cards c ON c.id = r.cid
            WHERE r.type = 1
              AND c.did IN ({did_placeholders})
              AND c.ivl >= ?
            """,
            params,
        ).fetchone()
        used_start_ms = int(min_row[0]) if min_row and min_row[0] is not None else None

    return total, correct, used_start_ms


def _count_cards_studied(
    con: sqlite3.Connection,
    *,
    deck_ids: list[int],
    start_ms: int | None,
    end_ms: int,
) -> int:
    if not deck_ids:
        return 0
    did_placeholders = ",".join("?" for _ in deck_ids)
    params: list[Any] = [*deck_ids]
    time_filter = ""
    if start_ms is not None:
        time_filter = " AND r.id >= ? AND r.id <= ?"
        params.extend([int(start_ms), int(end_ms)])
    row = con.execute(
        f"""
        SELECT COUNT(*)
        FROM revlog r
        JOIN cards c ON c.id = r.cid
        WHERE c.did IN ({did_placeholders})
          {time_filter}
        """,
        params,
    ).fetchone()
    return int(row[0] or 0) if row else 0


def export_snapshot(*, root: Path, trigger: str) -> Path:
    appdata = os.environ.get("APPDATA") or ""
    if not appdata:
        raise RuntimeError("APPDATA is not set.")

    profile, cfg = _load_config(root)
    if not cfg.enabled:
        raise RuntimeError("anki_snapshot.enabled is false.")

    if not cfg.rules:
        raise RuntimeError("anki_snapshot.rules is required (or configure legacy single-rule fields).")

    collection_db = _resolve_collection_db(appdata, profile)
    if not collection_db.exists():
        raise RuntimeError(f"Anki collection DB not found: {collection_db}")

    out_dir = _resolve_output_dir(appdata, profile, cfg.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stats_path = out_dir / "anki_stats_snapshot.json"
    lexical_path = out_dir / "lexical_snapshot.json"
    known_words_db_path = out_dir / "known_words.sqlite"
    exported_at = _utc_now_iso()
    snapshot_date = exported_at.split("T", 1)[0]

    busy_timeout_ms = 5000

    with _CollectionDbRo(collection_db, busy_timeout_ms=busy_timeout_ms) as con:
        end_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        start_ms: int | None
        if cfg.stats_range_days is None:
            start_ms = None
        else:
            start_ms = max(0, end_ms - int(cfg.stats_range_days) * 86400 * 1000)

        deck_rows: list[dict[str, Any]] = []
        lexical_deck_rows: list[dict[str, Any]] = []
        all_lexemes: list[tuple[str, str, int, str]] = []
        total_reviews = 0
        total_correct = 0
        total_cards_studied = 0
        overall_start_ms: int | None = None

        for rule in cfg.rules:
            deck_ids = _resolve_deck_ids(con, rule.deck_paths, bool(rule.include_subdecks))
            if not deck_ids:
                raise RuntimeError(f"Rule '{rule.rule_id}' refers to missing deck(s): {rule.deck_paths}")

            reviews, correct, used_start_ms = _count_true_reviews(
                con,
                deck_ids=deck_ids,
                start_ms=start_ms,
                end_ms=end_ms,
                mature_interval_days=int(rule.mature_interval_days),
            )
            cards_studied = _count_cards_studied(con, deck_ids=deck_ids, start_ms=start_ms, end_ms=end_ms)

            if used_start_ms is not None:
                overall_start_ms = used_start_ms if overall_start_ms is None else min(overall_start_ms, used_start_ms)

            total_reviews += int(reviews)
            total_correct += int(correct)
            total_cards_studied += int(cards_studied)

            mids: list[int]
            if rule.note_types:
                mids = _resolve_note_type_ids(con, rule.note_types)
                if not mids:
                    raise RuntimeError(f"Rule '{rule.rule_id}' note_types not found: {rule.note_types}")
            else:
                mids = _distinct_note_type_ids_in_decks(con, deck_ids)

            ord_by_mid = _field_ord_by_mid(con, mids, rule.target_field)
            missing = [m for m in mids if m not in ord_by_mid]
            if missing:
                raise RuntimeError(
                    f"Rule '{rule.rule_id}' target_field '{rule.target_field}' missing on {len(missing)} note type(s)."
                )

            rows = con.execute(
                "SELECT id, name FROM decks WHERE id IN (" + ",".join("?" for _ in deck_ids) + ") ORDER BY id",
                (*[int(d) for d in deck_ids],),
            ).fetchall()
            deck_id0 = int(deck_ids[0])
            deck_name0 = str(rule.deck_paths[0])
            for did, name in rows:
                if int(did) == deck_id0:
                    deck_name0 = str(name or deck_name0)
                    break

            lexeme_surfaces = _mature_lexeme_surfaces(
                con,
                deck_ids=deck_ids,
                note_type_ids=mids if rule.note_types else None,
                field_ord_by_mid=ord_by_mid,
                mature_interval_days=int(rule.mature_interval_days),
            )
            for s in lexeme_surfaces:
                all_lexemes.append((exported_at, rule.rule_id, int(deck_id0), str(s)))

            lexical_deck_rows.append(
                {
                    "rule_id": rule.rule_id,
                    "deck_id": int(deck_id0),
                    "deck_name": deck_name0.replace("\x1f", "::"),
                    "target_field": rule.target_field,
                    "mature_interval_days": int(rule.mature_interval_days),
                    "mature_lexical_count": int(len(lexeme_surfaces)),
                }
            )

            deck_rows.append(
                {
                    "rule_id": rule.rule_id,
                    "deck_id": int(deck_id0),
                    "deck_name": deck_name0.replace("\x1f", "::"),
                    "cards_studied": int(cards_studied),
                    "reviews": int(reviews),
                    "true_retention": (float(correct) / float(reviews)) if reviews else 0.0,
                    "debug": {"mature_interval_days": int(rule.mature_interval_days)},
                }
            )

        if overall_start_ms is None:
            overall_start_ms = start_ms if start_ms is not None else 0

        stats = {
            "range": {
                "start": _utc_iso_from_epoch_ms(int(overall_start_ms)),
                "end": _utc_iso_from_epoch_ms(int(end_ms)),
            },
            "decks": deck_rows,
            "totals": {
                "cards_studied": int(total_cards_studied),
                "reviews": int(total_reviews),
                "true_retention": (float(total_correct) / float(total_reviews)) if total_reviews else 0.0,
                "reviews_revlog_lastIvl": int(total_reviews),
                "true_retention_revlog_lastIvl": (float(total_correct) / float(total_reviews)) if total_reviews else 0.0,
                "reviews_revlog_ivl": int(total_reviews),
                "true_retention_revlog_ivl": (float(total_correct) / float(total_reviews)) if total_reviews else 0.0,
                "reviews_reviewlike": int(total_reviews),
                "true_retention_reviewlike": (float(total_correct) / float(total_reviews)) if total_reviews else 0.0,
            },
            "meta": {
                "exported_at": exported_at,
                "trigger": trigger,
                "profile_name": profile,
            },
        }

    with sqlite3.connect(str(known_words_db_path)) as kw_con:
        _ensure_known_words_schema(kw_con)
        kw_con.execute("BEGIN")
        try:
            for _snapshot_ts, rule_id, _deck_id, surface in all_lexemes:
                normalized = _normalize_surface_for_identity(surface)
                if not normalized:
                    continue
                content_key = _content_key_for_lexeme(normalized, rule_id)
                row = kw_con.execute(
                    """
                    INSERT INTO lexemes (
                      content_key, surface, normalized_surface, rule_id, first_seen, last_seen
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(content_key) DO UPDATE SET
                      last_seen = excluded.last_seen
                    RETURNING id
                    """,
                    (content_key, surface, normalized, rule_id, snapshot_date, snapshot_date),
                ).fetchone()
                if not row:
                    continue
                lexeme_id = int(row[0])
                kw_con.execute(
                    """
                    INSERT OR IGNORE INTO lexeme_snapshots(lexeme_id, snapshot_date)
                    VALUES(?, ?)
                    """,
                    (lexeme_id, snapshot_date),
                )
            kw_con.commit()
        except Exception:
            try:
                kw_con.rollback()
            except Exception:
                pass
            raise

    lexical_snapshot = {
        "range": {"start": exported_at, "end": exported_at},
        "decks": lexical_deck_rows,
        "meta": {
            "exported_at": exported_at,
            "trigger": trigger,
            "profile_name": profile,
        },
    }

    _json_dump_atomic(stats_path, stats)
    _json_dump_atomic(lexical_path, lexical_snapshot)
    return stats_path


def discover_collection(*, profile: str) -> dict[str, Any]:
    appdata = os.environ.get("APPDATA") or ""
    if not appdata:
        return {"ok": False, "error": "APPDATA is not set."}

    collection_db = _resolve_collection_db(appdata, profile)
    if not collection_db.exists():
        return {"ok": False, "error": f"collection.anki2 not found: {collection_db}"}

    busy_timeout_ms = 5000
    with _CollectionDbRo(collection_db, busy_timeout_ms=busy_timeout_ms) as con:
        deck_rows = con.execute("SELECT id, name FROM decks ORDER BY name").fetchall()
        decks: list[dict[str, Any]] = [{"id": int(did), "name": _to_deck_path(str(name or ""))} for did, name in deck_rows]

        nt_rows = con.execute("SELECT id, name FROM notetypes ORDER BY name").fetchall()
        note_types: list[dict[str, Any]] = [{"id": int(mid), "name": str(name or "")} for mid, name in nt_rows]

        fields_rows = con.execute("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord").fetchall()
        fields_by_mid: dict[int, list[str]] = {}
        for ntid, _ord, fname in fields_rows:
            fields_by_mid.setdefault(int(ntid), []).append(str(fname or ""))
        for nt in note_types:
            nt["fields"] = fields_by_mid.get(int(nt["id"]), [])

        deck_mid_rows = con.execute(
            """
            SELECT DISTINCT c.did, n.mid
            FROM cards c
            JOIN notes n ON n.id = c.nid
            ORDER BY c.did, n.mid
            """
        ).fetchall()
        mids_by_deck: dict[int, list[int]] = {}
        for did, mid in deck_mid_rows:
            mids_by_deck.setdefault(int(did), []).append(int(mid))
        for d in decks:
            d["note_type_ids"] = sorted(set(mids_by_deck.get(int(d["id"]), [])))

    return {"ok": True, "profile": profile, "decks": decks, "note_types": note_types}


def main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--trigger", default="tokei")
    parser.add_argument("--discover", action="store_true")
    parser.add_argument("--profile")
    args = parser.parse_args(argv[1:])

    env_root = os.environ.get("TOKEI_USER_ROOT")
    root = Path(env_root).resolve() if env_root else Path(__file__).resolve().parents[1]
    if args.discover:
        profile = str(args.profile or "").strip()
        if not profile:
            try:
                profile, _cfg = _load_config(root)
            except Exception:
                profile = "User 1"
        payload = discover_collection(profile=profile)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if payload.get("ok") else 1

    export_snapshot(root=root, trigger=str(args.trigger))
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    raise SystemExit(main(sys.argv))
