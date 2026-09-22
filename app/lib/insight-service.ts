/**
 * 洞察服务层 —— 编排 DB 读取与纯计算, 生成 InsightResponse。
 *
 * 与 API 路由分离, 便于单测 (mock db 模块) 与页面 (server component) 复用。
 * 所有指标实时计算, 无缓存表。
 */

import * as db from './db';
import {
  buildFindings,
  computeDecouplingInsight,
  computeFormTrends,
  computeLoadInsight,
  computePaceHrModel,
  computeVdotTrend,
  dayOrdinal,
  type DecouplingInput,
} from './insight';
import {
  computeCategoryComparison,
  computePeriodization,
  computeRouteComparison,
  computeWeatherComparison,
  type CategorySample,
  type RouteSample,
  type WeatherSample,
} from './insight-compare';
import { computeTrainingLoads } from './training-load';
import type { InsightParams, InsightResponse, LoadInsight, PeriodizationWeek } from './types';

/** 计算区间天数 (含端点)。 */
function rangeDays(startDate: string, endDate: string): number {
  return Math.max(1, dayOrdinal(endDate) - dayOrdinal(startDate) + 1);
}

/** 为 ACWR 提供 28 天预热窗口的起点。 */
function subDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** 解耦分析的最少长跑里程 (km)。 */
const DECOUPLING_MIN_KM = 10;
/** 解耦分析的记录采样上限 (避免超长活动拖慢请求)。 */
const MAX_DECOUPLING_RUNS = 20;

/**
 * 生成指定区间的完整洞察。
 * @throws 日期非法时由 db.ts 抛出
 */
export function getInsight(params: InsightParams): InsightResponse {
  const { startDate, endDate } = params;

  // ACWR 需要 28 天历史预热; 其余指标直接用所选区间
  const warmupStart = subDays(startDate, 28);

  const vdot = computeVdotTrend(db.getVdotSamples(startDate, endDate));

  const zTotals = db.getHrZoneTotals(startDate, endDate);
  // 负荷序列取"预热窗口 → 区间末", 但周聚合仅展示所选区间
  const dailyLoads = db.getDailyLoads(warmupStart, endDate).map((p) => ({
    date: p.date,
    load: p.load,
    distanceMeters: p.distance,
    duration: p.duration,
  }));
  const fullLoad: LoadInsight = computeLoadInsight(dailyLoads, zTotals, endDate);
  const rangeStartKey = startDate.slice(0, 7);
  const weeklyInRange = fullLoad.weekly.filter((w) => w.week >= `${rangeStartKey}`);
  const load: LoadInsight = { ...fullLoad, weekly: weeklyInRange };

  // 解耦: 区间的长跑, 逐条读取记录
  const longRuns = db
    .getLongRuns(startDate, endDate, DECOUPLING_MIN_KM)
    .slice(-MAX_DECOUPLING_RUNS);
  const decouplingInputs: DecouplingInput[] = longRuns.map((run) => ({
    activityId: run.activityId,
    date: run.date,
    distanceMeters: run.distanceMeters,
    durationSeconds: run.durationSeconds,
    records: db.getActivityRecordSamples(run.activityId),
  }));
  const decoupling = computeDecouplingInsight(decouplingInputs);

  const form = computeFormTrends(db.getFormSamples(startDate, endDate));

  const paceHr = computePaceHrModel(
    db.getPaceHrSamples(startDate, endDate),
    db.getLatestThresholdHr(),
  );

  const activityCount = db.getActivityCountInRange(startDate, endDate);

  // ---- v2: 类别 / 气温 / 路线 / 周期化 ----
  const rows = db.getInsightActivityRows(startDate, endDate);

  const categorySamples: CategorySample[] = rows.map((r) => ({
    name: r.name,
    distanceKm: r.distanceKm,
    durationSeconds: r.durationSeconds,
    distanceMeters: r.distanceKm * 1000,
    avgPaceSecPerKm: r.avgPaceSecPerKm,
    avgHeartRate: r.avgHeartRate,
    avgCadence: r.avgCadence,
    vdot: r.vdot,
    trainingLoad: r.trainingLoad,
  }));
  const categories = computeCategoryComparison(categorySamples);

  const weatherSamples: WeatherSample[] = rows
    .filter((r) => r.temperatureC != null)
    .map((r) => ({
      temperatureC: r.temperatureC as number,
      avgPaceSecPerKm: r.avgPaceSecPerKm,
      avgHeartRate: r.avgHeartRate,
      avgCadence: r.avgCadence,
    }));
  const weather = computeWeatherComparison(weatherSamples);

  const routeSamples: RouteSample[] = rows.map((r) => ({
    activityId: r.activityId,
    name: r.name,
    date: r.date,
    distanceKm: r.distanceKm,
    avgPaceSecPerKm: r.avgPaceSecPerKm,
    avgHeartRate: r.avgHeartRate,
  }));
  const routes = computeRouteComparison(routeSamples);

  const findings = buildFindings({
    vdot,
    load,
    decoupling,
    paceHr,
    rangeDays: rangeDays(startDate, endDate),
    categories,
  });

  // 周期化: 复用预热窗口的逐日负荷, 计算周维度 CTL/ATL/TSB 期末值
  const weeklyLoads: PeriodizationWeek[] = (() => {
    const summary = computeTrainingLoads(db.getDailyLoads(warmupStart, endDate));
    const byWeek = new Map<string, PeriodizationWeek>();
    for (const p of summary.series) {
      if (p.date < startDate) continue;
      const key = isoWeekKeyOf(p.date);
      byWeek.set(key, {
        week: key,
        km: 0,
        tl: 0,
        activities: 0,
        ctl: Math.round(p.ctl * 10) / 10,
        atl: Math.round(p.atl * 10) / 10,
        tsb: Math.round(p.tsb * 10) / 10,
      });
    }
    return [...byWeek.values()];
  })();
  const periodization = computePeriodization(
    dailyLoads.map((d) => ({
      date: d.date,
      load: d.load,
      distanceMeters: d.distanceMeters,
      duration: d.duration,
    })),
    weeklyLoads,
  );

  return {
    range: { startDate, endDate },
    activityCount,
    vdot,
    load,
    decoupling,
    form,
    paceHr,
    findings,
    categories,
    weather,
    routes,
    periodization,
  };
}

/** 本地 ISO 周键 (YYYY-Www)。 */
function isoWeekKeyOf(dateStr: string): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
