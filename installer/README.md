# Tokei Installer (Inno Setup)

This installer is app-only. It installs the PyInstaller build into Program Files and
creates shortcuts. It does not install Node.js, Puppeteer, or any external tools.

## Build Prerequisites

- Inno Setup 6 installed (`ISCC.exe` available in PATH)
- A built app folder at `dist\Tokei\` (from Phase 2)

## Build Steps

1) Build the app:
   - `.venv\Scripts\python.exe -m PyInstaller --clean --noconfirm tokei.spec`
2) Build the installer:
   - `ISCC.exe installer\Tokei.iss`

Output is written to `dist-installer\Tokei-Setup-<version>.exe`.

## Runtime Behavior

- Installs to `C:\Program Files\Tokei\`
- Creates `%APPDATA%\Tokei\` if missing
- Creates `%APPDATA%\Tokei\config.json` if missing (does not overwrite existing)
- Sets per-user `TOKEI_USER_ROOT` to `%APPDATA%\Tokei` so the exe reads config from there
- Adds Start Menu shortcut; desktop shortcut is optional
- Does not overwrite existing user data in `%APPDATA%\Tokei\`

## Node.js Preflight Check

The installer runs `where node` and shows a warning if Node.js is missing.
Installation continues either way.

Message shown:

```
Node.js is required to run Tokei.
Please install Node.js before running the application.
https://nodejs.org/
```

## Uninstall Behavior

During uninstall, the user is prompted:

```
Do you want to remove user data stored in %APPDATA%\Tokei ?
```

- Yes: `%APPDATA%\Tokei\` is removed.
- No: user data is preserved.

`%USERPROFILE%\Pictures\Tokei\` is never deleted.
