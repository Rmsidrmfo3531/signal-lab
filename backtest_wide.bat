@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo [ERROR] Node.js not found. Install Node.js 22+ from https://nodejs.org/
 pause
 exit /b 1
)
echo Signal Lab wide backtest: 365 days, 30 symbols. First run downloads candles (20-40 minutes).
node scripts\backtest.mjs --days 365 --balance 400 --scalp-1m-days 0 --symbols BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,BNBUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,SUIUSDT,TRXUSDT,DOTUSDT,BCHUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,INJUSDT,TIAUSDT,SEIUSDT,WIFUSDT,FILUSDT,ATOMUSDT,UNIUSDT,AAVEUSDT,ETCUSDT,HBARUSDT,1000PEPEUSDT,ENAUSDT %* > backtest_wide_output.txt 2>&1
type backtest_wide_output.txt
echo.
echo Done. Results: backtest-results\report.txt
pause
