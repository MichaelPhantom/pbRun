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

// ---------------------------------------------------------------------------
// 一组活动的聚合（**均配速不是一个"平均值"**）
// ---------------------------------------------------------------------------

/**
 * 一组活动可用的原始量。`seconds` 缺失时可由 `pace × distance` 精确还原
 * （配速的定义就是 秒/公里，所以这不引入任何近似）。
 */
export interface GroupSample {
  /** 该活动的配速（秒/公里） */
  paceSecPerKm?: number | null;
  /** 该活动的距离（公里） */
  distanceKm?: number | null;
  /** 该活动的计时器秒数 */
  seconds?: number | null;
  /** 该活动的平均心率（bpm） */
  heartRate?: number | null;
  /** 该活动的平均步频（spm） */
  cadence?: number | null;
  /** 该活动的平均步幅（米） */
  strideLength?: number | null;
}

/**
 * 样本的秒数：优先显式 `seconds`，否则由 `pace × distance` 精确还原。
 *
 * 为什么需要这条兜底：`activity_laps` 里有 lap 的 `moving_time` 与 `duration`
 * 都为 0（数据缺失），但 `average_pace` 有值 —— 此时「秒数」是唯一能由配速
 * 反推出来的量，丢掉它会让区间表的「均配速」变成 0 或 null。
 * 这不是近似：配速的定义就是 秒/公里。
 */
export function sampleSeconds(s: GroupSample): number | null {
  if (s.seconds != null && Number.isFinite(s.seconds) && s.seconds > 0) return s.seconds;
  const p = s.paceSecPerKm;
  const d = s.distanceKm;
  if (p != null && Number.isFinite(p) && p > 0 && d != null && Number.isFinite(d) && d > 0) {
    return p * d;
  }
  return null;
}

/**
 * 一组活动的**均配速** = Σ计时器秒数 / Σ距离（秒/公里）。
 *
 * ## 为什么不能是「各次活动配速的平均值」
 *
 * `AVG(average_pace)` 是 *比值的平均*，它只在每次跑的距离相同时才等于这段时期的
 * 配速。真实的跑量结构里长短差异极大，于是它会系统性偏高（配速越高=越慢，
 * 因为 `mean(1/v) ≥ 1/mean(v)`，Jensen 不等式）。真实库实测：
 *
 * | 窗口 | `AVG(average_pace)` | Σt/Σd | 偏差 |
 * |------|--------------------|-------|------|
 * | 近 7 天 | 388.3 | 358.3 | **+30.0 s/km（+8.4%）** |
 * | 近 30 天 | 365.0 | 358.6 | +6.4 s/km |
 * | 2026-06 | 388.5 | 365.5 | +23.0 s/km（+6.3%） |
 * | 2026-03 | 358.1 | 344.9 | +13.2 s/km（+3.8%） |
 *
 * 那 7 天里只有两次跑：4.76 km 的恢复跑（7:26/km）与 15.06 km 的常规跑
 * （5:31/km）。卡片说「6:28/km」，而这两次合起来跑 19.82 km 用了 7100 秒 =
 * **5:58/km**。半分钟的差距，方向永远偏向「你比实际更慢」。
 *
 * 这个定义还有两个别的口径没有的性质：
 *  - **可从展示出来的数字自证**：均配速 ≡ 总时长 / 总距离，用户拿卡片上另外两个
 *    数字就能验算；
 *  - **可组合**：把窗口切成子区间，再由子区间的 Σt、Σd 合并，结果不变；
 *    「时长加权平均配速」不满足这条（父区间无法由子区间还原）。
 */
export function groupPaceSecPerKm(samples: GroupSample[]): number | null {
  let seconds = 0;
  let km = 0;
  for (const s of samples) {
    const t = sampleSeconds(s);
    const d = s.distanceKm;
    if (t == null || d == null || !Number.isFinite(d) || d <= 0) continue;
    seconds += t;
    km += d;
  }
  return km > 0 ? seconds / km : null;
}

/**
 * 一组活动的**均心率** = Σ(心率 × 计时器秒数) / Σ计时器秒数。
 *
 * 权重必须是**时间**：心率是「每分钟多少次」的强度量，汇总时应当按停留时间加权，
 * 否则一次 12 分钟的间歇会与一次 2 小时的长距离等权。真实库近 7 天：等权 135.0
 * vs 时长加权 139.8（**-4.8 bpm**）—— 因为那周有一次很短的恢复跑把均值拉低。
 */
export function groupHeartRate(samples: GroupSample[]): number | null {
  let weighted = 0;
  let seconds = 0;
  for (const s of samples) {
    const hr = s.heartRate;
    if (hr == null || !Number.isFinite(hr) || hr <= 0) continue;
    const t = sampleSeconds(s);
    if (t == null) continue;
    weighted += hr * t;
    seconds += t;
  }
  return seconds > 0 ? weighted / seconds : null;
}

/**
 * 一组活动的**均步频** = Σ(步频 × 计时器秒数) / Σ计时器秒数（步/分钟）。
 *
 * 与心率同理：步频是速率，权重是时间。真实库近 7 天等权 177.0 vs 时长加权 181.4
 * （**-4.4 spm**）—— 短间歇的步频更高，等权会把它当成常态。
 */
export function groupCadence(samples: GroupSample[]): number | null {
  let weighted = 0;
  let seconds = 0;
  for (const s of samples) {
    const cad = s.cadence;
    if (cad == null || !Number.isFinite(cad) || cad <= 0) continue;
    const t = sampleSeconds(s);
    if (t == null) continue;
    weighted += cad * t;
    seconds += t;
  }
  return seconds > 0 ? weighted / seconds : null;
}
