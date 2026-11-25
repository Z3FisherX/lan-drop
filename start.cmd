@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js first.
  pause
  exit /b 1
)
if not exist node_modules\qrcode (
  echo Installing dependencies...
  call npm install --ignore-scripts --no-audit --no-fund --package-lock=false
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node server.js %*
pause
