#!/usr/bin/env node
/**
 * 回填 FIT 新字段（garmin_vo2max / recovery_time / primary_benefit /
 * hr_zone_boundaries / power_zone_boundaries / devices / user_weight /
 * user_height / resting_heart_rate_fit / workout_name / workout_steps /
 * hrv_rmssd）以及逐秒记录 power/altitude/speed/distance 扩展列。
 *
 * 数据源：.cache/fit/<activity_id> FIT 缓存，逐个重新解析。
 * 用法：node scripts/garmin/backfill-fit-fields.js [--dry-run] [--limit N]
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

  // 找出 DB 中所有活动 id
  const activityIds = db.getAllActivityIds();
  console.log(`DB 活动总数: ${activityIds.length}`);

  // 找出缓存中存在的 FIT
  let cached = [];
  try {
    cached = await fs.readdir(FIT_CACHE_DIR);
  } catch {
    console.error(`✗ FIT 缓存目录不存在: ${FIT_CACHE_DIR}`);
    process.exit(1);
  }
  const cachedSet = new Set(cached);
  const targets = activityIds.filter(id => cachedSet.has(String(id)));
  console.log(`缓存命中: ${targets.length} 个 FIT 文件`);

  const workList = limit ? targets.slice(0, limit) : targets;

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let recordsUpdated = 0;
  let lapsUpdated = 0;

  const t0 = Date.now();
  for (let i = 0; i < workList.length; i++) {
    const id = workList[i];
    const fitPath = path.join(FIT_CACHE_DIR, String(id));
    try {
      const parsed = await parser.parseFitFile(fitPath);
      if (!parsed.activity) {
        skipped++;
        continue;
      }
      const a = parsed.activity;

      // 只回填 FIT 新字段（不覆盖既有核心指标）
      const patch = {};
      const fields = [
        'garmin_vo2max', 'recovery_time', 'primary_benefit',
        'hr_zone_boundaries', 'power_zone_boundaries',
        'devices', 'user_weight', 'user_height', 'resting_heart_rate_fit',
        'workout_name', 'workout_steps', 'hrv_rmssd', 'hrv_rmssd_ratio',
        // 海拔（km→m 换算修复后需重刷）
        'avg_altitude', 'max_altitude', 'min_altitude',
        // 心率区间：time_in_hr_zone 是本地 5 区口径（由逐秒心率推导），
        // device_time_in_hr_zone 是设备原始数组（仅供追溯）。两者都幂等。
        'time_in_hr_zone', 'device_time_in_hr_zone',
        // 总计数（第十类缺陷 2026-11-07）：游泳=总划水/跳绳=总跳跃/爬楼=总步数。
        // FIT 里一直有（349/353），此前解析器不读 → 全库该列不存在。
        'total_cycles',
        // 泳池规格 + 主观感受 + 出汗量（第十类缺陷第二轮）：
        // pool_length/num_active_lengths 是 SWOLF 的输入（4/4）；
        // workout_feel/workout_rpe 是唯一由用户主动输入的字段（251/353）；
        // est_sweat_loss 是补液建议依据（349/353，设备估算值）。
        'pool_length', 'num_active_lengths',
        'workout_feel', 'workout_rpe', 'est_sweat_loss',
      ];
      for (const f of fields) {
        if (a[f] != null) patch[f] = a[f];
      }

      if (dryRun) {
        const filled = Object.keys(patch).length;
        if (filled > 0) {
          console.log(`[dry-run] ${id}: ${filled} 字段 (${Object.keys(patch).slice(0, 3).join(',')})`);
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      if (Object.keys(patch).length > 0) {
        db.updateActivityFields(id, patch);
        updated++;
      } else {
        skipped++;
      }

      // 逐秒记录扩展列回填
      if (Array.isArray(parsed.records) && parsed.records.length > 0) {
        db.insertActivityRecords(id, parsed.records.map(r => ({ ...r, activity_id: id })));
        recordsUpdated++;
      }

      // lap 级字段回填（第十类缺陷续 / 第十二类缺陷）。
      //
      // 只补指定列，**不重写整个 lap**：`insertLaps` 会先 DELETE 再 INSERT，
      // 拿解析结果整体覆盖库里的 lap。而解析器不产出的列（`cumulative_time`
      // 由解析器算、但 `lap_trigger` 等历史字段可能不同）会被覆盖成 NULL ——
      // 对已有 3137 段真实数据的库来说风险太大。
      // 改为按 `lap_index` 逐段 UPDATE，只动传进去的列。
      //
      // `intensity`（第十二类缺陷）：设备记录的分段角色，覆盖 3058/3137（97.5%）。
      // 详情页的「角色」列此前按配速推断，与设备值仅 73.2% 一致。
      if (Array.isArray(parsed.laps) && parsed.laps.length > 0) {
        const n = db.updateLapFields(id, parsed.laps, ['total_cycles', 'intensity']);
        if (n > 0) lapsUpdated++;
      }

      if ((i + 1) % 20 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`  进度 ${i + 1}/${workList.length} (${elapsed}s)`);
      }
    } catch (e) {
      console.error(`✗ ${id}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n✓ 完成: 回填 ${updated} / 跳过 ${skipped} / 失败 ${failed}` + (dryRun ? ' (dry-run)' : ''));
  console.log(`  逐秒记录重写: ${recordsUpdated} 个活动`);
  console.log(`  lap 划水/计数回填: ${lapsUpdated} 个活动`);
  db.close();
  // 失败项反映到退出码, 供 CI/cron 察觉部分失败 (原实现恒 0)。
  if (failed > 0) process.exitCode = 1;
}

module.exports = { main, FIT_CACHE_DIR };

// 仅 CLI 直跑时执行 (被 require 时不自动运行, 便于单测)
if (require.main === module) {
  main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
