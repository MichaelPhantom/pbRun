#!/usr/bin/env node
/**
 * backfill-route-signatures.js — 由已入库的 track 回填路线签名
 * (route_cells / route_bounds / route_km)。
 *
 * 为什么需要：fit-parser 只对**新同步**的活动写签名；历史活动的 track 早已在库，
 * 但没有签名列 → 跨名称「同路线」聚类会静默漏召回（不报错，只是找不到）。
 *
 * 数据源: activities.track（JSON，{coords,bounds,elev,n}）—— 无需 FIT 缓存、无需鉴权。
 * 口径: scripts/common/route-signature.js（与 app/lib/route-shape.ts 由一致性测试守护）。
 *
 * 流程:
 *   1. 备份 activities.db → .bak.<timestamp>（可回滚）
 *   2. 补齐 route_cells / route_bounds / route_km 列 + idx_activities_route_km（幂等）
 *   3. 逐活动派生签名并 UPDATE（仅写三列，不动 track/其他字段）
 *   4. 校验：签名数量、网格数分布、长度与 activities.distance 的偏差
 *
 * 幂等: 可重复运行（覆盖同值）。--force 时重算已有签名的行（默认只补空缺）。
 *
 * 用法:
 *   node scripts/garmin/backfill-route-signatures.js            # 只补空缺
 *   node scripts/garmin/backfill-route-signatures.js --force    # 全量重算
 *   node scripts/garmin/backfill-route-signatures.js --dry-run  # 只统计不写库
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { deriveRouteSignature } = require('../common/route-signature');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'app', 'data', 'activities.db');

const COLUMNS = [
  ['route_cells', 'TEXT'],
  ['route_bounds', 'TEXT'],
  ['route_km', 'REAL'],
];

function log(msg) { console.log(`[backfill-routes] ${msg}`); }

/**
 * 确保签名列与索引存在（幂等）。
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]} 本次新增的列名
 */
function ensureColumns(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('activities')").all().map((r) => r.name);
  const added = [];
  for (const [name, type] of COLUMNS) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE activities ADD COLUMN ${name} ${type}`);
      added.push(name);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_activities_route_km ON activities(route_km)');
  return added;
}

/**
 * 解析 track 列并派生签名。
 * @param {string|null} trackJson
 * @returns {ReturnType<typeof deriveRouteSignature>}
 */
function signatureOf(trackJson) {
  if (!trackJson) return null;
  let track;
  try {
    track = JSON.parse(trackJson);
  } catch {
    return null;
  }
  if (!track || !Array.isArray(track.coords)) return null;
  return deriveRouteSignature(track);
}

/**
 * 回填主流程。
 * @param {{dbPath?: string, force?: boolean, dryRun?: boolean, backup?: boolean}} [opts]
 * @returns {Promise<{total:number, written:number, skipped:number, noTrack:number,
 *   invalid:number, addedColumns:string[], backupPath:string|null}>}
 */
async function main(opts = {}) {
  const dbPath = opts.dbPath || DB_PATH;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;
  if (!fs.existsSync(dbPath)) throw new Error(`DB 不存在: ${dbPath}`);

  let backupPath = null;
  if (!dryRun && opts.backup !== false) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backupPath = `${dbPath}.bak.${ts}`;
    fs.copyFileSync(dbPath, backupPath);
    log(`已备份 DB → ${backupPath}`);
  }

  const db = new Database(dbPath);
  const addedColumns = dryRun ? [] : ensureColumns(db);
  if (addedColumns.length > 0) log(`已添加列: ${addedColumns.join(', ')}`);

  // dry-run 在旧库上可能还没有 route_cells 列: 动态决定是否查询该列
  const hasRouteCells = db
    .prepare("SELECT name FROM pragma_table_info('activities')")
    .all()
    .some((r) => r.name === 'route_cells');
  const rows = db
    .prepare(
      `SELECT activity_id, name, distance, track,
              ${hasRouteCells ? 'route_cells' : 'NULL AS route_cells'}
       FROM activities
       ORDER BY start_time DESC`,
    )
    .all();

  const stmt = dryRun
    ? null
    : db.prepare(
        'UPDATE activities SET route_cells = ?, route_bounds = ?, route_km = ? WHERE activity_id = ?',
      );

  let written = 0;
  let skipped = 0;
  let noTrack = 0;
  let invalid = 0;
  const gridSizes = [];
  const lengthDeltas = [];

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!row.track) { noTrack++; continue; }
      if (row.route_cells && !force) { skipped++; continue; }
      const sig = signatureOf(row.track);
      if (!sig) { invalid++; continue; }
      if (stmt) {
        stmt.run(
          JSON.stringify(sig.cells),
          JSON.stringify(sig.bounds),
          sig.km,
          row.activity_id,
        );
      }
      written++;
      gridSizes.push(sig.cells.length);
      // 轨迹长度 vs 活动距离：绕圈/折返会让轨迹长度偏大，但不应差一个量级
      if (row.distance > 0) lengthDeltas.push(sig.km / row.distance);
    }
  });
  tx();

  db.close();

  if (gridSizes.length > 0) {
    const sorted = [...gridSizes].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    log(`网格数: 中位 ${med}, p95 ${p95}, 最大 ${sorted[sorted.length - 1]}`);
    if (lengthDeltas.length > 0) {
      const ratios = [...lengthDeltas].sort((a, b) => a - b);
      log(
        `轨迹长度/活动距离: 中位 ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}, ` +
          `p05 ${ratios[Math.floor(ratios.length * 0.05)].toFixed(2)}, ` +
          `p95 ${ratios[Math.floor(ratios.length * 0.95)].toFixed(2)}`,
      );
    }
  }

  log(
    `${dryRun ? '[dry-run] ' : ''}完成: 活动=${rows.length}, 写入=${written}, ` +
      `已有签名跳过=${skipped}, 无轨迹=${noTrack}, 轨迹无效=${invalid}`,
  );
  if (backupPath) log(`回滚: cp "${backupPath}" "${dbPath}"`);

  return { total: rows.length, written, skipped, noTrack, invalid, addedColumns, backupPath };
}

module.exports = { main, log, ensureColumns, signatureOf };

if (require.main === module) {
  const argv = process.argv.slice(2);
  // 支持 --db-path=<path>（便于在 DB 副本上先验证）
  const dbArg = argv.find((a) => a.startsWith('--db-path='));
  main({
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    dbPath: dbArg ? dbArg.slice('--db-path='.length) : undefined,
  }).catch((e) => {
    console.error('致命错误:', e);
    process.exit(1);
  });
}
