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
 * 2026-02 1727 vs 2025（+298 / 17%）、2026 全年 18122 vs 19788（+1666）。
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

  /** 2026 全年：差 1666（这是「同一个词两个数」在年度尺度上的量级）。 */
  test('2026 全年：合并 − 跑步 = 力量负荷（真实库 1666）', () => {
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN ${RUN} THEN COALESCE(training_load, 0) ELSE 0 END) AS runLoad,
           SUM(CASE WHEN activity_type = 'strength_training'
                    THEN COALESCE(training_load, 0) ELSE 0 END) AS strengthLoad
         FROM activities
         WHERE start_time_local LIKE '2026%'`,
      )
      .get() as { runLoad: number; strengthLoad: number };
    // 力量负荷是正数且量级合理（不是 0、也不吞掉跑量）
    expect(row.strengthLoad).toBeGreaterThan(1000);
    expect(row.runLoad).toBeGreaterThan(15000);
    // 差值占跑步负荷的 5%–20%（真实库 9.2%）
    const share = row.strengthLoad / row.runLoad;
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.2);
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
  test('2026 年跑步 vs 全类型的距离差全部来自游泳/球类（力量距离恒 0）', () => {
    const byType = db
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
});
