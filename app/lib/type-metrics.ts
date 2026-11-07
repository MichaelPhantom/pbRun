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
 * 3. **力量课的 `total_cycles` 不可用，但「有效组数」可用** —— 两者是完全不同的
 *    字段，不要因为前者被否掉就连后者一起丢。力量课 49/51 有 `workout_steps`
 *    （组结构 JSON），`buildStrengthProfile()` 从中数出 `workingSets`（active/
 *    interval 且非循环控制步）。这是**真实可推导**的（详情页与 AI 都在用），
 *    卡片上也必须给 —— 否则 51 条力量（第二大类）依然只有「时长 + 负荷 + 徽标」。
 */

import { cycleCountLabel, cycleLapLabel } from '@/app/lib/cycles';
import { floorsFromAscent, formatFloors } from '@/app/lib/floors';
import { buildStrengthProfile, isStrengthType } from '@/app/lib/strength';

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
  /**
   * `total_cycles` 的**分段表列头**形态（`label` + `unit`）；与 `cycles` 同生共死。
   *
   * 与 `cyclesLabel` 的唯一区别是单位形态：`cyclesLabel.unit` 是**散文**用的
   * （「189 次跳跃」「307 步」），而 `DataTable` 把 `unit` 渲染成标签下方的
   * 独立一行小字 —— 直接搬过去就读成「跳跃次数 / 次跳跃」。
   *
   * 详情页此前靠 `swimming ? '划水次数' : ...` + `swimming ? '次' : unit`
   * 两条硬编码特例让游泳那格碰巧正确。**调用方不该按类型分支**，故两套形态
   * 都在这里给出（派生仍全部来自 `cycles.ts` 的单一白名单）。
   */
  cyclesLapLabel: { label: string; unit: string } | null;
  /**
   * 力量课的**有效组数**（active/interval 且非循环控制步的步数）。
   *
   * 与 `cycles` 是两个完全不同的字段：力量课 51 条都有 `total_cycles` 但语义
   * 未确认（`r(cyc, 时长) = −0.118`），而 `workingSets` 是从 `workout_steps`
   * 的组结构数出来的，语义明确（详情页「有效组数」与 AI 数据块都在用）。
   * 仅 `strength_training` 且 `workout_steps` 可解析时非 null。
   */
  workingSets: number | null;
}

/** 类型专属指标所需的最小活动形状（`Activity` 天然满足）。 */
export interface TypeMetricsSource {
  activity_type?: string | null;
  total_ascent?: number | null;
  total_cycles?: number | null;
  /** 力量课组结构 JSON（`strength_training` 专用，49/51 有值）。 */
  workout_steps?: unknown;
  /** 力量课计划名回落链的一环（`buildStrengthProfile` 需要）。 */
  name?: string | null;
  workout_name?: string | null;
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
  // 分段表列头形态（「跳跃次数 / 次」）。与散文形态同源，只是单位不带名词。
  const lapLabel = cycleLapLabel(activity.activity_type);
  const cyclesValue =
    label != null && activity.total_cycles != null && Number.isFinite(activity.total_cycles)
      ? Math.round(activity.total_cycles)
      : null;

  // 力量课的有效组数。**不是** `total_cycles` 的替身 —— 前者来自组结构
  // （`workout_steps` 里 active/interval 的步数），后者是设备计的数字且语义
  // 未确认。两者可以同时为 null（没有课表的力量课），也可以一个有值另一个没有。
  //
  // 门控：① 只对 `strength_training`；② `workingSets > 0` 才给 —— 没有
  // `workout_steps` 的 2 条力量课会得到 0，显示「0 组」是把「没课表」读成
  // 「没做组」，那是假数据。
  const sets = isStrengthType(activity.activity_type)
    ? buildStrengthProfile(activity).workingSets
    : 0;

  return {
    floors: floorsValue,
    floorsText: formatFloors(floorsValue),
    cycles: cyclesValue,
    // 标签与数值同生共死：没有数值就不给标签，避免渲染出孤零零的「次划水」。
    cyclesLabel: cyclesValue == null ? null : label,
    cyclesLapLabel: cyclesValue == null ? null : lapLabel,
    workingSets: sets > 0 ? sets : null,
  };
}
