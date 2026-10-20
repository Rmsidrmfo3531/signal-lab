@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Same local application with a local-Wi-Fi listener and password protection.
rem Use only on a trusted private Wi-Fi network, never port forward TCP/3000.
set "HOST=0.0.0.0"
set "SIGNAL_LAB_MOBILE_MODE=1"
call "%~dp0start.bat"
