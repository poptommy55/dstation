@echo off
REM  @@PLUGIN_NAME@@ one-click uninstaller.  Pure ASCII on purpose
REM  (see the header of the install .cmd for why).

chcp 65001 >nul 2>&1
title Uninstalling @@PLUGIN_NAME@@

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
    echo ---------------------------------------------------------
    echo  Uninstall did NOT finish. Read the messages above.
    echo ---------------------------------------------------------
)
pause
exit /b %RC%
