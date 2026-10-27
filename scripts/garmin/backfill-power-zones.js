/**
 * backfill-power-zones.js — 按 app 5 区 %FTP 模型重算 `activities.time_in_power_zone`。
 *
 * 背景（与 `backfill-hr-zones.js` 同构的口径缺陷）：
 * `activities.time_in_power_zone` 原先直接存 FIT `time_in_zone` 的原始数组，导致：
 *
 *   1. **覆盖不全**：只有 **33/348** 条活动有该消息，而 `activity_records.power`
 *      的逐秒功率在 **241/241** 条跑步活动里全有；
 *   2. **跨活动不可聚合**：设备数组存**绝对瓦数**上限，随 FTP 变化 —— 实测
 *      16 套方案（`[218,267,307,338,390,…]` 与 `[229,282,318,353,406,…]`）。
 *      按索引相加得到的「Z3 秒数」没有物理含义。归一成 %FTP 后 241/241 只有
 *      一套方案 65/80/90/100/115；
 *   3. **与 UI/AI 口径冲突**：区间占比图若直接用设备数组，同一活动同一时段
 *      的「Z3 占比」会随 FTP 设置漂移。
 *
 * 现在统一为：`time_in_power_zone` = **app 5 区 %FTP 模型 × 逐秒功率推导**
 * （覆盖 241/241 有功率的活动、可按索引跨活动聚合），设备原始数组改存
 * `device_time_in_power_zone` 仅供追溯。
 *
 * 流程:
 *   1. 备份 DB → .bak.<timestamp>（可回滚）
 *   2. 确保 device_time_in_power_zone 列存在（幂等）
 *   3. 把现有 time_in_power_zone 迁到 device_time_in_power_zone（仅当后者为空、
 *      且原数组明显不是本地口径时；幂等）
 *   4. 逐活动读取 activity_records 的逐秒功率 + FTP（显式优先, 回退区间边界）
 *      → 按 5 区模型重算 → 覆盖写回
 *
 * 环境变量:
 *   DB_PATH   activities.db 路径
 *
 * 用法:
 *   node scripts/garmin/backfill-power-zones.js
 *   node scripts/garmin/backfill-power-zones.js --dry-run
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { powerZoneSecondsFromSamples, resolveFtp } = require('../common/power-zones');
const { effectiveTimeSec } = require('../common/pace');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'app', 'data', 'activities.db');

/** 本地口径的标志：长度恰为 5 且无 null。 */
const LOCAL_ZONE_LENGTH = 5;

function log(msg) {
  console.log(`[backfill-power-zones] ${msg}`);
}

/**
 * 判断一个区间数组是否「已经是本地 5 区口径」。
 *
 * 只看长度不够 —— 设备数组也可能恰好被裁到 5 槽（实测尾部 null 已被
 * `_extractZoneBounds` 去掉）。故同时要求：长度为 5、无 null、且各槽是秒数
 * （非负数字）。
 */
function looksLocalZoneArray(arr) {
  return (
    Array.isArray(arr) &&
    arr.length === LOCAL_ZONE_LENGTH &&
    arr.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
  );
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

  const cols = db.prepare("SELECT name FROM pragma_table_info('activities')").all().map((r) => r.name);
  let hasDeviceCol = cols.includes('device_time_in_power_zone');
  // 顺序关键: 迁移必须在重算之前, 且列必须**无条件**先补上 ——
  // 否则重算会覆盖掉原始设备数组而没留档（心率回填时踩过这个坑）。
  if (!hasDeviceCol && !dryRun) {
    db.exec('ALTER TABLE activities ADD COLUMN device_time_in_power_zone TEXT');
    hasDeviceCol = true;
    log('已添加 activities.device_time_in_power_zone 列');
  } else if (!hasDeviceCol) {
    log('device_time_in_power_zone 列不存在（dry-run 不迁移）');
  }

  const deviceColExpr = hasDeviceCol ? 'device_time_in_power_zone' : 'NULL AS device_time_in_power_zone';
  const activities = db.prepare(
    `SELECT activity_id, time_in_power_zone, ${deviceColExpr}, power_zone_boundaries,
            functional_threshold_power, moving_time, duration
     FROM activities ORDER BY start_time`,
  ).all();

  // 1) 迁移：把「明显不是本地 5 区口径」的旧数组搬到 device_time_in_power_zone。
  let migrated = 0;
  if (!dryRun && hasDeviceCol) {
    const migrateStmt = db.prepare(
      'UPDATE activities SET device_time_in_power_zone = ?, time_in_power_zone = NULL WHERE activity_id = ?',
    );
    for (const a of activities) {
      if (!a.time_in_power_zone || a.device_time_in_power_zone) continue;
      let arr;
      try {
        arr = JSON.parse(a.time_in_power_zone);
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      if (!looksLocalZoneArray(arr)) {
        migrateStmt.run(a.time_in_power_zone, a.activity_id);
        migrated++;
      }
    }
    log(`旧设备数组迁入 device_time_in_power_zone: ${migrated} 条`);
  }

  // 2) 逐活动按逐秒功率重算 5 区秒数
  const samplesStmt = db.prepare(
    'SELECT elapsed_sec, power FROM activity_records WHERE activity_id = ? AND power IS NOT NULL ORDER BY elapsed_sec',
  );
  const updateStmt = db.prepare('UPDATE activities SET time_in_power_zone = ? WHERE activity_id = ?');

  let written = 0;
  let noPower = 0;
  let noFtp = 0;
  let mismatched = 0;
  const mismatchSamples = [];

  const runAll = db.transaction(() => {
    for (const a of activities) {
      const ftp = resolveFtp(a);
      if (!ftp) {
        noFtp++;
        continue;
      }
      const rows = samplesStmt.all(a.activity_id);
      if (rows.length < 2) {
        noPower++;
        continue;
      }
      const secs = powerZoneSecondsFromSamples(
        rows.map((r) => ({ elapsedSec: Number(r.elapsed_sec), power: Number(r.power) })),
        ftp.watts,
      );
      if (!secs.some((v) => v > 0)) {
        noPower++;
        continue;
      }
      const expected = effectiveTimeSec(a) ?? 0;
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
    `完成: 重算=${written}, 无功率=${noPower}, 无FTP=${noFtp}, 秒数/时长偏离>10%=${mismatched}` +
      `${dryRun ? ' (dry-run)' : ''}`,
  );
  if (mismatchSamples.length > 0) {
    log(`偏离样例: ${JSON.stringify(mismatchSamples)}`);
  }
}

module.exports = { main, log, looksLocalZoneArray };

if (require.main === module) {
  main().catch((e) => {
    console.error('致命错误:', e);
    process.exit(1);
  });
}
