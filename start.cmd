@echo off
rem Starts the companion. The first time, it installs what it needs (Node.js has to be on this PC: https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is needed first: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Installing what it needs... & call npm install || (pause & exit /b 1))
node src\index.js %*
pause
