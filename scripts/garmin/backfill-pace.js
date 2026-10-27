#!/usr/bin/env node
/**
 * backfill-pace.js — 按**计时器时间**重算 `average_pace` / `average_speed`。
 *
 * ## 背景（2026-10-27 审计）
 *
 * `average_pace` / `average_speed` 一直由 `duration` 推导，而 `duration` 存的是
 * FIT `total_elapsed_time`（**含暂停**）。于是同一个活动卡片会自相矛盾：
 *
 * | 活动 | 距离 | 卡片「时长」(`moving_time`) | 卡片「平均配速」 | 配速×距离 |
 * |------|------|------------------------------|------------------|-----------|
 * | `582132079` | 6.63 km | 43.7 分 | **26:19/km** | 174.4 分 |
 * | `632595826` | 7.17 km | 45.8 分 | **11:17/km** | 80.8 分 |
 * | `621669611` | 5.24 km | 35.5 分 | **9:14/km** | 48.4 分 |
 * | `598287817` | 6.10 km | 45.8 分 | **9:07/km** | 55.6 分 |
 *
 * 真实库 251 条有配速的活动里，`average_pace` **251/251 严格等于
 * `duration/distance`**，只有 158 条同时等于 `moving_time/distance`。
 * lap 级同理：3082 个 lap 里 `average_pace` **2972/2972** 等于经过时间口径，
 * 而 `average_moving_pace` **2972/2972** 等于计时器口径 —— 后者才是对的，
 * 却从未被 UI 消费。
 *
 * 设备自己算的 `enhanced_avg_speed` 也是计时器口径：251 条活动里 **248 条**
 * 与 `distance/moving_time` 偏差 <2%（另 3 条是游泳，设备按划水时段加权）。
 * Strava / Garmin Connect 展示的配速同样是计时器口径。
 *
 * 所以这不是「两种口径都行」，是我们**读错了自己存的列**。
 *
 * ## 为什么不用读 FIT
 *
 * `moving_time` 与 `duration` 都已在库里（活动 348/348、lap 3080/3082 有值）。
 * 本脚本是纯 DB 重算，不依赖 `.cache/fit` —— 回填在只有 DB 的机器上也能跑。
 *
 * ## 口径
 *
 * 唯一实现是 `scripts/common/pace.js`（镜像 `app/lib/pace.ts`），与
 * `fit-parser` 的写入路径、`validate-data` 的校验路径完全同一份代码。
 *
 * ## 特性
 *
 *   - **幂等**：只在值实际变化时写库；重复运行无副作用。
 *   - **可干跑**：`--dry-run` 只打印将变更的条目。
 *   - **可限量**：`--limit N`。
 *   - **失败可见**：任一条失败 → 退出码 1。
 *
 * ## 用法
 *
 *   node scripts/garmin/backfill-pace.js [--dry-run] [--limit N] [--db PATH]
 */

const path = require('path');
const DatabaseManager = require('../common/db-manager');
const { effectiveTimeSec, paceSecPerKm, speedKmh } = require('../common/pace');

const DEFAULT_DB = path.join(process.cwd(), 'app', 'data', 'activities.db');

/** 浮点比较容差：秒/公里与 km/h 都保留到小数点后 6 位。 */
const EPSILON = 1e-6;

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { dryRun: false, limit: null, db: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--db') args.db = argv[++i];
  }
  return args;
}

/** 两个可空数字是否「实质相等」（都 null 也算相等）。 */
function sameValue(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= EPSILON;
}

/**
 * 重算一张表的配速/速度列。
 *
 * @param {object} db          DatabaseManager 实例
 * @param {string} table       'activities' | 'activity_laps'
 * @param {string} distanceCol 距离列名（activities 为公里、activity_laps 为米）
 * @param {(v:number)=>number|null} toKm 距离转公里
 * @param {object} opts        { dryRun, limit }
 */
function backfillTable(db, table, distanceCol, toKm, opts) {
  const rows = db.db
    .prepare(
      `SELECT rowid AS rid, ${distanceCol} AS distance, duration, moving_time,
              average_pace, average_speed
         FROM ${table}
        ${opts.limit ? `LIMIT ${opts.limit}` : ''}`
    )
    .all();

  const updates = [];
  let skippedNoTime = 0;
  let skippedNoDistance = 0;

  for (const row of rows) {
    const distanceKm = row.distance == null ? null : toKm(row.distance);
    const seconds = effectiveTimeSec(row);
    const pace = paceSecPerKm(distanceKm, seconds);
    const speed = speedKmh(distanceKm, seconds);

    if (pace == null) {
      // 区分两种「算不出来」：没有可信时间 / 没有距离。
      // 两者都**不写 0**，也不把旧值抹成 NULL —— 旧值可能仍是唯一线索。
      if (seconds == null) skippedNoTime++;
      else skippedNoDistance++;
      continue;
    }
    if (sameValue(row.average_pace, pace) && sameValue(row.average_speed, speed)) continue;
    updates.push({ rid: row.rid, pace, speed, before: row.average_pace });
  }

  if (!opts.dryRun && updates.length > 0) {
    const stmt = db.db.prepare(
      `UPDATE ${table} SET average_pace = ?, average_speed = ? WHERE rowid = ?`
    );
    const run = db.db.transaction((items) => {
      for (const u of items) stmt.run(u.pace, u.speed, u.rid);
    });
    run(updates);
  }

  return { total: rows.length, changed: updates.length, skippedNoTime, skippedNoDistance, updates };
}

/** 主流程。返回 `{ ok, tables }`，供测试断言。 */
function backfillPace(opts = {}) {
  const db = opts.db instanceof DatabaseManager ? opts.db : new DatabaseManager(opts.dbPath || DEFAULT_DB);
  const ownDb = !(opts.db instanceof DatabaseManager);

  try {
    // activities.distance 是**公里**；activity_laps.distance 是**米**。
    // 这个单位差是库内既有契约（见 db-manager 的 schema 注释），换算只在这里做一次。
    const activities = backfillTable(db, 'activities', 'distance', (km) => km, opts);
    const laps = backfillTable(db, 'activity_laps', 'distance', (m) => m / 1000, opts);

    return {
      ok: true,
      tables: { activities, activity_laps: laps },
    };
  } finally {
    if (ownDb) db.close();
  }
}

/** CLI 入口。 */
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const dbPath = args.db || DEFAULT_DB;

  console.log(`回填配速/速度（时间基数 = 计时器时间 moving_time）`);
  console.log(`数据库: ${path.resolve(dbPath)}`);
  if (args.dryRun) console.log('模式: DRY-RUN（不写库）');

  let result;
  try {
    result = backfillPace({ dbPath, dryRun: args.dryRun, limit: args.limit });
  } catch (e) {
    console.error(`回填失败: ${e.message}`);
    return 1;
  }

  for (const [table, s] of Object.entries(result.tables)) {
    console.log(
      `\n${table}: ${s.total} 行，变更 ${s.changed} 行` +
        (s.skippedNoTime ? `，跳过 ${s.skippedNoTime} 行（无可信时间）` : '') +
        (s.skippedNoDistance ? `，跳过 ${s.skippedNoDistance} 行（无距离）` : '')
    );
    if (args.dryRun) {
      for (const u of s.updates.slice(0, 20)) {
        console.log(`  rowid=${u.rid}  ${u.before == null ? 'NULL' : u.before.toFixed(1)} → ${u.pace.toFixed(1)} s/km`);
      }
      if (s.updates.length > 20) console.log(`  ... 另 ${s.updates.length - 20} 行`);
    }
  }
  return 0;
}

module.exports = { backfillPace, backfillTable, parseArgs, sameValue, main, EPSILON, DEFAULT_DB };

if (require.main === module) {
  // 退出码必须在 try/catch **之外** 计算并返回 —— 否则异常路径会静默返回 0。
  process.exit(main());
}
