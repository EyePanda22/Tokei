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
  pause
  exit /b 1
)

echo.
echo === Tokei Reset ===
echo.
echo This will:
echo  - Delete EVERYTHING in: cache\
echo  - Delete EVERYTHING in: output\
echo  - Reset: config.json back to defaults
echo.
echo After reset you must run: Setup-Tokei.bat
echo.

set "CONFIRM="
set /p CONFIRM=Type RESET to continue (anything else cancels) ^> 
if /i not "%CONFIRM%"=="RESET" (
  echo.
  echo Cancelled.
  echo.
  pause
  exit /b 0
)

echo.
set "DEL_TOKEN="
set /p DEL_TOKEN=Also delete toggl-token.txt? (y/N) ^> 
set "DEL_TOKEN=%DEL_TOKEN: =%"

set "DEL_TOKEN_FLAG="
if /i "%DEL_TOKEN%"=="y" set "DEL_TOKEN_FLAG=--delete-token"
if /i "%DEL_TOKEN%"=="yes" set "DEL_TOKEN_FLAG=--delete-token"

%PY_EXE% tools\tokei_reset.py --yes --config config.json --cache-dir cache --output-dir output %DEL_TOKEN_FLAG%
if errorlevel 1 (
  echo.
  echo Reset failed.
  pause
  exit /b 1
)

echo.
echo Reset complete.
echo Next: run Setup-Tokei.bat
echo.
pause
endlocal

