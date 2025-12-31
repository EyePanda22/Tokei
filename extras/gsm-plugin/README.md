# GSM live sessions export (recommended)

This folder contains a GameSentenceMiner (GSM) user plugin that exports GSM **today session totals**
into a small SQLite database that Tokei can read later (even if GSM is closed).

## What it does

- Calls GSM's local API: `http://localhost:55000/api/today-stats`
- Upserts each session into: `%TOKEI_USER_ROOT%\cache\gsm_live.sqlite` (or `%APPDATA%\Tokei\cache\gsm_live.sqlite` if `TOKEI_USER_ROOT` is not set)
- Uses a stable session key so it will not double-count when the plugin runs repeatedly

## Why this exists

GSM's `gsm.db` can lag behind "live today" stats (depending on when GSM rolls up/persists daily totals).
Exporting sessions while GSM is running means Tokei can generate an accurate end-of-day report without requiring
you to re-open GSM.

## Install

1) In GSM, enable user plugins (see GSM docs).
2) Open your GSM plugin file:
   - `%APPDATA%\GameSentenceMiner\plugins.py`
3) Replace its contents with `extras/gsm-plugin/plugins.py`, or copy/paste the contents.

## Notes

- This is user-specific configuration and should not be installed by the Tokei installer.
- If `gsm_live.sqlite` is present, Tokei treats `gsm.db` as the lifetime baseline and reconciles recent days (3-day window) without double-counting.
