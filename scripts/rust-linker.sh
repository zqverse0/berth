#!/usr/bin/env bash
set -eu

# Prefer mold for local Linux development, but keep clean CI/Docker hosts that
# do not install mold buildable with the system linker.
if command -v mold >/dev/null 2>&1; then
  args=()
  for arg in "$@"; do
    # Recent Rust toolchains may select their bundled lld explicitly. The last
    # -fuse-ld flag wins, so remove that default when opting into mold.
    if [[ "$arg" != "-fuse-ld=lld" ]]; then
      args+=("$arg")
    fi
  done
  exec gcc -fuse-ld=mold "${args[@]}"
fi

exec gcc "$@"
