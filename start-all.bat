@echo off
setlocal
title Swasemi Launcher
cd /d "%~dp0"

echo Launching Swasemi Fleet Platform...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Launcher failed or was aborted.
    echo Press any key to close this window...
    pause >nul
)
