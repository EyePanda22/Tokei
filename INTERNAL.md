# Internal notes (dev/troubleshooting)

## Runtime logs

Tokei appends a lightweight runtime log to:

- `%TOKEI_USER_ROOT%\logs\runtime.log`

It logs only:

- App start
- Config loaded
- Python invocation start/end
- Report output paths
- Fatal errors

### Notes about `PY_END ... status=...`

- `status` is the raw Python process exit code.
- `0` = success
- `2` = "report already generated today" sentinel (Tokei will prompt: new / overwrite / cancel)
- `10–13` = internal Python error categories (Config/API/DB/Output)
- The final Windows process exit code is mapped by Node and will be `0/1/2/3/99` (Python codes never leak to the OS).

## Repo troubleshooting (copy/paste)

Use these when you want to run from the repo without accidentally using the installed `%APPDATA%\Tokei` config/cache (i.e., ignore `TOKEI_USER_ROOT` from the installer).

### CMD

```bat
cd /d D:\Tokei
set TOKEI_USER_ROOT=
set TOKEI_APP_ROOT=
set TOGGL_API_TOKEN=
run.bat
```

### Refresh today (dev mode)

Use this to overwrite today's report in dev/repo mode (uses `--overwrite-today`):

```bat
cd /d D:\Tokei
set TOKEI_USER_ROOT=
set TOKEI_APP_ROOT=
Refresh-Today-Report.bat
```

## Run the built EXE (from this repo)

The repo build output lives under:

- `D:\Tokei\dist\Tokei\Tokei.exe`

### Portable-style test (uses the EXE folder for config/cache)

This clears the installed `TOKEI_USER_ROOT` (if set) so the EXE behaves portably.

```bat
cd /d D:\Tokei\dist\Tokei
set TOKEI_USER_ROOT=
set TOKEI_APP_ROOT=
.\Tokei.exe --no-pause
```

### Installed-style test (uses `%APPDATA%\Tokei`)

```bat
cd /d D:\Tokei\dist\Tokei
set TOKEI_USER_ROOT=%APPDATA%\Tokei
.\Tokei.exe --no-pause
```

### PowerShell

```powershell
cd D:\Tokei
Remove-Item Env:TOKEI_USER_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:TOKEI_APP_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:TOGGL_API_TOKEN -ErrorAction SilentlyContinue
.\run.bat
```
