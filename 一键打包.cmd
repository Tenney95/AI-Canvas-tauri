@echo off
setlocal
chcp 65001 >nul
title AI Canvas - Local Windows Build
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-local-windows.ps1"
set "BUILD_EXIT=%ERRORLEVEL%"
echo.
if not "%BUILD_EXIT%"=="0" echo Build failed. Read the error and build.log above.
pause
exit /b %BUILD_EXIT%
