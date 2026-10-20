@echo off
chcp 65001 >nul
cd /d "%~dp0"
for /f "delims=" %%D in ('node data-cli.mjs path') do set "DATA_DIR=%%D"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
explorer "%DATA_DIR%"
