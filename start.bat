@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有检测到 Node.js。请先安装 Node 18 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)
echo.
echo   正在启动 Novel ...
echo   关闭这个窗口即可停止服务。
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8787'"
node server.js
pause
