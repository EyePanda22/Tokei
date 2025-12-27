from __future__ import annotations

import os
import runpy
import shutil
import subprocess
import sys
import traceback
from pathlib import Path


def _roots() -> tuple[Path, Path]:
    if getattr(sys, "frozen", False):
        app_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent)).resolve()
        user_root = Path(sys.executable).resolve().parent
        return app_root, user_root
    root = Path(__file__).resolve().parent
    return root, root


def _run_python_script() -> int | None:
    args = sys.argv[1:]
    if not args or args[0] != "--run-python":
        return None
    if len(args) < 2:
        print("Missing script path for --run-python.", file=sys.stderr)
        return 2

    app_root, _user_root = _roots()
    script = Path(args[1])
    if not script.is_absolute():
        script = app_root / script
    if not script.exists():
        print(f"Python script not found: {script}", file=sys.stderr)
        return 2

    sys.argv = [str(script), *args[2:]]
    runpy.run_path(str(script), run_name="__main__")
    return 0


def main() -> int:
    py_mode = _run_python_script()
    if py_mode is not None:
        return py_mode

    app_root, user_root = _roots()
    env_user_root = os.environ.get("TOKEI_USER_ROOT")
    if env_user_root and env_user_root.strip():
        user_root = Path(env_user_root).expanduser().resolve()

    pause_at_end = False
    args = sys.argv[1:]
    if getattr(sys, "frozen", False):
        pause_at_end = True
    if os.environ.get("TOKEI_NO_PAUSE", "").strip() == "1":
        pause_at_end = False
    if "--no-pause" in args:
        pause_at_end = False
        args = [a for a in args if a != "--no-pause"]

    node = shutil.which("node")
    if not node:
        print("Node.js was not found in PATH.", file=sys.stderr)
        return 2

    mjs_path = app_root / "Tokei.mjs"
    if not mjs_path.exists():
        print(f"Tokei.mjs not found: {mjs_path}", file=sys.stderr)
        return 2

    env = os.environ.copy()
    env["TOKEI_APP_ROOT"] = str(app_root)
    env["TOKEI_USER_ROOT"] = str(user_root)
    if getattr(sys, "frozen", False):
        env["TOKEI_PYTHON_EXE"] = str(Path(sys.executable).resolve())
        env["TOKEI_PYTHON_ARGS"] = "--run-python"

    cmd = [node, str(mjs_path), *args]
    result = subprocess.run(cmd, cwd=str(user_root), env=env)
    code = int(result.returncode)
    if pause_at_end and sys.stdin.isatty():
        try:
            input("Press Enter to close...")
        except EOFError:
            pass
    return code


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except Exception:
        traceback.print_exc()
        exit_code = 1
    finally:
        if exit_code != 0 and "--run-python" not in sys.argv and sys.stdin.isatty():
            try:
                input("Press Enter to close...")
            except EOFError:
                pass

    raise SystemExit(exit_code)
