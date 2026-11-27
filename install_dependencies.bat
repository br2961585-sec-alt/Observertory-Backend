@echo off
title Observatory Telemetry - Dependency Installer
cd /d "%~dp0"
color 0B

echo =====================================================================
echo          OBSERVATORY: DEPENDENCY INSTALLATION WIZARD
echo =====================================================================
echo [*] Checking Python environment...

python --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [!] ERROR: Python is not found in your system PATH.
    echo     Please install Python 3.9+ and ensure "Add Python to PATH" is checked.
    echo     Download: https://www.python.org/downloads/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('python --version 2^>^&1') do set PYTHON_VER=%%i
echo [*] Found: %PYTHON_VER%

echo [*] Checking pip...
python -m pip --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [!] ERROR: pip module not found in your Python installation.
    echo     Please reinstall Python with pip enabled.
    pause
    exit /b 1
)

echo [*] Upgrading pip (optional / recommended)...
python -m pip install --upgrade pip --quiet --no-warn-script-location >nul 2>&1

echo [*] Installing required accelerator packages for acquired.py:
echo     - psutil (Fast process enumeration ^& metrics)
echo     - pycaw  (WASAPI core audio microphone session tracking)
echo     - comtypes (Windows COM runtime dependency for pycaw)
echo     - watchdog (Kernel filesystem observation)
echo =====================================================================

if exist "%~dp0requirements.txt" (
    echo [*] Installing from requirements.txt...
    python -m pip install -r "%~dp0requirements.txt"
) else (
    echo [*] Installing packages directly...
    python -m pip install psutil pycaw comtypes watchdog
)

if %errorlevel% neq 0 (
    color 0C
    echo.
    echo [!] ERROR: Failed to install one or more dependencies.
    echo     Please check your internet connection or install with administrator privileges.
    pause
    exit /b 1
)

echo.
echo [*] Verifying installation with Python...
python -c "import psutil; import pycaw; import comtypes; import watchdog; print('    [OK] All modules imported successfully without errors.')"
if %errorlevel% neq 0 (
    color 0C
    echo [!] Verification failed. One or more modules could not be imported.
    pause
    exit /b 1
)

color 0A
echo.
echo =====================================================================
echo [SUCCESS] All dependencies for acquired.py are installed and verified!
echo =====================================================================
echo.
echo You can now run the telemetry daemon using:
echo    1. Double-click "run_acquired.bat"
echo    2. Or run: python acquired.py 1.5
echo.
set /p RUN_NOW="Do you want to start acquired.py now? (Y/N) [default: N]: "
if /i "%RUN_NOW%"=="Y" (
    echo [*] Launching Observatory Telemetry Daemon...
    python acquired.py 1.5
)

pause
