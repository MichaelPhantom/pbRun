export type TimeRangeDays = 30 | 90 | 180;

export const TIME_RANGE_DAYS_OPTIONS: TimeRangeDays[] = [30, 90, 180];

export function getDateRangeFromDays(days: TimeRangeDays): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = now.toISOString().split('T')[0];
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  const startDate = start.toISOString().split('T')[0];
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

/** 按聚合维度返回周期键: 月 → `YYYY-MM`; 周 → `YYYY-Www` (ISO 8601) */
export function periodKeyOf(dateStr: string, groupBy: 'week' | 'month'): string {
  const date = new Date(dateStr);
  if (groupBy === 'month') {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
  const { year, week } = isoWeekOf(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
