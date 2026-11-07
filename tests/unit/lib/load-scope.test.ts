/**
 * `app/lib/load-scope.ts` —— 「训练负荷」口径标签的唯一来源。
 *
 * ## 为什么需要这一层
 *
 * 同一个词「训练负荷」在不同页面是**两个不同口径**，且都没标注：
 *
 * | 页面 | 数据源 | 口径 | 真实库 2026-08 |
 * |------|--------|------|----------------|
 * | 首页「本月概览」 | `getCombinedTrainingLoads` | 跑步 + 力量 | **2004** |
 * | `/analysis` 负荷图 | `getCombinedTrainingLoads` | 跑步 + 力量 | 2004 |
 * | `/stats` 训练负荷 | `getStats`（带 `runningTypeClause`） | **纯跑步** | **1715** |
 *
 * 差 289（17%）。用户在首页看到「训练负荷 2004」、点进 `/stats` 看到
 * 「训练负荷 1715」，两个数字都叫同一个名字 —— 既不知道谁对，也不知道
 * 差在哪。这不是算错，是**口径没标**。
 *
 * 合并口径本身是对的（力量课对 CTL/ATL/TSB 的贡献不该恒为 0），跑步口径
 * 也是对的（`/stats` 是「跑步数据统计」）。错的只是**同一个词没有限定语**。
 *
 * ## 三条纪律
 *
 * 1. **标签与数值同源**：hint 里的力量负荷必须来自页面**同一份**力量汇总，
 *    而不是另算一遍 —— 否则 hint 会和力量卡上的「本月负荷」对不上。
 * 2. **0 也要说清**：本月没有力量负荷时，合并值恰好等于跑步值。此时 hint
 *    必须写「跑步口径（无力量负荷）」，而不是继续挂「合并」—— 后者会让用户
 *    以为那两个数不同。
 * 3. **负数/非数按 0**：`summarizeStrengthSessions` 已保证非负，这里只是
 *    防御脏数据（`NaN` 会让 hint 显示「力量负荷 NaN」）。
 */

import {
  LOAD_SCOPE_COMBINED,
  LOAD_SCOPE_RUNNING,
  DISTANCE_SCOPE_HINT,
  STATS_SCOPE_HINT,
  INSIGHT_LOAD_SCOPE_HINT,
  PERIODIZATION_SCOPE_HINT,
  PERIOD_COMPARISON_LOAD_SCOPE_HINT,
  combinedLoadScopeHint,
  monthLoadScopeHint,
} from '@/app/lib/load-scope';

describe('训练负荷口径标签', () => {
  test('两个口径的措辞固定：合并说「力量」，跑步说「跑步」', () => {
    expect(LOAD_SCOPE_COMBINED).toContain('力量');
    expect(LOAD_SCOPE_COMBINED).toContain('合并');
    expect(LOAD_SCOPE_RUNNING).toContain('跑步');
    // 两个标签必须能区分 —— 若都写成「训练负荷」，本模块就没有意义
    expect(LOAD_SCOPE_COMBINED).not.toBe(LOAD_SCOPE_RUNNING);
  });

  test('本月有力量负荷 → hint 点名合并口径与力量那部分的数值', () => {
    expect(monthLoadScopeHint(289)).toBe('跑步 + 力量合并（力量负荷 289）');
    expect(monthLoadScopeHint(167)).toBe('跑步 + 力量合并（力量负荷 167）');
  });

  /**
   * 本月没有力量负荷时，合并值 ≡ 跑步值。此时继续挂「合并」会让用户
   * 以为首页与 `/stats` 的两个数不同 —— 必须明说这是纯跑步口径。
   */
  test('本月无力量负荷 → hint 明说「跑步口径」而不是继续挂合并', () => {
    const hint = monthLoadScopeHint(0);
    expect(hint).toBe('跑步口径（本月无力量负荷）');
    expect(hint).not.toContain('合并');
  });

  test('负数 / NaN / Infinity 按 0 处理（不显示「力量负荷 NaN」）', () => {
    expect(monthLoadScopeHint(Number.NaN)).toBe('跑步口径（本月无力量负荷）');
    expect(monthLoadScopeHint(Number.POSITIVE_INFINITY)).toBe('跑步口径（本月无力量负荷）');
    expect(monthLoadScopeHint(-5)).toBe('跑步口径（本月无力量负荷）');
    expect(monthLoadScopeHint(null)).toBe('跑步口径（本月无力量负荷）');
    expect(monthLoadScopeHint(undefined)).toBe('跑步口径（本月无力量负荷）');
  });

  /** 力量负荷 < 0.5 时四舍五入为 0 —— 与力量卡上的 `totalLoad.toFixed(0)` 一致。 */
  test('力量负荷 < 0.5 视为无（与力量卡显示 0 一致）', () => {
    expect(monthLoadScopeHint(0.4)).toBe('跑步口径（本月无力量负荷）');
  });

  /**
   * `/analysis` 的负荷图是合并口径，必须让用户看到力量那部分**占多少** ——
   * 否则 ACWR 变了却找不到原因（力量卡在下方，负荷图在上方）。
   */
  test('分析页 hint 给出力量占比', () => {
    expect(combinedLoadScopeHint(289, 2004)).toBe('合并口径：含力量负荷 289（占 14.4%）');
    expect(combinedLoadScopeHint(50, 200)).toBe('合并口径：含力量负荷 50（占 25.0%）');
  });

  /**
   * **里程也是跑步口径**，但差值来源与负荷不同：力量距离恒为 0，
   * 差的是游泳/球类那 10.23km。措辞必须点对类型，否则用户去力量卡里找。
   */
  test('里程 hint 点的是游泳/球类，不是力量', () => {
    expect(DISTANCE_SCOPE_HINT).toContain('跑步');
    expect(DISTANCE_SCOPE_HINT).toContain('游泳');
    expect(DISTANCE_SCOPE_HINT).not.toContain('力量');
  });

  test('分析页无力量负荷 → 明说纯跑步口径', () => {
    const hint = combinedLoadScopeHint(0, 1118);
    expect(hint).toBe('跑步口径（区间内无力量负荷）');
    expect(hint).not.toContain('合并');
  });

  test('分析页分母为 0 / 脏数据 → 不显示 NaN%', () => {
    expect(combinedLoadScopeHint(0, 0)).toBe('跑步口径（区间内无力量负荷）');
    expect(combinedLoadScopeHint(Number.NaN, Number.NaN)).toBe('跑步口径（区间内无力量负荷）');
    expect(combinedLoadScopeHint(10, 0)).toBe('跑步口径（区间内无力量负荷）');
  });

  /**
   * **第二十类缺陷：`/stats` 的口径提示把「差值来源」说错了。**
   *
   * `STATS_SCOPE_HINT` 旧文案只写「不含力量训练」。但九格里的**累计爬升**
   * 差值来源完全不是力量：
   *
   * | 指标 | 跑步 | 全类型 | 差值 | 差值来源 |
   * |------|------|--------|------|----------|
   * | 累计爬升 | 7853 m | 9165 m | **1312** | **爬楼 100%**（力量 0） |
   * | 距离 | 2200.9 km | 2212.8 km | 11.9 | 游泳/球类（力量 0） |
   * | 时长 | 214.4 h | 258.2 h | 43.8 | 力量 26.2 + 爬楼 8.7 + 球类/游泳 |
   * | 训练负荷 | 18122 | 19788 | 1666 | 力量 100%（爬楼 0） |
   *
   * 也就是说：**同一句「不含力量训练」对训练负荷是对的，对累计爬升完全错**
   * —— 用户拿 Garmin 上的总爬升减 `/stats` 的爬升，差的 1312m 全在爬楼里，
   * 去力量卡永远找不到。这不是算错，是**限定语点错了类型**。
   *
   * 与第十八类同源（措辞与数据不符），只是那次错在「该不该标」，这次错在
   * 「标的是哪个类型」。
   */
  test('口径提示必须点出「爬楼」—— 累计爬升的差值 100% 来自爬楼', () => {
    expect(STATS_SCOPE_HINT).toContain('爬楼');
  });

  /**
   * 反证：提示不能只说力量。若文案里「力量」是**唯一**被点名的非跑步类型，
   * 用户就会把全部差值都归因到力量。
   */
  test('口径提示不得只点名力量（差值来源不止力量）', () => {
    expect(STATS_SCOPE_HINT).toContain('力量');
    expect(STATS_SCOPE_HINT).toContain('爬楼');
  });

  /**
   * **`/insight` 负荷卡：三格两个口径，必须同时点出**（第二十一类缺陷）。
   *
   * 急性/慢性是合并口径（`getCombinedTrainingLoads`），峰值周跑量是纯跑步
   * （`periodization` 来自 `getInsightActivityRows`）。只说「合并」会让用户
   * 以为峰值周跑量也含力量；只说「跑步」则与另两格直接矛盾。
   */
  test('洞察页 hint 必须同时点出合并与跑步两种口径', () => {
    expect(INSIGHT_LOAD_SCOPE_HINT).toContain(LOAD_SCOPE_COMBINED);
    expect(INSIGHT_LOAD_SCOPE_HINT).toContain(LOAD_SCOPE_RUNNING);
    // 必须点名哪一格是哪个口径，否则「两种口径」仍然要用户自己猜
    expect(INSIGHT_LOAD_SCOPE_HINT).toContain('急性');
    expect(INSIGHT_LOAD_SCOPE_HINT).toContain('峰值周跑量');
  });

  /** 措辞不得暗示峰值周跑量含力量 —— 那是最容易产生的误读。 */
  test('洞察页 hint 不得让峰值周跑量看起来含力量', () => {
    // 「含力量训练」必须限定在急性/慢性上，不能紧跟峰值周跑量
    expect(INSIGHT_LOAD_SCOPE_HINT).toMatch(/急性\/慢性[^；]*含力量训练/);
    expect(INSIGHT_LOAD_SCOPE_HINT).toMatch(/峰值周跑量[^；]*不含力量训练/);
  });
});

/**
 * **三处消费面必须共用 `app/lib/load-scope.ts`**（第十八类缺陷的守卫）。
 *
 * 缺陷形态：同一个词「训练负荷」在首页是合并口径、在 `/stats` 是跑步口径，
 * 两处都没标注。修法不是改数值（两个口径都对），而是**加限定语**。
 *
 * 而限定语一旦允许各写一遍，就会漂移 —— 本项目已吃过两次「同一规则两处
 * 各写一遍」的亏（配速时间基数、类型徽标条件）。故锁三件事：
 *
 *  1. 三处都必须 import 本模块的导出（不许自己拼字符串）；
 *  2. 三处都不得硬编码「跑步 + 力量合并」「跑步口径」这类措辞；
 *  3. 首页的力量负荷必须来自**同一份**力量汇总（`strengthThisMonth.totalLoad`），
 *     不许另算一遍 —— 否则 hint 与力量卡上的「本月负荷」对不上。
 */
describe('训练负荷口径标签的三处调用方', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const root = path.resolve(__dirname, '../../..');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  /** 剥掉注释 —— 文件里保留了「旧实现硬编码」的历史说明，守卫不能被它骗过。 */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('首页必须用 monthLoadScopeHint，且力量数值来自 strengthThisMonth', () => {
    const src = read('app/page.tsx');
    expect(src).toMatch(
      /import\s*\{[^}]*monthLoadScopeHint[^}]*\}\s*from\s*['"]@\/app\/lib\/load-scope['"]/,
    );
    expect(src).toMatch(/monthLoadScopeHint\(strengthThisMonth\.totalLoad\)/);
    // 不得硬编码口径措辞
    const code = stripComments(src);
    expect(code).not.toMatch(/跑步 \+ 力量合并/);
    expect(code).not.toMatch(/跑步口径（/);
  });

  test('/stats 必须用 STATS_SCOPE_HINT', () => {
    const src = read('app/stats/StatsClient.tsx');
    expect(src).toMatch(
      /import\s*\{[^}]*STATS_SCOPE_HINT[^}]*\}\s*from\s*['"]@\/app\/lib\/load-scope['"]/,
    );
    expect(src).toMatch(/\{STATS_SCOPE_HINT\}/);
    const code = stripComments(src);
    expect(code).not.toMatch(/跑步口径：距离/);
  });

  test('/analysis 必须用 combinedLoadScopeHint（力量负荷与分母同源）', () => {
    const src = read('app/analysis/AnalysisClient.tsx');
    expect(src).toMatch(
      /import\s*\{[^}]*combinedLoadScopeHint[^}]*\}\s*from\s*['"]@\/app\/lib\/load-scope['"]/,
    );
    expect(src).toMatch(/combinedLoadScopeHint\(strength\.strengthLoad,\s*strength\.combinedLoad\)/);
    const code = stripComments(src);
    expect(code).not.toMatch(/合并口径：含力量负荷/);
  });

  /**
   * 首页四格里只有训练负荷是合并口径，另三格是跑步口径 —— 这条锁死
   * 「不要因为加了口径说明就把距离/天数/配速也改成合并」。
   */
  test('首页另三格仍是跑步口径（数据源 getTrainingLoads 的 distance/runs/duration）', () => {
    const src = read('app/page.tsx');
    const code = stripComments(src);
    // 本月距离/平均配速 来自 loadPoints 的 distance/duration（合并口径只加 load）
    expect(code).toMatch(/thisMonthKm/);
    expect(code).toMatch(/monthAvgPace/);
    // 跑步天数必须是 runs > 0（不是 load > 0）
    expect(code).toMatch(/\(p\.runs \?\? 0\) > 0/);
  });

  /**
   * **距离 hint 必须点「游泳/球类」而不是「力量」** —— 力量距离恒为 0，
   * 真实库那 10.23km 全来自游泳 4 条 + 球类 6 条。措辞错了用户会去力量卡里找。
   */
  test('首页「本月距离」用 DISTANCE_SCOPE_HINT（不得硬编码）', () => {
    const src = read('app/page.tsx');
    expect(src).toMatch(
      /import\s*\{[^}]*DISTANCE_SCOPE_HINT[^}]*\}\s*from\s*['"]@\/app\/lib\/load-scope['"]/,
    );
    expect(src).toMatch(/hint=\{DISTANCE_SCOPE_HINT\}/);
    const code = stripComments(src);
    expect(code.includes('跑步口径（不含游泳/球类）')).toBe(false);
  });

  /**
   * **「当前跑力」固定近一周，其余八格跟随所选周期**（第十九类缺陷）。
   * 这条锁死 hint 来自模块，不许在页面里写死「近一周」。
   */
  test('/stats 的「当前跑力」hint 必须来自 CURRENT_VDOT_SCOPE_HINT', () => {
    const src = read('app/stats/StatsClient.tsx');
    expect(src).toMatch(
      /import\s*\{[^}]*CURRENT_VDOT_SCOPE_HINT[^}]*\}\s*from\s*['"]@\/app\/lib\/load-scope['"]/,
    );
    expect(src).toMatch(/hint=\{CURRENT_VDOT_SCOPE_HINT\}/);
    // 剥注释后不得再出现裸的「近一周」字面量
    const code = stripComments(src);
    expect(code.includes("hint=\"近一周\"")).toBe(false);
  });

  /**
   * **`/insight` 是第十八类漏掉的第三处消费面**（第二十一类缺陷）。
   *
   * 洞察页的负荷卡三格里，急性/慢性是合并口径、峰值周跑量是纯跑步口径 ——
   * 首页 / 分析页 / `/stats` 都补了口径说明，唯独这里漏了。
   */
  test('/insight 负荷卡必须用 INSIGHT_LOAD_SCOPE_HINT（不得硬编码）', () => {
    const src = read('app/insight/InsightClient.tsx');
    expect(src).toMatch(
      /import\s*\{[^}]*INSIGHT_LOAD_SCOPE_HINT[^}]*\}\s*from\s*['"]@\/app\/lib\/load-scope['"]/,
    );
    expect(src).toMatch(/\{INSIGHT_LOAD_SCOPE_HINT\}/);
    const code = stripComments(src);
    // 不得自己拼口径措辞
    expect(code.includes('急性/慢性负荷含力量训练')).toBe(false);
  });

  /**
   * **第二十三类：`/insight`「周期化分析」卡与负荷卡口径分布相反。**
   *
   * | 卡 | 合并口径的格 | 跑步口径的格 |
   * |----|--------------|--------------|
   * | 训练负荷与周期 | 急性 / 慢性 | 峰值周跑量 |
   * | 周期化分析 | 负荷 / CTL / ATL / TSB | 跑量 / 次数 |
   *
   * 两卡恰好相反，故**必须各有各的 hint**，共用一句必然有一处说错。
   */
  test('周期化卡必须用 PERIODIZATION_SCOPE_HINT（与负荷卡的 hint 不同）', () => {
    const src = read('app/insight/InsightClient.tsx');
    expect(src).toMatch(
      /import\s*\{[^}]*PERIODIZATION_SCOPE_HINT[^}]*\}\s*from\s*['"]@\/app\/lib\/load-scope['"]/,
    );
    expect(src).toMatch(/\{PERIODIZATION_SCOPE_HINT\}/);
    const code = stripComments(src);
    expect(code.includes('负荷与 CTL/ATL/TSB 为')).toBe(false);
  });

  /**
   * 两条 hint 的措辞必须能**互相区分**：否则页面上出现两段几乎一样的说明，
   * 用户分不清哪句管哪张卡（正是「同一规则两处各写一遍」的温床）。
   */
  test('两条洞察页 hint 必须互不相同且各自点名本卡的格', () => {
    expect(PERIODIZATION_SCOPE_HINT).not.toBe(INSIGHT_LOAD_SCOPE_HINT);
    // 负荷卡说「急性/慢性」与「峰值周跑量」
    expect(INSIGHT_LOAD_SCOPE_HINT).toContain('急性');
    expect(INSIGHT_LOAD_SCOPE_HINT).toContain('峰值周跑量');
    // 周期化卡说「跑量」与「次数」+ CTL/ATL/TSB
    expect(PERIODIZATION_SCOPE_HINT).toContain('跑量');
    expect(PERIODIZATION_SCOPE_HINT).toContain('次数');
    expect(PERIODIZATION_SCOPE_HINT).toContain('CTL');
    // 周期化卡不得出现「峰值周跑量」—— 那是另一张卡的格
    expect(PERIODIZATION_SCOPE_HINT).not.toContain('峰值周跑量');
  });

  /**
   * **第二十六类：【区间环比】的负荷是跑步口径，与同一 prompt 的另一块相反。**
   *
   * `formatPeriodComparison` 吃 `getPeriodStats`（带 `runningTypeClause`），
   * 整块自洽 —— 跑量/次数/时长/配速/心率/跑力/负荷全是纯跑步。
   *
   * 但它在 `buildGlobalCoachMessages` 里与【全局训练指标】拼进**同一条 user
   * 消息**，而后者第二十五类刚标注「负荷/TL/CTL/ATL/TSB 为跑步 + 力量合并
   * （含力量训练）」。两个「训练负荷」在同一段上下文里口径相反。
   *
   * 真实库近 90 天（2026-08-11 ~ 11-08）：跑步 4550 / 合并 4958（差 408，8.2%）。
   */
  test('PERIOD_COMPARISON_LOAD_SCOPE_HINT 必须是跑步口径且点明不含力量', () => {
    expect(PERIOD_COMPARISON_LOAD_SCOPE_HINT).toContain(LOAD_SCOPE_RUNNING);
    expect(PERIOD_COMPARISON_LOAD_SCOPE_HINT).toContain('不含力量训练');
    // 绝不能写成合并口径 —— 那会与本块其余指标（跑量/次数/配速）自相矛盾
    expect(PERIOD_COMPARISON_LOAD_SCOPE_HINT).not.toContain(LOAD_SCOPE_COMBINED);
  });

  test('period-comparison.ts 必须 import 该 hint（不得硬编码口径措辞）', () => {
    const src = read('app/lib/period-comparison.ts');
    expect(src).toMatch(
      /import\s*\{[^}]*PERIOD_COMPARISON_LOAD_SCOPE_HINT[^}]*\}\s*from\s*['"]\.\/load-scope['"]/,
    );
    expect(src).toMatch(/\$\{PERIOD_COMPARISON_LOAD_SCOPE_HINT\}/);
    const code = stripComments(src);
    expect(code.includes('不含力量训练')).toBe(false);
  });
});
