from __future__ import annotations

import os
from pathlib import Path

project_root = Path(globals().get("__file__", os.path.abspath("tokei.spec"))).resolve().parent


def _collect_datas(src_dir: Path, dest_root: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            if f.endswith((".pyc", ".pyo")):
                continue
            src = Path(root) / f
            rel_parent = src.relative_to(src_dir).parent
            dest = str(Path(dest_root) / rel_parent) if str(rel_parent) != "." else dest_root
            out.append((str(src), dest))
    return out


datas = [
    (str(project_root / "Tokei.mjs"), "."),
    *_collect_datas(project_root / "tools", "tools"),
    (str(project_root / "src"), "src"),
    (str(project_root / "design"), "design"),
    (str(project_root / "config.example.json"), "."),
    (str(project_root / "README.md"), "."),
]

a = Analysis(
    ["tokei_launcher.py"],
    pathex=[str(project_root), str(project_root / "tools")],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "sqlite3",
        "_sqlite3",
        "tokei_errors",
        "jinja2",
        "jinja2.environment",
        "jinja2.loaders",
        "markupsafe",
        "zoneinfo",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Tokei",
    icon=str(project_root / "assets" / "tokei.ico"),
    version=str(project_root / "tools" / "windows_version_info.txt"),
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    name="Tokei",
)
