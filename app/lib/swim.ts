/**
 * 游泳 SWOLF —— 池长、趟数、SWOLF 的唯一派生层。
 *
 * ## 为什么需要这一层
 *
 * 游泳（真实库 4 条，但它是**唯一有「技术效率」可量化**的运动）此前只有
 * 「每 100m 配速」和「划频」两个孤立数字。而游泳圈真正的技术指标是 **SWOLF**：
 *
 *     SWOLF = 单趟用时（秒）+ 单趟划水次数
 *
 * 它把「快」和「省」合成一个数：同样 25m，48 秒 + 20 划 = 68，比 40 秒 + 32 划 = 72
 * 更高效（后者虽然快但每一划推进距离短）。单看配速会误判成后者更好。
 *
 * ## 数据从哪来（全部是 FIT 原始字段，本轮才读进库）
 *
 * | 字段 | 用途 | 真实库 |
 * |------|------|--------|
 * | `pool_length` | 池长（米），SWOLF 的基准 | 4/4 |
 * | `num_active_lengths` | 活跃趟数（不含休息） | 4/4 |
 * | `total_cycles` | 总划水次数 | 4/4 |
 * | `moving_time` | 计时器时间（含池边休息？不含 —— 见下） | 4/4 |
 *
 * ## 两条自证不变式（实测都精确成立）
 *
 * 1. **`num_active_lengths × pool_length == total_distance`** ——
 *    775 = 31×25、1075 = 43×25、2200 = 44×50、2050 = 41×50，4/4 精确相等。
 *    这条证明「趟数」与「池长」两个字段都没读错，且距离是泳池整趟累加。
 * 2. **`total_cycles ÷ num_active_lengths` = 每趟划水次数**，落在 16.7–21.0，
 *    与游泳常识（25m 自由泳 16–22 划）吻合。
 *
 * ## SWOLF 绝不能跨池长比较
 *
 * 50m 池的单趟用时和划水次数都约为 25m 池的 2 倍，SWOLF 自然也翻倍。
 * 真实库实测：25m 池两条 SWOLF 58 / 65，50m 池两条 75 / 62 —— 直接比会得出
 * 「25m 池更高效」的错误结论。**折算是错的**（把 50m 的 SWOLF ÷2 会得到 37，
 * 远低于任何真实 25m 值，因为转身与蹬壁在长池里被摊薄）。
 * 故本模块只输出 `{ swolf, poolLengthM }`，展示时必须**同时给出池长**。
 *
 * ## 时间基数
 *
 * 用**活跃 lap 的计时器时间之和**，不是活动 `moving_time`。原因：`moving_time`
 * 含池边休息（真实库 599287904 有 804 秒休息段），用它算「单趟用时」会把休息
 * 摊进每一趟，SWOLF 虚高。调用方负责传入活跃时间（见 `activeSwimSeconds`）。
 */

/** 单次活动 SWOLF 结果。`poolLengthM` 必须一起展示 —— SWOLF 只在同池长内可比。 */
export interface SwolfResult {
  /** SWOLF 值（单趟秒数 + 单趟划水次数），四舍五入到整数。 */
  swolf: number;
  /** 池长（米）。25 或 50，用于标注「SWOLF 58（25m 池）」。 */
  poolLengthM: number;
}

/** 单趟用时上限（秒）。50m 池世界纪录约 21s，业余 25m 池单趟 20–90s。 */
export const SWIM_SEC_PER_LENGTH_MAX = 180;

/** 单趟划水次数上限。25m 蝶泳约 8–10 划，蛙泳 15–25 划；超过 60 只可能是脏数据。 */
export const SWIM_STROKES_PER_LENGTH_MAX = 60;

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 由趟数与池长验证距离自洽（自证不变式 1）。
 *
 * 返回 `true` 表示 `num_active_lengths × pool_length` 与 `distanceM` 相差 < 1m
 * （设备距离可能带小数，留 1m 容差）。
 *
 * 为什么需要它：这两个字段是**独立**从 FIT 读的，若解析时单位搞错（比如
 * `pool_length` 的 scale 是 100，即 FIT 里存的是厘米），乘积会离谱地大。
 * 用它做守卫，比单看某个字段更可靠。
 */
export function swimDistanceConsistent(
  activeLengths: number | null | undefined,
  poolLengthM: number | null | undefined,
  distanceM: number | null | undefined,
): boolean {
  if (!finite(activeLengths) || !finite(poolLengthM) || !finite(distanceM)) return false;
  if (activeLengths <= 0 || poolLengthM <= 0 || distanceM <= 0) return false;
  return Math.abs(activeLengths * poolLengthM - distanceM) < 1;
}

/**
 * 派生 SWOLF。任一输入不可信时返回 `null`（整项不渲染）。
 *
 * 参数全部是**原始单位**：
 * - `activeSeconds` 活跃 lap 的计时器秒数之和（不含休息）；
 * - `activeLengths` 活跃趟数（`num_active_lengths`）；
 * - `totalCycles` 总划水次数（`total_cycles`）；
 * - `poolLengthM` 池长（`pool_length`，米）。
 *
 * 返回 `null` 的情形（都是「宁可不显示」）：
 * - 任一输入缺失/非有限数/`<= 0`；
 * - 单趟用时或单趟划水次数超出物理合理范围（见两个 `*_MAX` 常量）；
 * - SWOLF 本身超出合理范围（下限 20 秒 + 5 划 = 25；上限 180 + 60 = 240）。
 */
export function swolfOf(
  activeSeconds: number | null | undefined,
  activeLengths: number | null | undefined,
  totalCycles: number | null | undefined,
  poolLengthM: number | null | undefined,
): SwolfResult | null {
  if (
    !finite(activeSeconds) || activeSeconds <= 0 ||
    !finite(activeLengths) || activeLengths <= 0 ||
    !finite(totalCycles) || totalCycles <= 0 ||
    !finite(poolLengthM) || poolLengthM <= 0
  ) {
    return null;
  }

  const secPerLength = activeSeconds / activeLengths;
  const strokesPerLength = totalCycles / activeLengths;

  // 物理合理性守卫。单趟 20s 以下只可能是池长读错（比如把 25m 读成 2.5m），
  // 单趟 3 分钟以上通常是休息被算进了活跃时间。
  if (secPerLength < 5 || secPerLength > SWIM_SEC_PER_LENGTH_MAX) return null;
  if (strokesPerLength < 1 || strokesPerLength > SWIM_STROKES_PER_LENGTH_MAX) return null;

  const swolf = Math.round(secPerLength + strokesPerLength);
  if (swolf < 25 || swolf > 240) return null;

  return { swolf, poolLengthM: Math.round(poolLengthM) };
}

/**
 * SWOLF 展示文案。**必须带池长** —— 25m 池的 58 与 50m 池的 58 完全不是一回事。
 *
 * `null` → `null`（调用方整项略去）。
 */
export function formatSwolf(result: SwolfResult | null | undefined): string | null {
  if (!result || !finite(result.swolf) || !finite(result.poolLengthM)) return null;
  return `${Math.round(result.swolf)}（${Math.round(result.poolLengthM)}m 池）`;
}

/** `activeSwimSeconds` 需要的最小 lap 形状（只依赖距离与两个时间列）。 */
export interface SwimLapLike {
  distance: number | null;
  moving_time?: number | null;
  duration?: number | null;
}

/**
 * 活跃 lap 的计时器秒数之和（SWOLF 的时间基数）。
 *
 * ## 为什么不能用活动级 `moving_time`
 *
 * 真实库 `599287904` 的 `moving_time = 2088s`，但其中 **804 秒是池边休息**
 * （0 距离 lap）。用 2088 算单趟用时会把休息摊到每一趟：
 * 2088/31 = 67.4s + 16.7 划 = SWOLF 84，而真实值是 58 —— 差 26 分，
 * 直接把一次不错的训练读成「效率很差」。
 *
 * ## 口径
 *
 * 只累加 `distance > 0` 的 lap，每个 lap 取 `moving_time`（计时器时间），
 * 缺失时回退 `duration` —— 与全站 `effectiveTimeSec` 同一优先级。
 *
 * 真实库 4/4 条与 FIT 直接算出的活跃时间**精确相等**（1283 / 2010 / 2370 / 1862）。
 * 注意 `617083438` 是 2370 而非 2369：lap 级四舍五入与 session 级差 1 秒，
 * 对 SWOLF 无影响（75 与 75）。
 */
export function activeSwimSeconds(laps: ReadonlyArray<SwimLapLike> | null | undefined): number | null {
  if (!Array.isArray(laps) || laps.length === 0) return null;
  let total = 0;
  let any = false;
  for (const l of laps) {
    const d = l?.distance;
    if (!finite(d) || d <= 0) continue; // 0 距离休息段不计入
    const mt = l.moving_time;
    const du = l.duration;
    const sec = finite(mt) && mt > 0 ? mt : finite(du) && du > 0 ? du : null;
    if (sec == null) continue;
    total += sec;
    any = true;
  }
  return any && total > 0 ? total : null;
}
