@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo [ERROR] Node.js not found. Install Node.js 22+ from https://nodejs.org/
 echo Then restart this command window.
 pause
 exit /b 1
)
if not exist "%~dp0server.mjs" (
 echo [ERROR] server.mjs is missing. Extract the entire ZIP file first.
 pause
 exit /b 1
)
for /f %%V in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 22 (
 echo [ERROR] Node.js 22 or newer required. Your version:
 node -v
 pause
 exit /b 1
)
echo [UPDATE] Checking downloaded update package integrity before server start.
node update-cli.mjs --apply
if errorlevel 1 (
 echo [ERROR] Update check failed; server was NOT started. Verify backup and update files.
 pause
 exit /b 1
)
echo [START] Node version:
node -v
echo [START] Starting local server; browser opens when ready.
set "SIGNAL_LAB_OPEN_BROWSER=1"
set "RESTART_COUNT=0"
:SERVER_LOOP
node server.mjs
set "SERVER_EXIT=%ERRORLEVEL%"
if "%SERVER_EXIT%"=="0" goto SERVER_STOP
set /a RESTART_COUNT+=1
if %RESTART_COUNT% GEQ 3 (
 echo [ERROR] Server crashed 3 times. Check messages above and stop retrying.
 goto SERVER_STOP
)
echo [WARN] Unexpected server exit code %SERVER_EXIT%. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto SERVER_LOOP
:SERVER_STOP
echo.
echo [STOPPED] Server is no longer running. Check messages above.
pause
