@echo off
REM ============================================================
REM  启动 D-STATION（Electron 外壳 + dsh 后端 sidecar）
REM  位置：build\electron-app\start-dstation.bat
REM
REM  重要：启动前请先彻底退出旧实例
REM    （右下角托盘图标 右键 → 「退出（停止 dsh 服务）」）
REM  否则单实例锁会阻止新窗口打开，看起来像"没反应"。
REM ============================================================
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 未找到 electron.exe，请确认 node_modules 已完整安装。
  pause
  exit /b 1
)

echo 正在启动 D-STATION ...
start "" "node_modules\electron\dist\electron.exe" .
