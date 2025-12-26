# Tokei (APL-independent dashboard sync)

Tokei is a standalone sync + report generator that combines:

- Toggl (API token) for lifetime + today immersion (with description breakdown)
- AnkiMorphs (ankimorphs.db) for known lemma/inflection counts
- Hashi (hashi_exports/anki_stats_snapshot.json) for Anki retention + review totals
- Mokuro (volume-data.json) for manga characters read
- GameSentenceMiner (gsm.db) for GSM characters read

It caches merged snapshots into cache/tokei_cache.sqlite, then renders:

- HTML: output/Tokei Report <report_no>.html
- PNG:  output/Tokei Report <report_no>.png
- Warnings: output/Tokei Report <report_no> WARNINGS.txt (only if warnings exist)

## Scripts (Windows)

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
- Tokei.bat
  - Legacy wrapper that calls run.bat
- Reset-Tokei.bat
  - Deletes cache/ and output/
  - Resets config.json back to defaults
  - Optional: deletes toggl-token.txt

## Recommended first-time setup

1) Install Python 3.10+ and Node.js 18+ (external prerequisites).
2) Run Setup-Environment.bat to create the venv and install dependencies.
3) Run Setup-Tokei.bat to configure your settings.
4) Run run.bat to generate a report.

## Re-running guidance

- Setup-Environment.bat and Setup-Tokei.bat are typically one-time; rerun only when dependencies or settings change.
- Rerun Setup-Environment.bat if Python/Node dependencies change.
- Rerun Setup-Tokei.bat any time you want to update settings.
- run.bat is safe to run daily (it will detect same-day reports).
- Reset-Tokei.bat is destructive; use it only when you want to wipe cache/output.

## External data sources (read-only)

Tokei reads from these external tools but does not modify them:

- Hashi (Anki add-on)
  - Reads hashi_exports/anki_stats_snapshot.json from your Anki profile
  - If missing, Tokei warns and continues
- AnkiMorphs (Anki add-on)
  - Reads ankimorphs.db from your Anki profile
  - If missing, Tokei warns and continues
- GSM (Game Sentence Miner)
  - Reads gsm.db (auto path uses %APPDATA%\GameSentenceMiner\gsm.db)
  - If missing, Tokei warns and continues
- Mokuro
  - Reads volume-data.json from the configured path
  - If missing, Tokei warns and continues

## Notes

- output_dir in config.json can be absolute or relative to the Tokei folder.
- Theme previews are available as PNGs in samples/.
- For fresh Anki stats, Anki must be running; Tokei triggers a Hashi export via http://127.0.0.1:8766/export before reading the file.
- Toggl /me/time_entries may limit how far back it can query. Use toggl.baseline_hours to account for older time if needed.
