@echo off
cd /d "%~dp0"
echo Starting Astra Proxy Browser at http://127.0.0.1:6740 ...
start "" "http://127.0.0.1:6740"
node server.js
pause
