@echo off
rem ============================================================================
rem  Agent preset installer -- double-click this file.
rem
rem  This file MUST stay pure ASCII (cmd.exe reads .bat/.cmd in the OEM code
rem  page, so Chinese text here would show up as garbage). All Chinese messages
rem  live in install.ps1 and in the readme, which are UTF-8 with BOM.
rem
rem  Package contains @@AGENT_COUNT@@ agent preset(s): @@AGENT_IDS@@
rem ============================================================================

chcp 65001 >nul 2>&1
echo.
echo   D-STATION agent preset installer
echo   ------------------------------------------------
echo   Agents in this package: @@AGENT_COUNT@@  (@@AGENT_IDS@@)
echo.
echo   Installing... please wait.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" echo   [OK] Install finished. Read the messages above.
if not "%RC%"=="0" echo   [FAILED] Install did not complete (exit code %RC%).
echo.
echo   Press any key to close this window.
pause >nul
exit /b %RC%
