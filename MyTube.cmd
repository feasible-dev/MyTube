@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer from https://nodejs.org/ then reopen MyTube.cmd.
  pause
  exit /b 1
)
node.exe scripts\launch.mjs
if errorlevel 1 (
  echo.
  echo MyTube could not start. See the message above.
  pause
  exit /b 1
)
