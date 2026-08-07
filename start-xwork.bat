@echo off
chcp 65001 >nul
title XWork
cd /d "%~dp0app"
if not exist "node_modules" call npm install
if errorlevel 1 goto :failed
echo [XWork] Starting... engine may take 10-30s on first launch.
call npm run dev
goto :eof

:failed
echo [XWork] npm install failed. Check network and retry.
pause
