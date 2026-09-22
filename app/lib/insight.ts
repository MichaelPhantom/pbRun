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
  duration: number;
}

/** ISO 周键 (YYYY-Www)。 */
export function isoWeekKey(dateStr: string): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 由逐日负荷计算: 周聚合 + 急性/慢性负荷 + ACWR + 强度分布。
 * @param daily 逐日负荷
 * @param zSeconds 各 HR 区间总秒数 (7 元素, 索引 0=Z1)
 * @param referenceDate 计算 ACWR 的"今天"; 缺省用 daily 最后一天
 */
export function computeLoadInsight(
  daily: DailyLoad[],
  zSeconds: number[],
  referenceDate?: string,
): LoadInsight {
  const sorted = [...daily].sort((a, b) => (a.date < b.date ? -1 : 1));

  // 周聚合
  const byWeek = new Map<string, { km: number; tl: number; n: number; seconds: number }>();
  for (const d of sorted) {
    const key = isoWeekKey(d.date);
    const w = byWeek.get(key) ?? byWeek.set(key, { km: 0, tl: 0, n: 0, seconds: 0 }).get(key)!;
    w.km += d.distanceMeters / 1000;
    w.tl += d.load;
    w.n += 1;
    w.seconds += d.duration;
  }
  const weekly = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, v]) => ({ week, ...v }));

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

  // 强度分布
  const totalZ = zSeconds.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const zDistribution = zSeconds.map((sec, i) => ({
    zone: i + 1,
    seconds: sec,
    pct: totalZ > 0 ? (sec / totalZ) * 100 : 0,
  }));
  const lowIntensityPct = totalZ > 0 ? ((zSeconds[0] ?? 0) + (zSeconds[1] ?? 0)) / totalZ * 100 : 0;
  const highIntensityPct =
    totalZ > 0 ? ((zSeconds[3] ?? 0) + (zSeconds[4] ?? 0) + (zSeconds[5] ?? 0) + (zSeconds[6] ?? 0)) / totalZ * 100 : 0;

  return { weekly, acute, chronic: chronicWeekly, acwr, acwrTone, zDistribution, lowIntensityPct, highIntensityPct };
}

// ---------------------------------------------------------------------------
// 3. 有氧解耦 (Pa:HR drift)
// ---------------------------------------------------------------------------

export interface RecordSample {
  elapsed_sec: number;
  heart_rate: number | null;
  speed: number | null; // m/s
  distance: number | null; // m
}

export interface DecouplingInput {
  activityId: number;
  date: string;
  distanceMeters: number;
  durationSeconds: number;
  records: RecordSample[];
}

/**
 * 计算单次活动的有氧解耦: 前后半段 (速度/心率) 比值的相对变化。
 * 仅使用有效记录 (hr>0 且 speed>0.5m/s), 样本 <120 返回 null。
 * 正值 = 后半段效率下降 (心率漂移), 负值 = 后半段反而更高效。
 */
export function computeDecouplingPct(records: RecordSample[]): number | null {
  const valid = records.filter(
    (r) => r.heart_rate != null && r.heart_rate > 0 && r.speed != null && r.speed > 0.5,
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
