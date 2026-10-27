/**
 * 海拔跨度派生（`max_altitude` / `min_altitude` 的唯一消费方）。
 *
 * ## 为什么单独一层
 *
 * `activities` 有 `avg_altitude` / `max_altitude` / `min_altitude` 三列，真实库
 * **234/348** 有值（228 跑步 + 6 田径场），且三者 NULL 模式完全一致（要么全有要么全无）。
 * 但审计发现：只有 `avg_altitude` 被 AI 数据块用过一次，`max_altitude` / `min_altitude`
 * **零消费** —— 于是「这趟起伏有多大」这个最直观的信息在 UI 与 prompt 里都不存在。
 *
 * ## 一个必须解释的「看似矛盾」
 *
 * 真实库 **191/234** 条活动的 `max - min` **小于** `total_ascent`。这不是数据错误：
 *
 * - `max - min` 是**净高差**（最高点减最低点，一圈环形路线回到起点就只有几十米）；
 * - `total_ascent` 是**累计爬升**（每次上坡都累加，来回折返的路线会远大于净高差）。
 *
 * 实测 `538279608`：min 435m / max 511m（净高差 76m）而累计爬升 194m —— 一条在
 * 435–511m 之间反复上下的小环路，两个数都对。若把「净高差 76m」当成「爬升 76m」
 * 展示，用户会以为手表少记了；若把累计爬升当净高差，又会让海拔跨度看起来不可能。
 * 故本模块只输出**净高差**，并把「累计爬升」留给既有字段，两者在文案上必须分开。
 *
 * ## 校验
 *
 * 三列虽同源，仍要防脏数据：`max < min`（写入顺序错）、跨度 > 3000m（地球表面单次
 * 跑步不可能，除非是数据错误）、非有限数 —— 任一不满足就返回 null，宁可不显示。
 */
import type { Activity } from './types';

/** 单次活动净高差上限（米）。珠峰大本营到峰顶也才 3400m，跑步不可能超过 3000m。 */
export const ELEVATION_SPAN_MAX_M = 3000;

export interface ElevationSpan {
  minM: number;
  maxM: number;
  /** 净高差（max - min），不是累计爬升。 */
  spanM: number;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 由活动行解析海拔跨度。任一列缺失或数据不自洽时返回 `null`。
 *
 * 注意**不要**用 `total_ascent` 兜底：那是累计量，语义不同（见文件头）。
 */
export function elevationSpan(
  activity: Pick<Activity, 'min_altitude' | 'max_altitude'>,
): ElevationSpan | null {
  const minM = activity.min_altitude;
  const maxM = activity.max_altitude;
  if (!finite(minM) || !finite(maxM)) return null;
  const spanM = maxM - minM;
  if (spanM < 0) return null;
  if (spanM > ELEVATION_SPAN_MAX_M) return null;
  return {
    minM: Math.round(minM * 10) / 10,
    maxM: Math.round(maxM * 10) / 10,
    spanM: Math.round(spanM * 10) / 10,
  };
}

/**
 * 净高差 vs 累计爬升的比值，用于判断「这条路线是不是反复上下」。
 *
 * - 比值 ≈ 1：单向爬升（一路向上，净高差≈累计爬升）；
 * - 比值 ≫ 1：反复折返/环形上下（真实库最高 `538279608` 194/76 = 2.55）；
 * - 净高差为 0 时返回 null（平路，比值无意义）。
 *
 * 用途：AI 数据块据此判断「爬升大但净高差小 = 短坡反复」还是「净高差大 = 持续爬坡」，
 * 两者的配速代价完全不同。
 */
export function ascentToSpanRatio(
  totalAscent: number | null | undefined,
  span: ElevationSpan | null,
): number | null {
  if (!finite(totalAscent) || totalAscent <= 0 || span == null || span.spanM <= 0) return null;
  return Math.round((totalAscent / span.spanM) * 100) / 100;
}
