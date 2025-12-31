# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning when possible.

## Unreleased

### Added

### Fixed

## 0.2.0 - 2025-12-31

### Added
- Ttsu Reader support: ingest novel characters read from `statistics_*.json` via `config.json -> ttsu.data_dir`, include it in the Reading card, and add onboarding prompts in both `Tokei.mjs` and `Setup-Tokei.bat`.
- Version bump tooling: `npm run bump:{patch,minor,major}` to keep `package.json`, `installer/Tokei.iss`, `Tokei.mjs`, and the Windows EXE version resource in sync.

### Fixed

## 0.1.2 - 2025-12-31

### Added
- Support for ingesting GSM live session totals from `TOKEI_USER_ROOT/cache/gsm_live.sqlite` (written by a GSM plugin) and reconciling with `gsm.db` without double-counting (3-day window).
- GSM plugin template and install notes in `extras/gsm-plugin/` (recommended for accurate end-of-day GSM totals).

### Fixed
- `config.json` parsing now tolerates a UTF-8 BOM in both the Node loader (`Tokei.mjs`) and the Python pipeline (`tools/tokei_sync.py`).
