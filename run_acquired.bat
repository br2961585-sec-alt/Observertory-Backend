@echo off
title Observatory Telemetry Daemon (acquired.py)
cd /d "%~dp0"
color 0A

echo =====================================================================
echo               OBSERVATORY: LOCAL TELEMETRY DAEMON
echo =====================================================================
echo [*] Checking Python environment...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [!] ERROR: Python is not found in your system PATH.
    echo     Please install Python 3.9+ and add it to PATH.
    pause
    exit /b 1
)

echo [*] Starting telemetry engine...
echo [*] Target file: collector.json
echo [*] Press Ctrl+C at any time to stop the daemon.
echo =====================================================================
python acquired.py 1.5

pause
