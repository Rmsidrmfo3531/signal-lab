@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Node.js 22+ required & pause & exit /b 1)
node windows-supervisor.mjs
if errorlevel 1 pause
