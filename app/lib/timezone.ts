/**
 * 时间域单一事实源 (single source of truth)。
 *
 * 背景 (2026-10-06 修复):
 *   历史 `start_time_local` 列实际存的是 UTC (解析器误用 FIT `session.timestamp`,
 *   而它与 `session.start_time` 同值), 导致 230/230 条活动本地时间为 UTC,
 *   其中 38 条晨跑 (本地 00:00–08:00) 的**日期**被算到前一天 →
 *   月汇总/年热力图/每日里程/VDOT 趋势日期/训练负荷 ACWR 全部受影响。
 *
 * 契约 (与 scripts/testing/make-fixture-db.js 既有约定一致, 本模块使其显式化):
 *   - `start_time`       : UTC 绝对时刻, ISO 8601 带 `Z` 与毫秒, 例 `2026-10-06T07:41:39.000Z`
 *   - `start_time_local` : **本地墙钟**, ISO 8601 **无时区标记**, 例 `2026-10-06T15:41:39.000`
 *   - 二者之差 = 该活动发生时的 UTC 偏移 (本项目固定 +08:00 / Asia/Shanghai, 无夏令时)
 *
 * 为什么本地时间带不带 `Z` 很关键:
 *   - `substr(start_time_local, 1, 10)` 直接得到正确的本地日期 (分桶/日聚合依赖);
 *   - `new Date('...T15:41:39')` 在任意时区环境下都按“本地分量”解析,
 *     因此 `getHours()` 恒等于墙钟小时 —— 展示层不依赖运行环境 TZ。
 *   反之若带 `Z`, 展示结果会随服务器/浏览器时区漂移 (历史上恰好在 UTC+8 客户端“看起来对”,
 *   掩盖了真实缺陷)。
 *
 * 本模块为纯函数 (无 I/O、无全局状态), 便于单元测试穷举边界。
 */

/** 本项目恒定的当地 UTC 偏移 (分钟)。Asia/Shanghai = UTC+8, 无夏令时。 */
export const LOCAL_TZ_OFFSET_MIN = 480;

/** 当地时区 IANA 名称 (仅用于文档/诊断, 不参与计算)。 */
export const LOCAL_TZ_NAME = 'Asia/Shanghai';

const MS_PER_MIN = 60_000;

/** 判断字符串是否为“带显式时区标记”的 ISO 8601 (Z 或 ±HH:MM)。 */
export function hasExplicitTimezone(iso: string): boolean {
  return /(Z|[+-]\d{2}:?\d{2})$/i.test(iso.trim());
}

/**
 * 解析 UTC ISO 字符串为毫秒时间戳; 非法返回 null。
 *
 * 仅接受带时区标记的字符串 (含 `Z` 或 `±HH:MM`), 避免把“本地墙钟”误当 UTC。
 */
export function parseUtcMillis(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const s = iso.trim();
  if (!hasExplicitTimezone(s)) return null;
  const ms = new Date(s).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 把 UTC ISO 字符串转换为本地墙钟字符串 (无时区标记, 带毫秒)。
 *
 * @example toLocalWallClock('2026-10-06T07:41:39.000Z') // '2026-10-06T15:41:39.000'
 * @returns 非法输入返回 null
 */
export function toLocalWallClock(
  utcIso: string | null | undefined,
  offsetMin: number = LOCAL_TZ_OFFSET_MIN,
): string | null {
  const ms = parseUtcMillis(utcIso);
  if (ms == null) return null;
  return formatWallClock(ms + offsetMin * MS_PER_MIN);
}

/**
 * 把“本地墙钟”字符串按给定偏移还原为 UTC ISO 字符串 (带 `Z`)。
 *
 * @example fromLocalWallClock('2026-10-06T15:41:39.000') // '2026-10-06T07:41:39.000Z'
 * @returns 非法输入返回 null
 */
export function fromLocalWallClock(
  localWallClock: string | null | undefined,
  offsetMin: number = LOCAL_TZ_OFFSET_MIN,
): string | null {
  const ms = parseWallClockMillis(localWallClock);
  if (ms == null) return null;
  return new Date(ms - offsetMin * MS_PER_MIN).toISOString();
}

/**
 * 解析“本地墙钟”字符串为毫秒时间戳 (把它当作 UTC 分量读取, 不做时区换算)。
 * 用于在本地域内做比较/排序/分桶, 保持全流程无时区漂移。
 */
export function parseWallClockMillis(localWallClock: string | null | undefined): number | null {
  if (!localWallClock) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    localWallClock.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? '0'),
    Number((frac ?? '0').padEnd(3, '0')),
  );
  return Number.isNaN(ms) ? null : ms;
}

/** 毫秒时间戳 → 本地墙钟字符串 `YYYY-MM-DDTHH:MM:SS.sss` (按 UTC 分量读取)。 */
export function formatWallClock(ms: number): string {
  return new Date(ms).toISOString().replace(/Z$/, '');
}

/**
 * 取本地日期 `YYYY-MM-DD`。
 *
 * 优先使用 `start_time_local`; 缺失时用 `start_time` 按偏移换算 (兼容历史/异常行),
 * 都不可用返回 null。这是**分桶/日聚合的唯一入口**, 防止各处重复实现产生口径分叉。
 */
export function localDateOf(
  activity: { start_time_local?: string | null; start_time?: string | null },
  offsetMin: number = LOCAL_TZ_OFFSET_MIN,
): string | null {
  const local = activity.start_time_local;
  if (local && /^\d{4}-\d{2}-\d{2}/.test(local.trim())) return local.trim().slice(0, 10);
  const derived = toLocalWallClock(activity.start_time, offsetMin);
  return derived ? derived.slice(0, 10) : null;
}

/** 取本地月键 `YYYY-MM`; 缺失返回 null。 */
export function localMonthOf(
  activity: { start_time_local?: string | null; start_time?: string | null },
  offsetMin: number = LOCAL_TZ_OFFSET_MIN,
): string | null {
  const d = localDateOf(activity, offsetMin);
  return d ? d.slice(0, 7) : null;
}

/**
 * 本地日期区间 [startDate, endDate] (含端点, `YYYY-MM-DD`) → UTC ISO 边界对。
 *
 * 供 SQL 以 `start_time` 过滤 (UTC 列) 时把用户语义的“本地日期”正确翻译为 UTC 范围。
 * 左闭右开之外仍需闭区间末刻: 用 `23:59:59.999` 保持与原实现的字符串比较兼容。
 */
export function localDateRangeToUtc(
  startDate: string,
  endDate: string,
  offsetMin: number = LOCAL_TZ_OFFSET_MIN,
): { startUtc: string; endUtc: string } {
  const startMs = parseWallClockMillis(`${startDate}T00:00:00.000`);
  const endMs = parseWallClockMillis(`${endDate}T23:59:59.999`);
  if (startMs == null || endMs == null) {
    throw new Error(`localDateRangeToUtc: 日期格式应为 YYYY-MM-DD, 实际 "${startDate}".."${endDate}"`);
  }
  return {
    startUtc: new Date(startMs - offsetMin * MS_PER_MIN).toISOString(),
    // endDate 的本地末刻 → UTC; 用 23:59:59.999 保证含端点
    endUtc: new Date(endMs - offsetMin * MS_PER_MIN).toISOString(),
  };
}

/**
 * 当前本地日期 `YYYY-MM-DD` (基于给定的“现在”时刻, 便于测试注入)。
 * 用于默认时间窗口, 避免 `new Date().toISOString()` 在 UTC 环境/凌晨时分取到前一天。
 */
export function todayLocalDate(now: Date = new Date(), offsetMin: number = LOCAL_TZ_OFFSET_MIN): string {
  return formatWallClock(now.getTime() + offsetMin * MS_PER_MIN).slice(0, 10);
}

/**
 * 当前本地月份键 `YYYY-MM` (基于给定的“现在”时刻, 便于测试注入)。
 *
 * 为什么必须存在: `now.getFullYear()/getMonth()` 读的是**进程时区**的日历分量 ——
 * 同一个时刻, GitHub Runner (TZ=UTC) 的 11-30 17:00Z 与生产 (Asia/Shanghai)
 * 读到的月份不同 (前者 11 月、后者 12 月)。产品契约是固定 +480 业务时区,
 * 一切日历分量必须经由本模块换算, 而不是读进程分量。
 */
export function localMonthKeyOf(now: Date = new Date(), offsetMin: number = LOCAL_TZ_OFFSET_MIN): string {
  return todayLocalDate(now, offsetMin).slice(0, 7);
}

/**
 * 月份键回推 N 个月 `YYYY-MM` (按日历月, 月界安全: 1 月回推 1 = 去年 12 月)。
 */
export function localMonthKeyMinusMonths(monthKey: string, months: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey ?? '');
  if (!m) throw new Error(`localMonthKeyMinusMonths: 非法月份键 "${monthKey}"`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) - months;
  const y = Math.floor(total / 12);
  const month = (total % 12 + 12) % 12;
  return `${y}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * 本地日期回推 N 个月 (按日历月, 日越界钳制到目标月末)。
 *
 * 例: `2026-08-31` 回推 1 个月 → `2026-07-31`; `2026-03-31` 回推 1 个月 →
 * `2026-02-28`。为什么必须钳制: `Date.setMonth` 会把 3/31 的「31」顺延成
 * 4/1, 使窗口悄悄偏移 (getPersonalRecords 6months 溢出防护的通用化)。
 */
export function localDateMinusMonths(dateYmd: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd ?? '');
  if (!m) throw new Error(`localDateMinusMonths: 非法日期 "${dateYmd}"`);
  const day = Number(m[3]);
  const targetKey = localMonthKeyMinusMonths(`${m[1]}-${m[2]}`, months);
  const [ty, tm] = targetKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${targetKey}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/**
 * 任意 ISO 时刻/墙钟 → 业务时区 (+480) 墙钟串 `YYYY-MM-DDTHH:MM:SS.sss`。
 *
 * 展示层唯一入口: 带时区标记 (`Z`/`±HH:MM`) 的输入按绝对时刻换算到业务时区;
 * 无标记的输入按项目契约**已是本地墙钟**, 原样规范化 —— 两种情况都不读
 * 进程时区 (旧实现 `new Date(iso).getHours()` 在 TZ=UTC 的服务器上会把
 * UTC 时刻原样展示, 与生产 CST 用户看到的时间差 8 小时)。
 * 日期串 (`YYYY-MM-DD`) 视为当日 00:00。非法输入返回 null。
 */
export function toBusinessWallClock(iso: string | null | undefined): string | null {
  const s = (iso ?? '').trim();
  if (!s) return null;
  if (hasExplicitTimezone(s)) return toLocalWallClock(s);
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000` : s;
  const ms = parseWallClockMillis(normalized);
  return ms == null ? null : formatWallClock(ms);
}

/** 由“今天本地日期”回推 N 天的本地日期 (基于日历日, 非固定 86.4e6 毫秒)。 */
export function localDateMinusDays(baseLocalDate: string, days: number): string {
  const ms = parseWallClockMillis(`${baseLocalDate}T00:00:00.000`);
  if (ms == null) throw new Error(`localDateMinusDays: 非法本地日期 "${baseLocalDate}"`);
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** 计算两个时间 (UTC ISO ↔ 本地墙钟) 之间的偏移分钟数; 无法计算返回 null。 */
export function inferOffsetMinutes(
  utcIso: string | null | undefined,
  localWallClock: string | null | undefined,
): number | null {
  const utcMs = parseUtcMillis(utcIso);
  const localMs = parseWallClockMillis(localWallClock);
  if (utcMs == null || localMs == null) return null;
  return Math.round((localMs - utcMs) / MS_PER_MIN);
}
