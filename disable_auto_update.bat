@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node windows-supervisor.mjs --disable
pause
