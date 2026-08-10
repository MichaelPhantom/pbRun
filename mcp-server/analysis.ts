/**
 * pbRun MCP Server — 纯逻辑模块 (无 DB 依赖, 便于单元测试)。
 * 降采样 / 日期工具 / 心率区间 / 跨期对比 / ACWR 训练负荷分析。
 */
import type { PeriodStats, TrainingLoadPoint } from '../app/lib/types';
import { downsampleRecords } from '../app/lib/sampling';
import { hrZoneRanges } from '../app/lib/hr-zones';

export { downsampleRecords, hrZoneRanges };

/** YYYY-MM-DD 日期串 */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(value: string): boolean {
  return DATE_RE.test(value);
}

/** 校验日期参数 (可选字段可为 undefined), 非法时抛错 */
export function assertDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  toolName: string
): void {
  if (startDate !== undefined && !isDateStr(startDate)) {
    throw new Error(`${toolName}: startDate 格式应为 YYYY-MM-DD, 实际为 "${startDate}"`);
  }
  if (endDate !== undefined && !isDateStr(endDate)) {
    throw new Error(`${toolName}: endDate 格式应为 YYYY-MM-DD, 实际为 "${endDate}"`);
  }
  if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
    throw new Error(`${toolName}: startDate (${startDate}) 不能晚于 endDate (${endDate})`);
  }
}

/** 本地时区 YYYY-MM-DD */
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 生成从 startDate 到 endDate (含) 的日期串数组 */
export function eachDay(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (cur <= end) {
    out.push(localDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

const round2 = (n: number | undefined | null): number | null =>
  n == null ? null : Math.round(n * 100) / 100;

const pct = (cur: number, base: number): number | null =>
  base === 0 ? null : Math.round(((cur - base) / base) * 10000) / 100;

/** 跨期对比 delta (B 相对 A; avg_pace_diff 负值表示变快) */
export function computeCompareDelta(a: PeriodStats, b: PeriodStats): {
  distance_pct: number | null;
  duration_pct: number | null;
  avg_pace_diff: number | null;
  vdot_diff: number | null;
  training_load_pct: number | null;
} {
  return {
    distance_pct: pct(b.totalDistance, a.totalDistance),
    duration_pct: pct(b.totalDuration, a.totalDuration),
    avg_pace_diff: round2(b.avgPace != null && a.avgPace != null ? b.avgPace - a.avgPace : null),
    vdot_diff: round2(b.avgVDOT != null && a.avgVDOT != null ? b.avgVDOT - a.avgVDOT : null),
    training_load_pct: pct(b.totalTrainingLoad ?? 0, a.totalTrainingLoad ?? 0),
  };
}

export interface TrainingLoadAnalysis {
  days: number;
  startDate: string;
  endDate: string;
  total_load: number;
  avg_daily_load: number;
  acute_load: number;
  chronic_load: number;
  acwr: number | null;
  consecutive_rest_days: number;
  consecutive_training_days: number;
  recommendation: string;
  daily: { date: string; load: number; distance: number; duration: number }[];
}

/**
 * ACWR 训练负荷分析 (纯函数)。
 * @param days    分析天数窗口 (7-365)
 * @param points  日期区间内按日聚合的训练负荷 (升序, 可缺天, 缺天按 0 计)
 * @param startDate / endDate 分析区间 (YYYY-MM-DD, 含两端)
 */
export function computeTrainingLoadAnalysis(
  days: number,
  points: TrainingLoadPoint[],
  startDate: string,
  endDate: string
): TrainingLoadAnalysis {
  const loadByDate = new Map(points.map((p) => [p.date, p]));
  const daily = eachDay(startDate, endDate).map((date) => {
    const p = loadByDate.get(date);
    return { date, load: p?.load ?? 0, distance: p?.distance ?? 0, duration: p?.duration ?? 0 };
  });

  const sum = (arr: { load: number }[]) => arr.reduce((s, d) => s + d.load, 0);
  const totalLoad = sum(daily);
  const acuteLoad = sum(daily.slice(-7)) / Math.min(7, days);
  const chronicLoad = sum(daily.slice(-28)) / Math.min(28, days);
  const acwr = chronicLoad > 0 ? Math.round((acuteLoad / chronicLoad) * 100) / 100 : null;

  let consecutiveRestDays = 0;
  for (let i = daily.length - 1; i >= 0 && daily[i].load === 0; i--) consecutiveRestDays++;
  let consecutiveTrainingDays = 0;
  for (let i = daily.length - 1; i >= 0 && daily[i].load > 0; i--) consecutiveTrainingDays++;

  let recommendation: string;
  if (acwr == null || totalLoad === 0) {
    recommendation = '暂无足够训练数据, 无法计算 ACWR';
  } else if (acwr < 0.8) {
    recommendation = `ACWR=${acwr}, 训练量偏低 (欠训练), 建议在身体允许下适当增加训练量`;
  } else if (acwr <= 1.3) {
    recommendation = `ACWR=${acwr}, 处于最佳区间 (0.8-1.3), 保持当前训练节奏`;
  } else if (acwr <= 1.5) {
    recommendation = `ACWR=${acwr}, 负荷偏高 (警戒区), 建议安排 1-2 天恢复`;
  } else {
    recommendation = `ACWR=${acwr}, 负荷过高 (危险区), 受伤风险高, 建议休息 2-3 天并降低强度`;
  }

  return {
    days,
    startDate,
    endDate,
    total_load: round2(totalLoad)!,
    avg_daily_load: round2(totalLoad / days)!,
    acute_load: round2(acuteLoad)!,
    chronic_load: round2(chronicLoad)!,
    acwr,
    consecutive_rest_days: consecutiveRestDays,
    consecutive_training_days: consecutiveTrainingDays,
    recommendation,
    daily,
  };
}
