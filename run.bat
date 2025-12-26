@echo off
setlocal EnableExtensions

cd /d "%~dp0"

if not exist ".venv\Scripts\activate.bat" (
  echo.
  echo Local venv not found at .venv\Scripts\activate.bat
  echo Run Setup-Environment.bat first.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js was not found in PATH.
  echo Install Node.js ^(18+ recommended^) and re-run Setup-Environment.bat.
  pause
  exit /b 1
)

set "NODE_VER="
set "NODE_MAJOR="
for /f "delims=" %%i in ('node -p process.versions.node') do set "NODE_VER=%%i"
for /f "tokens=1 delims=." %%i in ("%NODE_VER%") do set "NODE_MAJOR=%%i"
if "%NODE_MAJOR%"=="" (
  echo.
  echo Failed to detect Node.js version.
  pause
  exit /b 1
)
set /a NODE_MAJOR_NUM=%NODE_MAJOR%
if errorlevel 1 (
  echo.
  echo Failed to parse Node.js version: %NODE_VER%
  pause
  exit /b 1
)
if %NODE_MAJOR_NUM% LSS 18 (
  echo.
  echo Node.js 18+ is required to run Tokei.
  pause
  exit /b 1
)

if not exist "node_modules\puppeteer\package.json" (
  echo.
  echo Puppeteer is not installed in this folder.
  echo Run Setup-Environment.bat to install Node dependencies.
  pause
  exit /b 1
)

call ".venv\Scripts\activate.bat"
if errorlevel 1 (
  echo.
  echo Failed to activate the local venv.
  pause
  exit /b 1
)

node Tokei.mjs
if errorlevel 1 pause

endlocal
