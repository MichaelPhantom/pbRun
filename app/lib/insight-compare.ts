/**
 * 洞察 v2 计算层 —— 类别 / 气温 / 路线 / 周期化对比。纯函数, 无 DB 依赖。
 */

import {
  dayOrdinal,
  linearRegression,
  mean,
  type DailyLoad,
} from './insight';
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
    });
    void durSum;
  }

  // 按活动数降序
  stats.sort((a, b) => b.count - a.count);
  return { stats, totalActivities: samples.length };
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

/** 按气温分档聚合心率/配速/效率, 用于量化高温的生理代价。 */
export function computeWeatherComparison(samples: WeatherSample[]): WeatherComparison {
  const valid = samples.filter((s) => s.temperatureC != null && Number.isFinite(s.temperatureC));
  if (valid.length === 0) return { buckets: [], sampleCount: 0 };

  const buckets = new Map<string, WeatherSample[]>();
  for (const s of valid) {
    const edge = WEATHER_EDGES.find((e) => s.temperatureC < e.max) ?? WEATHER_EDGES[WEATHER_EDGES.length - 1];
    (buckets.get(edge.label) ?? buckets.set(edge.label, []).get(edge.label)!).push(s);
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

/** 由逐日负荷 + ISO 周聚合计算周期化洞察 (含周维度 CTL/ATL/TSB)。 */
export function computePeriodization(
  daily: DailyLoad[],
  weeklyCtlAtlTsb: PeriodizationWeek[] | null = null,
): PeriodizationInsight {
  // 周聚合跑量/负荷/次数
  const byWeek = new Map<string, { km: number; tl: number; n: number }>();
  for (const d of [...daily].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const key = isoWeekKeyLocal(d.date);
    const w = byWeek.get(key) ?? byWeek.set(key, { km: 0, tl: 0, n: 0 }).get(key)!;
    w.km += d.distanceMeters / 1000;
    w.tl += d.load;
    w.n += 1;
  }

  const loadMap = new Map((weeklyCtlAtlTsb ?? []).map((w) => [w.week, w]));
  let weeks: PeriodizationWeek[] = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, v]) => {
      const extra = loadMap.get(week);
      return {
        week,
        km: Math.round(v.km * 10) / 10,
        tl: Math.round(v.tl),
        activities: v.n,
        ctl: extra?.ctl ?? 0,
        atl: extra?.atl ?? 0,
        tsb: extra?.tsb ?? 0,
      };
    });

  if (weeks.length === 0) {
    return { weeks: [], peakWeekKm: 0, avgWeekKm: 0, rampRatePerWeek: 0, weeklyChangeStdPct: null };
  }

  const kms = weeks.map((w) => w.km);
  const peakWeekKm = Math.max(...kms);
  const avgWeekKm = Math.round((kms.reduce((a, b) => a + b, 0) / kms.length) * 10) / 10;

  // 平均每周增幅 (线性回归斜率)
  let rampRatePerWeek = 0;
  if (weeks.length >= 2) {
    const reg = linearRegression(weeks.map((_, i) => i), kms);
    rampRatePerWeek = reg ? Math.round(reg.slope * 100) / 100 : 0;
  }

  // 周环比波动标准差 (%)
  let weeklyChangeStdPct: number | null = null;
  const pcts: number[] = [];
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i - 1].km > 0) {
      pcts.push(((weeks[i].km - weeks[i - 1].km) / weeks[i - 1].km) * 100);
    }
  }
  if (pcts.length >= 2) {
    const m = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    const variance = pcts.reduce((a, b) => a + (b - m) ** 2, 0) / pcts.length;
    weeklyChangeStdPct = Math.round(Math.sqrt(variance) * 10) / 10;
  }

  weeks = weeks.slice(-12); // 只保留最近 12 周用于展示
  return { weeks, peakWeekKm, avgWeekKm, rampRatePerWeek, weeklyChangeStdPct };
}

/** 本地 ISO 周键 (与 insight.isoWeekKey 语义一致, 但独立避免循环引入)。 */
function isoWeekKeyLocal(dateStr: string): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
