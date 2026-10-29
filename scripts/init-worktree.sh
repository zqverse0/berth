#!/bin/bash
# Worktree 初始化脚本
# 用法: ./scripts/init-worktree.sh

set -e

echo "🚀 初始化 worktree..."

# 1. 安装 Node.js 依赖
echo "📦 安装 pnpm 依赖..."
pnpm install --frozen-lockfile

# 2. 构建 Next.js（生成 out/ 目录）
echo "🔨 构建 Next.js..."
pnpm build

# 3. 准备 GUI 自有 sidecar
echo "⚙️  准备 sidecar 二进制文件..."
pnpm tauri:prepare-sidecars

echo "✅ Worktree 初始化完成！"
echo ""
echo "现在可以运行:"
echo "  - pnpm tauri dev      (开发模式)"
echo "  - pnpm tauri build    (生产构建)"
echo "  - cd src-tauri && cargo build  (仅编译 Rust)"
