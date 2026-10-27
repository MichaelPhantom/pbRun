/**
 * 配速 / 速度的**唯一推导口径**（时间基数 = 计时器时间 timer time）。
 *
 * ## 为什么必须单独成模块
 *
 * 2026-10-27 审计发现：`average_pace` / `average_speed` 一直由 `duration`
 * 推导，而 `duration` 存的是 FIT `total_elapsed_time`（**含暂停**）。
 * 于是同一个活动卡片会自相矛盾：
 *
 * | 活动 | 距离 | 卡片「时长」(`moving_time`) | 卡片「平均配速」 | 配速×距离 |
 * |------|------|------------------------------|------------------|-----------|
 * | `582132079` | 6.63 km | 43.7 分 | **26:19/km** | 174.4 分 |
 * | `632595826` | 7.17 km | 45.8 分 | **11:17/km** | 80.8 分 |
 *
 * 真实库 251 条有配速的活动里，`average_pace` **251/251 严格等于
 * `duration / distance`**，只有 158 条同时等于 `moving_time / distance`。
 * 也就是说：所有「暂停较多」的活动（跑步 19 条偏差 >10%、4 条 >25%、
 * 2 条 >50%）的配速都是错的，而它们恰好是最需要解释的那些。
 *
 * 设备自己算的 `enhanced_avg_speed` 用的是**计时器时间**：251 条活动里
 * **248 条**与 `distance / moving_time` 偏差 <2%（另 3 条是游泳，设备按
 * 划水时段加权）。Strava / Garmin Connect 展示的配速同样是计时器口径。
 * 所以这不是「两种都行」，而是我们**读错了自己存的列**。
 *
 * ## 口径
 *
 * `effectiveTimeSec()` = `moving_time`（若 > 0），否则回退 `duration`。
 *
 * 回退只在「该活动没写 timer time」时发生 —— 与 `app/lib/power.ts` 对 TSS
 * 的处理完全一致（TSS 的时间基数早已声明为 `moving_time`）。同一个概念
 * 不允许两套实现：写入（`fit-parser` / 回填）与读取（`db.ts` 的配速样本、
 * 个人最佳、长跑解耦）都走这里，CJS 镜像在 `scripts/common/pace.js`。
 */

/** 同时带「移动时间」与「总时长」的行（活动行与 lap 行都满足）。 */
export interface TimeBaseFields {
  moving_time?: number | null;
  duration?: number | null;
}

/**
 * 计算配速/速度时应使用的秒数：**计时器时间优先**，缺失才回退经过时间。
 *
 * 入参允许 `null`/`undefined`：调用方常从 `parsed.activity` 这类可空对象上取值，
 * 「拿不到行」与「行里没这两列」应当同样处理成 null，而不是抛错。
 *
 * @returns 正数秒数；两者都缺失/非正时返回 null（不造 0，避免除零与假配速）。
 */
export function effectiveTimeSec(row: TimeBaseFields | null | undefined): number | null {
  if (row == null) return null;
  const moving = row.moving_time;
  if (moving != null && Number.isFinite(moving) && moving > 0) return moving;
  const elapsed = row.duration;
  if (elapsed != null && Number.isFinite(elapsed) && elapsed > 0) return elapsed;
  return null;
}

/**
 * 配速（秒/公里）。
 *
 * @param distanceKm 距离（公里，DB 原单位）
 * @param seconds 计时器秒数（见 `effectiveTimeSec`）
 */
export function paceSecPerKm(distanceKm: number | null | undefined, seconds: number | null | undefined): number | null {
  if (distanceKm == null || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds / distanceKm;
}

/**
 * 速度（公里/小时）。与 `paceSecPerKm` 是**同一个时间基数**的两种表达，
 * 因此两者永远互为倒数 —— 不会再出现「配速按经过时间、速度按计时器」的分叉。
 */
export function speedKmh(distanceKm: number | null | undefined, seconds: number | null | undefined): number | null {
  const pace = paceSecPerKm(distanceKm, seconds);
  return pace == null ? null : 3600 / pace;
}
