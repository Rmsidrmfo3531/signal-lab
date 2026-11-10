@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "PORT=3100"
set "HOST=127.0.0.1"
set "SIGNAL_LAB_DATA_DIR=%LOCALAPPDATA%\SignalLab_v6_Test"
where node >nul 2>nul
if errorlevel 1 (echo Node.js 22+ required & pause & exit /b 1)
node windows-supervisor.mjs
if errorlevel 1 pause
