#!/usr/bin/env bash
# e2e 构建封装: 隔离产物目录 (.next-e2e) + 处理 app/data 软链。
#
# 本机自部署时 app/data 是指向块存储的软链, Turbopack 拒绝追踪"越界软链"
# 导致构建失败 (见 docs/deployment.md)。CI 无此软链。本脚本统一处理:
# 构建前将软链暂存为真实空目录, 构建后恢复, 使 e2e 在两种环境都可构建。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DIST_DIR="${DIST_DIR:-.next-e2e}"
DATA_LINK_BAK="$ROOT/app/data.link.bak"

restore() {
  if [ -e "$DATA_LINK_BAK" ] && [ ! -L "$ROOT/app/data" ]; then
    rmdir "$ROOT/app/data" 2>/dev/null || true
    rm -rf "$ROOT/app/data"
    mv "$DATA_LINK_BAK" "$ROOT/app/data"
  fi
}
trap restore EXIT

if [ -L "$ROOT/app/data" ]; then
  mv "$ROOT/app/data" "$DATA_LINK_BAK"
  mkdir -p "$ROOT/app/data"
fi

DIST_DIR="$DIST_DIR" env -u NODE_ENV "$ROOT/node_modules/.bin/next" build
