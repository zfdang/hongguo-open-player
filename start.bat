@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ======================================================
echo 🎬 正在启动 红果短剧桌面播放器...
echo ======================================================

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo ❌ 错误: 未检测到 Node.js，请先从官网安装 Node.js (建议 20.x 或 22.x): https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo 📦 首次运行，正在自动安装依赖，请稍候...
  call npm install --omit=dev
)

echo 🚀 启动服务并打开播放器界面...
node src/server/index.js --open

pause
