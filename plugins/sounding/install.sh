#!/usr/bin/env bash
# Berth org.berth.install 安装 / 更新脚本：用 uv 把 sounding（会话分析引擎 https://github.com/zqverse0/sounding）装成独立命令。
# 装在 uv 的工具目录（~/.local/bin/sounding），不碰系统 Python；再跑一次即更新。
# 宿主负责流式输出、总超时（600s）与互斥。
set -eu

source="git+https://github.com/zqverse0/sounding"

if ! command -v uv >/dev/null 2>&1; then
  echo "sounding needs uv (https://docs.astral.sh/uv/): install it with" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

echo "Installing sounding from ${source}…"
uv tool install --force --python 3.12 "$source"
sounding --version
