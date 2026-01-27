from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def _default_config() -> dict:
    return {
        "anki_profile": "User 1",
        "timezone": "local",
        "theme": "dark-graphite",
        "output_dir": "output",
        "one_page": True,
        "anki_stats": {"require_fresh": True},
        "toggl": {
            "start_date": "auto",
            "refresh_days_back": 60,
            "refresh_buffer_days": 2,
            "chunk_days": 7,
            "baseline_hours": 0,
        },
        "mokuro": {"volume_data_path": ""},
        "ttsu": {"data_dir": ""},
        "gsm": {"db_path": "auto"},
    }


def _delete_tree_contents(dir_path: Path) -> list[str]:
    deleted: list[str] = []
    if not dir_path.exists():
        return deleted
    if not dir_path.is_dir():
        return deleted

    for p in sorted(dir_path.rglob("*"), reverse=True):
        try:
            if p.is_file() or p.is_symlink():
                p.unlink()
                deleted.append(str(p))
            elif p.is_dir():
                try:
                    p.rmdir()
                    deleted.append(str(p) + os.sep)
                except OSError:
                    pass
        except OSError:
            pass
    return deleted


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Path to Tokei config.json")
    parser.add_argument("--cache-dir", required=True, help="Path to Tokei/cache")
    parser.add_argument("--output-dir", required=True, help="Path to Tokei/output")
    parser.add_argument("--delete-token", action="store_true", help="Also delete Tokei/toggl-token.txt")
    parser.add_argument("--yes", action="store_true", help="Skip interactive confirmation (used by .bat)")
    args = parser.parse_args(argv[1:])

    config_path = Path(args.config)
    cache_dir = Path(args.cache_dir)
    output_dir = Path(args.output_dir)
    tokei_dir = config_path.parent
    token_path = tokei_dir / "toggl-token.txt"

    if not args.yes:
        print("Refusing to reset without --yes (use Reset-Tokei.bat).")
        return 2

    _delete_tree_contents(cache_dir)
    _delete_tree_contents(output_dir)

    config_path.write_text(
        json.dumps(_default_config(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    if args.delete_token and token_path.exists():
        try:
            token_path.unlink()
        except OSError:
            pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main(os.sys.argv))
