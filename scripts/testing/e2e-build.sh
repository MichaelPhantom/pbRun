#!/usr/bin/env bash
# e2e 构建封装: 隔离产物目录 (.next-e2e) + 处理 app/data 软链。
#
# 本机自部署时 app/data 是指向块存储的软链, Turbopack 拒绝追踪"越界软链"
# 导致构建失败 (见 docs/deployment.md)。CI 无此软链。本脚本统一处理:
# 构建前将软链暂存为真实空目录, 构建后恢复, 使 e2e 在两种环境都可构建。
#
# 构建与 deploy-prod.sh 同一防护（docs/ops.md §2/§2.1）:
#  1. 经 systemd-run --user --scope 挪入 user.slice —— 脚本/远程会话所在的
#     cgroup（如 opencode.service 1.5G）会把 next build memcg OOM kill（137）;
#  2. Turbopack 失败则清半成品回退 --webpack —— 2 核机器 PostCSS worker
#     固定 wall-clock deadline 冷缓存必超时。PB_BUILD_WEBPACK=1 可直接 webpack。
set -euo pipefail

# 非登录 shell（cron/远程会话）下 systemctl --user / systemd-run --user 需要它
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DIST_DIR="${DIST_DIR:-.next-e2e}"
DATA_LINK_BAK="$ROOT/app/data.link.bak"
TSCONFIG_BAK="$ROOT/.tsconfig.e2e.bak"
SCOPE_MEM="${PB_BUILD_SCOPE_MEM:-8G}"

# next build 会重写 tsconfig.json (展开数组/加 include), 造成无关 git 改动。
# 构建前备份、构建后还原, 保持工作区干净。
[ -f "$ROOT/tsconfig.json" ] && cp "$ROOT/tsconfig.json" "$TSCONFIG_BAK"

restore() {
  if [ -e "$DATA_LINK_BAK" ] && [ ! -L "$ROOT/app/data" ]; then
    rmdir "$ROOT/app/data" 2>/dev/null || true
    rm -rf "$ROOT/app/data"
    mv "$DATA_LINK_BAK" "$ROOT/app/data"
  fi
  if [ -f "$TSCONFIG_BAK" ]; then
    mv "$TSCONFIG_BAK" "$ROOT/tsconfig.json"
  fi
}
trap restore EXIT

if [ -L "$ROOT/app/data" ]; then
  mv "$ROOT/app/data" "$DATA_LINK_BAK"
  mkdir -p "$ROOT/app/data"
fi

# 单次构建（参数透传给 next build）。用户 systemd 可用时挪进 user.slice。
# 注意 env 的参数顺序：选项（-u）必须在赋值（DIST_DIR=）之前，否则赋值之后
# 的 -u 会被当成要执行的命令（/usr/bin/env: '-u': No such file or directory）。
build_with() {
  if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --quiet --scope true 2>/dev/null; then
    systemd-run --user --scope --quiet -p "MemoryMax=${SCOPE_MEM}" \
      env -u NODE_ENV DIST_DIR="$DIST_DIR" "$ROOT/node_modules/.bin/next" build "$@"
  else
    echo "⚠ 用户 systemd 不可用, 直接构建 (受限 cgroup 内可能被 memcg OOM kill, 见 docs/ops.md §2)" >&2
    env -u NODE_ENV DIST_DIR="$DIST_DIR" "$ROOT/node_modules/.bin/next" build "$@"
  fi
}

if [ "${PB_BUILD_WEBPACK:-0}" = "1" ]; then
  build_with --webpack
elif build_with; then
  :
else
  # Turbopack 失败（2 核 PostCSS worker 超时 / memcg OOM）→ 清半成品回退 webpack。
  # 半成品必须清：残缺产物会让 next start 静默 500（与 2026-10-26 生产事故同形态）。
  echo "⚠ Turbopack 构建失败, 清理半成品后回退 --webpack" >&2
  rm -rf "$ROOT/$DIST_DIR"
  build_with --webpack
fi
