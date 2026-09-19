@echo off
REM ============================================================
REM  @@PLUGIN_NAME@@ one-click installer
REM
REM  This file is intentionally PURE ASCII.
REM  cmd.exe reads .cmd/.bat using the OEM code page, so non-ASCII
REM  text here shows up as garbage on some machines. All the Chinese
REM  messages live in install.ps1, which is UTF-8 with BOM and renders
REM  correctly under PowerShell 5.1.
REM ============================================================

chcp 65001 >nul 2>&1
title Installing @@PLUGIN_NAME@@ @@VERSION@@

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
    echo ---------------------------------------------------------
    echo  Installation did NOT finish. Read the messages above.
    echo ---------------------------------------------------------
)
pause
exit /b %RC%
