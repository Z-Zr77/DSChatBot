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
echo First run will open the setup wizard in your browser.
echo Press Ctrl+C to stop.
echo.
node launch.mjs
echo.
echo [exit] process ended.
pause