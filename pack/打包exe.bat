@echo off
setlocal
cd /d "%~dp0"
title DSChatBot - Build installer
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "BUILD_LOG=%~dp0build-logs\installer-%RANDOM%-%RANDOM%.log"
if not exist "%~dp0build-logs" mkdir "%~dp0build-logs"
>"%BUILD_LOG%" echo DSChatBot installer build - %DATE% %TIME%
if errorlevel 1 goto :logfail
echo ==========================================
echo   DSChatBot - Build installer only
echo ==========================================
echo Log: "%BUILD_LOG%"
echo.
where node >nul 2>&1
if errorlevel 1 (
  >>"%BUILD_LOG%" echo [ERROR] Node.js not found. Install Node.js and retry.
  goto :fail
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  >>"%BUILD_LOG%" echo [ERROR] npm.cmd not found. Check your Node.js installation.
  goto :fail
)
node -p "require('./package.json').version" >"%BUILD_LOG%.version" 2>>"%BUILD_LOG%"
if errorlevel 1 goto :fail
set /p BUILD_VERSION=<"%BUILD_LOG%.version"
del "%BUILD_LOG%.version"
if not defined BUILD_VERSION goto :fail
set "BUILD_EXE=%~dp0dist\DSChatBot-Setup-%BUILD_VERSION%.exe"
echo Version: %BUILD_VERSION%
if exist "%BUILD_EXE%" echo Same-version installer will be replaced: "%BUILD_EXE%"
echo [1/3] Checking build dependencies...
if not exist "node_modules\.bin\electron-builder.cmd" (
  echo Installing dependencies. Details are written to the log.
  if exist package-lock.json (
    call npm.cmd ci --no-audit --no-fund >>"%BUILD_LOG%" 2>&1
  ) else (
    call npm.cmd install --no-audit --no-fund >>"%BUILD_LOG%" 2>&1
  )
  if errorlevel 1 goto :fail
)
echo [2/3] Checking console page...
node check.mjs >>"%BUILD_LOG%" 2>&1
if errorlevel 1 goto :fail
echo [3/3] Building installer. This may take several minutes...
echo Build output is being saved to the log shown above.
call npm.cmd run dist:installer >>"%BUILD_LOG%" 2>&1
if errorlevel 1 goto :fail
if not exist "%BUILD_EXE%" (
  >>"%BUILD_LOG%" echo [ERROR] Build exited successfully but expected installer is missing.
  goto :fail
)
echo.
echo [DONE] Installer created:
for %%F in ("%BUILD_EXE%") do echo   %%~fF  -  %%~zF bytes
echo Log: "%BUILD_LOG%"
echo Exit DSChatBot before running the installer.
if /i not "%~1"=="--no-pause" pause
exit /b 0

:fail
echo.
echo [FAILED] Build did not complete. Log follows:
type "%BUILD_LOG%"
echo.
echo Saved log: "%BUILD_LOG%"
if /i not "%~1"=="--no-pause" pause
exit /b 1

:logfail
echo [FAILED] Cannot create log file: "%BUILD_LOG%"
if /i not "%~1"=="--no-pause" pause
exit /b 1
