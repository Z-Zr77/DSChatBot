@echo off
setlocal
cd /d "%~dp0"
title QQ Bot - test launch
echo ==========================================
echo   QQ Bot test launch (dev mode, uses system node)
echo ==========================================
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 20+ first: https://nodejs.org
  pause
  exit /b 1
)
echo Node:
node -v
echo.
echo First run opens the console. The first-meet card is there.
echo The QQ / NapCat wizard does not open on startup.
echo Press Ctrl+C to stop.
echo.
node launch.mjs
echo.
echo [exit] process ended.
pause