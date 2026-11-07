#!/usr/bin/env node
/**
 * 回填**力量训练**的 `training_load`（2026-11-07）。
 *
 * ## 为什么需要
 *
 * `sync.js` 的 `calculateTrainingLoad` 派生分支历史上只对跑步三类型开放
 * （`runnableTypes2 = ['running', 'treadmill_running', 'track_running']`），于是
 * 生产库 51 条 `strength_training` 的 `training_load` **全部为 NULL** —— 每周
 * 2 次力量课对 ACWR/CTL/TSB 的贡献恒为 0。这是教练视角的盲区：身体不区分
 * 负荷来源，力量训练同样消耗恢复预算。
 *
 * 本脚本按 `app/lib/strength.ts` 的口径（按训练效应加权，非跑步的 HR-TRIMP）
 * 回填历史数据。**幂等**：只处理 `training_load IS NULL` 的行，已回填的不重写。
 *
 * ## 口径边界
 *
 * - 只处理 `activity_type = 'strength_training'`；其它非跑步类型（篮球/游泳等）
 *   暂不接入（它们的负荷模型未论证，不臆造）。
 * - 时间基数 = 计时器时间优先（`moving_time` → `duration`），与配速/TSS 同一纪律。
 * - 量纲与库内跑步 `training_load` 一致，**不是** Garmin 官方 `training_load_peak`。
 *
 * ## 用法
 *
 *   node scripts/garmin/backfill-strength-load.js --dry-run   # 预览，不写库
 *   node scripts/garmin/backfill-strength-load.js             # 实际回填
 *   node scripts/garmin/backfill-strength-load.js --limit 10  # 只处理前 10 条
 */
require('dotenv').config();
const DatabaseManager = require('../common/db-manager');
const { calculateStrengthLoad } = require('../common/strength-load');

/** 安全解析 CLI 整数参数；缺失/非法返回 null。 */
function parseLimit(args) {
  const idx = args.indexOf('--limit');
  if (idx === -1) return null;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limit = parseLimit(args);

  const db = new DatabaseManager('app/data/activities.db');

  const rows = db.db
    .prepare(
      `SELECT activity_id, name, duration, moving_time, average_heart_rate,
              total_training_effect, total_anaerobic_training_effect, training_load
       FROM activities
       WHERE activity_type = 'strength_training'
         AND training_load IS NULL
       ORDER BY start_time DESC`
    )
    .all();

  console.log(`力量训练待回填 (training_load IS NULL): ${rows.length} 条`);
  if (rows.length === 0) {
    console.log('✓ 无需回填');
    db.close();
    return;
  }

  const target = limit ? rows.slice(0, limit) : rows;
  let written = 0;
  let skipped = 0;
  const samples = [];

  for (const r of target) {
    const load = calculateStrengthLoad(r);
    if (load <= 0) {
      // 时长缺失的力量课无法估算负荷 —— 保持 NULL（不写 0，0 会被 ACWR 当成
      // 「做了但无负荷」，语义上比「未知」更糟）
      skipped += 1;
      continue;
    }
    if (samples.length < 5) {
      samples.push({
        id: r.activity_id,
        name: r.name,
        duration: r.moving_time ?? r.duration,
        hr: r.average_heart_rate,
        te: r.total_training_effect,
        load,
      });
    }
    if (!dryRun) {
      db.updateActivityFields(r.activity_id, { training_load: load });
    }
    written += 1;
  }

  console.log(`${dryRun ? '[DRY-RUN] 将' : '已'}写入 ${written} 条, 跳过(时长缺失) ${skipped} 条`);
  console.log('样本 (前 5 条):');
  for (const s of samples) {
    console.log(
      `  #${s.id} ${s.name ?? '(无名)'} ${s.duration}s HR ${s.hr ?? '-'} TE ${s.te ?? '-'} → load ${s.load}`
    );
  }

  if (!dryRun) {
    const remain = db.db
      .prepare(
        `SELECT COUNT(*) AS n FROM activities
         WHERE activity_type = 'strength_training' AND training_load IS NULL`
      )
      .get();
    console.log(`回填后仍为 NULL: ${remain.n} 条 (应为时长缺失的少数)`);
  }
  db.close();
}

main();
