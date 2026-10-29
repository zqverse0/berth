#!/usr/bin/env bash
# Berth org.berth.install 安装 / 更新脚本：从 GitHub Releases 下载 gh 官方二进制，按官方 checksums
# 校验 sha256 后装到 ~/.local/bin/gh（已装过则原地更新）。不走 apt/brew（要 sudo 或交互）。
# 宿主负责流式输出、总超时（600s）与互斥。
set -eu

case "$(uname -s)" in
  Linux) os=linux ext=tar.gz ;;
  Darwin) os=macOS ext=zip ;;
  *) echo "unsupported OS: $(uname -s); install gh from https://cli.github.com" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  armv6l | armv7l) arch=armv6 ;;
  i386 | i686) arch=386 ;;
  *) echo "unsupported CPU: $(uname -m); install gh from https://cli.github.com" >&2; exit 1 ;;
esac

# 已装过就原地更新那一份（否则新装的会被 PATH 里靠前的旧版遮住）；包管理器装的不碰。
dest="$HOME/.local/bin/gh"
if existing=$(command -v gh 2>/dev/null) && [ "$existing" != "$dest" ]; then
  if [ -L "$existing" ] || [ ! -w "$existing" ]; then
    echo "gh at $existing is managed elsewhere (apt, brew, …); update it with that tool" >&2
    exit 1
  fi
  dest=$existing
fi
# releases/latest 跳转到 .../tag/vX.Y.Z：不调 API，避开未登录的速率限制。
latest=$(curl -fsSL --connect-timeout 20 --max-time 60 -o /dev/null -w '%{url_effective}' \
  https://github.com/cli/cli/releases/latest)
version=${latest##*/v}
case "$version" in
  [0-9]*) ;;
  *) echo "could not resolve the latest gh version (got: $latest)" >&2; exit 1 ;;
esac
name="gh_${version}_${os}_${arch}"
base="https://github.com/cli/cli/releases/download/v${version}"
echo "Downloading gh ${version} (${os}/${arch})…"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --connect-timeout 20 --max-time 300 "$base/$name.$ext" -o "$tmp/$name.$ext"
curl -fsSL --connect-timeout 20 --max-time 60 "$base/gh_${version}_checksums.txt" -o "$tmp/checksums.txt"

expected=$(awk -v f="$name.$ext" '$2 == f { print $1 }' "$tmp/checksums.txt")
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$tmp/$name.$ext" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$name.$ext" | awk '{ print $1 }')
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "checksum mismatch for $name.$ext; refusing to install" >&2
  exit 1
fi

if [ "$ext" = zip ]; then
  unzip -q "$tmp/$name.$ext" -d "$tmp"
else
  tar -xzf "$tmp/$name.$ext" -C "$tmp"
fi
mkdir -p "$(dirname "$dest")"
install -m 755 "$tmp/$name/bin/gh" "$dest"
"$dest" --version | head -n 1
echo "Installed to $dest. Run \`gh auth login\` once in a terminal to sign in if you haven't."
