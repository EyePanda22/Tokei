# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning when possible.

## 0.7.0 - 2026-01-08

### Added
- Electron installer: bundled embedded Python runtime so users do not need to install Python separately.
- Build tooling: `tools/prep_embedded_python.mjs` (and `npm run prep:python`) to download/extract embedded Python and minimal runtime wheels.

### Changed
- Electron runtime now auto-detects the bundled `python\\python.exe` when packaged (via `TOKEI_PYTHON_EXE`).
- README: updated setup/build instructions to reflect bundled Python for Electron builds.

## 0.6.1 - 2026-01-07

### Added
- Electron UI: Toggl baseline lifetime time setting (Advanced) with in-app instructions and a quick link to Toggl Summary reports.

### Changed
- Clarified Toggl history limitations (default 60-day window) and baseline guidance in both the UI and README.
- UI: smaller inline close button for Advanced panels.

### Fixed
- README: corrected Tokei logo path so the image renders.

## 0.6.0 - 2026-01-07

### Added
- Native Electron **File** menu (Menu API): Open Logs, Restart, Quit.
- Sources tab path configuration for Mokuro and Ttsu (folder picker) plus a **Save sources** action.
- Mokuro path can now point at a folder (Tokei resolves `volume-data.json` within it).
- Updated Getting started tab content, including Google Drive guidance for syncing Mokuro/Ttsu data and an optional Ko-fi support widget.

### Changed
- UI navigation now surfaces Logs via the File menu and keeps Getting started as a dedicated tab.

## 0.5.0 - 2026-01-04

### Added
- Sources tab in the UI for enabling/disabling sources and quick launch actions (Mokuro/Ttsu web, GSM exe, known.csv helpers).
- Known CSV import from the UI (copies to `TOKEI_USER_ROOT/data/known.csv` for Phase 2 ingestion).
- Optional per-source disable toggles (`mokuro.enabled`, `ttsu.enabled`, `gsm.enabled`) to hide the Reading section for unused sources.

### Fixed
- GSM Launch in the UI now targets the default installed exe path under `%LOCALAPPDATA%` (with a clearer fallback when missing).

## 0.4.0 - 2026-01-03

### Added
- Sync-only snapshot output: `cache/latest_sync.json` (refreshable multiple times per day without allocating a `report_no`).
- New UI Run flow: separate **Sync** and **Generate report** actions with a "Sync before report" checkbox.
- New CLI flags: `--sync-only` and `--no-sync` for separating cache refresh from report rendering.
- Improved "At a glance" UI summary for latest sync/report.

### Fixed

## 0.3.1 - 2026-01-03

### Added
- Setup-first local UI (`ui/`) for editing config, validating Anki/Python/Puppeteer, and running the pipeline.
- Electron wrapper + Windows per-user installer config (electron-builder) for distributing the UI (`electron/` + `npm run dist:win`).
- Electron builds bundle Puppeteer browser binaries via `tools/prep_puppeteer_cache.mjs` so PNG rendering works without user-side `npm install`.
- `Tokei-UI.bat` launcher for opening the UI on Windows.
- Safer GSM live-session plugin install: `extras/gsm-plugin/tokei_live_sync.py` helper + `extras/gsm-plugin/plugins.py` shim that wraps an existing `main()`.

### Fixed

## 0.3.0 - 2026-01-02

### Added
- Built-in Anki snapshot exporter (`tools/tokei_anki_export.py`) that writes Hashi-compatible `anki_stats_snapshot.json` and `known_words.sqlite` from `collection.anki2`.
- First-run Anki snapshot setup wizard in `Tokei.mjs` that builds `config.json -> anki_snapshot.rules` (supports multiple decks per rule).

## 0.2.0 - 2025-12-31

### Added
- Ttsu Reader support: ingest novel characters read from `statistics_*.json` via `config.json -> ttsu.data_dir`, include it in the Reading card, and add onboarding prompts in both `Tokei.mjs` and `Setup-Tokei.bat`.
- Version bump tooling: `npm run bump:{patch,minor,major}` to keep `package.json`, `installer/Tokei.iss`, `Tokei.mjs`, and the Windows EXE version resource in sync.

### Fixed

## 0.1.2 - 2025-12-31

### Added
- Support for ingesting GSM live session totals from `TOKEI_USER_ROOT/cache/gsm_live.sqlite` (written by a GSM plugin) and reconciling with `gsm.db` without double-counting (all days present in `gsm_live.sqlite`).
- GSM plugin template and install notes in `extras/gsm-plugin/` (recommended for accurate end-of-day GSM totals).

### Fixed
- `config.json` parsing now tolerates a UTF-8 BOM in both the Node loader (`Tokei.mjs`) and the Python pipeline (`tools/tokei_sync.py`).
- GSM reconciliation no longer emits a warning when `gsm.db` is simply missing/behind for a day (reduces noisy `WARNINGS.txt` output).
