#!/usr/bin/env node
/**
 * 回填活动开始时间的本地墙钟与 UTC 偏移（2026-10-06 时区缺陷修复）。
 *
 * 背景
 *   历史 `fit-parser.js` 用 FIT 的 `session.timestamp` 填 `start_time_local`，
 *   而它与 `session.start_time`（UTC）同值 → 230/230 条活动的本地时间实为 UTC，
 *   其中 38 条晨跑（本地 00:00–08:00）**日期**被算到前一天，波及：
 *   月汇总 / 年热力图 / 每日里程 / VDOT 趋势日期 / 训练负荷 ACWR / 跑姿趋势。
 *
 * 本脚本
 *   逐条读取 FIT（`activity.local_timestamp` 为唯一可信本地时间），
 *   重算并回填：
 *     - start_time       : UTC（带 Z），FIT 无误时保持不变（防误伤）
 *     - start_time_local : 本地墙钟（无 Z）
 *     - start_tz_offset_min : 本地相对 UTC 的分钟偏移（Asia/Shanghai = 480）
 *
 * 特性
 *   - 幂等：只在值发生变化时写库；重复运行无副作用。
 *   - 可干跑：`--dry-run` 只打印将变更的条目。
 *   - 可限量：`--limit N`。
 *   - 失败可见：任一条失败 → 退出码 1（供 CI/cron 察觉部分失败）。
 *
 * 数据源（按序查找，命中即用）
 *   1. `--fit-dir <dir>`（默认环境变量 GARMIN_CN_EXPORT_DIR）
 *   2. `.cache/fit/<activity_id>`（sync.js 的本地缓存，文件名无扩展名）
 *
 * 用法
 *   node scripts/garmin/backfill-start-time-local.js [--dry-run] [--limit N] [--fit-dir DIR]
 */

const fs = require('fs');
const path = require('path');

const GarminFITParser = require('./fit-parser');
const DatabaseManager = require('../common/db-manager');

const DEFAULT_CACHE_DIR = path.join(process.cwd(), '.cache', 'fit');

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { dryRun: false, limit: null, fitDir: process.env.GARMIN_CN_EXPORT_DIR || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--fit-dir') args.fitDir = argv[++i];
  }
  return args;
}

/** 在若干候选目录中定位某活动的 FIT 文件；找不到返回 null。 */
function locateFit(activityId, dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of [`${activityId}.fit`, String(activityId)]) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* 继续找下一个 */
      }
    }
  }
  return null;
}

/**
 * 判断某行是否需要回填（纯函数，便于单测）。
 * 需要的条件：FIT 能算出本地墙钟，且与库中现有值不同（或偏移缺失）。
 */
function needsBackfill(row, parsed) {
  if (!parsed || !parsed.start_time_local) return { needed: false };
  const localChanged = row.start_time_local !== parsed.start_time_local;
  const offsetChanged =
    parsed.start_tz_offset_min != null && row.start_tz_offset_min !== parsed.start_tz_offset_min;
  return { needed: localChanged || offsetChanged, localChanged, offsetChanged };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new DatabaseManager('app/data/activities.db');
  const parser = new GarminFITParser();

  const dirs = [args.fitDir, DEFAULT_CACHE_DIR].filter(Boolean);
  const ids = db.getAllActivityIds();
  const work = args.limit ? ids.slice(0, args.limit) : ids;

  console.log(`活动总数: ${ids.length}，本次处理: ${work.length}`);
  console.log(`FIT 搜索目录: ${dirs.join(' , ')}`);
  console.log(args.dryRun ? '模式: DRY-RUN (不写库)' : '模式: 实际写入');

  let changed = 0;
  let unchanged = 0;
  let missing = 0;
  let failed = 0;
  const samples = [];

  for (const id of work) {
    const fitPath = locateFit(id, dirs);
    if (!fitPath) {
      missing++;
      continue;
    }
    try {
      const parsed = await parser.parseFitFile(fitPath);
      const a = parsed && parsed.activity;
      if (!a) {
        failed++;
        continue;
      }
      const row = db.getActivity(id);
      if (!row) {
        missing++;
        continue;
      }

      const { needed } = needsBackfill(row, a);
      if (!needed) {
        unchanged++;
        continue;
      }

      changed++;
      if (samples.length < 5) {
        samples.push({
          id,
          before: row.start_time_local,
          after: a.start_time_local,
          offset: a.start_tz_offset_min,
        });
      }

      if (!args.dryRun) {
        // 仅在 FIT 明确给出 UTC 时覆盖 start_time (防误伤); 偏移一并回填。
        const patch = {
          start_time_local: a.start_time_local,
          start_tz_offset_min: a.start_tz_offset_min ?? null,
        };
        if (a.start_time) patch.start_time = a.start_time;
        db.updateActivityFields(id, patch);
      }
    } catch (e) {
      failed++;
      console.error(`✗ ${id}: ${e.message}`);
    }
  }

  if (samples.length > 0) {
    console.log('\n样例 (前 5 条):');
    for (const s of samples) {
      console.log(`  ${s.id}  ${s.before}  →  ${s.after}  (offset=${s.offset})`);
    }
  }

  console.log(
    `\n✓ 完成: 变更 ${changed} / 未变 ${unchanged} / 缺 FIT ${missing} / 失败 ${failed}` +
      (args.dryRun ? ' (dry-run)' : ''),
  );
  db.close();
  if (failed > 0) process.exitCode = 1;
}

module.exports = { main, locateFit, needsBackfill, parseArgs, DEFAULT_CACHE_DIR };

// 仅 CLI 直跑时执行 (被 require 时不自动运行, 便于单测)
if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
