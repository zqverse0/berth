#!/usr/bin/env bash
# 安装 Cline CLI：官方渠道只有 npm（`npm install -g cline`，需要 Node.js 22+）。
set -euo pipefail
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found: install Node.js 22 or newer first, then install again." >&2
  exit 1
fi
echo "Running npm install -g cline…"
npm install -g cline </dev/null
