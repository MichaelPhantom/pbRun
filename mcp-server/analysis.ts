/**
 * pbRun MCP Server — 纯逻辑模块 (无 DB 依赖, 便于单元测试)。
 * 降采样 / 日期工具 / 心率区间 / 跨期对比 / ACWR 训练负荷分析。
 */
import type { PeriodStats, TrainingLoadPoint } from '../app/lib/types';
import { downsampleRecords } from '../app/lib/sampling';
import { hrZoneRanges } from '../app/lib/hr-zones';
import { isValidDateParam } from '../app/lib/query-params';
import { localDateMinusDays } from '../app/lib/timezone';

export { downsampleRecords, hrZoneRanges };

/** YYYY-MM-DD 日期串 (格式) */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 格式正确且为真实日历日 (拒绝 2026-02-30 等) */
export function isDateStr(value: string): boolean {
  return isValidDateParam(value);
}

/** 校验日期参数 (可选字段可为 undefined), 非法时抛错 */
export function assertDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  toolName: string
): void {
  if (startDate !== undefined && !isDateStr(startDate)) {
    throw new Error(`${toolName}: startDate 应为合法的 YYYY-MM-DD 日期, 实际为 "${startDate}"`);
  }
  if (endDate !== undefined && !isDateStr(endDate)) {
    throw new Error(`${toolName}: endDate 应为合法的 YYYY-MM-DD 日期, 实际为 "${endDate}"`);
  }
  if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
    throw new Error(`${toolName}: startDate (${startDate}) 不能晚于 endDate (${endDate})`);
  }
}

/**
 * offset → page 转换 (list_activities)。getActivities 只接受 page, 因此 offset
 * 必须是 limit 的整数倍, 否则 (page-1)*limit < offset 会**静默跳过**中间记录。
 * 非法 offset 显式抛错而非静默截断。
 */
export function offsetToPage(offset: number, limit: number): number {
  if (limit < 1) throw new Error(`limit 必须 >= 1, 实际为 ${limit}`);
  if (offset < 0) throw new Error(`offset 必须 >= 0, 实际为 ${offset}`);
  if (offset % limit !== 0) {
    throw new Error(`offset (${offset}) 必须是 limit (${limit}) 的整数倍`);
  }
  return offset / limit + 1;
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
  /** 近 7 天负荷**总量**（与主站 `LoadInsight.acute` 同口径，非日均）。 */
  acute_load: number;
  /** 近 28 天**周均**负荷（慢性窗总量 ÷ 4；与主站 `LoadInsight.chronic` 同口径）。 */
  chronic_load: number;
  /** 实际用于慢性窗的天数（< 28 表示历史不足，ACWR 为 null 的原因）。 */
  chronic_load_days: number;
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

  // ACWR 的窗口是**定长标准窗**（急性 7 天、慢性 28 天），与分析窗口 `days` 无关。
  // 旧实现 `min(28, days)` 把慢性窗截成分析窗：days=7 时急/慢窗完全重合，
  // **ACWR 恒等于 1.0、永远报「最佳区间」**（哪怕突然爆量一倍）；days=14 时慢性窗
  // 被截成非标准的 14 天。实测见 tests/unit/mcp/analysis.test.ts。
  //
  // 慢性窗直接从 `points` 回溯（工具层在 days<28 时会补取 28 天数据），**不能**只看
  // `daily`（分析窗）——否则补取的数据被丢弃，等于没补。数据纪元内的缺行 = 真休息
  // （0 负荷）；**纪元之前**的天数才是「没有数据」。
  const loadByDatePlain = new Map(points.map((p) => [p.date, p.load ?? 0]));
  const chronicDays = eachDay(localDateMinusDays(endDate, 27), endDate);
  let chronicTotal = 0;
  for (const d of chronicDays) chronicTotal += loadByDatePlain.get(d) ?? 0;
  const acuteTotal = sum(daily.slice(-7));

  // 慢性窗实际覆盖天数 = min(28, 从最早数据日到区间末)。不足 28 天（新用户 / 新装
  // 同步）时缺的天**不是**「休息 0 负荷」，把它们当 0 会把 chronic 压小、ACWR 虚高。
  // 与「周聚合夹紧」同一纪律：宁可不给值（null），不编造一个看起来正常的数。
  const firstPointDate = points.map((p) => p.date).sort()[0];
  const chronicLoadDays = firstPointDate
    ? Math.min(28, eachDay(firstPointDate, endDate).length)
    : 0;
  const hasFullChronicWindow = chronicLoadDays >= 28;
  const acuteLoad = acuteTotal;                 // 7 天总量（主站口径）
  const chronicLoad = chronicTotal / 4;         // 28 天周均（主站口径）
  const acwr =
    hasFullChronicWindow && chronicTotal > 0
      ? Math.round((acuteTotal / chronicLoad) * 100) / 100
      : null;

  let consecutiveRestDays = 0;
  for (let i = daily.length - 1; i >= 0 && daily[i].load === 0; i--) consecutiveRestDays++;
  let consecutiveTrainingDays = 0;
  for (let i = daily.length - 1; i >= 0 && daily[i].load > 0; i--) consecutiveTrainingDays++;

  let recommendation: string;
  if (acwr == null) {
    recommendation =
      totalLoad === 0
        ? '暂无足够训练数据, 无法计算 ACWR'
        : `训练历史不足 28 天（现有 ${chronicLoadDays} 天）, 无法计算可靠的 ACWR —— 缺失天数不按 0 负荷处理`;
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
    chronic_load_days: chronicLoadDays,
    acwr,
    consecutive_rest_days: consecutiveRestDays,
    consecutive_training_days: consecutiveTrainingDays,
    recommendation,
    daily,
  };
}
