@echo off
cd /d "%~dp0"
where py >nul 2>nul && (
  py -3 start.py
  goto :eof
)
where python >nul 2>nul && (
  python start.py
  goto :eof
)
echo Python 3 is required to start the local viewer.
echo Install Python from https://www.python.org/downloads/ then run this file again.
pause
