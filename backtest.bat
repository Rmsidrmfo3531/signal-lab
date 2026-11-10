@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo [ERROR] Node.js not found. Install Node.js 22+ from https://nodejs.org/
 pause
 exit /b 1
)
echo Signal Lab backtest: 60 days, 6 symbols. First run downloads candles (several minutes).
node scripts\backtest.mjs --days 60 %* > backtest_output.txt 2>&1
type backtest_output.txt
echo.
echo Results: backtest-results\report.txt
pause
