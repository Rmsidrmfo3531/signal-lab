@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stop ALL Signal Lab server windows first.
echo Enter a BACKUP store-YYYY...json file path.
set /p "SOURCE=Backup JSON path: "
if "%SOURCE%"=="" goto END
set "SOURCE=%SOURCE:"=%"
node data-cli.mjs restore "%SOURCE%"
:END
pause
