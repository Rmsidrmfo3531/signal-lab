@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stop ALL Signal Lab server windows first.
echo Enter the FOLDER containing the old version store.json.
echo (Tip: drag the old folder here, then press Enter.)
set /p "SOURCE=Old Signal Lab folder: "
if "%SOURCE%"=="" goto END
set "SOURCE=%SOURCE:"=%"
node data-cli.mjs import "%SOURCE%"
:END
pause
