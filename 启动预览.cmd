@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js，或直接打开同目录的圣诞光屿.html。
  pause
  exit /b 1
)
node server.cjs --open
pause
