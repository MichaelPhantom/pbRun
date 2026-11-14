#!/usr/bin/env node
/**
 * 回填 VDOT / training_load（新口径）
 * - **仅跑步类型**（running / track_running / treadmill_running，缺类型视为 running）：
 *   VDOT 与 training_load 都是跑步口径指标，非跑步活动（游泳/球类/力量训练）一律不写
 * - VDOT 仅 Z3+ 代表性强度（**先筛 Z3+ 再取最快 lap**，否则全程 Z3+ 才计），
 *   日常轻松跑置 null（不把训练平均强度当能力）。选择语义唯一实现：
 *   `scripts/common/vdot-segment.js`（第三十七类缺陷修复）
 * - training_load 优先 FIT 官方（fit-parser 已提取），缺省才自定义
 * - clamp %VO2max 已在 calculator 内
 * - 写库前先备份 DB → `.bak.<timestamp>`（与其余 backfill-* 同一纪律；可回滚）
 * 用法：node scripts/garmin/backfill-vdot.js [--dry-run] [--limit N]
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const DatabaseManager = require('../common/db-manager');
const GarminFITParser = require('./fit-parser');
const VDOTCalculator = require('../common/vdot-calculator');
const { effectiveTimeSec } = require('../common/pace');
const { selectRepresentativeSegment } = require('../common/vdot-segment');

const FIT_CACHE_DIR = path.join(process.cwd(), '.cache', 'fit');
const DB_PATH = path.join(process.cwd(), 'app', 'data', 'activities.db');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

  const maxHr = process.env.MAX_HR ? parseInt(process.env.MAX_HR) : null;
  const restingHr = process.env.RESTING_HR ? parseInt(process.env.RESTING_HR) : null;
  if (!maxHr || !restingHr) {
    console.error('✗ 需设置 MAX_HR / RESTING_HR');
    process.exit(1);
  }
  const calc = new VDOTCalculator(maxHr, restingHr);
  // 写库前备份（与 backfill-hr-zones / backfill-lap-zones 等同一纪律）。
  // 旧实现是唯一不备份的回填脚本 —— 而它恰恰会**清空**旧 VDOT（needClear 分支），
  // 口径改坏时没有回滚点。dry-run 不写库也不备份。
  if (!dryRun) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bakPath = `${DB_PATH}.bak.${ts}`;
    fsSync.copyFileSync(DB_PATH, bakPath);
    console.log(`已备份 DB → ${bakPath}`);
  }
  const db = new DatabaseManager('app/data/activities.db');
  const parser = new GarminFITParser();

  const ids = db.getAllActivityIds();
  console.log(`DB 活动总数: ${ids.length}`);
  let cached = [];
  try { cached = await fs.readdir(FIT_CACHE_DIR); } catch { console.error('✗ 无 FIT 缓存'); process.exit(1); }
  const cachedSet = new Set(cached);
  const targets = ids.filter(id => cachedSet.has(String(id)));
  console.log(`缓存命中: ${targets.length}`);
  const workList = limit ? targets.slice(0, limit) : targets;

  let updated = 0, cleared = 0, kept = 0, failed = 0;
  for (const id of workList) {
    try {
      const fitPath = path.join(FIT_CACHE_DIR, String(id));
      const parsed = await parser.parseFitFile(fitPath);
      const activityRow = db.getActivity(id);
      if (!activityRow) { failed++; continue; }
      // FIT 官方 training_load（若有）
      const fitLoad = parsed.activity?.training_load ?? null;
      // laps 来自 DB（已入库）或本次解析
      let laps = [];
      try {
        const stmt = db.db.prepare('SELECT * FROM activity_laps WHERE activity_id = ? ORDER BY lap_index');
        laps = stmt.all(id);
      } catch {}
      if ((!laps || laps.length === 0) && Array.isArray(parsed.laps)) laps = parsed.laps;

      // 计算代表段
      // VDOT 是**跑步跑力**指标（Daniels 的 VO2max 推算依赖跑步速度与跑步经济性），
      // 必须与 sync.js 的 `runnableTypes` 同口径。此前这里只对 training_load 做了
      // 类型筛选、对 VDOT 完全没筛 —— 只要非跑步活动有一个距离 >400m 且带心率/配速
      // 的 lap（真实库篮球 1665m/2604m、乒乓 35m 都有 lap 记录），就会算出「游泳 VDOT」
      // 这类伪能力值。缺 activity_type 视为 running（旧库兼容，与 app/lib/sport.ts 一致）。
      const runnableTypes = ['running', 'treadmill_running', 'track_running'];
      const isRunningActivity = runnableTypes.includes(activityRow.activity_type || 'running');
      const wholeHr = activityRow.average_heart_rate ?? parsed.activity?.average_heart_rate;
      const wholeDist = parsed.activity?.distance ?? activityRow.distance;
      // **时间基数 = 计时器时间**（与配速/VDOT/训练负荷同一口径）。
      // 旧实现取 `parsed.activity?.duration ?? activityRow.duration`，两者都是
      // `total_elapsed_time`（含暂停）—— 于是 VDOT 与 training_load 都按
      // 「把暂停也算成跑步」的速度/时长算，真实库 25 条 VDOT、19 条 TL 偏差 >10%。
      const wholeDur = effectiveTimeSec({
        moving_time: parsed.activity?.moving_time ?? activityRow.moving_time,
        duration: parsed.activity?.duration ?? activityRow.duration,
      }) ?? 0;
      let seg = null;
      if (isRunningActivity) {
        // 选择语义唯一实现（第三十七类缺陷：先筛 Z3+ 再取最快，不是取最快再检查）。
        seg = selectRepresentativeSegment({
          laps,
          whole: { distanceKm: wholeDist, timeSec: wholeDur, avgHr: wholeHr },
          isRepresentativeEffort: (hr) => calc.isRepresentativeEffort(hr),
        });
      }

      let newVdot = null;
      if (seg) newVdot = calc.calculateVdotFromPace(seg.d, seg.t);
      const oldVdot = activityRow.vdot_value;

      // training_load 决策
      let newLoad = fitLoad;
      if (newLoad == null && wholeDur && wholeHr && isRunningActivity) {
        newLoad = calc.calculateTrainingLoad(wholeDur, wholeHr);
      }
      const oldLoad = activityRow.training_load;

      const patch = {};
      // VDOT：有代表段则写，无则显式置 null（与旧值区分）
      if (newVdot !== oldVdot) {
        patch.vdot_value = newVdot;
      }
      if (newLoad !== oldLoad && newLoad != null) {
        patch.training_load = newLoad;
      }
      // 旧 VDOT 非空但新为空 → 需要清掉
      const needClear = oldVdot != null && newVdot == null;

      if (Object.keys(patch).length === 0 && !needClear) { kept++; continue; }
      if (dryRun) {
        if (needClear) console.log(`[dry-run] ${id}: clear VDOT ${oldVdot} → null`);
        else console.log(`[dry-run] ${id}: patch ${JSON.stringify(patch)}`);
        if (needClear) cleared++; else updated++;
        continue;
      }
      if (needClear) {
        db.updateActivityFields(id, { vdot_value: null });
        cleared++;
      } else if (Object.keys(patch).length > 0) {
        db.updateActivityFields(id, patch);
        updated++;
      }
    } catch (e) {
      console.error(`✗ ${id}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n✓ 完成: 更新 ${updated} / 清空 ${cleared} / 保持 ${kept} / 失败 ${failed}` + (dryRun ? ' (dry-run)' : ''));
  db.close();
  // 失败项反映到退出码, 供 CI/cron 察觉部分失败 (原实现恒 0)。
  if (failed > 0) process.exitCode = 1;
}
module.exports = { main, FIT_CACHE_DIR };

// 仅 CLI 直跑时执行 (被 require 时不自动运行, 便于单测)
if (require.main === module) {
  main().catch(e => { console.error('Fatal', e); process.exit(1); });
}
