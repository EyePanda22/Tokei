# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning when possible.

## 0.8.2 - 2026-02-17

### Changed
- CLI: stop attempting legacy Hashi HTTP exports; when the built-in snapshot exporter is disabled, Tokei now reads the most recent snapshot file on disk (if present).

### Fixed
- CLI: fix Anki snapshot export update detection (mtime check now correctly compares against the pre-export timestamp).
- GSM live sessions plugin templates: updated `logger` import to support newer GSM versions (fallback kept for older installs) to prevent `ModuleNotFoundError: GameSentenceMiner.util.configuration` from breaking user plugins.

## 0.8.1 - 2026-01-27

### Added
- Electron UI: user-friendly error summaries on the Dashboard Run panel with collapsible "Technical details" (tracebacks are no longer shown by default).
- Electron UI: structured error messages for common Anki snapshot setup issues (disabled exporter / missing rules) to improve troubleshooting.

### Changed
- Config: introduced `anki_stats.require_fresh` (replaces the Hashi-namespaced `hashi.require_fresh`) for the "Don't block reports if Anki isn't set up" behavior (legacy `hashi.require_fresh` is still read for compatibility).
- UI/Docs: clarified that `hashi_exports` is a legacy folder name used for Anki snapshot outputs; reduced Hashi add-on emphasis for new users.

### Fixed
- Avoid noisy Python tracebacks for common configuration errors by returning actionable guidance to the UI.

## 0.8.0 - 2026-01-08

### Added
- Electron UI: first-run Setup Wizard overlay (auto-opens when `config.json` is missing) plus a Setup tab button to rerun the wizard at any time.
- Electron UI: Report settings panel in Setup (output folder, timezone, theme picker, open theme samples).
- Electron UI: Anki "Don't block reports if Anki isn't set up" toggle (sets `anki_stats.require_fresh=false`).
- Wizard: exit confirmation dialog (Save and exit / Exit without saving / Continue setup) with draft saving so users can resume later.
- Wizard: Anki rule editor now matches the Setup tab flow (multiple rules, selectable rule row, and discover chips for decks/note types/fields).

### Changed
- Wizard: Google Drive install link updated to the Workspace Drive page.
- Setup copy: clarified that the Toggl token is required for Toggl hours.

### Fixed
- Wizard overlay: ensure `hidden` reliably hides the overlay (fixes “wizard appears even when closed”).
- Electron UI: `?tab=...` handling no longer prevents the “missing config -> force wizard” flow.
- Wizard: render content before showing the overlay (fixes blank Welcome screen until Next/Back).
- Wizard: Anki Discover no longer renders decks as `[object Object]`.

## 0.7.2 - 2026-01-08

### Fixed
- Anki discover (`tokei_anki_export.py --discover`): avoid `UnicodeEncodeError` on Windows when decks/note types contain non-ASCII characters (e.g. kana/kanji) by writing UTF-8 to stdout.

## 0.7.1 - 2026-01-08

### Added
- Setup UI: Anki profile field plus profile auto-detect dropdown (scans local Anki2 profiles).

### Changed
- README: documented `config.json -> anki_profile`.

### Fixed
- Embedded Python: Python scripts now reliably import local modules when running under the bundled Python runtime (fixes `ModuleNotFoundError: tokei_errors` and related issues).
- UI: Anki “Discover decks/fields” now uses the currently selected Anki profile.

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
