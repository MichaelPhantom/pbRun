/**
 * `total_cycles` 的**语义白名单** —— 第十一类缺陷的唯一来源。
 *
 * ## 为什么需要白名单而不是「按类型给标签」
 *
 * 第十类缺陷把 `total_cycles` 读进了库，然后按运动类型给标签：游泳「总划水次数」、
 * 跳绳「总跳跃次数」、爬楼「总步数」，**其余一律「总计数」**。
 *
 * 前三者能自证，最后那个「总计数」不能。它是「我不知道这是什么，但既然库里有
 * 一个数，就展示出来吧」的典型 —— 用户看到「总计数 436」只会更困惑。
 *
 * ## 两条判据
 *
 * 一个 `total_cycles` 值能展示，必须同时满足：
 *
 * 1. **结构自证**：`Σlap.total_cycles == session.total_cycles` ——
 *    证明活动级与分段级读的是同一个量（不是解析错位）。
 * 2. **独立锚点**：能用一个**不同来源**的量交叉验证 ——
 *    证明这个量的物理意义就是标签说的那个。
 *
 * 真实库实测：
 *
 * | 类型 | Σlap==session | 独立锚点 | 结论 |
 * |------|---------------|---------|------|
 * | 游泳 4/4 | ✅ 518/798/923/695 全等 | ✅ ÷活跃时间 ≈ 划频（24.2 vs 24） | 总划水次数 |
 * | 跳绳 3/3 | ✅ 189/187/193 全等 | ✅ 115–150 次/分（跳绳常识 100–160） | 总跳跃次数 |
 * | 爬楼 30/30 | ✅ 30/30 全等 | ✅ 14.6–29.0 步/层（14 级台阶约 20 步） | 总步数 |
 * | 力量 0/51 有 lap | ❌ 无 lap 消息 | ❌ `r(cyc, 时长) = −0.118` | 不展示 |
 * | 室内有氧 1/9 | ❌ | ❌ 同名活动 5 / 19 / 66 / 474 | 不展示 |
 * | HIIT 0/3 | ❌ | ❌ | 不展示 |
 * | 篮球 3/3 | ✅ | ❌ 1685/53min = 32「触球」/分（荒谬） | 不展示 |
 * | 乒乓/羽毛 3/3 | ✅ | ❌ 0.06–0.14 m/cycle（语义随项目变） | 不展示 |
 *
 * ## 力量训练的反证最硬
 *
 * `r(total_cycles, moving_time) = −0.118`（n=51，几乎无关）。同模板「核心稳定性4」：
 *
 * | 活动 | 时长 | `total_cycles` |
 * |------|------|----------------|
 * | 557320917 | 15.2 min | **51** |
 * | 626200915 | 28.1 min | **40** |
 *
 * 时长翻倍，计数反而更少 —— 它不可能是「做了多少次」。而 `num_laps` 恒为
 * 37/41/42/43/44/49（随课表模板变，与时长无关），也不是组数。
 *
 * ## 室内有氧的反证最直观
 *
 * 同名「5 分钟平板支撑挑战」9 条里有 4 种取值：**5 / 19 / 66 / 474**。
 * 平板支撑只有 1 次，任何「次数」解释都不成立。
 *
 * ## 纪律
 *
 * **「库里有值」不等于「知道它是什么」**。语义未确认的字段宁可不展示 ——
 * 展示一个错误标签比不展示更糟：用户会拿它做训练决策。
 */

/** 一条已确认语义的 `total_cycles` 说明。 */
export interface CycleSemantic {
  /** 展示标签（如「总划水次数」）。 */
  label: string;
  /** 展示单位（如「次划水」）。 */
  unit: string;
  /**
   * 自证依据（**必填**）。写清「结构自证 + 独立锚点」两条证据，
   * 后续若有人想加类型，必须先在这里补出等价强度的证据。
   */
  basis: string;
}

/**
 * 已确认语义的类型白名单。
 *
 * 新增条目必须同时给出结构自证与独立锚点 —— 见本文件头注释的判据。
 */
export const CYCLE_SEMANTICS: Readonly<Record<string, CycleSemantic>> = {
  lap_swimming: {
    label: '总划水次数',
    unit: '次划水',
    basis:
      'Σlap==session 4/4 精确（518/798/923/695）；total_cycles ÷ 活跃时间 ≈ FIT 划频（24.2/23.8/23.4/22.4 vs 24/24/23/22）',
  },
  open_water: {
    label: '总划水次数',
    unit: '次划水',
    basis:
      '与 lap_swimming 同一 FIT 语义（sport=swimming，同为总划水次数）；真实库暂无 open_water 样本，故沿用泳池游泳的 Σlap==session 与 ÷活跃时间≈划频两条证据',
  },
  jump_rope: {
    label: '总跳跃次数',
    unit: '次跳跃',
    basis:
      'Σlap==session 3/3 精确（189/187/193）；÷时长 = 115–150 次/分，落在跳绳常识区间 100–160',
  },
  floor_climbing: {
    label: '总步数',
    unit: '步',
    basis:
      'Σlap==session 30/30 精确；÷楼层（total_ascent ÷ 3.048）= 14.6–29.0 步/层，与 14 级台阶约 20 步吻合',
  },
};

/**
 * 查 `total_cycles` 的语义。**未确认 → `null`**（调用方整项略去）。
 *
 * 空 / `null` 的 `activity_type` 按全站归一纪律视为 `running`（旧库兼容），
 * 而跑步本来就不展示 `total_cycles` —— 所以同样返回 `null`。
 */
export function cycleSemanticOf(
  activityType: string | null | undefined,
): CycleSemantic | null {
  if (typeof activityType !== 'string' || activityType === '') return null;
  return CYCLE_SEMANTICS[activityType] ?? null;
}

/**
 * 详情页概览的 `{ label, unit }`。**未确认类型 → `null`**。
 *
 * 注意这里**没有**「总计数」兜底 —— 那正是第十一类缺陷：
 * 用一个含糊的标签把语义未确认的数字伪装成确定值。
 */
export function cycleCountLabel(
  activityType: string | null | undefined,
): { label: string; unit: string } | null {
  const sem = cycleSemanticOf(activityType);
  return sem == null ? null : { label: sem.label, unit: sem.unit };
}
