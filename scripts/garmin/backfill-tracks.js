#!/usr/bin/env node
/**
 * backfill-tracks.js — 一次性回填活动路线轨迹 (track 列)。
 *
 * 数据源: .cache/fit/{activity_id} (每日同步缓存的原始 FIT, 无需重新鉴权拉取)。
 * 流程:
 *   1. 备份 activities.db → .bak.<timestamp> (可回滚)
 *   2. ALTER TABLE activities ADD COLUMN track TEXT (若不存在; 幂等)
 *   3. 逐活动解析缓存 FIT → 提取降采样轨迹 (fit-parser._extractTrack)
 *   4. UPDATE activities SET track=? WHERE activity_id=? (仅写 track 列, 不动其他字段)
 *
 * 幂等: 可重复运行 (覆盖同值); 无 GPS 活动写 NULL (室内/跑步机, 详情页不渲染地图)。
 * 不依赖 Garmin API/凭证 — 纯本地缓存解析。
 */
require('dotenv').config();
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');
const GarminFITParser = require('./fit-parser');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'app', 'data', 'activities.db');
const FIT_CACHE_DIR = path.join(process.cwd(), '.cache', 'fit');

function log(msg) { console.log(`[backfill-tracks] ${msg}`); }

async function main() {
  if (!fs.existsSync(DB_PATH)) { console.error(`DB 不存在: ${DB_PATH}`); process.exit(1); }
  if (!fs.existsSync(FIT_CACHE_DIR)) { console.error(`FIT 缓存目录不存在: ${FIT_CACHE_DIR}`); process.exit(1); }

  // 1. 备份
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bakPath = `${DB_PATH}.bak.${ts}`;
  fs.copyFileSync(DB_PATH, bakPath);
  log(`已备份 DB → ${bakPath}`);

  const db = new Database(DB_PATH);
  const parser = new GarminFITParser();

  // 2. 迁移: 加 track 列 (幂等)
  const cols = db.prepare("SELECT name FROM pragma_table_info('activities')").all().map(r => r.name);
  if (!cols.includes('track')) {
    db.exec('ALTER TABLE activities ADD COLUMN track TEXT');
    log('已添加 track 列');
  } else {
    log('track 列已存在, 跳过迁移');
  }

  // 3. 取所有 activity_id (数值, 与缓存文件名对应)
  const rows = db.prepare('SELECT activity_id, name, start_time_local FROM activities ORDER BY start_time DESC').all();
  log(`DB 共 ${rows.length} 条活动, 缓存 FIT 文件 ${fs.readdirSync(FIT_CACHE_DIR).length} 个`);

  let updated = 0, noGps = 0, noCache = 0, errors = 0;
  const updateStmt = db.prepare('UPDATE activities SET track = ? WHERE activity_id = ?');

  for (const row of rows) {
    const cachePath = path.join(FIT_CACHE_DIR, String(row.activity_id));
    if (!fs.existsSync(cachePath)) { noCache++; continue; }
    try {
      const { activity } = await parser.parseFitFile(cachePath);
      if (!activity) { errors++; continue; }
      updateStmt.run(activity.track ?? null, row.activity_id);
      if (activity.track) updated++; else noGps++;
    } catch (e) {
      errors++;
      console.error(`  ✗ activity ${row.activity_id} (${row.name}): ${e.message}`);
    }
  }

  db.close();
  log(`完成: 回填轨迹=${updated}, 无GPS=${noGps}, 无缓存=${noCache}, 错误=${errors}`);
  log(`回滚: cp "${bakPath}" "${DB_PATH}"`);
}

main().catch(e => { console.error('致命错误:', e); process.exit(1); });
