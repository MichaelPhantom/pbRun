import { localDateMinusDays, todayLocalDate } from './timezone';

/**
 * 汇总页/洞察 AI 的时间窗。
 * 0 = 全部历史（用于「整体数据」口径），其余为自然日回看天数。
 * 365 不直接出现在页面选项里，供 stats 的「年」映射使用。
 */
export type TimeRangeDays = 7 | 30 | 90 | 180 | 365 | 0;

/** 页面选项顺序：近一周 → 近一月 → 近三月 → 近半年 → 全部。 */
export const TIME_RANGE_DAYS_OPTIONS: TimeRangeDays[] = [7, 30, 90, 180, 0];

/** 供 Segmented / 文案复用的短标签（避免 5 个长标签在移动端溢出）。 */
export const TIME_RANGE_LABELS: Record<TimeRangeDays, string> = {
  7: '近一周',
  30: '近一月',
  90: '近三月',
  180: '近半年',
  365: '近一年',
  0: '全部',
};

export function timeRangeLabel(days: number): string {
  return TIME_RANGE_LABELS[days as TimeRangeDays] ?? `${days}天`;
}

/**
 * 默认时间窗口 [startDate, endDate]（本地日期）。
 *
 * 2026-10-06 修复: 旧实现用 `now.toISOString()`（UTC 日期）——
 * 在本地 00:00–08:00 之间（Asia/Shanghai = UTC+8）会取到**前一天**,
 * 使默认窗口右端少一整天。现统一走 timezone 模块的本地日期。
 */
export function getDateRangeFromDays(days: TimeRangeDays): { startDate: string; endDate: string } {
  const endDate = todayLocalDate();
  // 0 = 全部历史：取一个早于本项目所有数据的日期，让聚合逻辑保持“无上界”语义。
  const startDate = days === 0 ? '2000-01-01' : localDateMinusDays(endDate, days);
  return { startDate, endDate };
}

export function parseTimeRangeDays(param: string | null): TimeRangeDays {
  if (param === 'all') return 0;
  const n = param != null ? parseInt(param, 10) : NaN;
  if (n === 7 || n === 30 || n === 90 || n === 180 || n === 365 || n === 0) return n;
  return 30;
}

/**
 * 上一个等长区间（含首尾），用于汇总 AI 的环比上下文。
 * 例: 2026-09-26 ~ 2026-10-25（30 天）→ 2026-08-27 ~ 2026-09-25。
 * 非法/倒置区间返回 null，由调用方省略环比段。
 */
export function previousDateRange(
  startDate: string,
  endDate: string,
): { startDate: string; endDate: string } | null {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(startDate) || !re.test(endDate) || startDate > endDate) return null;
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (days <= 0) return null;
  const prevEnd = localDateMinusDays(startDate, 1);
  const prevStart = localDateMinusDays(prevEnd, days - 1);
  return { startDate: prevStart, endDate: prevEnd };
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
 * 本地日期串 → ISO 周键 `YYYY-Www` (ISO 8601, 周一为一周开始)。
 *
 * **全站唯一实现**。此前同一段日历运算在四个文件里各写了一遍
 * (`insight.ts` 的 `isoWeekKey` / `insight-compare.ts` 的 `isoWeekKeyLocal` /
 * `insight-service.ts` 的 `isoWeekKeyOf` / 本文件的 `isoWeekOfLocalDay`) ——
 * 四份拷贝意味着「同一活动属于哪一周」有四个可能不一致的答案, 而周聚合正是
 * 靠这个键做分组。任何一份漂移都会让同一周在两张表里出现不同的跑量。
 *
 * 入参是**本地墙钟**字符串 (见 app/lib/timezone.ts 契约), 因此按字面日历分量
 * 计算, 不经过本地时区解析 —— 否则结果会随运行环境时区漂移 (本地串被当 UTC
 * 解析 → 在 UTC+8 服务器上整体偏移一天/一周)。
 */
export function isoWeekKey(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr ?? '');
  if (!m) return aggregateByFallback(dateStr);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return aggregateByFallback(dateStr);
  const dayNum = d.getUTCDay() || 7; // 周日→7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // 定位本周四 (ISO 规定周归属年)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * ISO 周键 → 该周的周一/周日 (本地日期, 含两端)。键非法返回 null。
 *
 * 存在的理由: 判断「某个周是否与所选区间相交」必须比较**日期**, 而不是比较
 * 字符串。历史缺陷正是拿 `YYYY-Www` 与 `YYYY-MM` 直接做 `>=` —— 两种格式
 * 的前缀长度都不同, 比较结果纯属巧合 (见 `isoWeeksBetween`)。
 */
export function isoWeekBounds(weekKey: string): { startDate: string; endDate: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey ?? '');
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (dow - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { startDate: monday.toISOString().slice(0, 10), endDate: sunday.toISOString().slice(0, 10) };
}

/**
 * 与 `[startDate, endDate]` **相交**的全部 ISO 周键 (升序, 含两端所在周)。
 *
 * 这是「周聚合窗口口径」的唯一判定入口。调用方不得自行用字符串比较筛周:
 * `'2026-W43' >= '2026-10'` 恒为真 (`W` > `1`), 于是「近一周」会把预热窗口里
 * 的 4 个旧周全部算进来 —— 真实库 7 天窗口曾显示 6 周共 191.6km, 而该窗口
 * 实际只有 26.4km。
 */
export function isoWeeksBetween(startDate: string, endDate: string): string[] {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(startDate ?? '');
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(endDate ?? '');
  if (!a || !b) return [];
  const startMs = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const endMs = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs > endMs) return [];
  const d = new Date(startMs);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1)); // 对齐到该周周一
  const out: string[] = [];
  while (d.getTime() <= endMs) {
    out.push(isoWeekKey(d.toISOString().slice(0, 10)));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
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
  if (groupBy === 'month') return `${m[1]}-${m[2]}`;
  return isoWeekKey(dateStr);
}

/** 兜底: 入参非 `YYYY-MM-DD...` 时回退到旧行为 (尽量不抛错破坏聚合)。 */
function aggregateByFallback(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr ?? '').slice(0, 7);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

