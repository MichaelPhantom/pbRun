#!/bin/bash
# ==============================================
# pbRun 生产部署脚本 (ubtu2, systemd user 服务)
# 用法:
#   bash scripts/deploy-prod.sh            # 常规部署 (pull + build + restart)
#   bash scripts/deploy-prod.sh --no-pull  # 跳过 git pull (本地已验证)
#   bash scripts/deploy-prod.sh --verify   # 仅健康检查
# ==============================================
set -euo pipefail

# 用户 systemd 总线定位: 自动化环境 (cron / CI / 非登录 shell) 里
# XDG_RUNTIME_DIR 往往是空的, 于是 `systemctl --user` 与 `systemd-run --user`
# 全部报 "Failed to connect to bus"。此前只在 run_build_in_scope 里局部 export,
# 导致 [3/5] 停止服务 / [5/5] 启动服务两步先失败 —— 构建成功了服务却没重启。
# 统一在入口处 export, 让整条脚本运行在同一总线上下文里。
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="pbRun.service"
BASE_URL="http://127.0.0.1:3996/pbrun"

cd "$ROOT"

# app/data 为指向块存储的软链时，Turbopack 构建会因"越界软链"失败；
# 构建前暂存软链并以空目录替身，构建后（成功/失败均）恢复。
DATA_LINK_BAK="$ROOT/app/data.link.bak"
stash_data_link() {
  if [ -L "$ROOT/app/data" ]; then
    echo "      app/data 为软链 (-> $(readlink "$ROOT/app/data"))，构建时临时替身"
    mv "$ROOT/app/data" "$DATA_LINK_BAK"
    mkdir -p "$ROOT/app/data"
  fi
}
restore_data_link() {
  if [ -e "$DATA_LINK_BAK" ] && [ ! -L "$ROOT/app/data" ]; then
    rmdir "$ROOT/app/data" 2>/dev/null || true
    # 替身目录非空说明构建写入了数据文件，合并回软链目标而非丢弃
    if [ -d "$ROOT/app/data" ]; then
      cp -rn "$ROOT/app/data/." "$(readlink "$DATA_LINK_BAK")/" 2>/dev/null || true
      rm -rf "$ROOT/app/data"
    fi
    mv "$DATA_LINK_BAK" "$ROOT/app/data"
    echo "      app/data 软链已恢复 (-> $(readlink "$ROOT/app/data"))"
  fi
}

# ── cgroup 内存防护 ─────────────────────────────────────────────────────
# 受限 cgroup (如 opencode.service, memcg 硬上限 1.5G) 里直接 next build 会被
# memcg OOM kill (exit 137)，留下半成品 .next → 服务静态资源 500 (生产事故
# 2026-10-26，诊断与判别见 docs/ops.md §2)。故构建默认经 systemd-run --user
# --scope 挪入 user.slice (无 memcg 上限)；用户 systemd 不可用时回退直接构建
# 并告警。上限可用 PB_BUILD_SCOPE_MEM 覆盖。
SCOPE_MEM="${PB_BUILD_SCOPE_MEM:-8G}"
BUILD_DIR="$ROOT/${DIST_DIR:-.next}"

# 单次构建 (参数透传给 next build)。用户 systemd 可用时挪进 user.slice。
build_with() {
  if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --quiet --scope true 2>/dev/null; then
    systemd-run --user --scope --quiet -p "MemoryMax=${SCOPE_MEM}" \
      env -u NODE_ENV "$ROOT/node_modules/.bin/next" build "$@"
  else
    echo "      ⚠ 用户 systemd 不可用, 直接构建 (受限 cgroup 内可能被 memcg OOM kill, 见 docs/ops.md §2)"
    env -u NODE_ENV "$ROOT/node_modules/.bin/next" build "$@"
  fi
}

run_build_in_scope() {
  if [ "${PB_BUILD_WEBPACK:-0}" = "1" ]; then
    echo "      PB_BUILD_WEBPACK=1 → 直接用 webpack 构建"
    build_with --webpack
    return
  fi
  echo "      经 systemd-run --user --scope 构建 (MemoryMax=${SCOPE_MEM}, 规避父 cgroup memcg 限额)"
  if build_with; then
    return 0
  fi
  # Turbopack 的 PostCSS worker 有固定的 wall-clock deadline。2 核 CPU 或高负载
  # 下冷缓存构建会撞上 "timeout while receiving message from process / deadline
  # has elapsed", 而这不是代码错误 (同一提交在 4 核 CI 上通过)。webpack 没有这个
  # deadline, 用它兜底 —— 但**必须先清掉半成品 .next**, 否则 next start 会命中
  # 残缺产物导致静态资源 500 (2026-10-26 生产事故的同一形态)。
  echo "      ⚠ Turbopack 构建失败 (2 核/高负载下 PostCSS worker 超时), 清理半成品后回退 --webpack"
  rm -rf "$BUILD_DIR"
  build_with --webpack
}

verify() {
  echo "[verify] 健康检查: $BASE_URL"
  local css status
  css=$(curl -s -L -o /dev/null -w "%{http_code}" "$BASE_URL/list" -H "Accept: text/html" || true)
  status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/list" || true)
  if [ "$status" != "200" ]; then
    echo "[verify] ✗ 首页非 200 (got $status)" >&2
    return 1
  fi
  local css_path
  # 必须匹配任意 `_next` 下的 .css —— 不能写死 `/static/chunks/*.css`:
  # Turbopack 把 CSS 放在 `_next/static/chunks/`，webpack 放在
  # `_next/static/css/`。旧实现只认前者，于是 Turbopack 回退 webpack 后
  # 构建成功、服务 200、校验却永远失败（校验器与被测实现耦合）。
  css_path=$(curl -s -L "$BASE_URL/list" | grep -oE '/pbrun/_next/[^"]+\.css' | head -1 || true)
  if [ -z "$css_path" ]; then
    echo "[verify] ✗ 页面未输出 CSS 引用" >&2
    return 1
  fi
  local css_code
  css_code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3996$css_path")
  if [ "$css_code" != "200" ]; then
    echo "[verify] ✗ 主 CSS 加载失败 ($css_code: $css_path)" >&2
    echo "[verify]   原因通常是前一次构建后未重启服务 (内存产物与磁盘产物不一致)" >&2
    return 1
  fi
  echo "[verify] ✓ 首页 200, CSS $css_path → $css_code"
}

if [ "${1:-}" = "--verify" ]; then
  verify
  exit $?
fi

if [ "${1:-}" != "--no-pull" ]; then
  echo "[1/5] git pull"
  git pull --rebase
fi

echo "[2/5] 依赖检查 (package-lock 变化时自动 npm ci)"
if git diff HEAD@{1} --name-only 2>/dev/null | grep -q '^package-lock.json$' || [ -z "$(ls node_modules/.package-lock.json 2>/dev/null)" ]; then
  npm ci --no-audit --no-fund
else
  echo "      依赖未变化, 跳过"
fi

echo "[3/5] 停止服务 (避免 next start 持有旧 .next 时被覆盖)"
systemctl --user stop "$SERVICE"

echo "[4/5] 构建 (unset NODE_ENV: 防止 Next 16 误判环境)"
stash_data_link
trap restore_data_link EXIT
if ! run_build_in_scope; then
  echo "[4/5] ✗ 构建失败, 清理半成品 $BUILD_DIR (残缺产物会让 next start 静默 500)" >&2
  rm -rf "$BUILD_DIR"
  exit 1
fi
restore_data_link
trap - EXIT

# 构建后必须恢复软链；若恢复失败则 loud 失败，绝不带着坏数据目录启动服务。
if [ -e "$ROOT/app/data.link.bak" ] || [ ! -L "$ROOT/app/data" ]; then
  echo "[4/5] ✗ app/data 软链未恢复，拒绝启动服务" >&2
  restore_data_link || true
  ls -lad "$ROOT/app/data" "$ROOT/app/data.link.bak" 2>&1 || true
  exit 1
fi

echo "[5/5] 启动服务"
systemctl --user start "$SERVICE"

sleep 2
verify
echo "部署完成 ✓ (日志: journalctl --user -u pbRun -f)"