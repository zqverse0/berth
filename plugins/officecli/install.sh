#!/usr/bin/env bash
# Berth org.berth.install 安装脚本：跑 OfficeCLI 官方 install.sh（国内镜像优先，GitHub 兜底），
# 装完自检能否启动。宿主负责流式输出、总超时（600s）与互斥。
set -u
mirror=https://d.officecli.ai/install.sh
github=https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.sh

# 先落临时文件再执行：避免 `curl | bash` 断流时把兜底输出拼在半截脚本后面。
f=$(mktemp) || exit 1
trap 'rm -f "$f"' EXIT
curl -fsSL --connect-timeout 20 --max-time 60 "$mirror" -o "$f" \
  || curl -fsSL --connect-timeout 20 --max-time 60 "$github" -o "$f" \
  || { echo "failed to download the OfficeCLI installer" >&2; exit 1; }
bash "$f" || exit $?

# 自包含 .NET 二进制在精简镜像上常缺 libicu：装上了却跑不起来时给出可操作的提示。
bin=$(command -v officecli || echo "$HOME/.local/bin/officecli")
if ! err=$("$bin" --version 2>&1 >/dev/null); then
  case $(printf '%s' "$err" | tr '[:upper:]' '[:lower:]') in
    *"valid icu package"*|*libicu*)
      echo "officecli could not start: the ICU library its embedded .NET runtime needs is missing. Install it and retry (Debian/Ubuntu: apt-get install -y libicu72; Alpine: apk add icu-libs)." >&2 ;;
    *"error while loading shared libraries"*)
      echo "officecli could not start: a required system library is missing. Install the library named below and retry." >&2 ;;
  esac
  echo "$err" >&2
  exit 1
fi
