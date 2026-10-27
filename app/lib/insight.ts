/**
 * 洞察 (Insight) 计算层 —— 纯函数, 无 DB / 无副作用, 便于单测。
 *
 * 输入原始行数据 (由 db.ts 读取), 输出结构化洞察指标。
 * 所有数值在请求时实时计算, 不写缓存表、不硬编码 (见 docs/data-sync.md 约定)。
 */

import type {
  DecouplingInsight,
  DecouplingPoint,
  FormTrends,
  InsightFinding,
  LoadInsight,
  PaceHrModel,
  VdotTrendFit,
} from './types';
import { isoWeekBounds, isoWeekKey, isoWeeksBetween } from './date-utils';

export { isoWeekKey } from './date-utils';

// ---------------------------------------------------------------------------
// 通用统计工具
// ---------------------------------------------------------------------------

/** 皮尔逊相关系数; 样本不足或零方差返回 null。 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}

/** 最小二乘线性回归 y = slope*x + intercept; 样本不足返回 null。 */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r: number } | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = my - slope * mx;
  const r = pearson(xs, ys) ?? 0;
  return { slope, intercept, r };
}

/** 日期串 (YYYY-MM-DD 或 ISO) → UTC 天数序号, 供回归 x 轴使用。 */
export function dayOrdinal(dateStr: string): number {
  const d = new Date(dateStr.length >= 10 ? `${dateStr.slice(0, 10)}T00:00:00Z` : dateStr);
  return Math.floor(d.getTime() / 86400000);
}

/** 数值数组均值; 空返回 null。 */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// 1. VDOT 趋势
// ---------------------------------------------------------------------------

export interface VdotSample {
  date: string; // ISO / YYYY-MM-DD
  vdot: number;
}

/**
 * 由 VDOT 样本计算: 原始散点 + 按月聚合 + 线性趋势 + 平台期判定。
 * @param samples 任意顺序的 VDOT 样本
 */
export function computeVdotTrend(samples: VdotSample[]): VdotTrendFit {
  const valid = samples
    .filter((s) => s.vdot != null && Number.isFinite(s.vdot))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const raw = valid.map((s) => ({ date: s.date.slice(0, 10), vdot: s.vdot }));

  // 按月聚合
  const byMonth = new Map<string, number[]>();
  for (const s of valid) {
    const period = s.date.slice(0, 7);
    (byMonth.get(period) ?? byMonth.set(period, []).get(period)!).push(s.vdot);
  }
  const perMonth = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, vals]) => ({
      period,
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      max: Math.max(...vals),
      min: Math.min(...vals),
      n: vals.length,
    }));

  // 线性趋势 (x=天序号)
  const xs = valid.map((s) => dayOrdinal(s.date));
  const ys = valid.map((s) => s.vdot);
  const reg = linearRegression(xs, ys);
  const slopePer30d = reg ? reg.slope * 30 : 0;
  const intercept = reg?.intercept ?? 0;

  const latest = valid.length ? valid[valid.length - 1].vdot : null;
  const meanVdot = mean(ys);

  // 平台期: 最近 60 天样本 ≥3 且趋势斜率绝对值 < 0.15 VDOT/30d
  const lastOrdinal = xs.length ? xs[xs.length - 1] : 0;
  const recentIdx = xs.map((x, i) => ({ x, y: ys[i] })).filter((p) => lastOrdinal - p.x <= 60);
  const recentReg =
    recentIdx.length >= 3
      ? linearRegression(
          recentIdx.map((p) => p.x),
          recentIdx.map((p) => p.y),
        )
      : null;
  const plateau = recentReg != null && Math.abs(recentReg.slope * 30) < 0.15;

  return {
    raw,
    perMonth,
    slopePer30d,
    intercept,
    latest,
    mean: meanVdot,
    plateau,
  };
}

// ---------------------------------------------------------------------------
// 2. 训练负荷 / ACWR
// ---------------------------------------------------------------------------

export interface DailyLoad {
  date: string; // YYYY-MM-DD (本地)
  load: number;
  distanceMeters: number;
  /** 当日总时长（秒）。**时间基数 = 计时器时间**（与配速/TSS 同一口径，见 `app/lib/pace.ts`）。 */
  duration: number;
  /**
   * 当日**跑步次数**。与「天数」是两个不同的量 —— 真实库 238 个跑步日里有 3 天
   * 跑了不止一次（`2026-06-11` ×3、`2026-03-11` ×2、`2025-11-18` ×2），全历史
   * 238 天 / 242 次。
   *
   * 为什么要区分: 周表的「次数」列此前直接累加 `n += 1`（每天一次），于是
   * 全历史显示 238 次而真实是 242 次 —— 一个**看起来对、其实是天数**的数字。
   * 日聚合是「天数」，次数必须由 SQL 的 `COUNT(*)` 提供，不能在聚合层猜。
   */
  runs: number;
}

/**
 * ISO 周键 (YYYY-Www)。**实现已统一到 `date-utils.isoWeekKey`** —— 此处仅作
 * 向后兼容的再导出。历史上这里有一份独立拷贝 (`insight-compare.ts` 也有一份),
 * 四份拷贝各自维护「同一活动属于哪一周」, 是周聚合口径漂移的根源。
 */

/** 一周的训练量合计。 */
export interface WeeklyTotals {
  km: number;
  tl: number;
  /** **跑步次数**（不是天数）。 */
  n: number;
  seconds: number;
}

/**
 * 逐日负荷 → 按 ISO 周聚合。**周聚合的唯一实现**。
 *
 * `computeLoadInsight`（训练负荷卡 + 周训练量块）和 `computePeriodization`
 * （周期化卡 + 周维度表）都走这里 —— 两处各自实现时，「次数」在一处是天数、
 * 在另一处是次数，同一周在两张表里数字不一致。
 *
 * 注意 `n` 累加的是 `d.runs`（当日真实跑步次数），不是「每个日行 +1」。
 * 缺省按 1 兜底：日聚合行只在当天确实有跑步时才存在，所以「有行 ⇒ 至少一次」
 * 是语义上成立的；兜底成 0 会凭空产生「有跑量、0 次」的怪行。
 */
export function aggregateWeeklyLoad(daily: DailyLoad[]): Map<string, WeeklyTotals> {
  const out = new Map<string, WeeklyTotals>();
  for (const d of daily) {
    const key = isoWeekKey(d.date);
    const w = out.get(key) ?? out.set(key, { km: 0, tl: 0, n: 0, seconds: 0 }).get(key)!;
    w.km += d.distanceMeters / 1000;
    w.tl += d.load;
    w.n += d.runs ?? 1;
    w.seconds += d.duration;
  }
  return out;
}

/**
 * 由逐日负荷计算: 周聚合 + 急性/慢性负荷 + ACWR + 强度分布。
 * @param daily 逐日负荷
 * @param zSeconds 各 HR 区间总秒数 (**5 元素**, 索引 0=Z1)。上游 `getHrZoneTotals`
 *   保证长度为 5（app 的 5 区模型），函数内再 `slice(0,5)` 防御设备原始 7 槽数组。
 * @param referenceDate 计算 ACWR 的"今天"; 缺省用 daily 最后一天
 * @param range 周聚合的展示区间。**ACWR 仍然吃完整的 `daily`**（它需要 28 天预热），
 *   但周序列必须裁到这个区间内 —— 否则同一页面上「训练负荷」卡的某一周会包含
 *   区间外的天数，而「周期化」卡的同一周只含区间内的天数，两处显示不同的跑量
 *   （真实库「近一周」：W43 在负荷卡 28.3km、在周期化卡 21.6km，差的是 10-19/20
 *   这两天）。缺省时退化为「不裁剪」，供纯函数单测直接调用。
 */
export function computeLoadInsight(
  daily: DailyLoad[],
  zSeconds: number[],
  referenceDate?: string,
  range?: { startDate: string; endDate: string },
): LoadInsight {
  const sorted = [...daily].sort((a, b) => (a.date < b.date ? -1 : 1));

  // 周聚合 —— 唯一实现见 `aggregateWeeklyLoad`。
  //
  // 「次数」必须是 `d.runs`（当日真实跑步次数）之和，**不是**「有数据的天数」。
  // 旧实现 `w.n += 1` 每个日行加 1，于是周表的「次数」实际是「跑步天数」：
  // 全历史显示 238 次而真实 242 次（3 天跑了不止一次）。这个错误极隐蔽 ——
  // 数字本身合理，只有在「一天两练」的日子才和真值分叉。
  const weeklyDays =
    range != null ? sorted.filter((d) => d.date >= range.startDate && d.date <= range.endDate) : sorted;
  const byWeek = aggregateWeeklyLoad(weeklyDays);

  // 区间内的每个 ISO 周都要出现（零跑量周也出现），与 `computePeriodization` 同口径。
  // 只在**显式传入 range** 时补齐：缺省时不裁剪，补齐会把数据边界外的周也画出来。
  const weekKeys = range != null ? isoWeeksBetween(range.startDate, range.endDate) : [...byWeek.keys()].sort();
  const weekly = weekKeys.map((week) => {
    const v = byWeek.get(week);
    // 截断周标记 —— 与 `computePeriodization` 的 `PeriodizationWeek.partial` 同一判定。
    // 必须在两条序列上都标：趋势图的最高柱可能来自截断周，而「峰值周跑量」只统计
    // 完整周，不标就会出现「图最高柱 ≠ 卡片峰值」的自相矛盾。
    const b = range != null ? isoWeekBounds(week) : null;
    const partial =
      b != null && range != null ? b.startDate < range.startDate || b.endDate > range.endDate : false;
    return { week, km: v?.km ?? 0, tl: v?.tl ?? 0, n: v?.n ?? 0, seconds: v?.seconds ?? 0, partial };
  });

  // 急性/慢性: 以参考日为终点回溯
  const ref = referenceDate ?? sorted[sorted.length - 1]?.date;
  let acute = 0;
  let chronic = 0;
  if (ref) {
    const refOrd = dayOrdinal(ref);
    for (const d of sorted) {
      const age = refOrd - dayOrdinal(d.date);
      if (age >= 0 && age < 7) acute += d.load;
      if (age >= 0 && age < 28) chronic += d.load;
    }
  }
  const chronicWeekly = chronic / 4;
  const acwr = chronicWeekly > 0 ? acute / chronicWeekly : 0;

  let acwrTone: LoadInsight['acwrTone'];
  if (acwr === 0) acwrTone = 'under';
  else if (acwr < 0.8) acwrTone = 'under';
  else if (acwr <= 1.3) acwrTone = 'optimal';
  else if (acwr <= 1.5) acwrTone = 'caution';
  else acwrTone = 'risk';

  // 强度分布 (5 区口径)
  // `zSeconds` 由 `getHrZoneTotals` 保证为 5 元素；这里再 slice 一次作为防御：
  // 若上游误传更长的设备原始数组 (Z6/Z7 属另一套边界方案)，混进分母会让占比失真。
  const five = zSeconds.slice(0, 5);
  const totalZ = five.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const zDistribution = five.map((sec, i) => ({
    zone: i + 1,
    seconds: sec,
    pct: totalZ > 0 ? (sec / totalZ) * 100 : 0,
  }));
  // 口径 = app 的 5 区模型 (Z1-Z5), 故低强度取 Z1+Z2、高强度取 Z4+Z5。
  // 旧实现把索引 5/6 也算进高强度, 那是设备原始 7 槽数组的 Z6/Z7。
  const lowIntensityPct = totalZ > 0 ? ((five[0] ?? 0) + (five[1] ?? 0)) / totalZ * 100 : 0;
  const highIntensityPct = totalZ > 0 ? ((five[3] ?? 0) + (five[4] ?? 0)) / totalZ * 100 : 0;

  return { weekly, acute, chronic: chronicWeekly, acwr, acwrTone, zDistribution, lowIntensityPct, highIntensityPct };
}

// ---------------------------------------------------------------------------
// 3. 有氧解耦 (Pa:HR drift)
// ---------------------------------------------------------------------------

export interface RecordSample {
  elapsed_sec: number;
  heart_rate: number | null;
  speed: number | null; // km/h（逐秒记录原单位）
  distance: number | null; // km（逐秒记录原单位）
  altitude?: number | null; // m
  temperature?: number | null; // °C
  /**
   * 逐秒功率（瓦）。**仅**用于推导功率区间占比（`powerZoneBreakdown`）。
   * 真实库 241/241 条跑步活动有值、0/107 非跑步 —— 缺失时不产出区间。
   */
  power?: number | null;
}

export interface DecouplingInput {
  activityId: number;
  date: string;
  distanceMeters: number;
  durationSeconds: number;
  records: RecordSample[];
}

/**
 * 解耦「有效移动」的下限速度: **0.5 m/s**（约 1.8 km/h，快走/起跑的门槛）。
 *
 * 为什么必须显式换算：`RecordSample.speed` 的存储单位是 **km/h**
 * （`activity_records.speed`，fit-parser `lengthUnit='km'`）。旧实现直接写
 * `speed > 0.5` 而注释写的是 `0.5 m/s` —— 实际生效的是 **0.5 km/h ≈ 0.14 m/s**，
 * 即「几乎站着不动」也会被判为有效样本。等红灯时的 GPS 漂移、起终点的手表
 * 静止采样因此会被算进前后半段均值，把 Pa:HR 比值往样本更多的那一侧稀释。
 *
 * 真实库 241 条跑步活动的逐秒 `speed` 范围 0.806–37.3 km/h，落在
 * 0.5–1.8 km/h 区间的样本共 335 条（起跑/步行段），正是旧阈值会误收的部分。
 *
 * 单位换算集中在这里，调用方只使用 km/h —— 与 `max_speed` 那次
 * 「库内单位与标签不符」的缺陷同一纪律：数字带单位名，且换算只发生一次。
 */
export const MIN_MOVING_SPEED_MS = 0.5;
export const MIN_MOVING_SPEED_KMH = MIN_MOVING_SPEED_MS * 3.6; // 1.8

/**
 * 计算单次活动的有氧解耦: 前后半段 (速度/心率) 比值的相对变化。
 * 仅使用有效记录 (hr>0 且 speed > `MIN_MOVING_SPEED_KMH`), 样本 <120 返回 null。
 * 正值 = 后半段效率下降 (心率漂移), 负值 = 后半段反而更高效。
 */
export function computeDecouplingPct(records: RecordSample[]): number | null {
  // 入口已约束 heart_rate > 0 与 speed > MIN_MOVING_SPEED_KMH, 因此下方 `?? 0` 的
  // nullish 兜底、`h > 0 ? ... : 0` 的 0 侧、以及 `r1 === 0` 均为**防御性分支**
  // (正常数据不可达); 保留以防御未来 RecordSample 放宽或外部直调。
  const valid = records.filter(
    (r) =>
      r.heart_rate != null &&
      r.heart_rate > 0 &&
      r.speed != null &&
      r.speed > MIN_MOVING_SPEED_KMH,
  );
  if (valid.length < 120) return null;
  const mid = Math.floor(valid.length / 2);
  const half = (seg: RecordSample[]) => {
    const s = seg.reduce((a, r) => a + (r.speed ?? 0), 0) / seg.length;
    const h = seg.reduce((a, r) => a + (r.heart_rate ?? 0), 0) / seg.length;
    return h > 0 ? s / h : 0;
  };
  const r1 = half(valid.slice(0, mid));
  const r2 = half(valid.slice(mid));
  if (r1 === 0) return null;
  return ((r1 - r2) / r1) * 100;
}

/** 解耦值 → 语义等级。 */
export function decouplingTone(pct: number): DecouplingPoint['tone'] {
  if (pct < 5) return 'excellent';
  if (pct < 8) return 'good';
  if (pct < 10) return 'fair';
  return 'poor';
}

/** 由多次长跑解耦计算均值与趋势。 */
export function computeDecouplingInsight(inputs: DecouplingInput[]): DecouplingInsight {
  const points: DecouplingPoint[] = [];
  for (const input of inputs) {
    const pct = computeDecouplingPct(input.records);
    if (pct == null) continue;
    points.push({
      activityId: input.activityId,
      date: input.date.slice(0, 10),
      distanceMeters: input.distanceMeters,
      paceSecPerKm:
        input.distanceMeters > 0 ? input.durationSeconds / (input.distanceMeters / 1000) : 0,
      decouplingPct: pct,
      tone: decouplingTone(pct),
    });
  }
  points.sort((a, b) => (a.date < b.date ? -1 : 1));

  const meanPct = mean(points.map((p) => p.decouplingPct));
  let trendPer30d: number | null = null;
  if (points.length >= 3) {
    const reg = linearRegression(
      points.map((p) => dayOrdinal(p.date)),
      points.map((p) => p.decouplingPct),
    );
    trendPer30d = reg ? reg.slope * 30 : null;
  }
  return { points, meanPct, trendPer30d, sampleCount: points.length };
}

// ---------------------------------------------------------------------------
// 4. 跑姿技术趋势
// ---------------------------------------------------------------------------

export interface FormSample {
  date: string;
  cadence: number | null;
  strideLength: number | null;
  groundContactMs: number | null;
  verticalOscillation: number | null;
  verticalRatio: number | null;
}

/** 按月聚合跑姿指标 (取各月均值)。 */
export function computeFormTrends(samples: FormSample[]): FormTrends {
  const byMonth = new Map<string, FormSample[]>();
  for (const s of samples) {
    const period = s.date.slice(0, 7);
    (byMonth.get(period) ?? byMonth.set(period, []).get(period)!).push(s);
  }
  const monthly = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, rows]) => ({
      period,
      n: rows.length,
      cadence: mean(rows.map((r) => r.cadence).filter((v): v is number => v != null)),
      strideLength: mean(rows.map((r) => r.strideLength).filter((v): v is number => v != null)),
      groundContactMs: mean(rows.map((r) => r.groundContactMs).filter((v): v is number => v != null)),
      verticalOscillation: mean(
        rows.map((r) => r.verticalOscillation).filter((v): v is number => v != null),
      ),
      verticalRatio: mean(rows.map((r) => r.verticalRatio).filter((v): v is number => v != null)),
    }));
  return { monthly };
}

// ---------------------------------------------------------------------------
// 5. 配速-心率建模
// ---------------------------------------------------------------------------

export interface PaceHrSample {
  paceSecPerKm: number; // >0
  heartRate: number; // >0
}

/**
 * 用稳态跑样本回归 HR = intercept + slope × 配速(min/km)。
 * 同时用阈值心率反推阈值配速。
 */
export function computePaceHrModel(
  samples: PaceHrSample[],
  thresholdHr: number | null,
): PaceHrModel {
  const valid = samples.filter((s) => s.paceSecPerKm > 0 && s.heartRate > 0);
  const xs = valid.map((s) => s.paceSecPerKm / 60); // 分/公里
  const ys = valid.map((s) => s.heartRate);
  const reg = linearRegression(xs, ys);

  const predictions: PaceHrModel['predictions'] = [];
  for (const paceSec of [270, 300, 330, 360, 390]) {
    if (reg) predictions.push({ paceSecPerKm: paceSec, hr: reg.intercept + reg.slope * (paceSec / 60) });
  }

  let thresholdPaceSecPerKm: number | null = null;
  if (reg && reg.slope !== 0 && thresholdHr != null && thresholdHr > 0) {
    const paceMinPerKm = (thresholdHr - reg.intercept) / reg.slope;
    if (paceMinPerKm > 0) thresholdPaceSecPerKm = paceMinPerKm * 60;
  }

  return {
    n: valid.length,
    slope: reg?.slope ?? 0,
    intercept: reg?.intercept ?? 0,
    r: reg?.r ?? 0,
    predictions,
    thresholdPaceSecPerKm,
    thresholdHr,
  };
}

// ---------------------------------------------------------------------------
// 6. 洞察发现 (动态生成建议)
// ---------------------------------------------------------------------------

export interface FindingInput {
  vdot: VdotTrendFit;
  load: LoadInsight;
  decoupling: DecouplingInsight;
  paceHr: PaceHrModel;
  rangeDays: number;
  /** 可选: 类别对比 (由 insight-compare 提供) 用于生成类别相关建议。 */
  categories?: import('./types').CategoryComparison;
}

/**
 * 由各项指标动态生成洞察建议 (含严重度分级与可执行动作)。
 * 这是"报告不写死"的核心: 建议随数据变化而变化。
 */
export function buildFindings(input: FindingInput): InsightFinding[] {
  const { vdot, load, decoupling, paceHr } = input;
  const findings: InsightFinding[] = [];

  // 负荷平衡
  if (load.acwrTone === 'risk') {
    findings.push({
      id: 'load-risk',
      severity: 'critical',
      title: '负荷激增风险',
      detail: '急性负荷显著高于慢性基线，受伤概率上升。',
      metric: `ACWR ${load.acwr.toFixed(2)}`,
      action: '本周减量 20–30%，优先恢复，避免新增高强度课。',
    });
  } else if (load.acwrTone === 'caution') {
    findings.push({
      id: 'load-caution',
      severity: 'warn',
      title: '负荷接近警戒',
      detail: '训练负荷增长偏快，建议控制增量节奏。',
      metric: `ACWR ${load.acwr.toFixed(2)}`,
      action: '将每周跑量增量控制在 +5% 以内。',
    });
  } else if (load.acwrTone === 'optimal') {
    findings.push({
      id: 'load-optimal',
      severity: 'positive',
      title: '负荷处于理想区间',
      detail: '急慢性负荷比均衡，是可持续提升的窗口。',
      metric: `ACWR ${load.acwr.toFixed(2)}`,
      action: '保持当前节奏，可小幅加量。',
    });
  }

  // 强度分布: 轻松跑不足是最常见的结构性问题
  if (load.lowIntensityPct > 0 && load.lowIntensityPct < 15) {
    findings.push({
      id: 'intensity-low',
      severity: 'warn',
      title: '轻松跑占比偏低',
      detail: 'Z1–Z2 有氧基础时间不足，长期会限制恢复与耐力上限。',
      metric: `Z1–Z2 ${load.lowIntensityPct.toFixed(1)}%`,
      action: '每周安排 1–2 次真正轻松的 Z1–Z2 跑，把轻松跑占比提到 15–20%。',
    });
  }

  // VDOT 平台期
  if (vdot.plateau && vdot.latest != null) {
    findings.push({
      id: 'vdot-plateau',
      severity: 'info',
      title: '跑力进入平台期',
      detail: '近期 VDOT 趋势趋平，需要新的刺激来突破。',
      metric: `VDOT ${vdot.latest.toFixed(1)}`,
      action: '引入一次 5–8 分钟 VO₂max 间歇，或调整阈值课配速以打破平台。',
    });
  } else if (vdot.slopePer30d > 0.2) {
    findings.push({
      id: 'vdot-up',
      severity: 'positive',
      title: '跑力稳步提升',
      detail: 'VDOT 呈上升趋势，训练适应良好。',
      metric: `+${vdot.slopePer30d.toFixed(2)} / 月`,
      action: '保持训练结构，继续观察趋势。',
    });
  }

  // 有氧解耦
  if (decoupling.meanPct != null) {
    if (decoupling.meanPct > 10) {
      findings.push({
        id: 'decoupling-high',
        severity: 'warn',
        title: '有氧效率下降明显',
        detail: '长跑后半段心率漂移偏大，说明配速控制或耐力储备不足。',
        metric: `解耦 ${decoupling.meanPct.toFixed(1)}%`,
        action: '长跑降低强度、以能对话的配速进行，把解耦压到 8% 以内。',
      });
    } else if (decoupling.meanPct < 5) {
      findings.push({
        id: 'decoupling-good',
        severity: 'positive',
        title: '有氧效率优秀',
        detail: '长跑后半段心率漂移很小，有氧基础扎实。',
        metric: `解耦 ${decoupling.meanPct.toFixed(1)}%`,
      });
    }
  }

  // 类别结构: 有氧效率对比 — 找出效率最低的高强度类别
  if (input.categories && input.categories.stats.length > 0) {
    const withEff = input.categories.stats.filter(
      (c) => c.efficiency != null && c.count >= 2 && c.category !== 'other',
    );
    if (withEff.length >= 2) {
      const best = withEff.reduce((a, b) => ((a.efficiency ?? 0) >= (b.efficiency ?? 0) ? a : b));
      findings.push({
        id: 'category-best',
        severity: 'info',
        title: `效率最高的训练类型：${best.label}`,
        detail: `在各类训练中，「${best.label}」的有氧效率（速度/心率）最高，说明该强度下你的经济性最好。`,
        metric: `效率 ${best.efficiency!.toFixed(4)} m/s·bpm⁻¹`,
      });
    }
  }

  // 配速-心率模型
  if (paceHr.n >= 8 && paceHr.r < -0.5 && paceHr.thresholdPaceSecPerKm != null) {
    const p = paceHr.thresholdPaceSecPerKm;
    const paceStr = `${Math.floor(p / 60)}:${String(Math.round(p % 60)).padStart(2, '0')}`;
    findings.push({
      id: 'threshold-pace',
      severity: 'info',
      title: '阈值配速估计',
      detail: '基于配速-心率回归与阈值心率反推的当前阈值配速。',
      metric: `${paceStr} /km @ ${paceHr.thresholdHr} bpm`,
      action: '阈值课可将工作段配速锚定在该值附近。',
    });
  }

  return findings;
}
