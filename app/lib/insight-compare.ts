/**
 * 洞察 v2 计算层 —— 类别 / 气温 / 路线 / 周期化对比。纯函数, 无 DB 依赖。
 */

import {
  aggregateWeeklyLoad,
  dayOrdinal,
  linearRegression,
  mean,
  type DailyLoad,
} from './insight';
import { isoWeekBounds, isoWeeksBetween } from './date-utils';
import type {
  CategoryComparison,
  CategoryStats,
  PeriodizationInsight,
  PeriodizationWeek,
  RouteComparison,
  RouteStat,
  TrainingCategory,
  WeatherBucket,
  WeatherComparison,
} from './types';

// ---------------------------------------------------------------------------
// 类别分类
// ---------------------------------------------------------------------------

export const CATEGORY_LABELS: Record<TrainingCategory, string> = {
  threshold: '乳酸阈值',
  interval: '冲刺/间歇',
  long: '长距离',
  tempo: '节奏跑',
  vo2max: '最大摄氧量',
  easy: '轻松/基础',
  race: '比赛',
  other: '其他',
};

/** 由活动名称 + 子类型 + 距离推断训练类别 (与 Garmin 中文命名约定对齐)。 */
export function classifyActivity(
  name: string | null | undefined,
  distanceKm: number,
): TrainingCategory {
  const n = (name ?? '').toLowerCase();
  // 比赛优先 (含具体赛名)
  if (/精英赛|马拉松|半马|越野赛|比赛|race|marathon|10公里精英/.test(n)) return 'race';
  if (/乳酸阈|threshold|阈值/.test(n)) return 'threshold';
  if (/无氧|冲刺|间歇|interval|sprint|vo2|最大摄氧/.test(n)) {
    if (/最大摄氧|vo2/.test(n)) return 'vo2max';
    return 'interval';
  }
  if (/节奏|tempo/.test(n)) return 'tempo';
  if (/长距离|long|lsd/.test(n) || distanceKm >= 15) return 'long';
  if (/基础|轻松|恢复|easy|recovery|慢跑/.test(n)) return 'easy';
  return 'other';
}

// ---------------------------------------------------------------------------
// 类别对比
// ---------------------------------------------------------------------------

export interface CategorySample {
  name: string | null;
  distanceKm: number;
  durationSeconds: number;
  distanceMeters: number;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
  avgCadence: number | null;
  vdot: number | null;
  trainingLoad: number | null;
}

/**
 * 将所有活动按训练类别聚合。
 * avgPace/avgHR 采用「时长加权」(以每段的 duration 为权重), 更贴近真实强度。
 */
export function computeCategoryComparison(samples: CategorySample[]): CategoryComparison {
  const groups = new Map<TrainingCategory, CategorySample[]>();
  for (const s of samples) {
    const cat = classifyActivity(s.name, s.distanceKm);
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(s);
  }

  // 总量基准 (用于占比)
  const grandKm = samples.reduce((a, r) => a + r.distanceKm, 0);
  const grandDur = samples.reduce((a, r) => a + (r.durationSeconds || 0), 0);

  const stats: CategoryStats[] = [];
  for (const [category, rows] of groups.entries()) {
    const totalKm = rows.reduce((a, r) => a + r.distanceKm, 0);
    const durSum = rows.reduce((a, r) => a + (r.durationSeconds || 0), 0);

    let wPace = 0;
    let wPaceDur = 0;
    let wHr = 0;
    let wHrDur = 0;
    let wCad = 0;
    let wCadDur = 0;
    let effSum = 0;
    let effN = 0;

    for (const r of rows) {
      const w = r.durationSeconds > 0 ? r.durationSeconds : 1;
      if (r.avgPaceSecPerKm != null && r.avgPaceSecPerKm > 0) {
        wPace += r.avgPaceSecPerKm * w;
        wPaceDur += w;
      }
      if (r.avgHeartRate != null && r.avgHeartRate > 0) {
        wHr += r.avgHeartRate * w;
        wHrDur += w;
      }
      if (r.avgCadence != null && r.avgCadence > 0) {
        wCad += r.avgCadence * w;
        wCadDur += w;
      }
      // 有氧效率 = 速度(m/s) / 心率(bpm), 越高越经济
      if (r.avgPaceSecPerKm != null && r.avgPaceSecPerKm > 0 && r.avgHeartRate != null && r.avgHeartRate > 0) {
        effSum += 1000 / r.avgPaceSecPerKm / r.avgHeartRate;
        effN += 1;
      }
    }

    stats.push({
      category,
      label: CATEGORY_LABELS[category],
      count: rows.length,
      totalKm: Math.round(totalKm * 10) / 10,
      avgDistanceKm: Math.round((totalKm / rows.length) * 100) / 100,
      avgPaceSecPerKm: wPaceDur > 0 ? wPace / wPaceDur : null,
      avgHeartRate: wHrDur > 0 ? wHr / wHrDur : null,
      avgCadence: wCadDur > 0 ? wCad / wCadDur : null,
      avgVdot: mean(rows.map((r) => r.vdot).filter((v): v is number => v != null)),
      avgTrainingLoad: mean(rows.map((r) => r.trainingLoad).filter((v): v is number => v != null)),
      efficiency: effN > 0 ? effSum / effN : null,
      kmSharePct: grandKm > 0 ? Math.round((totalKm / grandKm) * 1000) / 10 : 0,
      timeSharePct: grandDur > 0 ? Math.round((durSum / grandDur) * 1000) / 10 : 0,
      isBestEfficiency: false,
    });
  }

  // 效率最高类别 (仅统计样本 >= 2 且有效率值的类别)
  const effCandidates = stats.filter((s) => s.efficiency != null && s.count >= 2);
  let bestEfficiencyCategory: TrainingCategory | null = null;
  if (effCandidates.length >= 2) {
    const best = effCandidates.reduce((a, b) => ((a.efficiency ?? 0) >= (b.efficiency ?? 0) ? a : b));
    bestEfficiencyCategory = best.category;
    best.isBestEfficiency = true;
  }

  // 按活动数降序
  stats.sort((a, b) => b.count - a.count);
  return { stats, totalActivities: samples.length, bestEfficiencyCategory };
}

// ---------------------------------------------------------------------------
// 气温对比
// ---------------------------------------------------------------------------

export interface WeatherSample {
  temperatureC: number;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
  avgCadence: number | null;
}

const WEATHER_EDGES: { max: number; label: string }[] = [
  { max: 10, label: '<10°C' },
  { max: 18, label: '10–18°C' },
  { max: 24, label: '18–24°C' },
  { max: 28, label: '24–28°C' },
  { max: Infinity, label: '≥28°C' },
];

/** 气温分档标签 (纯函数, 与 computeWeatherComparison 同源)。非有限值返回 null。 */
export function weatherBucketOf(tempC: number | null | undefined): string | null {
  if (tempC == null || !Number.isFinite(tempC)) return null;
  const edge =
    WEATHER_EDGES.find((e) => tempC < e.max) ?? WEATHER_EDGES[WEATHER_EDGES.length - 1];
  return edge.label;
}

/** 按气温分档聚合心率/配速/效率, 用于量化高温的生理代价。 */
export function computeWeatherComparison(samples: WeatherSample[]): WeatherComparison {
  const valid = samples.filter((s) => s.temperatureC != null && Number.isFinite(s.temperatureC));
  if (valid.length === 0) return { buckets: [], sampleCount: 0 };

  const buckets = new Map<string, WeatherSample[]>();
  for (const s of valid) {
    const label = weatherBucketOf(s.temperatureC);
    if (!label) continue;
    (buckets.get(label) ?? buckets.set(label, []).get(label)!).push(s);
  }

  const out: WeatherBucket[] = [];
  for (const edge of WEATHER_EDGES) {
    const rows = buckets.get(edge.label);
    if (!rows || rows.length === 0) continue;
    const paces = rows.map((r) => r.avgPaceSecPerKm).filter((v): v is number => v != null && v > 0);
    const hrs = rows.map((r) => r.avgHeartRate).filter((v): v is number => v != null && v > 0);
    const cads = rows.map((r) => r.avgCadence).filter((v): v is number => v != null && v > 0);
    let effSum = 0;
    let effN = 0;
    for (const r of rows) {
      if (r.avgPaceSecPerKm != null && r.avgPaceSecPerKm > 0 && r.avgHeartRate != null && r.avgHeartRate > 0) {
        effSum += 1000 / r.avgPaceSecPerKm / r.avgHeartRate;
        effN += 1;
      }
    }
    out.push({
      bucket: edge.label,
      count: rows.length,
      avgHeartRate: mean(hrs),
      avgPaceSecPerKm: mean(paces),
      efficiency: effN > 0 ? effSum / effN : null,
      avgCadence: mean(cads),
    });
  }

  return { buckets: out, sampleCount: valid.length };
}

// ---------------------------------------------------------------------------
// 路线对比
// ---------------------------------------------------------------------------

export interface RouteSample {
  activityId: number;
  name: string | null;
  date: string;
  distanceKm: number;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
}

/**
 * 路线指纹: 由活动名称的"地点前缀"生成 (Garmin 命名如 "两江新区 - 乳酸阈值")。
 * 取 " - " 前的地点部分; 无分隔则用完整名称。这样同地点的不同课表可归为同一路线。
 */
export function routeKeyOf(name: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  const idx = n.indexOf(' - ');
  const place = idx > 0 ? n.slice(0, idx) : n;
  // 过滤掉纯泛化名称 (无法代表路线)
  if (/^(跑步机|跑步|室内|室外)$/.test(place)) return null;
  return place.trim() || null;
}

/** 按路线指纹聚合, 计算次数/最佳/均值/趋势。仅保留出现 >= minRuns 次的路线。 */
export function computeRouteComparison(samples: RouteSample[], minRuns = 2): RouteComparison {
  const groups = new Map<string, RouteSample[]>();
  let recognizable = 0;
  for (const s of samples) {
    const key = routeKeyOf(s.name);
    if (!key) continue;
    recognizable += 1;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  const routes: RouteStat[] = [];
  for (const [routeKey, rows] of groups.entries()) {
    if (rows.length < minRuns) continue;
    const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
    const paced = rows
      .filter((r) => r.avgPaceSecPerKm != null && r.avgPaceSecPerKm > 0)
      .sort((a, b) => a.avgPaceSecPerKm! - b.avgPaceSecPerKm!);
    const best = paced[0] ?? null;

    // 配速趋势 (负斜率 = 随时间变快)
    let trend: number | null = null;
    if (paced.length >= 3) {
      const reg = linearRegression(
        paced.map((r) => dayOrdinal(r.date)),
        paced.map((r) => r.avgPaceSecPerKm!),
      );
      trend = reg ? reg.slope * 30 : null;
    }

    routes.push({
      routeKey,
      label: routeKey,
      count: rows.length,
      avgDistanceKm: Math.round((rows.reduce((a, r) => a + r.distanceKm, 0) / rows.length) * 100) / 100,
      bestPaceSecPerKm: best?.avgPaceSecPerKm ?? null,
      avgPaceSecPerKm: mean(paced.map((r) => r.avgPaceSecPerKm!)),
      avgHeartRate: mean(rows.map((r) => r.avgHeartRate).filter((v): v is number => v != null)),
      lastDate: sorted[sorted.length - 1].date.slice(0, 10),
      paceTrendPer30d: trend,
      best: best ? { activityId: best.activityId, date: best.date.slice(0, 10), paceSecPerKm: best.avgPaceSecPerKm! } : null,
      recent: sorted.slice(-5).map((r) => ({
        activityId: r.activityId,
        date: r.date.slice(0, 10),
        paceSecPerKm: r.avgPaceSecPerKm ?? 0,
        heartRate: r.avgHeartRate,
      })),
    });
  }

  routes.sort((a, b) => b.count - a.count);
  return { routes, stravaLikeCount: recognizable };
}

// ---------------------------------------------------------------------------
// 周期化分析
// ---------------------------------------------------------------------------

/**
 * 由逐日负荷 + ISO 周聚合计算周期化洞察 (含周维度 CTL/ATL/TSB)。
 *
 * `range` 提供所选区间的日期边界（含两端）。窗口口径的判定必须用**日期**，
 * 不能用周键字符串比较：
 *   - 旧实现拿预热窗口的逐日数据全量聚合，再交给 UI 显示 —— 「近一周」会得到
 *     6 周共 191.6km（真实该窗口只有 26.4km）；
 *   - 修窗口时也不能用 `week >= startDate.slice(0,7)`：`'2026-W43' >= '2026-10'`
 *     恒为真（`W` > `1`），等于没过滤。
 *
 * 缺省 `range` 时退化为「用数据自身的最早/最晚日」，供纯函数单测直接调用。
 */
export function computePeriodization(
  daily: DailyLoad[],
  weeklyCtlAtlTsb: Pick<PeriodizationWeek, 'week' | 'ctl' | 'atl' | 'tsb'>[] | null = null,
  range?: { startDate: string; endDate: string },
): PeriodizationInsight {
  const sorted = [...daily].sort((a, b) => (a.date < b.date ? -1 : 1));
  const startDate = range?.startDate ?? sorted[0]?.date;
  const endDate = range?.endDate ?? sorted[sorted.length - 1]?.date;

  // 只聚合落在区间内的日；预热窗口（ACWR 用）不得进入周期化统计。
  const inRange = startDate && endDate ? sorted.filter((d) => d.date >= startDate && d.date <= endDate) : [];

  // 周聚合跑量/负荷/次数 —— 复用 `aggregateWeeklyLoad`（唯一实现），
  // 保证「训练负荷」和「周期化」两张表对同一周给出同一组数字。
  const byWeek = aggregateWeeklyLoad(inRange);

  // **区间内的每一个 ISO 周都必须出现**，零跑量周也不例外。
  // 旧实现只列出「有数据的周」，于是休息周直接从图和表里消失：跑量曲线看似
  // 连续、周环比波动 σ 偏小（真实库 90 天窗口 18.1% vs 含零周 45.5%）、
  // 「周均」偏高。休息周是训练结构的一部分，不能被聚合悄悄抹掉。
  const weekKeys = startDate && endDate ? isoWeeksBetween(startDate, endDate) : [...byWeek.keys()].sort();

  const loadMap = new Map((weeklyCtlAtlTsb ?? []).map((w) => [w.week, w]));
  let weeks: PeriodizationWeek[] = weekKeys.map((week) => {
    const v = byWeek.get(week);
    const extra = loadMap.get(week);
    // 截断周: 该周周一早于区间起点, 或周日晚于区间终点。这样的周只统计了区间内
    // 的那几天, 跑量天然偏小 —— 必须显式标记, 否则它会被当成「退步的一周」。
    //
    // 只在调用方**显式传入 range** 时才有「截断」概念: 缺省时区间退化为数据
    // 自身的首尾日, 此时任何一周都必然「越界」, 标记全员截断没有意义。
    const b = range != null ? isoWeekBounds(week) : null;
    const partial = b != null && startDate != null && endDate != null
      ? b.startDate < startDate || b.endDate > endDate
      : false;
    return {
      week,
      km: v ? Math.round(v.km * 10) / 10 : 0,
      tl: v ? Math.round(v.tl) : 0,
      activities: v ? v.n : 0,
      ctl: extra?.ctl ?? 0,
      atl: extra?.atl ?? 0,
      tsb: extra?.tsb ?? 0,
      partial,
    };
  });

  if (weeks.length === 0) {
    return {
      weeks: [],
      peakWeekKm: 0,
      avgWeekKm: 0,
      rampRatePerWeek: 0,
      weeklyChangeStdPct: null,
      statsBasis: 'all',
      statsWeekCount: 0,
    };
  }

  // 峰值/周均/增幅/波动只用**完整周**算。
  //
  // 旧实现把截断周也当完整周: 真实库 30 天窗口的末周只含 1 天 (4.8km), 于是
  // 「周均」从 38.9km 掉到 32.1km、「周波动 σ」从 29.2% 涨到 41.2%、「周均增幅」
  // 从 -6.84 变成 -10.26 —— 全部指向一个不存在的「断崖式减量」。
  // 区间不足 2 个完整周时 (如「近一周」) 无法只用完整周, 退化为全部周, 并把
  // 口径写进 `statsBasis` 让 UI/AI 如实声明。
  const complete = weeks.filter((w) => !w.partial);
  const basisWeeks = complete.length >= 2 ? complete : weeks;
  const statsBasis: PeriodizationInsight['statsBasis'] = complete.length >= 2 ? 'complete' : 'all';

  const kms = basisWeeks.map((w) => w.km);
  const peakWeekKm = Math.max(...kms);
  const avgWeekKm = Math.round((kms.reduce((a, b) => a + b, 0) / kms.length) * 10) / 10;

  // 平均每周增幅 (线性回归斜率)
  let rampRatePerWeek = 0;
  if (basisWeeks.length >= 2) {
    const reg = linearRegression(basisWeeks.map((_, i) => i), kms);
    rampRatePerWeek = reg ? Math.round(reg.slope * 100) / 100 : 0;
  }

  // 周环比波动标准差 (%) —— 同样只在完整周序列上算
  let weeklyChangeStdPct: number | null = null;
  const pcts: number[] = [];
  for (let i = 1; i < basisWeeks.length; i++) {
    if (basisWeeks[i - 1].km > 0) {
      pcts.push(((basisWeeks[i].km - basisWeeks[i - 1].km) / basisWeeks[i - 1].km) * 100);
    }
  }
  if (pcts.length >= 2) {
    const m = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    const variance = pcts.reduce((a, b) => a + (b - m) ** 2, 0) / pcts.length;
    weeklyChangeStdPct = Math.round(Math.sqrt(variance) * 10) / 10;
  }

  weeks = weeks.slice(-12); // 只保留最近 12 周用于展示
  return {
    weeks,
    peakWeekKm,
    avgWeekKm,
    rampRatePerWeek,
    weeklyChangeStdPct,
    statsBasis,
    statsWeekCount: basisWeeks.length,
  };
}
