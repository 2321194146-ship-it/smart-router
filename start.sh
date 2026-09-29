#!/usr/bin/env bash
# Smart Router 可运行启动脚本
# 首次运行会自动安装生产依赖（better-sqlite3 是原生模块，需在目标机编译），随后启动网关。
set -euo pipefail
cd "$(dirname "$0")"

# 首次部署：若运行时配置缺失，从脱敏模板复制一份（不含任何真实密钥）。
if [ ! -f config/config.json ]; then
  if [ -f config/config.example.json ]; then
    echo "[start] 未找到 config/config.json，已从 config/config.example.json 生成模板"
    cp config/config.example.json config/config.json
  else
    echo "[start] 错误：缺少 config/config.json 且无可用的 config/config.example.json" >&2
    exit 1
  fi
fi

# 若依赖缺失（或原生模块未编译），则安装生产依赖
if [ ! -d node_modules ] || [ ! -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ]; then
  echo "[start] 正在安装生产依赖（可能需编译原生模块，请稍候）..."
  npm install --omit=dev
fi

# 以下环境变量可覆盖默认配置；不设置则使用默认值。
# 默认端口为 17878（模块化 6.1 测试端口）。7878 是旧生产网关，仅在人工显式执行
# PORT=7878 ./start.sh 时才会使用；本脚本不会自动占用或接管 7878。
export PORT="${PORT:-17878}"
export HOST="${HOST:-127.0.0.1}"
export ADMIN_TOKEN="${ADMIN_TOKEN:-}"
export CONFIG_FILE="${CONFIG_FILE:-}"
export DB_PATH="${DB_PATH:-}"
export CACHE_TTL="${CACHE_TTL:-}"

echo "[start] Smart Router 即将监听 ${HOST}:${PORT}"
exec node src/index.js
