#!/usr/bin/env bash
# 安装 Pi：运行官方安装脚本 https://pi.dev/install.sh（与官方文档的 curl | sh 等价）。
# Berth 在后台、无终端地调用本脚本：setsid 脱离控制终端，官方安装器里的 /dev/tty 提问
# 拿不到终端就按默认（不确认）继续，不会卡住。
set -euo pipefail
url=https://pi.dev/install.sh
script=$(mktemp)
trap 'rm -f "$script"' EXIT
echo "Downloading $url…"
curl -fsSL --retry 2 "$url" -o "$script"
echo "Running the official Pi installer…"
if command -v setsid >/dev/null 2>&1; then
  setsid -w sh "$script" </dev/null
else
  sh "$script" </dev/null
fi

# 群组 ACP 模式的适配器：锁版本装进插件数据目录（launch.js 的 acp() 从这里起），不用 npx 临时下载。
acp_dir="${BERTH_HOME:-$HOME/.berth}/state/pi/acp"
if command -v npm >/dev/null 2>&1; then
  echo "Installing pi-acp into $acp_dir…"
  mkdir -p "$acp_dir"
  npm install --prefix "$acp_dir" --no-save --no-audit --no-fund pi-acp@0.0.34
else
  echo "npm not found: skipping pi-acp (Pi cannot join groups until it is installed)"
fi
