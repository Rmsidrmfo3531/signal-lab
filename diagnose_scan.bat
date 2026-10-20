@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo [ERROR] Node.js 22+ required to diagnose.
 pause
 exit /b 1
)
node diagnose_scan.mjs
echo.
echo You may send the diagnostic report without copying your .env or store.json.
pause
