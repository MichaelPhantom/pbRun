/**
 * backfill-record-temperature.js — 回填历史逐秒温度 (activity_records.temperature)。
 *
 * 背景: 逐秒温度是后加字段; 旧记录只有心率/步频/海拔等。FIT 缓存里仍有原始温度,
 * 可离线回填, 无需重新鉴权拉取。
 *
 * 流程:
 *   1. 备份 DB → .bak.<timestamp> (可回滚)
 *   2. 确保 activity_records.temperature 列存在 (幂等)
 *   3. 逐活动解析 .cache/fit/{activity_id} → 按 record_index 更新温度
 *   4. 只更新 temperature IS NULL 的行 (幂等; 不覆盖已有值)
 *
 * 环境变量:
 *   DB_PATH          activities.db 路径
 *   FIT_CACHE_DIR    FIT 缓存目录 (默认 <cwd>/.cache/fit)
 *
 * 用法:
 *   node scripts/garmin/backfill-record-temperature.js
 *   node scripts/garmin/backfill-record-temperature.js --dry-run
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const GarminFITParser = require('./fit-parser');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'app', 'data', 'activities.db');
const FIT_CACHE_DIR = process.env.FIT_CACHE_DIR || path.join(process.cwd(), '.cache', 'fit');

function log(msg) { console.log(`[backfill-temp] ${msg}`); }

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!fs.existsSync(DB_PATH)) { console.error(`DB 不存在: ${DB_PATH}`); process.exit(1); }
  if (!fs.existsSync(FIT_CACHE_DIR)) { console.error(`FIT 缓存目录不存在: ${FIT_CACHE_DIR}`); process.exit(1); }

  if (!dryRun) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bakPath = `${DB_PATH}.bak.${ts}`;
    fs.copyFileSync(DB_PATH, bakPath);
    log(`已备份 DB → ${bakPath}`);
  } else {
    log('dry-run: 不写库、不备份');
  }

  const db = dryRun ? new Database(DB_PATH, { readonly: true }) : new Database(DB_PATH);
  const parser = new GarminFITParser();

  const cols = db.prepare("SELECT name FROM pragma_table_info('activity_records')").all().map(r => r.name);
  if (!cols.includes('temperature')) {
    if (dryRun) {
      log('activity_records 缺 temperature 列 (dry-run 不迁移)');
    } else {
      db.exec('ALTER TABLE activity_records ADD COLUMN temperature REAL');
      log('已添加 activity_records.temperature 列');
    }
  } else {
    log('temperature 列已存在, 跳过迁移');
  }

  const rows = db.prepare('SELECT activity_id, name, start_time_local FROM activities ORDER BY start_time DESC').all();
  let updateMany = null;
  const canUpdate = !dryRun || cols.includes('temperature');
  if (canUpdate) {
    const updateStmt = db.prepare(
      'UPDATE activity_records SET temperature = ? WHERE activity_id = ? AND record_index = ? AND temperature IS NULL'
    );
    updateMany = db.transaction((records, activityId) => {
      let changed = 0;
      for (const r of records) {
        if (r.temperature == null || !Number.isFinite(Number(r.temperature))) continue;
        changed += updateStmt.run(Number(r.temperature), activityId, r.record_index).changes;
      }
      return changed;
    });
  }

  let activities = 0;
  let updatedRows = 0;
  let noTemp = 0;
  let noCache = 0;
  let errors = 0;

  for (const row of rows) {
    const cachePath = path.join(FIT_CACHE_DIR, String(row.activity_id));
    if (!fs.existsSync(cachePath)) { noCache++; continue; }
    try {
      const { records } = await parser.parseFitFile(cachePath);
      const withTemp = (records || []).filter(
        (r) => r.temperature != null && Number.isFinite(Number(r.temperature))
      );
      if (withTemp.length === 0) { noTemp++; continue; }
      activities += 1;
      if (!dryRun && updateMany) updatedRows += updateMany(withTemp, row.activity_id);
      else updatedRows += withTemp.length;
    } catch (e) {
      errors++;
      console.error(`  ✗ activity ${row.activity_id} (${row.name}): ${e.message}`);
    }
  }

  db.close();
  log(
    `完成: 活动=${activities}, 温度记录=${updatedRows}, 无温度=${noTemp}, ` +
      `无缓存=${noCache}, 错误=${errors}${dryRun ? ' (dry-run)' : ''}`
  );
}

module.exports = { main, log };

if (require.main === module) {
  main().catch((e) => { console.error('致命错误:', e); process.exit(1); });
}
