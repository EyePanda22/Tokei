from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from tokei_errors import ConfigError

def _parse_hms_to_hours(value: str) -> float:
    parts = value.strip().split(":")
    if len(parts) != 3:
        raise ValueError("expected HH:MM:SS")
    hours_s, minutes_s, seconds_s = parts
    hours = int(hours_s)
    minutes = int(minutes_s)
    seconds = int(seconds_s)
    if hours < 0 or minutes < 0 or seconds < 0:
        raise ValueError("negative values not allowed")
    if minutes >= 60 or seconds >= 60:
        raise ValueError("minutes/seconds out of range")
    return hours + (minutes / 60.0) + (seconds / 3600.0)


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _save_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--anki-profile")
    parser.add_argument("--timezone")
    parser.add_argument("--theme")
    parser.add_argument(
        "--output-dir",
        help="Output directory for HTML/PNG (relative to Tokei folder or absolute).",
    )
    parser.add_argument("--start-date")
    parser.add_argument("--baseline-hms", help="Baseline lifetime time as HH:MM:SS (hours may exceed 24).")
    parser.add_argument("--baseline-hours", type=float)
    args = parser.parse_args(argv[1:])

    config_path = Path(args.config)
    data = _load_json(config_path)

    data.setdefault("anki_profile", "User 1")
    data.setdefault("timezone", "local")
    data.setdefault("theme", "midnight")
    data.setdefault("one_page", True)
    data.setdefault("toggl", {})
    data.setdefault("ankimorphs", {})

    if args.anki_profile:
        data["anki_profile"] = str(args.anki_profile)
    if args.timezone:
        data["timezone"] = str(args.timezone)
    if args.theme:
        data["theme"] = str(args.theme)
    if args.output_dir:
        data["output_dir"] = str(args.output_dir)

    toggl = data.get("toggl") if isinstance(data.get("toggl"), dict) else {}
    if args.start_date:
        toggl["start_date"] = str(args.start_date)
    if args.baseline_hms:
        try:
            toggl["baseline_hours"] = float(_parse_hms_to_hours(str(args.baseline_hms)))
        except Exception as e:
            raise ConfigError(f"Invalid --baseline-hms '{args.baseline_hms}': {e}") from e
    elif args.baseline_hours is not None:
        toggl["baseline_hours"] = float(args.baseline_hours)
    data["toggl"] = toggl

    _save_json(config_path, data)
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    try:
        raise SystemExit(main(sys.argv))
    except ConfigError as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(e.exit_code)
