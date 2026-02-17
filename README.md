**Pre-1.0 release**

Tokei is under active development (pre-1.0). This README includes both quick-start instructions for regular users and advanced setup details for power users to ensure HTML **and PNG** reports work reliably.

Note: Tokei runs as a console app (CLI), and also includes a setup-first UI (web + Electron wrapper).

# Tokei (dashboard sync)

<p>
  <img src="assets/tokeilogo-1.png" alt="Tokei logo" width="420" style="max-width: 100%; height: auto;" />
</p>

**Download:** https://github.com/EyePanda22/Tokei/releases/latest

Tokei is a standalone sync + report generator that combines:

- Toggl (API token) for lifetime + today immersion (with description breakdown)
- Anki stats (built-in snapshot exporter; legacy Hashi add-on optional) for retention + review totals
- Mokuro (volume-data.json) for manga characters read
- Ttsu Reader (ttu-reader-data/statistics_*.json) for novel characters read
- GameSentenceMiner (gsm.db) for GSM characters read

It caches merged snapshots into cache/tokei_cache.sqlite, then renders:

- HTML: output/Tokei Report <report_no>.html
- PNG:  output/Tokei Report <report_no>.png
- Warnings: output/Tokei Report <report_no> WARNINGS.txt (only if warnings exist)

The UI also maintains:
- `cache/latest_sync.json`: latest sync snapshot (safe to refresh multiple times per day)
- `cache/latest_stats.json`: latest report snapshot (includes `report_no`, used to open latest HTML)

## Installer (recommended)

If you install Tokei from the Windows installer in Releases, there are no extra runtime dependencies to install:
- The desktop app includes its own Node runtime (Electron).
- The report pipeline bundles Python and Puppeteer (including the browser needed for PNG screenshots).

## Theme samples

<p>
  <img src="samples/report-dark-graphite.png" alt="Dark Graphite sample" width="420" />
  <img src="samples/report-bright-daylight.png" alt="Bright Daylight sample" width="420" />
</p>

## Recommended first-time setup

### Quick start (most users)

1) Install Tokei (Latest Release) and run it from the Start Menu shortcut
2) No extra installs needed (the installer bundles the full report pipeline)
3) Optional (recommended for Mokuro/Ttsu): install Google Drive for Desktop so your reading data stays in sync
   - After it's installed, open your Drive on your PC (often `G:\`) and locate:
     - `ttu-reader-data` (Ttsu Reader)
     - `mokuro-reader` (Mokuro)
4) In Tokei:
   - Setup tab: configure Toggl token (optional), baseline lifetime hours (recommended if you've used Toggl >60 days), and Anki snapshot rules, then save
   - Sources tab: enable the sources you use and set paths
     - Mokuro: select your `mokuro-reader` folder (Tokei finds `volume-data.json` inside)
     - Ttsu: select your `ttu-reader-data` folder
     - Known CSV: import a CSV into `TOKEI_USER_ROOT/data/known.csv` (then run Sync)
5) Dashboard tab:
   - Sync refreshes caches and updates `cache/latest_sync.json` (no report generated)
   - Generate report produces HTML/PNG; by default it syncs first (checkbox)

Tip: use File > Open Logs to open the log folder if anything fails.

Optional: run `Tokei-UI.bat` any time to edit config, validate Anki export, test PNG rendering, and run reports (web UI)
- Dev/electron: `npm run ui:electron`

Legacy (deprecated): Hashi Anki add-on (not recommended for new users):
- In Anki: `Tools > Add-ons > Get Add-ons...` and enter `1132527238`
- Link: https://ankiweb.net/shared/info/1132527238

The Electron build generates HTML + PNG reports out of the box. If you are running from source / a portable folder, see the PNG setup notes below.

### PNG output (required for PNG reports)

PNG reports are rendered using Puppeteer via Node.js.

Electron UI builds bundle Puppeteer (and the required browser) so PNG rendering works without extra installs.

If you are running from source / a portable folder, install Python (or set `TOKEI_PYTHON_EXE`), install Node.js 18+, and run `npm install` in the Tokei folder so `node_modules\puppeteer` exists.

If Puppeteer is not installed, Tokei will still generate HTML reports, but PNG output will fail with a warning.

This explicit setup is intentional for the pre-1.0 release to maximize PNG reliability.

## Scripts (Windows)

These scripts are intended for running from source / a portable folder. If you installed the Electron desktop app from Releases, you do not need to run these.

- Setup-Environment.bat
  - Creates the local Python venv in .venv
  - Installs Python dependencies from requirements.txt
  - Installs Node dependencies (npm install)
  - Verifies Node.js 18+ and Puppeteer are available
  - Safe to run multiple times
- Setup-Tokei.bat
  - User configuration / onboarding only
  - Prompts for Toggl token, baseline, timezone, theme, output folder, Anki profile
  - Writes config.json and toggl-token.txt
  - Does not install software or change system state
  - Safe to run multiple times
- run.bat
  - Activates the local venv
  - Runs the application
  - Does not perform setup or installation
  - Safe to run multiple times
- Refresh-Today-Report.bat
  - Runs the app but overwrites today's existing report (no extra report number)
  - Safe to run multiple times (asks for confirmation)
- Tokei.bat
  - Legacy wrapper that calls run.bat
- Tokei-UI.bat
  - Launches the local setup/run UI in your browser (web UI)
  - If you are using the Electron build: use the installed desktop app instead
- Reset-Tokei.bat
  - Deletes cache/ and output/
  - Resets config.json back to defaults
  - Optional: deletes toggl-token.txt

## Config reference

- `config.json` is the live config used by Tokei.
- `config.example.json` is documentation only (not loaded at runtime).
- Field types are implied by the example values; keep the same types when editing `config.json`.
- Anki profile:
  - `anki_profile`: the name of your local Anki profile folder (defaults to `User 1`).
- Anki stats behavior:
  - `anki_stats.require_fresh`: if false, Tokei will not fail the report when Anki stats cannot be refreshed (it will fall back to the most recent snapshot file if available).
- Anki snapshot:
  - `anki_snapshot.enabled`: if true, Tokei uses the built-in Anki snapshot exporter (recommended).
  - `anki_snapshot.rules`: list of deck/field rules (supports multiple decks and note types per rule); see `config.example.json`.
- Phase 2:
  - Optional CSV ingest: any `*.csv` in `data/` (first column only; one or more header rows allowed). If no CSVs exist in `data/`, it falls back to `data/csv/known.csv` and `known.csv` for compatibility.
  - Optional config: `phase2.csv_rule_id` (defaults to `default`).

Troubleshooting:

- Runtime logs + exit code notes: `INTERNAL.md`
- Recent changes: `CHANGELOG.md`

## External data sources (read-only)

Tokei reads from these external tools but does not modify them:

- Anki (snapshot producer)
  - Built-in snapshot exporter (recommended): reads your Anki profile `collection.anki2` and writes snapshot files under `hashi_exports/` (configurable)
  - Hashi (Anki add-on, legacy/deprecated): writes the same snapshot files under `hashi_exports/` (configurable)
- GSM (Game Sentence Miner)
  - Reads gsm.db (auto path uses %APPDATA%\GameSentenceMiner\gsm.db)
  - If missing, Tokei warns and continues
- Mokuro
  - Reads volume-data.json from the configured path
  - If missing, Tokei warns and continues
- Ttsu Reader
  - Reads statistics_*.json under the configured ttu-reader-data directory
  - If missing, Tokei warns and continues

Optional source toggles (to hide Reading sections):
- `mokuro.enabled`, `ttsu.enabled`, `gsm.enabled` can be used to explicitly disable a source even if a path is configured.

## Notes

- The Getting started page includes a Ko-fi widget that loads from https://storage.ko-fi.com when viewed.
- output_dir in config.json can be absolute or relative to the Tokei folder.
- Theme previews are available as PNGs in samples/.
- For fresh Anki stats:
  - If `anki_snapshot.enabled=true`, Tokei exports from `collection.anki2` before reading the file.
  - Otherwise, Tokei reads the most recent snapshot file on disk (if present).
- Toggl history note: due to Toggl API limitations, Tokei effectively only pulls a recent window (by default the last 60 days via `toggl.refresh_days_back`).
  - If you've used Toggl for longer than that, set `toggl.baseline_hours` to your lifetime total through yesterday (do NOT include today).
  - Once set, you typically should not keep updating this value; only change it if you corrected your Toggl history/project selection or originally entered the wrong baseline.
  - Recommended way to find it: Toggl Track → Reports → Summary (`https://track.toggl.com/reports/summary`), set Start = first immersion day, End = yesterday, select your immersion project(s), then copy the Total time.

Advanced CLI flags:
- `--sync-only`: refresh caches + write `cache/latest_sync.json` (no report render)
- `--no-sync`: generate a report using `cache/latest_sync.json` without refreshing sources (run Sync first)


## Build Windows installer (Electron UI, Windows-only)

This produces a per-user Windows installer for the desktop UI (Electron).

Requirements:
- Node.js 18+
- `npm install`
- Network access during build (downloads embedded Python)
- Build machine must be allowed to create symlinks (Windows Developer Mode enabled, or run the build in an elevated terminal); otherwise `electron-builder` may fail extracting `winCodeSign`.

Build:
- `npm run dist:win`

Optional build settings:
- `TOKEI_PYTHON_EMBED_VERSION` (default `3.12.7`)
- `TOKEI_PYTHON_EMBED_ARCH` (default `amd64`)
- `TOKEI_PYTHON_EMBED_FORCE=1` to re-download/rebuild the embedded Python folder

Output:
- `dist-installer-electron\\`

## Re-running guidance

- Setup-Environment.bat and Setup-Tokei.bat are typically one-time; rerun only when dependencies or settings change.
- Rerun Setup-Environment.bat if Python/Node dependencies change.
- Rerun Setup-Tokei.bat any time you want to update settings.
- run.bat is safe to run daily (it will detect same-day reports and offer: new report / overwrite today / cancel).
- Reset-Tokei.bat is destructive; use it only when you want to wipe cache/output.

## Developer-only builds (source/portable)

These are not part of the released Windows installer and are intended for development, debugging, or portable/source workflows.

### Build `Tokei.exe` (developer-only)

This is a **portable CLI-style runner**, mainly useful if you want a single executable wrapper for the pipeline without shipping the full Electron desktop app.

It bundles Python + the Tokei Python code, but still requires external Node.js and Puppeteer (similar to running from source).

Build steps (one-folder):

1) Install PyInstaller into the local venv:
   - `.venv\\Scripts\\python.exe -m pip install pyinstaller`
2) Build:
   - `.venv\\Scripts\\python.exe -m PyInstaller --clean --noconfirm tokei.spec`
3) Output:
   - `dist\\Tokei\\Tokei.exe`

Run requirements for the built exe:

- Node.js 18+ is on PATH
- `node_modules\\puppeteer` exists in the same folder as `Tokei.exe` (run `Setup-Environment.bat` there)
- `config.json` exists (run `Setup-Tokei.bat` there)
