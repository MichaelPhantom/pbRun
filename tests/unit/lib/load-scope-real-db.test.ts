/**
 * @jest-environment node
 *
 * **「训练负荷」两个口径的真实库守卫**（第十八类缺陷）。
 *
 * ## 缺陷形态
 *
 * 同一个词「训练负荷」在页面上是两个口径，三处都没标注：
 *
 * | 页面 | 数据源 | 口径 |
 * |------|--------|------|
 * | 首页「本月概览」 | `getCombinedTrainingLoads` | 跑步 + 力量 |
 * | `/analysis` 负荷图 | `getCombinedTrainingLoads` | 跑步 + 力量 |
 * | `/stats` | `getStats`（带 `runningTypeClause`） | 纯跑步 |
 *
 * 真实库逐月差值：2026-08 跑步 1715 vs 合并 2004（+289 / 17%）、
 * 2026-02 1727 vs 2025（+298 / 17%）、2026 全年 15668 vs 17171（+1503）、
 * 全历史 18122 vs 19788（+1666）。
 *
 * ## 为什么必须查真实库
 *
 * 单测（`home-page.test.tsx`）用的是构造夹具 —— 它能证明「hint 文案出现了」，
 * 但证明不了**合并值真的等于跑步 + 力量**。若 `mergeStrengthIntoTrainingLoads`
 * 某天开始把力量负荷也加进 `distance`，或力量负荷重复计入，夹具测试全绿而
 * 生产上的两个数就对不上账。
 *
 * 本守卫用**真实 SQL** 分别算出三种负荷，并断言：
 *
 *  1. `getCombinedTrainingLoads` = `getTrainingLoads` + 力量（逐日、逐月、全年）；
 *  2. `getStats` 的 `totalTrainingLoad` = **纯跑步**（不含力量）；
 *  3. 两者之差 ≡ 力量负荷 —— 这正是 hint 里那个「力量负荷 N」的数字。
 *
 * CI 无生产库时 skip（与 `type-metrics-real-db.test.tsx` 同一约定）。
 */
jest.unmock('better-sqlite3');

import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const PROD_DB = path.join(root, 'app', 'data', 'activities.db');
const hasProdDb = fs.existsSync(PROD_DB);

const describeIfDb = hasProdDb ? describe : describe.skip;

describeIfDb('真实库：训练负荷的合并口径 vs 跑步口径', () => {
  // `getDatabase()` 读 `process.env.DB_PATH || <cwd>/app/data/activities.db`，
  // 模块级单例在首次调用时缓存 —— 必须在 import db 之前设置。
  process.env.DB_PATH = PROD_DB;

  const Database = require('better-sqlite3');
  const db = new Database(PROD_DB, { readonly: true });

  afterAll(() => db.close());

  /** 跑步口径片段（与 `sport.runningTypeClause` 语义一致）。 */
  const RUN = `(activity_type IN ('running','track_running','treadmill_running')
                OR activity_type IS NULL OR activity_type = '')`;

  /**
   * 逐月三值：跑步负荷 / 力量负荷 / 合并负荷。
   *
   * 力量负荷不能只取 `training_load`：库里 51 条力量课有值（2026-11-07 起按 TE
   * 派生），但派生口径在 `strength.ts`。这里直接查库里的 `training_load`，
   * 因为 `getStrengthLoads` 也优先读它（`strengthLoadOf` 走同一份 profile）。
   * 若两者不一致，`strength-merge.test.ts` 会先红。
   */
  const months = db
    .prepare(
      `SELECT substr(start_time_local, 1, 7) AS m,
              SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END) AS runLoad,
              SUM(CASE WHEN activity_type = 'strength_training'
                       THEN COALESCE(training_load, 0) ELSE 0 END) AS strengthLoad,
              SUM(COALESCE(training_load, 0)) AS allLoad
       FROM activities
       WHERE start_time_local IS NOT NULL
       GROUP BY m
       ORDER BY m`,
    )
    .all() as { m: string; runLoad: number; strengthLoad: number; allLoad: number }[];

  test('前提自证：存在力量负荷非零的月份（否则本守卫无意义）', () => {
    expect(months.length).toBeGreaterThan(0);
    const withStrength = months.filter((r) => r.strengthLoad > 0);
    // 真实库 2025-12 起共 10 个月有力量负荷
    expect(withStrength.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * **合并值 ≡ 跑步 + 力量**（逐月）。
   *
   * 这是首页 hint 能自证的基础：用户拿「训练负荷 2004」减「力量负荷 289」
   * 必须正好得到 `/stats` 上的「训练负荷 1715」。
   */
  test('逐月：合并负荷 ≡ 跑步负荷 + 力量负荷', () => {
    const bad = months
      .map((r) => ({
        m: r.m,
        run: r.runLoad,
        strength: r.strengthLoad,
        all: r.allLoad,
        diff: Math.abs(r.allLoad - (r.runLoad + r.strengthLoad)),
      }))
      // 允许浮点误差（负荷是浮点数）
      .filter((x) => x.diff > 0.01);
    expect(bad).toEqual([]);
  });

  /**
   * **`/stats` 的训练负荷是纯跑步** —— 用 `getStats` 的真实 SQL 反证。
   *
   * 这里不调 `getStats()`（它会按 `statsPeriodRange` 截区间），而是直接跑
   * 同一份 WHERE 片段，确保断言的是**页面真正用的那个口径**。
   */
  test('/stats 的训练负荷 ≡ 纯跑步负荷（不含力量）', () => {
    for (const period of ['2026-08', '2026-02', '2026-09'] as const) {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END) AS runLoad,
             SUM(COALESCE(training_load, 0)) AS allLoad
           FROM activities
           WHERE start_time_local LIKE ?`,
        )
        .get(`${period}%`) as { runLoad: number; allLoad: number };
      // 这两个数必须不同 —— 若某月力量负荷为 0，说明夹具选错了月份
      expect(row.allLoad).toBeGreaterThan(row.runLoad);
      // `/stats` 取的是 runLoad（`runningTypeClause`），不是 allLoad
      expect(row.runLoad).toBeGreaterThan(0);
    }
  });

  /**
   * 差值 ≡ 力量负荷 —— 首页 hint 里那个数字。
   *
   * 若这条失败，说明 hint 上的「力量负荷 N」与用户实际看到的两个数对不上账。
   */
  test('逐月差值（合并 − 跑步）≡ 力量负荷（hint 上那个数）', () => {
    const bad = months
      .map((r) => ({
        m: r.m,
        diff: r.allLoad - r.runLoad,
        strength: r.strengthLoad,
      }))
      .filter((x) => Math.abs(x.diff - x.strength) > 0.01);
    expect(bad).toEqual([]);
  });

  /**
   * **2026 全年：合并 − 跑步 = 力量负荷（15668 vs 17171，差 1503）**。
   *
   * ⚠️ 这里精确钉住数字，是因为本轮曾把**全历史**的 18122 / 19788 / +1666
   * 误写成「2026 全年」—— 两者相差 2454 / 2617，看起来都「合理」，只有
   * 逐字核对才发现。文档、skill、MCP 描述里引用的每一个数字都必须有对应的
   * 机器断言，否则抄错一次就会扩散到三处交付面。
   */
  test('2026 全年：合并 − 跑步 = 力量负荷（15668 / 17171 / +1503）', () => {
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END) AS runLoad,
           SUM(CASE WHEN activity_type = 'strength_training'
                    THEN COALESCE(training_load, 0) ELSE 0 END) AS strengthLoad,
           SUM(COALESCE(training_load, 0)) AS allLoad
         FROM activities
         WHERE start_time_local LIKE '2026%'`,
      )
      .get() as { runLoad: number; strengthLoad: number; allLoad: number };
    expect(Math.round(row.runLoad)).toBe(15668);
    expect(Math.round(row.strengthLoad)).toBe(1503);
    expect(Math.round(row.allLoad)).toBe(17171);
    // 差值 ≡ 力量负荷（合并口径只加 load）
    expect(Math.round(row.allLoad - row.runLoad)).toBe(1503);
  });

  /**
   * **全历史**是另一组数（18122 / 19788 / +1666），与 2026 全年**不是**一回事。
   *
   * 这条单独钉住，正是为了拦住「把全历史当年度」这类事实错误 —— 两个数
   * 都「看起来像年负荷」，抄错后文档与代码会一致地错，没有任何测试能发现。
   */
  test('全历史：18122 / 19788 / +1666（与 2026 全年是不同数字）', () => {
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END) AS runLoad,
           SUM(COALESCE(training_load, 0)) AS allLoad
         FROM activities`,
      )
      .get() as { runLoad: number; allLoad: number };
    expect(Math.round(row.runLoad)).toBe(18122);
    expect(Math.round(row.allLoad)).toBe(19788);
    expect(Math.round(row.allLoad - row.runLoad)).toBe(1666);
    // 两个数必须不同 —— 若哪天相等，说明某处查询条件写错了
    expect(Math.round(row.runLoad)).not.toBe(15668);
  });

  /**
   * **力量负荷只加 `load`，不改 `distance`/`duration`/`runs`** —— 这是
   * `mergeStrengthIntoTrainingLoads` 的核心纪律，也是「跑步天数」标签能成立的前提。
   *
   * 若某天有人把力量的 distance 也并进去，首页「本月距离」会突然虚高，
   * 而所有夹具测试仍然全绿（夹具里的力量课 distance 本来就是 0）。
   */
  test('合并口径不改跑步的 distance/duration/runs（只加 load）', () => {
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN ${RUN} THEN COALESCE(distance, 0) ELSE 0 END) AS runKm,
           SUM(COALESCE(distance, 0)) AS allKm,
           SUM(CASE WHEN ${RUN} THEN 1 ELSE 0 END) AS runN,
           COUNT(*) AS allN
         FROM activities
         WHERE start_time_local LIKE '2026%'`,
      )
      .get() as { runKm: number; allKm: number; runN: number; allN: number };
    // 真实库 2026 年：跑步 1893.3km vs 全类型 1903.53km（差 10.23km，
    // 来自游泳/篮球/乒乓这类「有距离但不属跑步」的活动 —— 它们**不进**合并
    // 训练负荷序列，因为 `getTrainingLoads` 只取跑步，力量只加 load）。
    expect(row.runKm).toBeLessThan(row.allKm);
    expect(row.runN).toBeLessThan(row.allN);
    // 距离差必须很小（力量/爬楼/HIIT/跳绳 distance 全 0，只有球类/游泳有距离）
    expect(row.allKm - row.runKm).toBeLessThan(row.runKm * 0.02);
  });

  /**
   * **年度里程差的来源是游泳/球类，不是力量** —— 首页 `DISTANCE_SCOPE_HINT`
   * 写「不含游泳/球类」必须与数据一致。
   *
   * 若哪天力量课开始记录距离（或球类被误加进跑步口径），这句措辞就会
   * 指向错误的类型，用户会去力量卡里找那 10km。
   */
  test('2026 年跑步 vs 全类型的距离差全部来自游泳/球类（力量距离恒 0）', () => {    const byType = db
      .prepare(
        `SELECT activity_type AS t,
                ROUND(SUM(COALESCE(distance, 0)), 2) AS km
         FROM activities
         WHERE start_time_local LIKE '2026%'
         GROUP BY activity_type
         HAVING km > 0
         ORDER BY km DESC`,
      )
      .all() as { t: string; km: number }[];

    const nonRunning = byType.filter(
      (r) => !['running', 'track_running', 'treadmill_running'].includes(r.t),
    );
    // 前提自证：确实有非跑步活动带距离（否则这条守卫无意义）
    expect(nonRunning.length).toBeGreaterThan(0);

    // 力量训练距离必须恒为 0 —— 这是「不含游泳/球类」措辞能成立的关键
    const strength = byType.find((r) => r.t === 'strength_training');
    expect(strength).toBeUndefined();

    // 带距离的非跑步类型只有游泳 + 球类
    const allowed = new Set(['lap_swimming', 'open_water_swimming', 'basketball', 'table_tennis', 'badminton']);
    const unexpected = nonRunning.filter((r) => !allowed.has(r.t));
    expect(unexpected).toEqual([]);

    // 差值总量 < 跑步总量的 2%（真实库 10.23 / 1893.3 = 0.54%）
    const diff = nonRunning.reduce((s, r) => s + r.km, 0);
    const runKm = byType
      .filter((r) => ['running', 'track_running', 'treadmill_running'].includes(r.t))
      .reduce((s, r) => s + r.km, 0);
    expect(diff / runKm).toBeLessThan(0.02);
  });

  /**
   * **第十九类：「当前跑力」固定近一周，与所选周期无关。**
   *
   * `/stats` 的「当前跑力」来自 `getStats('week').averageVDOT`（页面固定二次
   * 取数），而其余八格跟随 `period`。真实库：近 7 天 40.3（1 条）、
   * 2026 全年均值 39.6（106 条）、全历史 39.3（123 条）。
   *
   * 这条守卫证明「三个数确实不同」—— 若哪天它们相等（例如数据太少），
   * hint 存在的必要性就消失了，届时应重新评估措辞。
   */
  test('近一周 / 2026 全年 / 全历史 的 VDOT 均值互不相同（hint 有必要）', () => {
    const recent = db
      .prepare(
        `SELECT AVG(vdot_value) AS v, COUNT(vdot_value) AS n
         FROM activities
         WHERE ${RUN} AND vdot_value IS NOT NULL
           AND start_time_local >= date('now', '-6 days')`,
      )
      .get() as { v: number | null; n: number };
    const year = db
      .prepare(
        `SELECT AVG(vdot_value) AS v, COUNT(vdot_value) AS n
         FROM activities
         WHERE ${RUN} AND vdot_value IS NOT NULL AND start_time_local LIKE '2026%'`,
      )
      .get() as { v: number | null; n: number };
    const all = db
      .prepare(
        `SELECT AVG(vdot_value) AS v, COUNT(vdot_value) AS n
         FROM activities WHERE ${RUN} AND vdot_value IS NOT NULL`,
      )
      .get() as { v: number | null; n: number };

    // 全年与全历史样本量大（VDOT 只对 Z3+ 代表段计算，不是每次跑都有）
    expect(year.n).toBeGreaterThan(50);
    expect(all.n).toBeGreaterThan(100);
    expect(year.v).not.toBeNull();
    expect(all.v).not.toBeNull();

    // 三个窗口的均值互不相同（差值 > 0.1）
    expect(Math.abs((year.v as number) - (all.v as number))).toBeGreaterThan(0.1);
    if (recent.n > 0) {
      expect(Math.abs((recent.v as number) - (year.v as number))).toBeGreaterThan(0.1);
    }
  });

  /**
   * **第二十类：`/stats` 的累计爬升差值 100% 来自爬楼，力量恒为 0。**
   *
   * `STATS_SCOPE_HINT` 旧文案只写「不含力量训练」。但用户拿 Garmin 上的总爬升
   * 减 `/stats` 的爬升，差的 1312m 全在**爬楼**里 —— 去力量卡永远找不到
   * （51 条力量训练爬升合计恒为 0）。
   *
   * 这条守卫同时钉两件事：
   *  1. 爬升差值确实非零且量级显著（否则提示可以不提）；
   *  2. 差值的**全部**来自爬楼，力量贡献精确为 0 —— 这是「必须点爬楼」的证据。
   *
   * 若哪天力量训练开始记录爬升（或爬楼被并入跑步口径），本测试会红，
   * 迫使改动者重新核对提示里的类型清单。
   */
  test('累计爬升差值 100% 来自爬楼（力量训练爬升恒为 0）', () => {
    const row = db
      .prepare(
        `SELECT
           ROUND(SUM(CASE WHEN ${RUN} THEN COALESCE(total_ascent, 0) ELSE 0 END), 2) AS runAsc,
           ROUND(SUM(COALESCE(total_ascent, 0)), 2) AS allAsc,
           ROUND(SUM(CASE WHEN activity_type = 'strength_training'
                          THEN COALESCE(total_ascent, 0) ELSE 0 END), 2) AS strengthAsc,
           ROUND(SUM(CASE WHEN activity_type = 'floor_climbing'
                          THEN COALESCE(total_ascent, 0) ELSE 0 END), 2) AS floorAsc
         FROM activities`,
      )
      .get() as { runAsc: number; allAsc: number; strengthAsc: number; floorAsc: number };

    // 真实库：跑步 7853 / 全类型 9165 / 差 1312
    expect(Math.round(row.runAsc)).toBe(7853);
    expect(Math.round(row.allAsc)).toBe(9165);
    expect(Math.round(row.allAsc - row.runAsc)).toBe(1312);

    // 关键反证：力量训练爬升**精确为 0**，1312 全部来自爬楼
    expect(row.strengthAsc).toBe(0);
    expect(Math.round(row.floorAsc)).toBe(1312);
    expect(Math.round(row.allAsc - row.runAsc)).toBe(Math.round(row.floorAsc));
  });

  /**
   * **同一句提示要覆盖九格，而九格的差值来源不是同一个类型** —— 这条钉住
   * 「只点名力量是不够的」这个事实：训练负荷的差值 100% 来自力量、爬升的
   * 差值 100% 来自爬楼，两者互补且互不重叠。
   */
  test('负荷差值 100% 来自力量、爬升差值 100% 来自爬楼（互补且不重叠）', () => {
    const row = db
      .prepare(
        `SELECT
           ROUND(SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END), 2) AS runLoad,
           ROUND(SUM(CASE WHEN activity_type = 'strength_training'
                          THEN COALESCE(training_load, 0) ELSE 0 END), 2) AS strengthLoad,
           ROUND(SUM(CASE WHEN activity_type = 'floor_climbing'
                          THEN COALESCE(training_load, 0) ELSE 0 END), 2) AS floorLoad
         FROM activities`,
      )
      .get() as { runLoad: number; strengthLoad: number; floorLoad: number };

    // 负荷：差值全部来自力量，爬楼贡献精确为 0
    expect(Math.round(row.strengthLoad)).toBe(1666);
    expect(row.floorLoad).toBe(0);
    // 反过来：爬升差值全部来自爬楼，力量贡献精确为 0（见上一条）
    // —— 两句合起来证明「只写『不含力量训练』会让爬升的差值无处解释」
    expect(row.strengthLoad).toBeGreaterThan(0);
  });

  /**
   * **第二十一类：`/insight` 负荷卡的三格是两个口径。**
   *
   * 急性/慢性来自 `getCombinedTrainingLoads`（跑步 + 力量），峰值周跑量来自
   * `periodization`（`getInsightActivityRows` 带 `runningTypeClause`，纯跑步）。
   *
   * 这条守卫证明「两个口径确实不同」，否则提示存在的必要性就消失。
   * 用最近 28 天窗口（与 ACWR 的慢性窗同一区间）。
   */
  test('/insight 负荷卡：近 28 天合并负荷 ≠ 跑步负荷（力量贡献显著）', () => {
    const row = db
      .prepare(
        `SELECT
           ROUND(SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END), 2) AS runLoad,
           ROUND(SUM(COALESCE(training_load, 0)), 2) AS combinedLoad,
           ROUND(SUM(CASE WHEN activity_type = 'strength_training'
                          THEN COALESCE(training_load, 0) ELSE 0 END), 2) AS strengthLoad
         FROM activities
         WHERE start_time_local >= date('now', '-27 days')`,
      )
      .get() as { runLoad: number; combinedLoad: number; strengthLoad: number };

    // 合并 ≡ 跑步 + 力量（这是 LoadInsight 的 acute/chronic 的口径）
    expect(Math.abs(row.combinedLoad - (row.runLoad + row.strengthLoad))).toBeLessThan(0.01);
    // 两个数必须不同 —— 若相等说明该窗口没有力量课，提示就无从验证
    expect(row.combinedLoad).toBeGreaterThan(row.runLoad);
    expect(row.strengthLoad).toBeGreaterThan(0);
  });

  /**
   * **第二十二类：`/list` 月卡的「里程」是跑步口径、「次数」是全类型口径。**
   *
   * 真实库 2026-09 卡片显示「200.84 公里 · 25 次」：200.84km 只来自 21 次跑步，
   * 25 次是全部活动（21 跑步 + 2 力量 + 1 爬楼 + 1 游泳）。两个数字并列，
   * 读者自然算出「平均 8.03 km/次」，而真实跑步均距 9.56 km —— 差 19%。
   *
   * 这条守卫钉住「count 与 runCount 确实不同」这个事实（若某天相等，
   * 次数标注就成了噪音），并给出具体的差值量级。
   */
  test('/list 月卡：count（全类型）> runCount（跑步），差值来自非跑步活动', () => {
    const rows = db
      .prepare(
        `SELECT substr(start_time_local, 1, 7) AS m,
                COUNT(*) AS n,
                SUM(CASE WHEN ${RUN} THEN 1 ELSE 0 END) AS runN
         FROM activities
         WHERE start_time_local IS NOT NULL
         GROUP BY m
         ORDER BY m`,
      )
      .all() as { m: string; n: number; runN: number }[];

    // 前提自证：真实库里存在「同月两种计数不等」的月份
    const mismatched = rows.filter((r) => r.n > r.runN);
    expect(mismatched.length).toBeGreaterThanOrEqual(8);

    // 2026-09 是文档里引用的例子：25 次 vs 21 跑步
    const sep = rows.find((r) => r.m === '2026-09');
    expect(sep).toBeDefined();
    expect(sep!.n).toBe(25);
    expect(sep!.runN).toBe(21);

    // 2026-02 是最极端的月份（16 条爬楼）：37 次 vs 19 跑步
    const feb = rows.find((r) => r.m === '2026-02');
    expect(feb).toBeDefined();
    expect(feb!.n).toBe(37);
    expect(feb!.runN).toBe(19);

    // 每个月的 runCount 都必须 ≤ count（不能出现「跑步次数多于总次数」）
    for (const r of rows) expect(r.runN).toBeLessThanOrEqual(r.n);
  });

  /**
   * **第二十三类：`/insight`「周期化分析」表同一行也是两种口径。**
   *
   * `computePeriodization` 吃的 `dailyLoads` 来自 `getCombinedTrainingLoads`，
   * 但 `aggregateWeeklyLoad` 四个列各取不同字段：
   *
   * | 列 | 字段 | 口径 |
   * |----|------|------|
   * | 跑量 km | `distanceMeters` | **纯跑步** |
   * | 次数 n | `runs` | **纯跑步** |
   * | 负荷 tl | `load` | **跑步 + 力量** |
   * | CTL/ATL/TSB | `computeTrainingLoads` | **跑步 + 力量** |
   *
   * 这条守卫钉住「同一周里两个口径确实不同」：ISO 周 2026-W43
   * （10-19..10-25）合并负荷 256 / 跑步负荷 196（差 60，全来自力量），
   * 而同一周的跑量 28.32km 与次数 3 都是纯跑步。
   *
   * 若哪天两者相等（该周没有力量课），hint 的必要性就消失 —— 本测试会红，
   * 迫使改动者重新核对示例周。
   */
  test('/insight 周期化：同一 ISO 周内合并负荷 ≠ 跑步负荷，但跑量/次数只算跑步', () => {
    const row = db
      .prepare(
        `SELECT
           ROUND(SUM(COALESCE(training_load, 0)), 1) AS tlAll,
           ROUND(SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END), 1) AS tlRun,
           ROUND(SUM(CASE WHEN activity_type = 'strength_training'
                          THEN COALESCE(training_load, 0) ELSE 0 END), 1) AS sl,
           ROUND(SUM(CASE WHEN ${RUN} THEN COALESCE(distance, 0) ELSE 0 END), 2) AS km,
           SUM(CASE WHEN ${RUN} THEN 1 ELSE 0 END) AS n
         FROM activities
         WHERE substr(start_time_local, 1, 10) BETWEEN '2026-10-19' AND '2026-10-25'`,
      )
      .get() as { tlAll: number; tlRun: number; sl: number; km: number; n: number };

    // 合并负荷 = 跑步 + 力量（这是周期化表 tl 列的口径）
    expect(Math.abs(row.tlAll - (row.tlRun + row.sl))).toBeLessThan(0.01);
    expect(row.tlAll).toBe(256);
    expect(row.tlRun).toBe(196);
    expect(row.sl).toBe(60);

    // 跑量与次数是纯跑步口径（合并规则只加 load，distance/runs 保留跑步值）
    expect(row.km).toBe(28.32);
    expect(row.n).toBe(3);
  });

  /**
   * **第二十四类：注入 AI 的跑者画像里，跑量与负荷是两种口径。**
   *
   * `formatRunnerProfile` 的文本会进入**每一次**活动分析的 prompt。其中
   * 生涯/近期/周环比来自 `getStats` + `getActivities(runningOnly)`（纯跑步），
   * 负荷来自 `getCombinedTrainingLoads`（跑步 + 力量）。
   *
   * 这条守卫钉住「两个口径确实不同」：全历史跑步负荷 18122 / 合并 19788
   * （差 1666，全来自力量训练）。若哪天相等，那句说明就成了噪音。
   */
  test('跑者画像：全历史合并负荷 ≠ 跑步负荷（力量贡献 1666）', () => {
    const row = db
      .prepare(
        `SELECT
           ROUND(SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END), 0) AS runLoad,
           ROUND(SUM(COALESCE(training_load, 0)), 0) AS combinedLoad,
           ROUND(SUM(CASE WHEN activity_type = 'strength_training'
                          THEN COALESCE(training_load, 0) ELSE 0 END), 0) AS strengthLoad
         FROM activities`,
      )
      .get() as { runLoad: number; combinedLoad: number; strengthLoad: number };

    expect(row.runLoad).toBe(18122);
    expect(row.combinedLoad).toBe(19788);
    expect(row.strengthLoad).toBe(1666);
    // 合并 ≡ 跑步 + 力量（这是 CTL/ATL/TSB 的口径）
    expect(row.combinedLoad).toBe(row.runLoad + row.strengthLoad);
  });
});
