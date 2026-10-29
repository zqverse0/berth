#!/usr/bin/env bash
# 安装 Grok：运行官方安装脚本 https://x.ai/cli/install.sh（与官方文档的 curl | bash 等价）。
# Berth 在后台、无终端地调用本脚本：setsid 脱离控制终端，官方安装器里的 /dev/tty 提问
# 拿不到终端就按默认（不确认）继续，不会卡住。
set -euo pipefail
url=https://x.ai/cli/install.sh
script=$(mktemp)
trap 'rm -f "$script"' EXIT
echo "Downloading $url…"
curl -fsSL --retry 2 "$url" -o "$script"
echo "Running the official Grok installer…"
if command -v setsid >/dev/null 2>&1; then
  setsid -w bash "$script" </dev/null
else
  bash "$script" </dev/null
fi
