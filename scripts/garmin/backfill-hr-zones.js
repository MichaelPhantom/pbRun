/**
 * backfill-hr-zones.js — 按 app 5 区模型重算 `activities.time_in_hr_zone`。
 *
 * 背景（2026-10-27 修复的口径缺陷）：
 * `activities.time_in_hr_zone` 原先直接存 FIT `time_in_zone` 的原始数组，导致：
 *
 *   1. **覆盖不全**：只有 140/348 条活动有该消息（2026-10 之前的多数文件缺），
 *      而 `activity_records` 的逐秒心率 **348/348 全有**；
 *   2. **跨活动不可聚合**：设备边界随固件/用户设置变化，实测 19 套不同方案
 *      （50/60/70/80/90/100%、52/62/72/82/92%、59/73/82/87/92% of maxHR），
 *      数组索引 2 在一套里是「70–80%」在另一套里是「73–82%」—— 按索引相加
 *      得到的「Z3 占比」没有物理含义；
 *   3. **与 UI/AI 口径冲突**：`/analysis` 的区间表用 app 的 MAX_HR 5 区模型，
 *      `/insight` 的强度分布用设备 7 槽原始数组，同一活动同一时段 Z3 可以
 *      一个是 50%、一个是 4%。
 *
 * 现在统一为：`time_in_hr_zone` = **app 5 区模型 × 逐秒心率推导**（覆盖全部活动、
 * 可按索引跨活动聚合），设备原始数组改存 `device_time_in_hr_zone` 仅供追溯。
 *
 * 流程:
 *   1. 备份 DB → .bak.<timestamp>（可回滚）
 *   2. 确保 device_time_in_hr_zone 列存在（幂等）
 *   3. 先把现有 time_in_hr_zone 迁到 device_time_in_hr_zone（仅当后者为空，
 *      且原数组长度 ≠5 或明显不是本地口径时；幂等）
 *   4. 逐活动读取 activity_records 的逐秒心率 → 按 5 区模型重算 → 覆盖写回
 *
 * 环境变量:
 *   DB_PATH   activities.db 路径
 *   MAX_HR    最大心率（区间边界依据；缺省 190）
 *
 * 用法:
 *   node scripts/garmin/backfill-hr-zones.js
 *   node scripts/garmin/backfill-hr-zones.js --dry-run
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { hrZoneSecondsFromSamples, resolveMaxHr } = require('../common/hr-zones');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'app', 'data', 'activities.db');

function log(msg) {
  console.log(`[backfill-hr-zones] ${msg}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB 不存在: ${DB_PATH}`);
    process.exit(1);
  }

  if (!dryRun) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bakPath = `${DB_PATH}.bak.${ts}`;
    fs.copyFileSync(DB_PATH, bakPath);
    log(`已备份 DB → ${bakPath}`);
  } else {
    log('dry-run: 不写库、不备份');
  }

  const db = dryRun ? new Database(DB_PATH, { readonly: true }) : new Database(DB_PATH);
  const maxHr = resolveMaxHr();
  log(`MAX_HR=${maxHr}（区间边界 Z1<${Math.round(maxHr * 0.7)} / Z2<${Math.round(maxHr * 0.8)} / Z3<${Math.round(maxHr * 0.87)} / Z4<${Math.round(maxHr * 0.93)} / Z5>=${Math.round(maxHr * 0.93)}）`);

  const cols = db.prepare("SELECT name FROM pragma_table_info('activities')").all().map((r) => r.name);
  let hasDeviceCol = cols.includes('device_time_in_hr_zone');
  // 注意顺序: 迁移必须在重算之前, 且列必须**无条件**先补上 ——
  // 否则重算会覆盖掉原始设备数组而没留档（实测踩过: 首次运行 device 列 0 条,
  // 140 条设备的原始区间数据被直接盖成 5 区推导值）。
  if (!hasDeviceCol && !dryRun) {
    db.exec('ALTER TABLE activities ADD COLUMN device_time_in_hr_zone TEXT');
    hasDeviceCol = true; // 关键: ALTER 后必须更新标志, 否则下面的迁移会被跳过
    log('已添加 activities.device_time_in_hr_zone 列');
  } else if (!hasDeviceCol) {
    log('device_time_in_hr_zone 列不存在（dry-run 不迁移）');
  }

  const deviceColExpr = hasDeviceCol ? 'device_time_in_hr_zone' : 'NULL AS device_time_in_hr_zone';
  const activities = db.prepare(
    `SELECT activity_id, time_in_hr_zone, ${deviceColExpr}, moving_time, duration FROM activities ORDER BY start_time`,
  ).all();

  // 1) 迁移：把「明显不是本地 5 区口径」的旧数组搬到 device_time_in_hr_zone。
  //    本地口径的标志是长度恰为 5 且无 null；设备原始常见长度 6/7（含 Z6/Z7）。
  let migrated = 0;
  if (!dryRun && hasDeviceCol) {
    const migrateStmt = db.prepare(
      'UPDATE activities SET device_time_in_hr_zone = ?, time_in_hr_zone = NULL WHERE activity_id = ?',
    );
    for (const a of activities) {
      if (!a.time_in_hr_zone || a.device_time_in_hr_zone) continue;
      let arr;
      try {
        arr = JSON.parse(a.time_in_hr_zone);
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      // 长度 5 且无 null 视为已是本地口径（上一轮回填过），保留不迁
      const looksLocal = arr.length === 5 && arr.every((v) => v != null);
      if (!looksLocal) {
        migrateStmt.run(a.time_in_hr_zone, a.activity_id);
        migrated++;
      }
    }
    log(`旧设备数组迁入 device_time_in_hr_zone: ${migrated} 条`);
  }

  // 2) 逐活动按逐秒心率重算 5 区秒数
  const samplesStmt = db.prepare(
    'SELECT elapsed_sec, heart_rate FROM activity_records WHERE activity_id = ? AND heart_rate IS NOT NULL ORDER BY elapsed_sec',
  );
  const updateStmt = db.prepare('UPDATE activities SET time_in_hr_zone = ? WHERE activity_id = ?');

  let written = 0;
  let noHr = 0;
  let mismatched = 0;
  const mismatchSamples = [];

  const runAll = db.transaction(() => {
    for (const a of activities) {
      const rows = samplesStmt.all(a.activity_id);
      if (rows.length < 2) {
        noHr++;
        continue;
      }
      const secs = hrZoneSecondsFromSamples(
        rows.map((r) => ({ elapsedSec: Number(r.elapsed_sec), heartRate: Number(r.heart_rate) })),
        maxHr,
      );
      if (!secs.some((v) => v > 0)) {
        noHr++;
        continue;
      }
      const expected = a.moving_time || a.duration || 0;
      const derived = secs.reduce((s, v) => s + v, 0);
      if (expected > 0) {
        const ratio = derived / expected;
        if (ratio < 0.9 || ratio > 1.1) {
          mismatched++;
          if (mismatchSamples.length < 5) {
            mismatchSamples.push({ id: a.activity_id, derived, expected, ratio: ratio.toFixed(2) });
          }
        }
      }
      if (!dryRun) updateStmt.run(JSON.stringify(secs), a.activity_id);
      written++;
    }
  });
  runAll();

  db.close();
  log(
    `完成: 重算=${written}, 无心率=${noHr}, 秒数/时长偏离>10%=${mismatched}` +
      `${dryRun ? ' (dry-run)' : ''}`,
  );
  if (mismatchSamples.length > 0) {
    log(`偏离样例: ${JSON.stringify(mismatchSamples)}`);
  }
}

module.exports = { main, log };

if (require.main === module) {
  main().catch((e) => {
    console.error('致命错误:', e);
    process.exit(1);
  });
}
