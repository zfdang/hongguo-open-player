#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 错误: 未检测到 Node.js 环境，请先安装 Node.js (>= 18.0): https://nodejs.org/"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "📦 正在安装生产依赖..."
  npm install --omit=dev
fi

echo "🚀 正在启动红果短剧桌面播放器并打开界面..."
exec node src/server/index.js --open
