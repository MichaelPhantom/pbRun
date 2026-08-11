#!/bin/bash
# ==============================================
# pbRun 生产部署脚本 (ubtu2, systemd user 服务)
# 用法:
#   bash scripts/deploy-prod.sh            # 常规部署 (pull + build + restart)
#   bash scripts/deploy-prod.sh --no-pull  # 跳过 git pull (本地已验证)
#   bash scripts/deploy-prod.sh --verify   # 仅健康检查
# ==============================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="pbRun.service"
BASE_URL="http://127.0.0.1:3996/pbrun"

cd "$ROOT"

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
  css_path=$(curl -s -L "$BASE_URL/list" | grep -oE '/pbrun/_next/static/chunks/[^"]+\.css' | head -1 || true)
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
env -u NODE_ENV "$ROOT/node_modules/.bin/next" build

echo "[5/5] 启动服务"
systemctl --user start "$SERVICE"

sleep 2
verify
echo "部署完成 ✓ (日志: journalctl --user -u pbRun -f)"