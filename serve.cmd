@echo off
cd /d "%~dp0"
set NODE_OPTIONS=--openssl-legacy-provider
echo [Optical Breacher] Starting server...
node breacher.js --serve
pause
