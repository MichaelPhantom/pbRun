/**
 * 力量训练负荷派生 —— `app/lib/strength.ts` 的 **JS 镜像**（供同步脚本使用）。
 *
 * ## 为什么需要镜像（而不是 import TS）
 *
 * `scripts/garmin/sync.js` 是纯 Node CJS 脚本（不经 tsc/Next 构建），无法直接
 * `require('../app/lib/strength.ts')`。但同步时必须给力量课写 `training_load`，
 * 否则新同步的力量训练又会落回「零负荷」的老坑（51 条历史数据就是这么来的）。
 *
 * ## 防漂移纪律
 *
 * 口径的唯一真源是 `app/lib/strength.ts`；本文件是**逐行对应的镜像**，由
 * `tests/unit/lib/strength-sync-parity.test.ts` 用同一批输入逐一比对两边输出，
 * 任何一侧改动而另一侧没跟上 → 红灯。**不要在这里发明新规则**。
 *
 * 同步点清单（改任一侧必须同步）：
 *   - `strengthIntensityDomain` 的 TE 阈值 (3.5 / 2.5 / 1.5)
 *   - `strengthIntensityDomain` 的心率回退阈值 (100 / 130)
 *   - `estimateStrengthLoad` 的域系数 (1.5 / 1.3 / 1.0 / 0.6 / 0.8)
 *   - `strengthLoadBaseSeconds` 的时间基数优先级 (moving_time → duration)
 */

/** TE → 强度域（与 TS 版逐字对应）。 */
function strengthIntensityDomain(aerobicEffect, avgHeartRate) {
  if (aerobicEffect != null && Number.isFinite(aerobicEffect) && aerobicEffect > 0) {
    if (aerobicEffect >= 3.5) return 'high';
    if (aerobicEffect >= 2.5) return 'tempo';
    if (aerobicEffect >= 1.5) return 'base';
    return 'recovery';
  }
  if (avgHeartRate != null && Number.isFinite(avgHeartRate) && avgHeartRate > 0) {
    if (avgHeartRate < 100) return 'recovery';
    if (avgHeartRate < 130) return 'base';
    return 'tempo';
  }
  return 'unknown';
}

/** 强度域 → 负荷系数（与 TS 版逐字对应）。 */
const DOMAIN_FACTORS = {
  high: 1.5,
  tempo: 1.3,
  base: 1.0,
  recovery: 0.6,
  unknown: 0.8,
};

/** 时长(秒) × 强度域 → 负荷分（与 `estimateStrengthLoad` 逐字对应）。 */
function estimateStrengthLoad(durationSeconds, intensityDomain) {
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const factor = DOMAIN_FACTORS[intensityDomain];
  const hours = durationSeconds / 3600;
  return Math.round(hours * 100 * (factor == null ? DOMAIN_FACTORS.unknown : factor));
}

/** 时间基数：计时器时间优先（与 `strengthLoadBaseSeconds` 逐字对应）。 */
function strengthLoadBaseSeconds(movingTime, duration) {
  if (movingTime != null && Number.isFinite(movingTime) && movingTime > 0) return movingTime;
  if (duration != null && Number.isFinite(duration) && duration > 0) return duration;
  return 0;
}

/**
 * 一条力量活动 → 训练负荷分。
 *
 * @param {object} activityData 同步中的活动对象（含 duration/moving_time/
 *   average_heart_rate/total_training_effect）
 * @returns {number} 负荷分（时长 ≤ 0 时 0）
 */
function calculateStrengthLoad(activityData) {
  const domain = strengthIntensityDomain(
    activityData.total_training_effect,
    activityData.average_heart_rate,
  );
  const base = strengthLoadBaseSeconds(activityData.moving_time, activityData.duration);
  return estimateStrengthLoad(base, domain);
}

module.exports = {
  calculateStrengthLoad,
  strengthIntensityDomain,
  estimateStrengthLoad,
  strengthLoadBaseSeconds,
  DOMAIN_FACTORS,
};
