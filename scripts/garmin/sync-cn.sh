#!/usr/bin/env bash
# pbRun 国区增量同步编排: cn_export.py 导出新 FIT → pbRun sync.js 导入数据库
#
# 用法:
#   ./sync-cn.sh              # 增量 (cn_export 增量 + pbRun 增量)
#   ./sync-cn.sh --full       # 全量
#   ./sync-cn.sh --cdp        # 跳过 cn_export, 用 pbRun CDP 源直连
#
# 依赖: cft/garmin 管线 (cn_export.py + cdp_client.py), 国区 CDP 隧道 (u2:9995)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CFT_GARMIN="${CFT_GARMIN:-$(dirname "$(dirname "$SCRIPT_DIR")")/cft/garmin}"
CDP_URL="${GARMIN_CN_CDP:-http://127.0.0.1:9995}"
FIT_DIR="$CFT_GARMIN/export/fit"

# 颜色
G='\033[0;32m'; Y='\033[0;33m'; C='\033[0;36m'; R='\033[0;31m'; N='\033[0m'
log() { echo -e "${2:-$C}$1${N}"; }

MODE="incremental"
USE_CDP=false
for arg in "$@"; do
  case "$arg" in
    --full) MODE="full" ;;
    --cdp)  USE_CDP=true ;;
  esac
done

log "╔═══════════════════════════════════════════════╗" "$G"
log "║   pbRun 国区增量同步                           ║" "$G"
log "╚═══════════════════════════════════════════════╝" "$G"

if [ "$USE_CDP" = true ]; then
  # CDP 直连模式: pbRun 直接从国区浏览器下载
  log "CDP 直连模式: pbRun → $CDP_URL" "$C"
  cd "$SCRIPT_DIR/../.."
  exec node scripts/garmin/sync.js --source cdp --cdp "$CDP_URL" --all-types
fi

# local 模式: 先 cn_export.py 导出, 再 pbRun 导入
log "[1/3] 检查 cft/garmin 管线..." "$C"
if [ ! -f "$CFT_GARMIN/cn_export.py" ]; then
  log "✗ 未找到 $CFT_GARMIN/cn_export.py" "$R"
  log "  设置 CFT_GARMIN 环境变量指向 cft/garmin 目录" "$Y"
  exit 1
fi

log "[2/3] 国区导出 (cn_export.py)..." "$C"
if [ "$MODE" = "full" ]; then
  python3 "$CFT_GARMIN/cn_export.py" "$CDP_URL" --full || {
    log "✗ cn_export 失败 (会话过期? 运行 ws_login.py 重登)" "$R"
    exit 3
  }
else
  python3 "$CFT_GARMIN/cn_export.py" "$CDP_URL" || {
    log "✗ cn_export 失败 (会话过期? 运行 ws_login.py 重登)" "$R"
    exit 3
  }
fi

log "[3/3] pbRun 导入..." "$C"
cd "$SCRIPT_DIR/../.."
node scripts/garmin/sync.js --source local --fit-dir "$FIT_DIR" --all-types

log "✓ 同步完成" "$G"
