#!/usr/bin/env bash
# tailscaled 需要 root 与交互登录，插件不代装：已装就报版本，没装就给官方安装命令。
set -eu
if command -v tailscale >/dev/null 2>&1; then
  tailscale version | head -1
  exit 0
fi
echo "Tailscale is not installed. Run in a terminal (needs sudo):" >&2
echo "  curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --ssh" >&2
exit 1
