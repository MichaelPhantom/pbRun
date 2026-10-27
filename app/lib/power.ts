/**
 * 功率强度派生层（IF / TSS / 功率体重比 / FTP 来源判定）。
 *
 * ## 为什么需要这一层
 *
 * 真实库 348 条活动审计（2026-10-27）发现 4 个**设备从不写入**、但**完全可以推算**
 * 的字段，因此长期在 UI 与 AI 数据块里缺席：
 *
 * | 字段 | DB 覆盖 | 可推算性 |
 * |------|---------|----------|
 * | `intensity_factor` | **0/348** | `normalized_power / FTP`，NP 241/241、FTP 241/241 |
 * | `training_stress_score` | **0/348** | `秒/3600 × IF² × 100` |
 * | `average_power_to_weight` | **0/348** | `average_power / user_weight`，241/241 可算 |
 * | `functional_threshold_power` | **33/348** | `power_zone_boundaries[3]` 恒等于 FTP，241/241 |
 *
 * 关键实证（不是猜的）：
 *
 * 1. **`power_zone_boundaries[3]` 就是 FTP**。Garmin 功率区间数组形如
 *    `[218,267,307,338,390,4000,null,null]`，16 套实测方案的**第 4 个元素全部等于
 *    FTP**（区间占比恒为 0.646 / 0.794 / 0.906 / 1.000 / 1.151 of FTP）。33 条同时有
 *    `functional_threshold_power` 的活动里，两者**逐条完全相等（33/33）** —— 这就是
 *    把 FTP 覆盖率从 33/348 提到 241/348 的依据。
 * 2. **推算值必须落在生理合理区间**。241 条跑步活动的 IF 实测 0.417–1.060、
 *    TSS 5–138、功率体重比 1.42–5.41 W/kg，全部符合训练学常识；一旦越界说明
 *    FTP 取错或 NP 异常，此时**宁可不给**（返回 null），也不要输出 12.6 这种数字。
 *
 * ## 三个不得越界的纪律
 *
 * - **`max_power` 不参与任何派生**。真实库 241/241 有 `max_power`，但它是**逐秒
 *   瞬时峰值**：`548397123` 平均功率 306W、峰值 3866W（12.6 倍），对应 67kg 体重
 *   就是 57.7 W/kg —— 世界级场地车手冲刺约 20–25 W/kg。拿它算「最大功率体重比」
 *   会直接产出一个不存在的怪物数据。同一陷阱已在 `max_speed` 上踩过一次。
 * - **TSS 的时间基数是 `moving_time`（timer time）**，不是 `duration`。库里
 *   `duration` 存的是 FIT `total_elapsed_time`（含暂停），`moving_time` 才是
 *   `total_timer_time`；110/348 条活动的两者相差最多 7845 秒，用 `duration` 会把
 *   暂停时间算成训练负荷。
 * - **FTP 优先取设备显式值**。只有设备没写（208/241）时才回退到区间边界；
 *   两者都有时以设备为准（实测无冲突，但固件可能改口径）。
 *
 * 纯函数, 便于单测与 UI/AI 共用。
 */
import type { Activity } from './types';

/** FTP 合理区间（瓦）。低于 100 更像数据缺失，高于 600 超出业余跑者/骑行者范围。 */
export const FTP_MIN_W = 100;
export const FTP_MAX_W = 600;

/** IF 合理区间。低于 0.3 说明 NP 或 FTP 取错（几乎等于静息），高于 1.5 超出阈值可持续范围。 */
export const IF_MIN = 0.3;
export const IF_MAX = 1.5;

/** TSS 上限（单次活动）。>500 意味着近 5 小时全力阈值，跑步场景不可能。 */
export const TSS_MAX = 500;

/** 体重合理区间（公斤），用于功率体重比。 */
export const WEIGHT_MIN_KG = 30;
export const WEIGHT_MAX_KG = 200;

/** 功率体重比合理区间（W/kg）。业余跑者 1.4–5.5，>15 只可能是瞬时峰值混入。 */
export const W_PER_KG_MIN = 0.5;
export const W_PER_KG_MAX = 15;

/**
 * Garmin 功率区间数组中「阈值功率」所在的索引。
 *
 * 数组是**区间上限**序列: `[Z1上, Z2上, Z3上, Z4上, Z5上, ...]`。实测 16 套方案里
 * 第 4 个元素（索引 3）恒等于 FTP —— 因为 Garmin 把 Z4 的上界定义为阈值功率本身。
 */
export const POWER_ZONE_FTP_INDEX = 3;

/** FTP 的来源，决定展示时能否声称「设备口径」。 */
export type FtpSource = 'device' | 'zone-boundary';

export interface FtpResolution {
  watts: number;
  source: FtpSource;
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * 从 `power_zone_boundaries` 解析 FTP（设备未写显式 FTP 时的回退路径）。
 *
 * 校验不止「索引 3 在合理区间」—— 还要求前 4 个上界**严格递增**且第 5 个大于第 4 个，
 * 确认这真是一份区间数组（防止未来固件把别的语义写进同一列）。
 */
function ftpFromZoneBoundaries(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length <= POWER_ZONE_FTP_INDEX) return null;
  const b = arr.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  const ftp = b[POWER_ZONE_FTP_INDEX];
  if (!isFinitePositive(ftp) || ftp < FTP_MIN_W || ftp > FTP_MAX_W) return null;
  // 前 4 个上界必须严格递增（区间数组的基本形状），否则不是区间语义。
  for (let i = 1; i <= POWER_ZONE_FTP_INDEX; i++) {
    const prev = b[i - 1];
    const cur = b[i];
    if (!isFinitePositive(prev) || !isFinitePositive(cur) || cur <= prev) return null;
  }
  // 第 5 个上界必须存在且大于 FTP（Z5 上界；实测 4000W 这类哨兵值也算合法）。
  const z5 = b[POWER_ZONE_FTP_INDEX + 1];
  if (z5 != null && isFinitePositive(z5) && z5 <= ftp) return null;
  return ftp;
}

/**
 * 解析活动的 FTP：优先设备显式值，缺失时回退到功率区间边界。
 *
 * @returns 无法确定时返回 `null`（不猜、不填默认值 —— 编造的 FTP 会让 IF/TSS 全错）。
 */
export function resolveFtp(
  activity: Pick<Activity, 'functional_threshold_power' | 'power_zone_boundaries'>,
): FtpResolution | null {
  const device = activity.functional_threshold_power;
  if (isFinitePositive(device) && device >= FTP_MIN_W && device <= FTP_MAX_W) {
    return { watts: device, source: 'device' };
  }
  const derived = ftpFromZoneBoundaries(activity.power_zone_boundaries);
  return derived == null ? null : { watts: derived, source: 'zone-boundary' };
}

/** 强度因子 IF = NP / FTP。越界（FTP/NP 异常）时返回 null。 */
export function intensityFactor(normalizedPower: number | null | undefined, ftpWatts: number): number | null {
  if (!isFinitePositive(normalizedPower) || !isFinitePositive(ftpWatts)) return null;
  const ifv = normalizedPower / ftpWatts;
  if (ifv < IF_MIN || ifv > IF_MAX) return null;
  return Math.round(ifv * 100) / 100;
}

/**
 * 训练压力分数 TSS = (秒 / 3600) × IF² × 100。
 *
 * 定义上「1 小时全力阈值 = 100 TSS」。`seconds` 必须是**移动时间**（timer time），
 * 见文件头注释 —— 用含暂停的 elapsed 会把休息算成负荷。
 */
export function trainingStressScore(seconds: number | null | undefined, ifv: number | null): number | null {
  if (!isFinitePositive(seconds) || ifv == null || !Number.isFinite(ifv) || ifv <= 0) return null;
  const tss = (seconds / 3600) * ifv * ifv * 100;
  if (!Number.isFinite(tss) || tss <= 0 || tss > TSS_MAX) return null;
  return Math.round(tss);
}

/** 功率体重比（W/kg）= 平均功率 / 体重。 */
export function powerToWeight(
  averagePower: number | null | undefined,
  weightKg: number | null | undefined,
): number | null {
  if (!isFinitePositive(averagePower) || !isFinitePositive(weightKg)) return null;
  if (weightKg < WEIGHT_MIN_KG || weightKg > WEIGHT_MAX_KG) return null;
  const ratio = averagePower / weightKg;
  if (ratio < W_PER_KG_MIN || ratio > W_PER_KG_MAX) return null;
  return Math.round(ratio * 100) / 100;
}

/**
 * 峰值功率的合理上限倍数（相对平均功率）。
 *
 * 逐秒瞬时功率在冲刺时可以是均值的 2–3 倍，但真实库 `548397123` 是 **12.6 倍**
 * （306W → 3866W，对应 67kg 体重 57.7 W/kg；世界级场地车手冲刺约 20–25 W/kg）。
 * 这是传感器尖峰而非生理输出。故超过该倍数的 `max_power` 一律视为脏数据不展示。
 */
export const PEAK_POWER_RATIO_MAX = 3;

/**
 * 峰值功率（W），仅在「相对平均值合理」时返回，否则返回 `null`。
 *
 * 与 `max_speed` 同一处理原则：库里存的是**设备瞬时峰值**，不是可持续能力。
 * 展示时必须带「瞬时」限定，并且不能参与任何派生计算（见文件头）。
 */
export function peakPower(
  maxPower: number | null | undefined,
  averagePower: number | null | undefined,
): number | null {
  if (!isFinitePositive(maxPower) || !isFinitePositive(averagePower)) return null;
  if (maxPower / averagePower > PEAK_POWER_RATIO_MAX) return null;
  return Math.round(maxPower);
}

/** 单次活动的功率强度画像。各字段独立可为 null（输入不全时只缺那一项）。 */
export interface PowerIntensity {
  ftpW: number | null;
  ftpSource: FtpSource | null;
  intensityFactor: number | null;
  trainingStressScore: number | null;
  powerToWeight: number | null;
  /** 瞬时峰值功率（已过滤传感器尖峰），见 `peakPower`。 */
  peakPowerW: number | null;
}

/**
 * 汇总一次活动的功率强度指标。
 *
 * **设备显式值优先，推算只做回退** —— 与 FTP 的判定一致（设备口径永远比推断可靠）。
 * 真实库三列显式值全为 0/348，所以生产上走的都是推算路径；但未来固件开始写这三列时，
 * 应当直接采信，而不是用推算值覆盖它。
 *
 * 只依赖 `activities` 单行（不需要逐秒记录），因此详情页与 AI 数据块可以在同一处
 * 调用、得到同一份数字 —— 避免「UI 一个 TSS、模型另一个 TSS」。
 */
export function powerIntensity(
  activity: Pick<
    Activity,
    | 'functional_threshold_power'
    | 'power_zone_boundaries'
    | 'normalized_power'
    | 'average_power'
    | 'max_power'
    | 'average_power_to_weight'
    | 'training_stress_score'
    | 'intensity_factor'
    | 'moving_time'
    | 'duration'
    | 'user_weight'
  >,
): PowerIntensity {
  const ftp = resolveFtp(activity);
  // 显式 IF 优先（若设备将来写入），否则 NP/FTP 推算。
  const explicitIf = activity.intensity_factor;
  const ifv =
    isFinitePositive(explicitIf) && explicitIf >= IF_MIN && explicitIf <= IF_MAX
      ? Math.round(explicitIf * 100) / 100
      : ftp
        ? intensityFactor(activity.normalized_power, ftp.watts)
        : null;
  // TSS 的时间基数用移动时间；缺失时回退总时长（只有该活动没写 timer time 才会发生）。
  const seconds = activity.moving_time || activity.duration || null;
  const explicitTss = activity.training_stress_score;
  const explicitWkg = activity.average_power_to_weight;
  return {
    ftpW: ftp?.watts ?? null,
    ftpSource: ftp?.source ?? null,
    intensityFactor: ifv,
    trainingStressScore:
      isFinitePositive(explicitTss) && explicitTss <= TSS_MAX
        ? Math.round(explicitTss)
        : trainingStressScore(seconds, ifv),
    powerToWeight:
      isFinitePositive(explicitWkg) && explicitWkg >= W_PER_KG_MIN && explicitWkg <= W_PER_KG_MAX
        ? Math.round(explicitWkg * 100) / 100
        : powerToWeight(activity.average_power, activity.user_weight),
    peakPowerW: peakPower(activity.max_power, activity.average_power),
  };
}
