/**
 * 非跑步活动的**类型专属核心指标** —— 列表卡片 / 首页卡片 / 详情页共用的唯一来源。
 *
 * ## 为什么需要这一层
 *
 * 真实库 354 条里 **120 条非跑步**（力量 51、爬楼 30、室内有氧 9、游泳 4、
 * 篮球 3、HIIT 3、跳绳 3、乒乓 2、羽毛球 1、室内骑行 1）。此前这些活动在
 * `/list` 卡片与首页「最近活动」卡片上只有「时长 + 类型徽标」——
 * 爬楼 30 条（`distance` 全 0、`training_load` 全 null）就是一个纯空壳。
 *
 * 这是「记录栏目只有跑步」的**另一面**：不是筛选不到，而是**筛到了也看不出什么**。
 * 用户在列表里点「爬楼」看到 30 条只有时长的卡片，会得出「这些活动没记录什么」
 * 的结论 —— 而真相是详情页有楼层、AI 数据块有楼层，只有列表卡片没做。
 *
 * ## 为什么必须抽成一层
 *
 * 详情页（`ActivityDetailClient`）、`/list` 卡片（`ListClient`）、首页卡片
 * （`RecentActivityCard`）三处都需要「这个类型该显示什么核心指标」。若各自
 * 写一遍，必然漂移 —— 本项目已经吃过这个亏（配速时间基数、类型徽标条件
 * 都曾三处不一致）。故：
 *
 * - **派生规则**只有这里一份；
 * - 三个调用方只负责**排版**，不负责判断「要不要派生」。
 *
 * ## 两条纪律
 *
 * 1. **楼层只对 `floor_climbing` 派生**。山地跑的 300m 爬升是「爬了多少层楼的
 *    高度」，不是「爬了多少层楼」—— 同一个 `total_ascent ÷ 3.048` 算式在两种
 *    语义下都算得通，但结论完全不同。故类型门控在**这里**，不在调用方。
 * 2. **`total_cycles` 只对语义已确认的类型展示**（`cycleCountLabel` 白名单：
 *    游泳 / 跳绳 / 爬楼）。力量课 51 条都有 `total_cycles`（51/51），但
 *    `r(cyc, 时长) = −0.118` 否掉了「次数」假设 —— 把 73 写成「73 次」是编造。
 *    **未确认类型整格不渲染，绝不用「总计数/其他/杂项」兜底**。
 */

import { cycleCountLabel } from '@/app/lib/cycles';
import { floorsFromAscent, formatFloors } from '@/app/lib/floors';

/** 一条活动的类型专属核心指标。 */
export interface TypeMetrics {
  /**
   * 楼层数（原始数值，供需要自定义排版的调用方 —— 例如详情页概览的
   * `{ value, unit: '层', label: '楼层（约）' }`）。仅爬楼且爬升可信时非 null。
   */
  floors: number | null;
  /** 楼层展示文案（「约 15 层」）；与 `floors` 同生共死。 */
  floorsText: string | null;
  /** `total_cycles` 数值；仅语义已确认类型且字段有值时非 null。 */
  cycles: number | null;
  /** `total_cycles` 的完整标签（`label` + `unit`）；与 `cycles` 同生共死。 */
  cyclesLabel: { label: string; unit: string } | null;
}

/** 类型专属指标所需的最小活动形状（`Activity` 天然满足）。 */
export interface TypeMetricsSource {
  activity_type?: string | null;
  total_ascent?: number | null;
  total_cycles?: number | null;
}

/**
 * 派生一条活动的类型专属核心指标。
 *
 * 返回的对象**永远存在**（字段都可为 `null`），调用方按字段判空渲染 ——
 * 不要返回 `null` 让调用方再判一次「整个对象在不在」。
 */
export function typeMetricsOf(activity: TypeMetricsSource): TypeMetrics {
  // 楼层：类型门控在这里，调用方不需要知道「为什么跑步不派生」。
  const floorsValue =
    activity.activity_type === 'floor_climbing'
      ? floorsFromAscent(activity.total_ascent)
      : null;

  // 总次数：语义白名单在 `cycles.ts`，这里只做「有值 + 有语义」的合取。
  const label = cycleCountLabel(activity.activity_type);
  const cyclesValue =
    label != null && activity.total_cycles != null && Number.isFinite(activity.total_cycles)
      ? Math.round(activity.total_cycles)
      : null;

  return {
    floors: floorsValue,
    floorsText: formatFloors(floorsValue),
    cycles: cyclesValue,
    // 标签与数值同生共死：没有数值就不给标签，避免渲染出孤零零的「次划水」。
    cyclesLabel: cyclesValue == null ? null : label,
  };
}
