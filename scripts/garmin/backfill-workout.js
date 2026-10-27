#!/usr/bin/env node
/**
 * 回填 `workout_steps` / `workout_name` —— 只重写课表两列，不动其他字段与逐秒记录。
 *
 * ## 为什么需要单独一个回填脚本
 *
 * `fit-file-parser@2.3.3` 对 `workout_step` 走 `default:` 分支（`fitObj[type] = message`
 * 每次覆盖，不 push），多步课表只剩**最后一步**。真实库 285 条带课表活动里 120 条是
 * 多步课表（3/5/6/7/13/15/17/21 步），其中 60 条的最后一步恰是 `cooldown` —— 于是
 * 库里存的「课表」是冷身步，主课目标配速全丢。
 *
 * 同时 `duration_value` 在 `duration_type='time'` 时是**毫秒**（落库值 2400000 而活动
 * 只有 2404 秒），`custom_target_value_*` 在 `target_type='speed'` 时是 **mm/s**
 * （2944/3361 读起来像「每秒 3 公里」）。
 *
 * 修好的解析在 `scripts/garmin/fit-workout.js`（重扫原始字节 + 单位归一），
 * `fit-parser._extractWorkout` 已接入。本脚本把**历史行**刷成新格式。
 *
 * ## 为什么不用 `backfill-fit-fields.js`
 *
 * 那个脚本会同时重写逐秒记录（`activity_records` 全量重插），对「只修课表」这种
 * 幂等小修来说代价过大（285 个文件 × 数千条记录）。本脚本只 UPDATE 两列。
 *
 * 用法：
 *   node scripts/garmin/backfill-workout.js [--dry-run] [--limit N]
 */

const fs = require('fs').promises;
const path = require('path');

const GarminFITParser = require('./fit-parser');
const DatabaseManager = require('../common/db-manager');

const FIT_CACHE_DIR = path.join(process.cwd(), '.cache', 'fit');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

  const db = new DatabaseManager('app/data/activities.db');
  const parser = new GarminFITParser();

  const activityIds = db.getAllActivityIds();
  let cached = [];
  try {
    cached = await fs.readdir(FIT_CACHE_DIR);
  } catch {
    console.error(`✗ FIT 缓存目录不存在: ${FIT_CACHE_DIR}`);
    process.exit(1);
  }
  const cachedSet = new Set(cached);
  const targets = activityIds.filter((id) => cachedSet.has(String(id)));
  const workList = limit ? targets.slice(0, limit) : targets;
  console.log(`活动总数 ${activityIds.length} / 缓存命中 ${targets.length} / 本次处理 ${workList.length}`);

  const t0 = Date.now();
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  let multiStep = 0;

  for (let i = 0; i < workList.length; i++) {
    const id = workList[i];
    try {
      const parsed = await parser.parseFitFile(path.join(FIT_CACHE_DIR, String(id)));
      if (!parsed.activity) {
        unchanged++;
        continue;
      }
      const patch = {};
      if (parsed.activity.workout_name != null) patch.workout_name = parsed.activity.workout_name;
      if (parsed.activity.workout_steps != null) patch.workout_steps = parsed.activity.workout_steps;

      if (Object.keys(patch).length === 0) {
        unchanged++;
        continue;
      }
      const stepCount = patch.workout_steps ? JSON.parse(patch.workout_steps).length : 0;
      if (stepCount > 1) multiStep++;

      if (dryRun) {
        console.log(`[dry-run] ${id}: ${stepCount} 步 ${patch.workout_name || ''}`);
      } else {
        db.updateActivityFields(id, patch);
      }
      updated++;

      if ((i + 1) % 50 === 0) {
        console.log(`  进度 ${i + 1}/${workList.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    } catch (e) {
      console.error(`✗ ${id}: ${e.message}`);
      failed++;
    }
  }

  console.log(
    `\n✓ ${dryRun ? 'dry-run' : '回填'}完成: 更新 ${updated} / 无变化 ${unchanged} / 失败 ${failed}`,
  );
  console.log(`  其中多步课表 ${multiStep} 条`);
  db.close();
  if (failed > 0) process.exitCode = 1;
}

module.exports = { main, FIT_CACHE_DIR };

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
