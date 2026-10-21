@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where gh >nul 2>nul
if errorlevel 1 (
 echo GitHub CLI required: winget install --id GitHub.cli -e
 pause
 exit /b 1
)
gh auth status
if errorlevel 1 gh auth login
if errorlevel 1 (pause & exit /b 1)
node windows-supervisor.mjs --enable
if errorlevel 1 (pause & exit /b 1)
echo Enabled. Run start_auto.bat from now on.
pause
