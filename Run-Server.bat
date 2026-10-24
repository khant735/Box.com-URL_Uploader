@echo off
cd /d "%~dp0"
py -m pip install requests
py server.py
pause
