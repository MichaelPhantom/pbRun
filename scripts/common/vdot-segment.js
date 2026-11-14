/**
 * vdot-segment.js — 「VDOT 代表段选择」的**唯一实现**。
 *
 * 为什么单独成模块：代表段选择有**三条生产路径** —— Garmin 同步
 * （`scripts/garmin/sync.js`）、Strava 同步（`scripts/strava/sync.js`）、
 * 历史回填（`scripts/garmin/backfill-vdot.js`），外加例行校验
 * （`scripts/garmin/validate-data.js`）要按同一口径复核。选择语义只要有一处
 * 写歪，同步写入的值与回填写入的值就会分叉，而这种分叉不报错、只让
 * 「跑力趋势」悄悄失真。与 `lap-zones.js` / `pace.js` 同一模式：纯函数放
 * common，所有调用方共享。
 *
 * ## 契约（三处调用方注释的一致表述）
 *
 * 「取 laps 中**最快且为 Z3+** 的段为代表；无合适 lap 且全程也非 Z3+ 则跳过」
 *
 * 1. 候选 lap：距离 >400m、计时器时间 >30s、带心率与配速（排除 GPS 碎片段，
 *    如 8m/41m 的尾段）；
 * 2. **先筛 Z3+，再取最快** —— 不是「取最快再检查是否 Z3+」。最快段
 *    常常是心率还没起来的第一公里（Z2），旧实现「取最快再检查」会因为它
 *    不是 Z3+ 而把后面所有真正的 Z3+ 段一起丢掉，再退回全程均值；全程也
 *    非 Z3+ 时整条活动静默漏算。真实库 249 条跑步里 **32 条**因此没有跑力
 *    （如 `549651785` 渐进跑：最快 K3 心率 147/Z2，而 K11 以 3:50/km、
 *    心率 168/Z3 收尾 —— 真正的代表段是 K11）；
 * 3. 无 Z3+ 候选 lap → 全程 Z3+ 才退回全程；否则返回 null（轻松/恢复跑
 *    的平均强度不是能力值，不产出 VDOT）。
 *
 * ## 时间基数
 *
 * 与配速同一口径：**计时器时间**（`effectiveTimeSec`，moving_time 优先）。
 * VDOT 是配速的函数，时间基数分叉会产出「页面配速 6:35/km、VDOT 却按
 * 26:19/km 算」的自相矛盾。
 */

const { effectiveTimeSec } = require('./pace');

/** 候选 lap 的最小距离（米）：排除 GPS 碎片/尾段。 */
const MIN_LAP_DISTANCE_M = 400;
/** 候选 lap 的最小计时器时长（秒）：排除零长/瞬时碎片。 */
const MIN_LAP_TIME_SEC = 30;

/**
 * 选择 VDOT 代表段。
 *
 * @param {object} opts
 * @param {Array|null|undefined} opts.laps 分段数组（distance 米、average_pace 秒/公里、
 *   带 moving_time/duration 与 average_heart_rate）；无分段传 null/[]。
 * @param {{distanceKm?: number|null, timeSec?: number|null, avgHr?: number|null}} opts.whole
 *   全程口径：距离（公里）、计时器秒数、平均心率。
 * @param {(hr: number|null|undefined) => boolean} opts.isRepresentativeEffort
 *   Z3+ 判定（由 VDOTCalculator 提供，MAX_HR 口径单一来源）。
 * @returns {{d: number, t: number}|null} 代表段（距离米 / 计时器秒数）；无代表段返回 null。
 */
function selectRepresentativeSegment({ laps, whole, isRepresentativeEffort }) {
  const wholeIsRep = Boolean(whole && isRepresentativeEffort(whole.avgHr));
  const wholeSeg = wholeIsRep
    ? { d: (whole.distanceKm || 0) * 1000, t: whole.timeSec || 0 }
    : null;

  if (Array.isArray(laps) && laps.length > 0) {
    const cands = laps.filter(
      (l) =>
        l.distance > MIN_LAP_DISTANCE_M &&
        (effectiveTimeSec(l) ?? 0) > MIN_LAP_TIME_SEC &&
        l.average_heart_rate &&
        l.average_pace,
    );
    // 先筛 Z3+ 再取最快（契约第 2 条）。顺序反了就是第三十七类缺陷。
    const reps = cands.filter((l) => isRepresentativeEffort(l.average_heart_rate));
    if (reps.length > 0) {
      const best = reps.reduce((a, b) => (a.average_pace < b.average_pace ? a : b));
      return { d: best.distance, t: effectiveTimeSec(best) ?? best.duration };
    }
  }
  return wholeSeg;
}

module.exports = {
  selectRepresentativeSegment,
  MIN_LAP_DISTANCE_M,
  MIN_LAP_TIME_SEC,
};