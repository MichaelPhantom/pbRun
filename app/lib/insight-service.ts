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
import { computeTrainingLoads, trainingLoadFetchStart } from './training-load';
import { isoWeekKey } from './date-utils';
import type { InsightParams, InsightResponse, LoadInsight, PeriodizationWeek } from './types';

/** 计算区间天数 (含端点)。 */
function rangeDays(startDate: string, endDate: string): number {
  return Math.max(1, dayOrdinal(endDate) - dayOrdinal(startDate) + 1);
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

  // 取数起点必须同时满足两件事，故只能取**更长**的那一个：
  //  - ACWR 的慢性窗口 = 28 天（`computeLoadInsight` 按年龄回溯，多余历史无影响）；
  //  - CTL/ATL/TSB 的 EWMA 预热 = `TRAINING_LOAD_WARMUP_DAYS`（210 天 ≈ 5τ）。
  // 旧实现只取 28 天（为 ACWR 定的），顺手喂给 CTL —— τ=42 下 28 天只走了 0.67τ，
  // 残差 **51%**：真实库 7 天窗口的周期化 CTL 显示 24.3 而收敛值 48.9。
  const warmupStart = trainingLoadFetchStart(startDate);

  const vdot = computeVdotTrend(db.getVdotSamples(startDate, endDate));

  const zTotals = db.getHrZoneTotals(startDate, endDate);
  // 负荷序列取「预热窗口 → 区间末」, 但周聚合仅展示所选区间
  const loadPoints = db.getDailyLoads(warmupStart, endDate);
  const dailyLoads = loadPoints.map((p) => ({
    date: p.date,
    load: p.load,
    distanceMeters: p.distance,
    duration: p.duration,
    runs: p.runs,
  }));
  const fullLoad: LoadInsight = computeLoadInsight(dailyLoads, zTotals, endDate, { startDate, endDate });
  // 周聚合已在 `computeLoadInsight` 内按区间裁好（含零跑量周），这里不再二次过滤。
  // 旧实现的两处独立错误都在这里收口：
  //  - `w.week >= startDate.slice(0, 7)`：`'2026-W43' >= '2026-10'` 恒为真，
  //    预热窗口的周全部混进来（「近一周」显示 6 周 191.6km，真实 26.4km）；
  //  - 与周期化卡各算各的窗口：同一周在两张卡上显示不同跑量。
  const load: LoadInsight = fullLoad;

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
      // 距离/时长是分档均配速与均心率的聚合权重（Σt/Σd、Σhr·t/Σt），
      // 缺了它们就只能退回「各次配速的平均」，那是错的口径。
      distanceKm: r.distanceKm,
      durationSeconds: r.durationSeconds,
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

  // 周期化: 复用同一份逐日负荷, 计算周维度 CTL/ATL/TSB 期末值。
  // 必须传 `endDate` —— 序列要补零到参考日, 否则末周的值取的是最后一个训练日。
  const weeklyLoads: Pick<PeriodizationWeek, 'week' | 'ctl' | 'atl' | 'tsb'>[] = (() => {
    const summary = computeTrainingLoads(loadPoints, endDate);
    const byWeek = new Map<string, Pick<PeriodizationWeek, 'week' | 'ctl' | 'atl' | 'tsb'>>();
    for (const p of summary.series) {
      if (p.date < startDate) continue;
      const key = isoWeekKey(p.date);
      byWeek.set(key, {
        week: key,
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
      runs: d.runs,
    })),
    weeklyLoads,
    { startDate, endDate },
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
