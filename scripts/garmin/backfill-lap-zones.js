/**
 * backfill-lap-zones.js — 按 app 5 区模型重算 `activity_laps.time_in_hr_zone` /
 * `time_in_power_zone`。
 *
 * ## 背景（2026-10-27）
 *
 * lap 级统一列 `activity_laps.time_in_hr_zone` / `time_in_power_zone` 在真实库里
 * **0/3082 全为 NULL**。原因不是「设备不写就没法算」：
 *
 *   1. 设备确实不写 lap 级区间数组（实测 3082/3082 lap、348/348 session 全空）；
 *   2. 但**逐秒记录 + lap 的 `cumulative_time`（3082/3082 有值）足够推导**。
 *
 * 同步侧已由 `fit-parser._assignLapZoneSeconds` 接上（新同步的 lap 自动带值），
 * 但历史 3082 个 lap 仍是空的 —— 本脚本回填它们。
 *
 * ## 口径
 *
 * 与活动级**完全同一套**：
 *   - 心率 = `hrZoneSecondsFromRecords`（Z1<70%/Z2<80%/Z3<87%/Z4<93%/Z5≥93% MAX_HR）
 *   - 功率 = `powerZoneSecondsFromRecords`（Z1<65/Z2<80/Z3<90/Z4<100/Z5≥100 %FTP）
 *   - 长度恒为 5，可按索引跨 lap 聚合
 *   - 窗口 = `[cumulative[i-1], cumulative[i])` 半开区间（见 `scripts/common/lap-zones.js`）
 *
 * 窗口逻辑**不在本脚本里实现** —— 复用 `scripts/common/lap-zones.js`，与解析器
 * 共享同一份纯函数。两份实现漂移会让「同步写入的 lap」与「回填写入的 lap」不可
 * 加总，且不会报错。
 *
 * ## 流程
 *
 *   1. 备份 DB → `.bak.<timestamp>`（可回滚）
 *   2. 幂等确保 `activity_laps` 的 4 个 `device_*` 列存在（与 db-manager 的
 *      `newLapColumns` 同一集合；生产库可能仍是旧 schema）
 *   3. 把「明显不是本地 5 区口径」的旧 `time_in_hr_zone` / `time_in_power_zone`
 *      迁到对应 `device_*` 列留档（幂等；已有 device 值的不动）
 *   4. 逐活动读 `activity_records` + 该活动 FTP → 按 lap 时间窗推导 → 写回
 *
 * ## 为什么回填是「覆盖写」而不是「只补 NULL」
 *
 * 若上一轮推导用的是错的窗口语义（例如按 `start_time` 而非 `cumulative_time`），
 * 那些值看起来合法但不可加总。本脚本用当前唯一口径**全量重算**，保证库内所有
 * lap 行来自同一实现。
 *
 * 环境变量:
 *   DB_PATH   activities.db 路径
 *   MAX_HR    最大心率（区间边界依据；缺省 190）
 *
 * 用法:
 *   node scripts/garmin/backfill-lap-zones.js
 *   node scripts/garmin/backfill-lap-zones.js --dry-run
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveMaxHr } = require('../common/hr-zones');
const { resolveFtp } = require('../common/power-zones');
const { deriveLapZoneSeconds, looksLocalZoneArray } = require('../common/lap-zones');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'app', 'data', 'activities.db');

/** `activity_laps` 上仅追溯用的设备原始区间列（必须与 db-manager 一致）。 */
const LAP_DEVICE_ZONE_COLUMNS = [
  ['device_time_in_hr_zone', 'TEXT'],
  ['device_time_in_power_zone', 'TEXT'],
  ['device_time_in_speed_zone', 'TEXT'],
  ['device_time_in_cadence_zone', 'TEXT'],
];

function log(msg) {
  console.log(`[backfill-lap-zones] ${msg}`);
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
  log(
    `MAX_HR=${maxHr}（心率 Z1<${Math.round(maxHr * 0.7)} / Z2<${Math.round(maxHr * 0.8)} / ` +
      `Z3<${Math.round(maxHr * 0.87)} / Z4<${Math.round(maxHr * 0.93)} / Z5>=${Math.round(maxHr * 0.93)}）`,
  );

  const lapCols = db
    .prepare("SELECT name FROM pragma_table_info('activity_laps')")
    .all()
    .map((r) => r.name);
  const hasLapTable = lapCols.length > 0;
  if (!hasLapTable) {
    log('activity_laps 表不存在, 无需回填');
    db.close();
    return;
  }

  // 幂等补列：生产库可能仍是旧 schema（42 列, 无 device_*）。
  // 顺序关键（心率回填踩过的坑）: 迁移必须在重算之前, 且列必须**无条件**先补上 ——
  // 否则重算会把旧设备数组直接盖成推导值, 原始数据永久丢失。
  for (const [name, type] of LAP_DEVICE_ZONE_COLUMNS) {
    if (lapCols.includes(name)) continue;
    if (dryRun) {
      log(`${name} 列不存在（dry-run 不迁移）`);
      continue;
    }
    db.exec(`ALTER TABLE activity_laps ADD COLUMN ${name} ${type}`);
    lapCols.push(name);
    log(`已添加 activity_laps.${name} 列`);
  }

  const has = (c) => lapCols.includes(c);
  const hrDeviceExpr = has('device_time_in_hr_zone')
    ? 'device_time_in_hr_zone'
    : 'NULL AS device_time_in_hr_zone';
  const powerDeviceExpr = has('device_time_in_power_zone')
    ? 'device_time_in_power_zone'
    : 'NULL AS device_time_in_power_zone';

  // 1) 迁移：把「明显不是本地 5 区口径」的旧数组搬到 device_* 留档。
  //    本地口径标志 = 长度恰为 5 且各槽非负有限数字（设备数组常见 6/7/8 槽）。
  let migratedHr = 0;
  let migratedPower = 0;
  if (!dryRun && has('device_time_in_hr_zone')) {
    const laps = db
      .prepare(
        `SELECT id, time_in_hr_zone, ${hrDeviceExpr} FROM activity_laps
         WHERE time_in_hr_zone IS NOT NULL ORDER BY activity_id, lap_index`,
      )
      .all();
    const stmt = db.prepare(
      'UPDATE activity_laps SET device_time_in_hr_zone = ?, time_in_hr_zone = NULL WHERE id = ?',
    );
    for (const l of laps) {
      if (!l.time_in_hr_zone || l.device_time_in_hr_zone) continue;
      let arr;
      try {
        arr = JSON.parse(l.time_in_hr_zone);
      } catch {
        continue; // 损坏 JSON: 无法确认口径, 不猜
      }
      if (!looksLocalZoneArray(arr)) {
        stmt.run(l.time_in_hr_zone, l.id);
        migratedHr++;
      }
    }
    log(`旧 lap 心率数组迁入 device_time_in_hr_zone: ${migratedHr} 条`);
  }
  if (!dryRun && has('device_time_in_power_zone')) {
    const laps = db
      .prepare(
        `SELECT id, time_in_power_zone, ${powerDeviceExpr} FROM activity_laps
         WHERE time_in_power_zone IS NOT NULL ORDER BY activity_id, lap_index`,
      )
      .all();
    const stmt = db.prepare(
      'UPDATE activity_laps SET device_time_in_power_zone = ?, time_in_power_zone = NULL WHERE id = ?',
    );
    for (const l of laps) {
      if (!l.time_in_power_zone || l.device_time_in_power_zone) continue;
      let arr;
      try {
        arr = JSON.parse(l.time_in_power_zone);
      } catch {
        continue;
      }
      if (!looksLocalZoneArray(arr)) {
        stmt.run(l.time_in_power_zone, l.id);
        migratedPower++;
      }
    }
    log(`旧 lap 功率数组迁入 device_time_in_power_zone: ${migratedPower} 条`);
  }

  // 2) 逐活动推导。laps 按 lap_index 升序（deriveLapZoneSeconds 依赖顺序身份）。
  const activities = db
    .prepare(
      `SELECT activity_id, power_zone_boundaries, functional_threshold_power, moving_time, duration
       FROM activities ORDER BY start_time`,
    )
    .all();
  const lapsStmt = db.prepare(
    'SELECT id, lap_index, cumulative_time FROM activity_laps WHERE activity_id = ? ORDER BY lap_index',
  );
  const recordsStmt = db.prepare(
    `SELECT elapsed_sec, heart_rate, power FROM activity_records
     WHERE activity_id = ? ORDER BY elapsed_sec`,
  );
  const updateStmt = db.prepare(
    'UPDATE activity_laps SET time_in_hr_zone = ?, time_in_power_zone = ? WHERE id = ?',
  );

  let activitiesWithLaps = 0;
  let lapRows = 0;
  let writtenHr = 0;
  let writtenPower = 0;
  let skippedNoWindow = 0;
  let skippedNoRecords = 0;
  let noFtp = 0;
  let mismatched = 0;
  const mismatchSamples = [];

  const runAll = db.transaction(() => {
    for (const a of activities) {
      const laps = lapsStmt.all(a.activity_id);
      if (laps.length === 0) continue;
      activitiesWithLaps++;
      lapRows += laps.length;

      const records = recordsStmt.all(a.activity_id);
      if (records.length === 0) {
        skippedNoRecords++;
        continue;
      }

      const ftp = resolveFtp(a);
      if (!ftp) noFtp++;

      const derived = deriveLapZoneSeconds(laps, records, {
        maxHr,
        ftpWatts: ftp ? ftp.watts : null,
      });

      // 与活动级对账：各 lap 推导秒数之和应 ≈ 该活动 `moving_time`。
      // 偏差 >10% 说明窗口切分有问题（例如 lap 的 cumulative_time 与实际
      // 记录时长严重错位），只告警不改写。
      let derivedSum = 0;
      for (const d of derived) {
        if (!d || !d.hrZoneJson) continue;
        try {
          derivedSum += JSON.parse(d.hrZoneJson).reduce((s, v) => s + v, 0);
        } catch {
          /* 忽略: 我们刚自己 stringify 的, 不会坏 */
        }
      }
      const expected = a.moving_time || a.duration || 0;
      if (expected > 0 && derivedSum > 0) {
        const ratio = derivedSum / expected;
        if (ratio < 0.9 || ratio > 1.1) {
          mismatched++;
          if (mismatchSamples.length < 5) {
            mismatchSamples.push({
              id: a.activity_id,
              derived: Math.round(derivedSum),
              expected,
              ratio: ratio.toFixed(2),
            });
          }
        }
      }

      for (let i = 0; i < laps.length; i++) {
        const d = derived[i];
        if (!d) {
          // 窗口无法定位（cumulative_time 缺失/倒退/零长）→ **写 NULL**，不是「保留原值」。
          // 与同步路径对齐：解析器对该 lap 也不写列，落库即 NULL。
          // 若这里选择「跳过」，上一轮用错窗口算出的陈旧值会留在库里，
          // 而它看起来完全合法 —— 「全量重算」的承诺就落空了。
          skippedNoWindow++;
          if (!dryRun) updateStmt.run(null, null, laps[i].id);
          continue;
        }
        if (d.hrZoneJson) writtenHr++;
        if (d.powerZoneJson) writtenPower++;
        if (!dryRun) updateStmt.run(d.hrZoneJson, d.powerZoneJson, laps[i].id);
      }
    }
  });
  runAll();

  db.close();
  log(
    `完成: 活动=${activitiesWithLaps}, lap=${lapRows}, 写心率=${writtenHr}, 写功率=${writtenPower}, ` +
      `无时间窗=${skippedNoWindow}, 无记录=${skippedNoRecords}, 无FTP=${noFtp}, ` +
      `各段求和/时长偏离>10%=${mismatched}${dryRun ? ' (dry-run)' : ''}`,
  );
  if (mismatchSamples.length > 0) {
    log(`偏离样例: ${JSON.stringify(mismatchSamples)}`);
  }
}

module.exports = { main, log, LAP_DEVICE_ZONE_COLUMNS };

if (require.main === module) {
  main().catch((e) => {
    console.error('致命错误:', e);
    process.exit(1);
  });
}
