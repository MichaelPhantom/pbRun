/**
 * pace.js — `app/lib/pace.ts` 的 CJS 镜像（**只镜像纯函数**）。
 *
 * 为什么需要镜像：同步脚本（`scripts/garmin/fit-parser.js`）与回填脚本
 * （`scripts/garmin/backfill-pace.js`）是 CommonJS，无法 require TS 模块；
 * 而「配速该用哪个时间基数」必须只有一个答案。与 `scripts/common/hr-zones.js`
 * （镜像 `app/lib/hr-zones.ts`）、`scripts/common/power-zones.js` 同一模式，
 * 一致性由 `tests/unit/scripts/pace-parity.test.ts` 逐值比对守护。
 *
 * ## 口径（与 TS 版严格一致）
 *
 * 配速/速度的时间基数 = **计时器时间 `moving_time`**（FIT `total_timer_time`），
 * 缺失时才回退经过时间 `duration`（FIT `total_elapsed_time`）。
 *
 * 旧实现一律用 `duration`，导致「暂停较多」的活动配速荒谬：
 * `582132079` 6.63 km / 43.7 分钟（`moving_time`）却显示 **26:19/km**，
 * 因为 `duration` 是 10465 秒（含 7845 秒暂停）。
 */

/**
 * 计算配速/速度时应使用的秒数：**计时器时间优先**，缺失才回退经过时间。
 * @param {{moving_time?: number|null, duration?: number|null}} row
 * @returns {number|null} 正数秒数；两者都缺失/非正时为 null
 */
function effectiveTimeSec(row) {
  const moving = row && row.moving_time;
  if (moving != null && Number.isFinite(moving) && moving > 0) return moving;
  const elapsed = row && row.duration;
  if (elapsed != null && Number.isFinite(elapsed) && elapsed > 0) return elapsed;
  return null;
}

/**
 * 配速（秒/公里）。
 * @param {number|null|undefined} distanceKm 距离（公里）
 * @param {number|null|undefined} seconds 计时器秒数
 * @returns {number|null}
 */
function paceSecPerKm(distanceKm, seconds) {
  if (distanceKm == null || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds / distanceKm;
}

/**
 * 速度（公里/小时）。与 `paceSecPerKm` 是同一时间基数的两种表达，永远互为倒数。
 * @param {number|null|undefined} distanceKm
 * @param {number|null|undefined} seconds
 * @returns {number|null}
 */
function speedKmh(distanceKm, seconds) {
  const pace = paceSecPerKm(distanceKm, seconds);
  return pace == null ? null : 3600 / pace;
}

module.exports = { effectiveTimeSec, paceSecPerKm, speedKmh };
