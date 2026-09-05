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
        'workout_name', 'workout_steps', 'hrv_rmssd',
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
  db.close();
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
