/**
 * 分段**训练角色**的唯一来源 —— FIT lap `intensity`。
 *
 * ## 缺陷（第十二类）
 *
 * 详情页分段表一直有一列「角色」（热身 / 主课 / 恢复 / 冷身），但它**不是读出来的**，
 * 而是 `activity-insight.ts:analyzeLaps` 用**配速**推断的：
 *
 * ```
 * hard  = pace < 均值 × 0.92   → 主课
 * easy  = pace > 均值 × 1.12   → 热身/恢复/冷身（看位置）
 * 其余                          → 匀速
 * ```
 *
 * 而设备在 FIT lap 里**明确记录了每段的意图**（`intensity`：
 * `warmup / interval / recovery / rest / cooldown / active`），覆盖
 * **3074/3153（97.5%）**。解析器从未读取它，于是：
 *
 * 1. 用户看到的是**猜测**，而不是设备记录的计划结构；
 * 2. 猜测会出错。真实库与设备值逐段对比：**73.2% 一致（747/1021）**，
 *    274 段判错。典型：
 *
 * | 活动 | 设备记录 | 配速推断 |
 * |------|---------|---------|
 * | 647455345 第 1 段 | **热身** | 主课（第一段配速快就被当成主课） |
 * | 648412964 第 2 段 | **热身** | 匀速 |
 * | 650375691 第 1 段 | **热身** | 匀速 |
 *
 * 3. 更糟的是「主课漂移」「主课均配速」「主课平均心率」这些派生指标
 *    全都建立在 `role === 'work'` 之上 —— 角色判错，整块分析跟着错。
 *
 * ## 判据（与第十一类缺陷同一套）
 *
 * | 判据 | 检验 | 结果 |
 * |------|------|------|
 * | 结构自证 | `warmup` 是否恒在首段、`cooldown` 是否恒在末段 | **9/9 完美**（见下） |
 * | 独立锚点 | 与配速/心率推断的交叉一致率 | 73.2%（不高，但**这正是设备值的价值**：它记录了意图，配速只反映结果） |
 *
 * 真实库实测（多段且含 warmup/cooldown 的 9 条活动）：
 *
 * ```
 * 651707081  warmup,warmup,warmup,interval,recovery,interval,recovery,...,cooldown,cooldown
 * 648412964  warmup,warmup,warmup,interval,recovery,...,interval,cooldown,cooldown,cooldown
 * 639982410  warmup,warmup,warmup,interval,rest,interval,rest,...,cooldown,cooldown,cooldown
 * ```
 *
 * `warmup` 恒在索引 0，`cooldown` 恒在最后一个索引，`interval`/`recovery`
 * 严格交替 —— 这是**计划结构**才有的形态，随机噪声不可能出现。
 *
 * ## 与旧推断的关系
 *
 * **设备值优先，推断只作兜底**。FIT `intensity` 覆盖 97.5% 的 lap，剩下 2.5%
 * （79 段，主要是游泳休息段与室内骑行）没有值时才回落到配速/心率推断。
 * 两条路径都产出同一个 `LapRole` 枚举，下游无需区分来源 —— 但**来源要能查到**
 * （`roleSource`），否则将来又会出现「不知道这个角色是猜的还是读的」。
 */

/**
 * 分段角色。与 `ActivityInsightPanel.ROLE_LABEL` 的键**完全一致**
 * （warmup / work / recovery / cooldown / steady），这样 UI 不需要两套枚举。
 */
export type LapRole = 'warmup' | 'work' | 'recovery' | 'cooldown' | 'steady';

/** 角色来源：设备记录 / 由配速或心率推断。 */
export type LapRoleSource = 'device' | 'inferred';

/**
 * FIT `intensity` 枚举 → 角色。
 *
 * FIT profile 的 `intensity` 取值：
 * - `active`（0）—— 有效训练段。**不能一律当 `work`**：设备把匀速跑也标 `active`，
 *   真实库 63 段 `active` 里既有主课段也有轻松跑段（`657456825` 全程 22 段都是
 *   `active`）。它表达的是「这段在计时」，不是「这段是主课」。
 * - `interval`（1）—— 间歇主课段 → `work`
 * - `recovery`（3）—— 间歇恢复段 → `recovery`
 * - `rest`（4）—— 完全休息（游泳池边/组间）→ `recovery`
 * - `warmup`（5）—— 热身 → `warmup`
 * - `cooldown`（6）—— 冷身 → `cooldown`
 *
 * `active` 映射为 `null`（**不猜测**）：它只说「在计时」。若强行当 `work`，
 * 一次匀速慢跑会整场被标成「主课」，比现在的推断更糟。调用方拿到 `null`
 * 时回落到配速/心率推断 —— 那条路径对匀速跑本来就判 `steady`，是对的。
 */
const INTENSITY_TO_ROLE: Readonly<Record<string, LapRole | null>> = {
  interval: 'work',
  recovery: 'recovery',
  rest: 'recovery',
  warmup: 'warmup',
  cooldown: 'cooldown',
  // `active` 是「在计时」，不是「主课」—— 见上面的理由。
  active: null,
};

/** FIT `intensity` 的无效哨兵（`fit-file-parser` 把 `0xFF` 解成 `255`）。 */
const INTENSITY_INVALID = 255;

/**
 * 读 FIT lap `intensity` 并转成角色。**读不出就返回 `null`**（交给推断兜底）。
 *
 * @param intensity FIT lap `intensity` 原值（可能是字符串、数字、`255`、`undefined`）
 */
export function lapRoleFromIntensity(intensity: unknown): LapRole | null {
  if (typeof intensity === 'number') {
    if (intensity === INTENSITY_INVALID) return null;
    return null;
  }
  if (typeof intensity !== 'string') return null;
  const key = intensity.trim().toLowerCase();
  if (!key) return null;
  return INTENSITY_TO_ROLE[key] ?? null;
}

/**
 * 该 lap 的角色是否**来自设备记录**（而不是推断）。
 *
 * UI 用它决定徽标要不要带「设备」标记：用户需要知道这是计划里的角色，
 * 还是本项目按配速猜的。
 */
export function isDeviceRole(intensity: unknown): boolean {
  return lapRoleFromIntensity(intensity) != null;
}

/**
 * 按 lap 顺序做**结构校验**：`warmup` 必须在首段、`cooldown` 必须在末段。
 *
 * 这是 `intensity` 的**自证性不变式** —— 与 RMSSD ≤ RR 极差、IF = NP÷FTP
 * 同一纪律。设备如果因为解析错位把 `intensity` 读错列，几乎必然破坏这个形态
 * （真实库 9/9 条多段活动完美符合）。
 *
 * 返回违规描述列表（空数组 = 通过）。仅用于**开发期/测试**断言，
 * 生产路径不调用（一次活动最多几十段，但没必要每帧算）。
 */
export function validateLapRoles(roles: (LapRole | null)[]): string[] {
  const problems: string[] = [];
  const n = roles.length;
  if (n === 0) return problems;
  roles.forEach((r, i) => {
    if (r === 'warmup' && i !== 0) {
      // 热身可以连续多段（真实库 651707081 有 3 段），但必须从索引 0 开始。
      const allBefore = roles.slice(0, i).every((x) => x === 'warmup');
      if (!allBefore) problems.push(`warmup 出现在索引 ${i}，但前面不是连续 warmup`);
    }
    if (r === 'cooldown' && i !== n - 1) {
      // 冷身同理：必须一直延续到结尾。
      const allAfter = roles.slice(i + 1).every((x) => x === 'cooldown');
      if (!allAfter) problems.push(`cooldown 出现在索引 ${i}，但后面不是连续 cooldown`);
    }
  });
  return problems;
}
