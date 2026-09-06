#!/usr/bin/env node
/**
 * 回填 VDOT / training_load（新口径）
 * - VDOT 仅 Z3+ 代表性强度（最快 Z3+ lap，否则全程 Z3+ 才计），日常轻松跑置 null（不把训练平均强度当能力）
 * - training_load 优先 FIT 官方（fit-parser 已提取），缺省才自定义
 * - clamp %VO2max 已在 calculator 内
 * 用法：node scripts/garmin/backfill-vdot.js [--dry-run] [--limit N]
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const DatabaseManager = require('../common/db-manager');
const GarminFITParser = require('./fit-parser');
const VDOTCalculator = require('../common/vdot-calculator');

const FIT_CACHE_DIR = path.join(process.cwd(), '.cache', 'fit');

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
      let seg = null;
      const wholeHr = activityRow.average_heart_rate ?? parsed.activity?.average_heart_rate;
      const wholeDist = parsed.activity?.distance ?? activityRow.distance;
      const wholeDur = parsed.activity?.duration ?? activityRow.duration;
      if (Array.isArray(laps) && laps.length > 0) {
        const cands = laps.filter(l => l.distance > 400 && l.duration > 30 && l.average_heart_rate && l.average_pace);
        if (cands.length > 0) {
          const best = cands.reduce((a, b) => (a.average_pace < b.average_pace ? a : b));
          if (calc.isRepresentativeEffort(best.average_heart_rate)) seg = { d: best.distance, t: best.duration };
          else if (wholeHr && calc.isRepresentativeEffort(wholeHr)) seg = { d: (wholeDist || 0) * 1000, t: wholeDur || 0 };
        } else if (wholeHr && calc.isRepresentativeEffort(wholeHr)) {
          seg = { d: (wholeDist || 0) * 1000, t: wholeDur || 0 };
        }
      } else if (wholeHr && calc.isRepresentativeEffort(wholeHr)) {
        seg = { d: (wholeDist || 0) * 1000, t: wholeDur || 0 };
      }

      let newVdot = null;
      if (seg) newVdot = calc.calculateVdotFromPace(seg.d, seg.t);
      const oldVdot = activityRow.vdot_value;

      // training_load 决策
      let newLoad = fitLoad;
      if (newLoad == null && wholeDur && wholeHr) {
        const types = ['running', 'treadmill_running', 'track_running'];
        if (types.includes(activityRow.activity_type || 'running')) {
          newLoad = calc.calculateTrainingLoad(wholeDur, wholeHr);
        }
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
}
main().catch(e => { console.error('Fatal', e); process.exit(1); });
