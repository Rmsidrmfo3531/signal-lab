@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Two PCs, one record: keep the data folder in OneDrive (or any synced folder).
rem Folder: first line of shared_data_dir.txt next to this file, else %OneDrive%\SignalLabData.
set "SHARED="
if exist "%~dp0shared_data_dir.txt" set /p SHARED=<"%~dp0shared_data_dir.txt"
rem Personal OneDrive first (Explorer shows it as "OneDrive - Personal"), then the default one.
if "%SHARED%"=="" if not "%OneDriveConsumer%"=="" set "SHARED=%OneDriveConsumer%\SignalLabData"
if "%SHARED%"=="" if not "%OneDrive%"=="" set "SHARED=%OneDrive%\SignalLabData"
if "%SHARED%"=="" if exist "%USERPROFILE%\OneDrive - Personal\" set "SHARED=%USERPROFILE%\OneDrive - Personal\SignalLabData"
if "%SHARED%"=="" if exist "%USERPROFILE%\OneDrive\" set "SHARED=%USERPROFILE%\OneDrive\SignalLabData"
if "%SHARED%"=="" goto NO_SHARED
if not exist "%SHARED%" mkdir "%SHARED%"
if exist "%SHARED%\store.json" goto RUN
if not exist "%LOCALAPPDATA%\SignalLab\store.json" goto RUN
echo [SHARED] 이 PC의 기존 기록을 공유 폴더로 복사합니다 - 처음 한 번만
copy /Y "%LOCALAPPDATA%\SignalLab\store.json" "%SHARED%\store.json" >nul
:RUN
set "SIGNAL_LAB_DATA_DIR=%SHARED%"
rem Settings and secrets (.env: Telegram token, exchange keys) stay on this PC, not in the cloud.
set "SIGNAL_LAB_ENV_DIR=%LOCALAPPDATA%\SignalLab"
echo [SHARED] 기록 폴더: %SHARED%
echo [SHARED] 설정 파일: %SIGNAL_LAB_ENV_DIR%\.env (이 PC 전용)
echo [SHARED] 다른 PC의 서버를 끄고 OneDrive 동기화가 끝난 뒤 실행하세요.
call "%~dp0start.bat"
exit /b %ERRORLEVEL%
:NO_SHARED
echo [ERROR] OneDrive 폴더를 찾지 못했습니다. OneDrive에 로그인하거나,
echo         shared_data_dir.txt 파일 첫 줄에 동기화 폴더 경로를 적어 주세요.
pause
exit /b 1
