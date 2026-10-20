@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [BACKUP] Creating a timestamped snapshot of all records...
node data-cli.mjs backup
pause
