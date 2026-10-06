import { localDateMinusDays, todayLocalDate } from './timezone';

export type TimeRangeDays = 30 | 90 | 180;

export const TIME_RANGE_DAYS_OPTIONS: TimeRangeDays[] = [30, 90, 180];

/**
 * 默认时间窗口 [startDate, endDate]（本地日期）。
 *
 * 2026-10-06 修复: 旧实现用 `now.toISOString()`（UTC 日期）——
 * 在本地 00:00–08:00 之间（Asia/Shanghai = UTC+8）会取到**前一天**,
 * 使默认窗口右端少一整天。现统一走 timezone 模块的本地日期。
 */
export function getDateRangeFromDays(days: TimeRangeDays): { startDate: string; endDate: string } {
  const endDate = todayLocalDate();
  const startDate = localDateMinusDays(endDate, days);
  return { startDate, endDate };
}

export function parseTimeRangeDays(param: string | null): TimeRangeDays {
  const n = param != null ? parseInt(param, 10) : NaN;
  if (n === 30 || n === 90 || n === 180) return n;
  return 30;
}

/** 某月 startDate/endDate（用于 API 查询） */
export function monthToRange(yearMonth: string): { startDate: string; endDate: string } {
  const [y, m] = yearMonth.split('-').map(Number);
  const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endDate = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { startDate, endDate };
}

/** ISO 8601 周编号 (周一为一周开始, 第 1 周含当年首个周四); 返回 `{year, week}` */
export function isoWeekOf(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // 周日→7, 周一→1 ... 周六→6
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // 定位到本周四 (ISO 定义周归属年)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/**
 * 按聚合维度返回周期键: 月 → `YYYY-MM`; 周 → `YYYY-Www` (ISO 8601)。
 *
 * 入参是**本地墙钟**字符串 (见 app/lib/timezone.ts 契约), 因此这里按字面日历分量
 * 计算, 不经过 `new Date()` 的时区解析 —— 否则结果会随运行环境时区漂移
 * (本地串被当 UTC 解析 → 在 UTC+8 服务器上整体偏移一天/一周)。
 */
export function periodKeyOf(dateStr: string, groupBy: 'week' | 'month'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr ?? '');
  if (!m) return aggregateByFallback(dateStr);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (groupBy === 'month') return `${m[1]}-${m[2]}`;
  return isoWeekOfLocalDay(year, month, day);
}

/** 兜底: 入参非 `YYYY-MM-DD...` 时回退到旧行为 (尽量不抛错破坏聚合)。 */
function aggregateByFallback(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr ?? '').slice(0, 7);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 由本地日历分量求 ISO 周键 `YYYY-Www` (纯日历运算, 无时区参与)。 */
function isoWeekOfLocalDay(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7; // 周日→7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // 定位本周四
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
