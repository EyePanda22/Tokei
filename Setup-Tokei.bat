@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "PY_EXE="
if exist ".venv\Scripts\python.exe" set "PY_EXE=.venv\Scripts\python.exe"
if "%PY_EXE%"=="" set "PY_EXE=python"
%PY_EXE% -c "import sys" >nul 2>&1
if errorlevel 1 (
  echo.
  echo Python was not found. Run Setup-Environment.bat first.
  call :MAYBE_PAUSE
  exit /b 1
)

echo.
echo === Tokei Setup ===
echo.
echo This will update: config.json
echo.

REM Read existing config as defaults so Enter keeps your current settings.
set "DEFAULT_TIMEZONE=local"
set "DEFAULT_THEME=midnight"
set "DEFAULT_OUTPUT_DIR=output"
set "DEFAULT_ANKI_PROFILE=User 1"
set "DEFAULT_BASELINE_HMS=0:00:00"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $c=Get-Content -Raw 'config.json' | ConvertFrom-Json } catch { $c=$null }; if($c){ $c.timezone }"`) do if not "%%i"=="" set "DEFAULT_TIMEZONE=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $c=Get-Content -Raw 'config.json' | ConvertFrom-Json } catch { $c=$null }; if($c){ $c.theme }"`) do if not "%%i"=="" set "DEFAULT_THEME=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $c=Get-Content -Raw 'config.json' | ConvertFrom-Json } catch { $c=$null }; if($c){ $c.output_dir }"`) do if not "%%i"=="" set "DEFAULT_OUTPUT_DIR=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $c=Get-Content -Raw 'config.json' | ConvertFrom-Json } catch { $c=$null }; if($c){ $c.anki_profile }"`) do if not "%%i"=="" set "DEFAULT_ANKI_PROFILE=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $c=Get-Content -Raw 'config.json' | ConvertFrom-Json } catch { $c=$null }; $h=0; if($c -and $c.toggl -and $c.toggl.baseline_hours -ne $null){ $h=[double]$c.toggl.baseline_hours }; $s=[int][math]::Round($h*3600); $hh=[int]([math]::Floor($s/3600)); $mm=[int]([math]::Floor(($s%%3600)/60)); $ss=[int]($s%%60); \"{0}:{1:D2}:{2:D2}\" -f $hh,$mm,$ss"`) do if not "%%i"=="" set "DEFAULT_BASELINE_HMS=%%i"

echo Step 1: Toggl API token (optional but required for hours)
echo.
echo How to find your Toggl API token:
echo  - Toggl ^> Profile ^> Profile settings
echo  - Scroll to the very bottom to reveal your API token
echo.
echo If you enter it here, it will be saved to: toggl-token.txt (plain text)
echo You can also set it via the TOGGL_API_TOKEN environment variable instead.
echo.
set "TOGGL_TOKEN="
if exist "toggl-token.txt" (
  set /p TOGGL_TOKEN=Enter Toggl API token ^(press Enter to keep existing^) ^> 
) else (
  set /p TOGGL_TOKEN=Enter Toggl API token ^(press Enter to skip^) ^> 
)
if "%TOGGL_TOKEN%"=="" (
  if exist "toggl-token.txt" goto :AFTER_TOGGL_TOKEN
  goto :NO_TOGGL_TOKEN
)

call :SAVE_TOGGL_TOKEN "%TOGGL_TOKEN%"
if errorlevel 1 (
  echo.
  echo Failed to write toggl-token.txt
  call :MAYBE_PAUSE
  exit /b 1
)
goto :AFTER_TOGGL_TOKEN

:NO_TOGGL_TOKEN
echo.
set "CONTINUE_NO_TOKEN="
set /p CONTINUE_NO_TOKEN=No token entered. Tokei will NOT track immersion hours. Continue anyway? (y/N) ^> 
if /i not "%CONTINUE_NO_TOKEN%"=="y" if /i not "%CONTINUE_NO_TOKEN%"=="yes" (
  echo.
  echo Cancelled.
  echo.
  call :MAYBE_PAUSE
  exit /b 0
)

:AFTER_TOGGL_TOKEN

echo.
echo You will be asked for a baseline lifetime time value (HH:MM:SS).
echo Tokei will add this baseline to the time it can fetch from Toggl (which may be limited).
echo.
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddDays(-1).ToString(\"yyyy-MM-dd\")"') do set "YESTERDAY=%%i"
echo How to get baseline lifetime time from Toggl (recommended):
echo  1) Go to Toggl Track ^> Reports ^> Summary:
echo     https://track.toggl.com/reports/summary
echo  2) Set the date range:
echo     - Start: the earliest day you started tracking immersion
echo     - End:   %YESTERDAY%  (yesterday; do NOT include today in the baseline)
echo  3) Select your immersion project(s) (if you track multiple immersion projects, select them all)
echo  4) Make sure you are viewing the correct workspace
echo  5) Copy the "Total" hours shown at the top and enter it below
echo.
echo Why end date is yesterday:
echo  - Tokei will fetch TODAY's time via the Toggl API and add it on top of this baseline.
echo.

set "BASELINE_HMS="
set /p BASELINE_HMS=Enter baseline lifetime time (HH:MM:SS) (press Enter to keep: %DEFAULT_BASELINE_HMS%) ^> 
if "%BASELINE_HMS%"=="" set "BASELINE_HMS=%DEFAULT_BASELINE_HMS%"

echo.
set "TIMEZONE="
set /p TIMEZONE=Timezone (press Enter to keep: %DEFAULT_TIMEZONE%) ^> 
if "%TIMEZONE%"=="" set "TIMEZONE=%DEFAULT_TIMEZONE%"

echo.
echo Theme options:
echo   midnight (default)
echo   sakura-night
echo   forest-dawn
echo   neutral-balanced
echo   dark-graphite
echo   solar-slate
echo   neon-arcade
echo   bright-daylight
echo   bright-mint
echo   bright-iris
echo.
echo To preview themes, open the sample PNGs in: samples\
echo.
set "THEME="
set /p THEME=Theme (press Enter to keep: %DEFAULT_THEME%) ^> 
if "%THEME%"=="" set "THEME=%DEFAULT_THEME%"

echo.
set "OUTPUT_DIR="
set /p OUTPUT_DIR=Output folder (relative or absolute) (press Enter to keep: %DEFAULT_OUTPUT_DIR%) ^> 
if "%OUTPUT_DIR%"=="" set "OUTPUT_DIR=%DEFAULT_OUTPUT_DIR%"

echo.
set "ANKI_PROFILE="
set /p ANKI_PROFILE=Anki profile name (press Enter to keep: %DEFAULT_ANKI_PROFILE%) ^> 
if "%ANKI_PROFILE%"=="" set "ANKI_PROFILE=%DEFAULT_ANKI_PROFILE%"

%PY_EXE% tools\tokei_configure.py --config config.json --baseline-hms "%BASELINE_HMS%" --timezone "%TIMEZONE%" --theme "%THEME%" --output-dir "%OUTPUT_DIR%" --anki-profile "%ANKI_PROFILE%"
if errorlevel 1 (
  echo.
  echo Setup failed.
  call :MAYBE_PAUSE
  exit /b 1
)

echo.
echo Setup complete.
echo Next: run run.bat
echo.
call :MAYBE_PAUSE
endlocal
exit /b 0

:MAYBE_PAUSE
if "%TOKEI_NO_PAUSE%"=="1" goto :eof
pause
goto :eof

:SAVE_TOGGL_TOKEN
REM %~1 is the token (quoted by caller)
> "toggl-token.txt" (echo(%~1)
exit /b 0
