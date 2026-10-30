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
    # mv (rename) **不更新 mtime**, 只改 ctime —— 而软链的 mtime 是它被创建的时刻。
    # 看门狗按 mtime 判「哨兵存在多久」(超过 30min 视为残留), 不打时间戳它就会
    # 永远显示几十天前 (2026-10-30 实测 46.9 天), 年龄判据等于没有。
    touch -h "$DATA_LINK_BAK" 2>/dev/null || true
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

# ── 产物备份 / 回滚 ─────────────────────────────────────────────────────
# 2026-10-28 事故：一次部署在 [3/5] 停了服务，[4/5] 构建失败后脚本退出，
# **服务再也没起来** —— 站点停了 1 天 17 小时（3996 无监听），而门户卡片还绿着。
# 部署的第一原则不是「构建成功」，而是「失败也不能让站点下线」。所以：
#   构建前把上一版产物挪到 `<distDir>.prev`；构建成功才删备份；
#   构建失败则丢掉半成品、把备份挪回来、重新起服务，然后以非零码退出。
# 半成品目录绝不能留给 next start（残缺 .next → 静态资源 500，见 §2 事故）。
prev_dir() { printf '%s.prev' "$BUILD_DIR"; }

stash_build() {
  if [ -e "$BUILD_DIR" ]; then
    rm -rf "$(prev_dir)"
    mv "$BUILD_DIR" "$(prev_dir)"
    echo "      已备份上一版产物 → $(prev_dir)"
  elif [ -e "$(prev_dir)" ]; then
    # 上次部署中途被强杀：半成品已丢，但备份还在 —— 不要覆盖它
    echo "      沿用上次残留的产物备份 $(prev_dir)"
  fi
}

restore_build() {
  # 幂等: 只在备份存在时才动 BUILD_DIR —— 否则「没有可回滚的产物」时
  # 会先把唯一可用的产物删掉再报告没有备份 (旧实现的真实缺陷)。
  if [ -e "$(prev_dir)" ]; then
    rm -rf "$BUILD_DIR"
    mv "$(prev_dir)" "$BUILD_DIR"
    echo "      已回滚上一版产物"
  else
    echo "      ⚠ 没有可回滚的产物备份（首次部署）"
  fi
}

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

# ── 部署互斥 (flock) ───────────────────────────────────────────────────
# 两个会话同时部署会互相 mv .next/.next.prev: 一个在构建, 另一个把半成品当成
# 「上一版」备份 —— 站点静默 500 (与 2026-10-26 事故同形, 只是触发者不同)。
# flock 随进程死亡自动释放 (SIGKILL 也一样), 不存在 stale lock 需要人工清。
if command -v flock >/dev/null 2>&1; then
  exec 9>"$ROOT/.deploy.lock"
  if ! flock -n 9; then
    echo "[✗] 另一个部署正在进行 (.deploy.lock 被占用) —— 拒绝并发部署" >&2
    exit 1
  fi
fi

# ── 残留哨兵修复 ───────────────────────────────────────────────────────
# 被 SIGKILL 的部署会留下 app/data.link.bak (trap 对 SIGKILL 无效)。带着它部署,
# stash_data_link 会把新软链 mv 覆盖上去, 旧哨兵指向的块存储就此失去引用。
# 此刻已持有 flock ⇒ 没有别的部署在跑 ⇒ 这个哨兵必然是残留, 先恢复再继续。
if [ -e "$DATA_LINK_BAK" ]; then
  if [ -L "$ROOT/app/data" ]; then
    echo "[0/5] ⚠ 残留哨兵与 app/data 软链并存 —— 保留现役软链, 清掉哨兵"
    rm -f "$DATA_LINK_BAK"
  else
    echo "[0/5] 发现残留哨兵 (上次部署被强杀?) —— 先恢复 app/data"
    restore_data_link
  fi
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

# ── 失败安全网（覆盖**整个**停服窗口）────────────────────────────────────
# 2026-10-29 事故: 服务停了 17 小时 48 分, 脚本退出后再也没人拉起。
# 当时只在「构建失败」分支兜底 —— 而 stash/软链恢复阶段的失败同样会让站点
# 一直停着。从此刻起, 任何非成功退出都必须: 恢复软链 → 回滚产物 → 拉起服务。
# 成功路径置 DEPLOY_OK=1, 安全网空转; 已自行兜底的分支置 DEPLOY_GUARD_DONE=1。
DEPLOY_OK=0
DEPLOY_GUARD_DONE=0
deploy_guard() {
  local rc=$?
  if [ "$DEPLOY_OK" = "1" ] || [ "$DEPLOY_GUARD_DONE" = "1" ]; then
    return 0
  fi
  echo "[guard] 部署未完成 (rc=$rc) —— 兜底: 恢复软链 / 回滚产物 / 拉起服务" >&2
  restore_data_link || true
  if [ -e "$(prev_dir)" ] && [ ! -e "$BUILD_DIR" ]; then
    restore_build || true
  fi
  if [ -L "$ROOT/app/data" ] || [ ! -e "$DATA_LINK_BAK" ]; then
    systemctl --user start "$SERVICE" || true
    sleep 2
    verify || echo "[guard] ✗ 兜底后健康检查仍失败 —— 需要人工介入" >&2
  else
    echo "[guard] ✗ app/data 仍不是软链, 拒绝启动 (避免把数据写进仓库目录)" >&2
  fi
  return 0
}
trap deploy_guard EXIT

echo "[4/5] 构建 (unset NODE_ENV: 防止 Next 16 误判环境)"
stash_build
stash_data_link
if ! run_build_in_scope; then
  restore_data_link
  echo "[4/5] ✗ 构建失败 —— 回滚上一版产物并重启服务（绝不把站点留在 502）" >&2
  restore_build
  systemctl --user start "$SERVICE" || true
  sleep 2
  verify || true
  DEPLOY_GUARD_DONE=1     # 已兜底, 不让安全网再重复一遍
  exit 1
fi
restore_data_link
# 构建成功才丢弃备份
rm -rf "$(prev_dir)"

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
DEPLOY_OK=1          # 成功: 让 EXIT 安全网空转
echo "部署完成 ✓ (日志: journalctl --user -u pbRun -f)"