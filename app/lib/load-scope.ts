/**
 * **「训练负荷」口径标签的唯一来源** —— 首页 / `/analysis` / `/stats` 三处共用。
 *
 * ## 为什么需要这一层（第十八类缺陷）
 *
 * 同一个词「训练负荷」在页面上是**两个不同口径**，而三处都没标注：
 *
 * | 页面 | 数据源 | 口径 | 真实库 2026-08 |
 * |------|--------|------|----------------|
 * | 首页「本月概览」 | `getCombinedTrainingLoads` | 跑步 + 力量 | **2004** |
 * | `/analysis` 负荷图 | `getCombinedTrainingLoads` | 跑步 + 力量 | 2004 |
 * | `/stats` 训练负荷 | `getStats`（带 `runningTypeClause`） | **纯跑步** | **1715** |
 *
 * 差 **289（17%）**。2026-02 差 298（17%）、2026 全年 15668 vs 17171（+1503）、
 * 全历史 18122 vs 19788（+1666）。用户在首页
 * 看到「训练负荷 2004」、点「全部统计 →」过去看到「训练负荷 1715」—— 两个
 * 数字都叫同一个名字，既不知道谁对，也不知道差在哪。
 *
 * 更隐蔽的是**首页同一行四格两种口径**：本月距离 / 跑步天数 / 平均配速 都来自
 * 跑步口径（`getTrainingLoads` 的 `distance`/`runs`/`duration`），唯独训练负荷
 * 是合并口径（力量只加 `load`，见 `mergeStrengthIntoTrainingLoads`）。四格并列
 * 时没人会怀疑第四个。
 *
 * **两个口径本身都对**：力量课对 CTL/ATL/TSB 的贡献不该恒为 0（合并口径），
 * `/stats` 是「跑步数据统计」（跑步口径）。错的只是**同一个词没有限定语**。
 *
 * ## 三条纪律
 *
 * 1. **标签与数值同源**：hint 里的力量负荷必须来自页面**同一份**力量汇总
 *    （首页是 `strengthThisMonth.totalLoad`），不许另算一遍 —— 否则 hint 会和
 *    力量卡上的「本月负荷」对不上。本项目已在配速时间基数、类型徽标上各吃过
 *    一次「同一规则两处各写一遍」的亏。
 * 2. **0 也要说清**：没有力量负荷时，合并值恰好等于跑步值。此时 hint 必须写
 *    「跑步口径（无力量负荷）」，而不是继续挂「合并」—— 后者会让用户以为那两个
 *    数不同，反而制造怀疑。
 * 3. **脏数据按 0**：`NaN` / `Infinity` / 负数一律当作「无力量负荷」。hint 上
 *    出现「力量负荷 NaN」比不显示更糟。
 *
 * 措辞为什么用「力量负荷 N」而不是「含力量」：用户要的是**能对账的数**。
 * 首页力量卡上就有「本月负荷 100」，hint 写 100 才能当场自证
 * `合并值 − 力量值 = 跑步值`。
 */

/** 合并口径（跑步 + 力量）的短标签。 */
export const LOAD_SCOPE_COMBINED = '跑步 + 力量合并';

/** 纯跑步口径的短标签。 */
export const LOAD_SCOPE_RUNNING = '跑步口径';

/**
 * 里程口径的 hint —— **距离也是跑步口径**。
 *
 * 真实库 2026 年：跑步口径 1893.3km vs 全类型 1903.53km（差 10.23km，来自
 * 游泳 4 条 + 球类 6 条）。数字小不代表口径可以不标 —— 用户拿首页「本月距离」
 * 与 Garmin 上的总里程对不上时，没有任何线索说明差在哪。
 *
 * 注意：**力量训练距离恒为 0**，所以首页「本月距离」的差值不来自力量，而来自
 * 游泳/球类 —— 措辞必须点对类型，否则用户会去力量卡里找那 10km。
 */
export const DISTANCE_SCOPE_HINT = `${LOAD_SCOPE_RUNNING}（不含游泳/球类）`;

/**
 * 把力量负荷归一成「可展示的非负数」。
 *
 * 小于 0.5 视为 0 —— 与力量卡上的 `totalLoad.toFixed(0)` 同一舍入，
 * 否则会出现「hint 说力量负荷 0，卡片上也写 0，但 hint 仍挂『合并』」。
 */
function normalizeStrengthLoad(load: number | null | undefined): number {
  if (load == null || !Number.isFinite(load)) return 0;
  const n = Math.round(load);
  return n > 0 ? n : 0;
}

/**
 * 首页「本月概览」训练负荷的 hint。
 *
 * @param strengthLoad 当月力量负荷（必须与力量卡「本月负荷」同源）
 */
export function monthLoadScopeHint(strengthLoad: number | null | undefined): string {
  const n = normalizeStrengthLoad(strengthLoad);
  if (n === 0) return `${LOAD_SCOPE_RUNNING}（本月无力量负荷）`;
  return `${LOAD_SCOPE_COMBINED}（力量负荷 ${n}）`;
}

/**
 * `/analysis` 训练负荷图（合并口径）的 hint。
 *
 * 分析页的负荷图在上、力量卡在下 —— 不在这里说明占比，用户看到 ACWR 变化
 * 却找不到原因。
 *
 * @param strengthLoad 区间内力量负荷
 * @param combinedLoad 区间内合并总负荷（分母）
 */
export function combinedLoadScopeHint(
  strengthLoad: number | null | undefined,
  combinedLoad: number | null | undefined,
): string {
  const n = normalizeStrengthLoad(strengthLoad);
  const total =
    combinedLoad != null && Number.isFinite(combinedLoad) && combinedLoad > 0 ? combinedLoad : 0;
  if (n === 0 || total === 0) return `${LOAD_SCOPE_RUNNING}（区间内无力量负荷）`;
  const share = (n / total) * 100;
  return `合并口径：含力量负荷 ${n}（占 ${share.toFixed(1)}%）`;
}

/**
 * `/stats` 九格统计的 hint。
 *
 * `/stats` 的 SQL 带 `runningTypeClause`，九格**全部**是跑步口径 —— 一句话
 * 覆盖九格，不必逐格标注。
 */
export const STATS_SCOPE_HINT = `${LOAD_SCOPE_RUNNING}：距离/配速/负荷/心率/步频等均只统计跑步，不含力量训练`;

/**
 * `/stats` 的「当前跑力」hint —— **它不跟随所选周期**（第十九类缺陷）。
 *
 * 页面固定二次取数 `getStats('week')`，故无论切到周/月/年/总，「当前跑力」
 * 都是**最近 7 天**的平均 VDOT，而其余八格跟随 `period`。
 *
 * 真实库：近 7 天 40.3（1 条）、2026 全年均值 39.6（106 条）、全历史 39.3
 * （123 条）。在「年数据统计」标题下看到 40.3，读起来像「今年平均跑力 40.3」。
 *
 * 口径本身是对的 —— 「当前跑力」就该是最新的，不能跟着统计周期退化成历史均值
 * （否则「当前」二字失去意义）。错的是**没说明它不跟随周期**。
 *
 * 与分析页同一措辞（那边写「近一周跑步平均」）：分析页说的是「含不含非跑步」，
 * 这里说的是「哪个时间窗」，故用最短的「近一周」。
 */
export const CURRENT_VDOT_SCOPE_HINT = '近一周';
