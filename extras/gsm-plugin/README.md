# GSM live sessions export (recommended)

This folder contains a GameSentenceMiner (GSM) user plugin that exports GSM **today session totals**
into a small SQLite database that Tokei can read later (even if GSM is closed).

## What it does

- Calls GSM's local API: `http://localhost:7275/api/today-stats`
- Upserts each session into: `%TOKEI_USER_ROOT%\cache\gsm_live.sqlite` (or `%APPDATA%\Tokei\cache\gsm_live.sqlite` if `TOKEI_USER_ROOT` is not set)
- Uses a stable session key so it will not double-count when the plugin runs repeatedly

## Why this exists

GSM's `gsm.db` can lag behind "live today" stats (depending on when GSM rolls up/persists daily totals).
Exporting sessions while GSM is running means Tokei can generate an accurate end-of-day report without requiring
you to re-open GSM.

## Install

1) In GSM, enable user plugins (see GSM docs).
2) In `%APPDATA%\GameSentenceMiner\`, create a new file:
   - `tokei_live_sync.py` (copy from `extras/gsm-plugin/tokei_live_sync.py`)
3) Open your GSM plugin file:
   - `%APPDATA%\GameSentenceMiner\plugins.py`
4) Paste the shim near the bottom so it can wrap your existing `main()` (copy from `extras/gsm-plugin/plugins.py`).
   - The shim includes a fallback loader in case GSM doesn't add the plugins folder to Python's import path.

## Notes

- This is user-specific configuration and should not be installed by the Tokei installer.
- If `gsm_live.sqlite` is present, Tokei treats `gsm.db` as the lifetime baseline and reconciles all days present in `gsm_live.sqlite` without double-counting.
