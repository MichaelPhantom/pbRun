/**
 * Garmin 每日健康数据归一化（纯函数，无 IO，可单测）。
 *
 * ## 为什么需要这张表
 *
 * `activities.resting_heart_rate_fit` 来自 FIT 文件的 `user_profile` 消息，
 * **只在有活动的日子才有值**（真实库 225/368 ≈ 61%）。休息日、生病日、比赛前一天
 * ——恰恰是最需要看基线的日子——全部是空白。用它做「静息心率基线」结论会在最关键
 * 的窗口瞎掉，本仓库就吃过这个亏（2026-10 流感窗口 10 天无样本）。
 *
 * 健康数据是**按天**的，与当天有没有训练无关，所以必须独立成表、独立采集。
 *
 * ## 数据来源（connect.garmin.cn，只读）
 *
 * - `usersummary-service/usersummary/daily/{displayName}?calendarDate=YYYY-MM-DD`
 * - `hrv-service/hrv/{date}`
 * - `wellness-service/wellness/dailySleepData/{displayName}?date=YYYY-MM-DD`
 *
 * ## 单位纪律（与仓库其它表保持一致，不要在这里换口径）
 *
 * - 心率 / HRV：bpm、毫秒，整数
 * - 睡眠：**秒**（与 `activities.duration` 同口径，小时/分钟只在展示层换算）
 * - Body Battery / stress / steps：Garmin 原生整数
 * - 未采集到的字段一律 `null`，**不要用 0 代替**（0 是有效值，例如 steps=0）
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 有限数字 → 四舍五入整数；其余（undefined/null/NaN/字符串）→ null */
function toInt(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** 有限数字 → 原值；其余 → null */
function toNum(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 非空字符串 → 字符串；其余 → null（避免把 "" 写进库） */
function toText(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s : null;
}

/**
 * 把三个端点的原始响应合并成一行 `daily_wellness`。
 *
 * @param {object} input
 * @param {string} input.date     本地日历日 YYYY-MM-DD（Garmin 的 calendarDate 就是本地日）
 * @param {object|null} input.summary  usersummary 响应
 * @param {object|null} input.hrv      hrv-service 响应
 * @param {object|null} input.sleep    dailySleepData 响应
 * @param {string} [input.source]   数据来源标记，默认 'garmin-cdp'
 * @param {string} [input.fetchedAt] 采集时刻（ISO）
 * @returns {object} 可直接 upsert 的行对象
 */
function normalizeDailyWellness({
  date,
  summary,
  hrv,
  sleep,
  source = 'garmin-cdp',
  fetchedAt = new Date().toISOString(),
} = {}) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw new Error(`normalizeDailyWellness: 非法日期 "${date}"（需要 YYYY-MM-DD）`);
  }

  const s = summary && typeof summary === 'object' ? summary : {};
  const hs = hrv && typeof hrv === 'object' && hrv.hrvSummary ? hrv.hrvSummary : {};
  const baseline = hs.baseline && typeof hs.baseline === 'object' ? hs.baseline : {};
  const dto = sleep && typeof sleep === 'object' && sleep.dailySleepDTO ? sleep.dailySleepDTO : {};
  const scores = dto.sleepScores && typeof dto.sleepScores === 'object' ? dto.sleepScores : {};

  return {
    calendar_date: date,

    // 心率（全天口径，与训练无关）
    resting_heart_rate: toInt(s.restingHeartRate),
    resting_hr_7d_avg: toInt(s.lastSevenDaysAvgRestingHeartRate),
    min_heart_rate: toInt(s.minHeartRate),
    max_heart_rate: toInt(s.maxHeartRate),

    // 睡眠（秒）。sleep_score 是 Garmin 的 0-100 综合分。
    sleeping_seconds: toInt(dto.sleepTimeSeconds ?? s.sleepingSeconds),
    sleep_score: toInt(scores.overall && scores.overall.value),
    sleep_deep_seconds: toInt(dto.deepSleepSeconds),
    sleep_rem_seconds: toInt(dto.remSleepSeconds),
    sleep_light_seconds: toInt(dto.lightSleepSeconds),
    sleep_awake_seconds: toInt(dto.awakeSleepSeconds),
    sleep_avg_stress: toInt(dto.avgSleepStress),
    sleep_avg_heart_rate: toInt(dto.avgHeartRate),
    sleep_spo2_avg: toNum(dto.averageSpO2Value),
    sleep_respiration_avg: toNum(dto.averageRespirationValue),

    // 日间压力 / Body Battery
    avg_stress_level: toInt(s.averageStressLevel),
    max_stress_level: toInt(s.maxStressLevel),
    body_battery_at_wake: toInt(s.bodyBatteryAtWakeTime),
    body_battery_lowest: toInt(s.bodyBatteryLowestValue),
    body_battery_highest: toInt(s.bodyBatteryHighestValue),

    // 活动量（与训练记录相互独立，休息日也有值）
    total_steps: toInt(s.totalSteps),
    total_distance_meters: toInt(s.totalDistanceMeters),
    active_kilocalories: toInt(s.activeKilocalories),

    // HRV（Garmin 的 HRV Status，夜间测量）
    hrv_last_night_avg: toInt(hs.lastNightAvg),
    hrv_weekly_avg: toInt(hs.weeklyAvg),
    hrv_last_night_5min_high: toInt(hs.lastNight5MinHigh),
    hrv_status: toText(hs.status),
    hrv_baseline_low: toInt(baseline.balancedLow),
    hrv_baseline_high: toInt(baseline.balancedUpper),
    hrv_feedback: toText(hs.feedbackPhrase),

    source: toText(source) || 'garmin-cdp',
    fetched_at: fetchedAt,
  };
}

/** 除主键/元数据外，是否至少有一个生理或活动字段有值。用于跳过 Garmin 完全无数据的日期。 */
function hasAnySignal(row) {
  if (!row) return false;
  const signalKeys = [
    'resting_heart_rate',
    'resting_hr_7d_avg',
    'min_heart_rate',
    'max_heart_rate',
    'sleeping_seconds',
    'sleep_score',
    'avg_stress_level',
    'body_battery_at_wake',
    'total_steps',
    'hrv_last_night_avg',
    'hrv_weekly_avg',
    'hrv_status',
  ];
  return signalKeys.some((k) => row[k] !== null && row[k] !== undefined);
}

/** 生成 [from, to] 之间的连续日期（含两端，UTC 计算避免夏令时/时区抖动）。 */
function enumerateDates(from, to) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new Error(`enumerateDates: 需要 YYYY-MM-DD，收到 "${from}" / "${to}"`);
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error(`enumerateDates: 区间非法 ${from} → ${to}`);
  }
  const out = [];
  for (let t = start; t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** 从今天往回 N 天（含今天）的日期列表，按时间正序。 */
function lastNDates(n, today = new Date()) {
  const count = Math.max(1, Math.floor(Number(n) || 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end.getTime() - (count - 1) * 86400000);
  return enumerateDates(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
}

module.exports = {
  normalizeDailyWellness,
  hasAnySignal,
  enumerateDates,
  lastNDates,
  toInt,
  toNum,
  toText,
};