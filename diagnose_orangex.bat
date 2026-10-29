@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0" >nul 2>nul
if errorlevel 1 goto folder_error
where node.exe >nul 2>nul
if errorlevel 1 goto node_required
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto node_required
node.exe scripts\diagnose-orangex-windows.mjs
set "SIGNAL_LAB_DIAG_EXIT=%ERRORLEVEL%"
goto finish

:node_required
set "SIGNAL_LAB_DIAG_EXIT=2"
set "SIGNAL_LAB_DIAG_TEMP=%TEMP%"
if not defined SIGNAL_LAB_DIAG_TEMP set "SIGNAL_LAB_DIAG_TEMP=%TMP%"
if not defined SIGNAL_LAB_DIAG_TEMP goto temp_error
for %%I in ("%SIGNAL_LAB_DIAG_TEMP%") do set "SIGNAL_LAB_DIAG_TEMP=%%~fI"
set "SIGNAL_LAB_DIAG_CHECK=%SIGNAL_LAB_DIAG_TEMP%"
call :safe_directory
if errorlevel 1 goto temp_error
rem Refuse reparse ancestors and short-name aliases of existing user data.
for %%I in ("%SIGNAL_LAB_DIAG_TEMP%") do set "SIGNAL_LAB_DIAG_SHORT_TEMP=%%~sI"
if defined LOCALAPPDATA (
 for %%I in ("%LOCALAPPDATA%\SignalLab") do set "SIGNAL_LAB_DIAG_PROTECTED=%%~sI"
 call :protected_directory
 if errorlevel 1 goto temp_error
)
if defined SIGNAL_LAB_DATA_DIR (
 for %%I in ("%SIGNAL_LAB_DATA_DIR%") do set "SIGNAL_LAB_DIAG_PROTECTED=%%~sI"
 call :protected_directory
 if errorlevel 1 goto temp_error
)
set "SIGNAL_LAB_DIAG_DIRECTORY=%SIGNAL_LAB_DIAG_TEMP%\SignalLab-OrangeX-Diagnostics"
if exist "%SIGNAL_LAB_DIAG_DIRECTORY%\" (
 set "SIGNAL_LAB_DIAG_CHECK=%SIGNAL_LAB_DIAG_DIRECTORY%"
 call :safe_directory
 if errorlevel 1 goto temp_error
)
if not exist "%SIGNAL_LAB_DIAG_DIRECTORY%\" mkdir "%SIGNAL_LAB_DIAG_DIRECTORY%" >nul 2>nul
if not exist "%SIGNAL_LAB_DIAG_DIRECTORY%\" goto temp_error
:new_report
set "SIGNAL_LAB_DIAG_RUN=%SIGNAL_LAB_DIAG_DIRECTORY%\node-required-%RANDOM%-%RANDOM%-%RANDOM%"
if exist "%SIGNAL_LAB_DIAG_RUN%\" goto new_report
mkdir "%SIGNAL_LAB_DIAG_RUN%" >nul 2>nul
if errorlevel 1 goto temp_error
set "SIGNAL_LAB_DIAG_REPORT=%SIGNAL_LAB_DIAG_RUN%\environment.json"
> "%SIGNAL_LAB_DIAG_REPORT%" echo {"kind":"ORANGEX_WINDOWS_ONECLICK","version":1,"mode":"READ_ONLY","status":"ENVIRONMENT_NOT_READY","checkedAt":null,"exitCode":2,"dataSource":"LOCAL_ENVIRONMENT_ONLY","syntheticTest":false,"rawHttpBodiesIncluded":false,"actualRequestsRun":false,"environment":{"nodeVersion":null,"nodeSupported":false,"errorCode":"NODE_22_REQUIRED"},"readiness":{"status":"NOT_READY"},"realDataAutoEntryEnabled":false,"paperAutoEntryEnabled":false,"liveOrdersEnabled":false,"accountChecked":false,"ordersSubmitted":false,"note":"Node.js 22 or newer is required. No public API request or application data access was performed."}
if errorlevel 1 goto temp_error
echo Node.js 22 or newer is required. Install Node.js, then run this file again.
echo This command does not install software or require Git/API keys.
echo JSON report: "%SIGNAL_LAB_DIAG_REPORT%"
goto finish

:temp_error
echo Could not save a diagnostic JSON in the Windows temporary folder.
echo No application records or settings were changed.
set "SIGNAL_LAB_DIAG_EXIT=3"
goto finish

:folder_error
echo Extract the entire project ZIP before running diagnose_orangex.bat.
set "SIGNAL_LAB_DIAG_EXIT=3"
goto finish

:safe_directory
rem No filesystem writes in this routine. Attribute "l" denotes a reparse link.
set "SIGNAL_LAB_DIAG_CURRENT=%SIGNAL_LAB_DIAG_CHECK%"
set /a SIGNAL_LAB_DIAG_DEPTH=0 >nul
:safe_ancestor
set /a SIGNAL_LAB_DIAG_DEPTH=SIGNAL_LAB_DIAG_DEPTH+1 >nul
if %SIGNAL_LAB_DIAG_DEPTH% GTR 128 exit /b 1
set "SIGNAL_LAB_DIAG_ATTRIBUTES="
for %%I in ("%SIGNAL_LAB_DIAG_CURRENT%") do set "SIGNAL_LAB_DIAG_ATTRIBUTES=%%~aI"
if not defined SIGNAL_LAB_DIAG_ATTRIBUTES exit /b 1
if not "%SIGNAL_LAB_DIAG_ATTRIBUTES:l=%"=="%SIGNAL_LAB_DIAG_ATTRIBUTES%" exit /b 1
for %%I in ("%SIGNAL_LAB_DIAG_CURRENT%\..") do set "SIGNAL_LAB_DIAG_PARENT=%%~fI"
if /I "%SIGNAL_LAB_DIAG_PARENT%"=="%SIGNAL_LAB_DIAG_CURRENT%" exit /b 0
set "SIGNAL_LAB_DIAG_CURRENT=%SIGNAL_LAB_DIAG_PARENT%"
goto safe_ancestor

:protected_directory
set SIGNAL_LAB_DIAG_SHORT_TEMP | "%SystemRoot%\System32\findstr.exe" /I /B /L /C:"SIGNAL_LAB_DIAG_SHORT_TEMP=%SIGNAL_LAB_DIAG_PROTECTED%" >nul
if errorlevel 2 exit /b 1
if errorlevel 1 exit /b 0
exit /b 1

:finish
echo.
echo READ_ONLY only. No orders, account API, PAPER activation or withdrawals.
if not "%SIGNAL_LAB_DIAG_NO_PAUSE%"=="1" pause
popd >nul 2>nul
exit /b %SIGNAL_LAB_DIAG_EXIT%
