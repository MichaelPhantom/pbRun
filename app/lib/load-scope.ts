/**
 * **「训练负荷」口径标签的唯一来源** —— 首页 / `/analysis` / `/stats` 三处共用。
 *
 * ## 为什么需要这一层（第十八类缺陷）
 *
 * 同一个词「训练负荷」在页面上是**两个不同口径**，而三处都没标注：
 *
 * | 页面 | 数据源 | 口径 | 真实库 2026-08 |
 * |------|--------|------|----------------|
 * | 首页「本月概览」 | `getCombinedTrainingLoads` | 跑步 + 力量 | **1944** |
 * | `/analysis` 负荷图 | `getCombinedTrainingLoads` | 跑步 + 力量 | 1944 |
 * | `/stats` 训练负荷 | `getStats`（带 `runningTypeClause`） | **纯跑步** | **1655** |
 *
 * 差 **289（17%）**。2026-02 差 299、2026 全年 15337 vs 16936（+1599）、
 * 全历史 17730 vs 19492（+1762）。用户在首页
 * 看到「训练负荷 1944」、点「全部统计 →」过去看到「训练负荷 1655」—— 两个
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
 *
 * ## 第二十类缺陷：限定语点错了类型
 *
 * 旧文案只写「不含力量训练」。但九格的差值来源**不是同一个类型**：
 *
 * | 指标 | 跑步 | 全类型 | 差值 | 差值来源（真实库全历史） |
 * |------|------|--------|------|--------------------------|
 * | 累计爬升 | 7943 m | 9255 m | **1312** | **爬楼 100%**（力量 0 m） |
 * | 距离 | 2220.0 km | 2231.9 km | 11.9 | 游泳 6.1 + 球类 5.8（力量 0） |
 * | 训练负荷 | 17730 | 19492 | 1762 | 力量 100%（爬楼 0） |
 * | 时长 | 216.2 h | 261.6 h | 45.4 | 力量 27.8 + 爬楼 8.7 + 球类/游泳等 8.9 |
 *
 * 所以「不含力量训练」这一句对**训练负荷**是对的，对**累计爬升**完全错：
 * 用户拿 Garmin 上的总爬升减 `/stats` 的爬升，差的 1312m 全在爬楼里，
 * 去力量卡永远找不到（力量 53 条爬升合计恒为 0）。
 *
 * 这不是算错，是**限定语点错了类型** —— 与第十八类（同一个词两个口径）同源，
 * 只是那次错在「该不该标」，这次错在「标的是哪个类型」。
 *
 * 措辞策略：**列举真实存在的差值来源**（力量 / 爬楼 / 游泳 / 球类），
 * 而不是只点名一个。多列一个类型不会让人困惑，少列一个会让人找错地方。
 */
export const STATS_SCOPE_HINT = `${LOAD_SCOPE_RUNNING}：距离/配速/负荷/心率/步频等均只统计跑步（不含力量训练、爬楼、游泳、球类）`;

/**
 * `/stats` 的「当前跑力」hint —— **它不跟随所选周期**（第十九类缺陷）。
 *
 * 页面固定二次取数 `getStats('week')`，故无论切到周/月/年/总，「当前跑力」
 * 都是**最近 7 天**的平均 VDOT，而其余八格跟随 `period`。
 *
 * 真实库：近 7 天 40.1（2 条）、2026 全年均值 37.9（128 条）、全历史 37.7
 * （156 条）。在「年数据统计」标题下看到 40.1，读起来像「今年平均跑力 40.1」。
 *
 * 口径本身是对的 —— 「当前跑力」就该是最新的，不能跟着统计周期退化成历史均值
 * （否则「当前」二字失去意义）。错的是**没说明它不跟随周期**。
 *
 * 与分析页同一措辞（那边写「近一周跑步平均」）：分析页说的是「含不含非跑步」，
 * 这里说的是「哪个时间窗」，故用最短的「近一周」。
 */
export const CURRENT_VDOT_SCOPE_HINT = '近一周';

/**
 * `/insight` 负荷卡的 hint —— **同一张卡里两格合并、一格跑步**（第二十一类缺陷）。
 *
 * 洞察页的「训练负荷与周期」卡有三格：
 *
 * | 格 | 数据源 | 口径 |
 * |----|--------|------|
 * | 急性负荷 (7天) | `getCombinedTrainingLoads` | **跑步 + 力量** |
 * | 慢性负荷 (28天周均) | `getCombinedTrainingLoads` | **跑步 + 力量** |
 * | 峰值周跑量 | `periodization`（`getInsightActivityRows`） | **纯跑步** |
 *
 * 真实库近 28 天：合并 1047 vs 跑步 987（力量 60）。三个数并排却是两种口径，
 * 旧实现一个字都没标 —— 与首页「本月概览」四格、`/analysis` 负荷卡同一形态，
 * 是第十八类漏掉的**第三处消费面**。
 *
 * 为什么不能复用 `combinedLoadScopeHint`：那个函数需要「力量负荷 N」才能给出
 * 占比，而 `LoadInsight` 只带合并后的 `acute`/`chronic`，没有力量分量。
 * 硬凑一个数会引入第四份「力量负荷怎么算」的实现 —— 宁可只说明口径，不编数。
 *
 * 措辞必须**同时**点出两种口径：只说「合并」会让用户以为峰值周跑量也含力量
 * （那是纯跑步），只说「跑步」则与急性/慢性两格直接矛盾。
 */
export const INSIGHT_LOAD_SCOPE_HINT = `${LOAD_SCOPE_COMBINED}（急性/慢性负荷含力量训练）；峰值周跑量为${LOAD_SCOPE_RUNNING}（不含力量训练）`;

/**
 * `/insight`「周期化分析」卡的 hint —— **同一行里负荷合并、跑量/次数只跑步**
 * （第二十三类缺陷）。
 *
 * 这张表的数据来自 `computePeriodization(dailyLoads, ...)`，而 `dailyLoads`
 * 是 `getCombinedTrainingLoads`（跑步 + 力量）。但 `aggregateWeeklyLoad` 里
 * 四个列各取不同字段，口径并不一致：
 *
 * | 列 | 字段 | 口径 |
 * |----|------|------|
 * | 跑量 km | `distanceMeters` | **纯跑步**（合并规则只加 `load`，distance 保留跑步值） |
 * | 次数 n | `runs` | **纯跑步**（同上） |
 * | 负荷 tl | `load` | **跑步 + 力量** |
 * | CTL/ATL/TSB | `computeTrainingLoads` | **跑步 + 力量** |
 *
 * 真实库 2026-W43（ISO 周，10-19..10-25）：合并负荷 256 / 跑步负荷 196
 * （差 60，全来自力量训练），而同一行的跑量 28.32km 与次数 3 都是纯跑步。
 *
 * 更糟的是**趋势图把两个口径画在同一坐标系**：「周跑量 (km)」是跑步口径、
 * 「TSB」是合并口径 —— 用户会以为二者能互相解释（「跑量没变，为什么 TSB 掉了」
 * 的答案可能是力量课）。
 *
 * 与 `INSIGHT_LOAD_SCOPE_HINT` **不能共用**：那张卡里「峰值周跑量」是跑步口径、
 * 「急性/慢性」是合并口径，与这张卡的分布恰好相反 —— 共用一句必然有一处说错。
 */
export const PERIODIZATION_SCOPE_HINT = `负荷与 CTL/ATL/TSB 为${LOAD_SCOPE_COMBINED}（含力量训练）；跑量与次数为${LOAD_SCOPE_RUNNING}（只统计跑步）`;

/**
 * 【区间环比】块里「训练负荷」那行的口径后缀（第二十六类缺陷）。
 *
 * `formatPeriodComparison` 的数据来自 `getPeriodStats`，SQL 带 `runningTypeClause`
 * —— 跑量/次数/时长/配速/心率/跑力/负荷**全部**是纯跑步口径，块内部自洽。
 *
 * 问题不在块内，而在**同一个 prompt 的另一个块**：`formatInsightForCoach` 的
 * 【全局训练指标】里，负荷/TL/CTL/ATL/TSB 是跑步 + 力量合并（第二十五类刚补的
 * 说明写着「含力量训练」）。于是模型在同一段 user 消息里读到两个「训练负荷」，
 * 一个说含力量、一个是纯跑步 —— 无法判断该信哪个。
 *
 * 真实库近 90 天（2026-08-11 ~ 11-08）：跑步负荷 4550 / 合并 4958（差 408，8.2%）。
 *
 * 故在负荷行尾部点明口径，与【全局训练指标】那句形成对照，而不是矛盾。
 */
export const PERIOD_COMPARISON_LOAD_SCOPE_HINT = `${LOAD_SCOPE_RUNNING}，不含力量训练`;
