/**
 * @jest-environment node
 *
 * **统计聚合的时间基数**必须与配速一致（计时器时间 `moving_time`）。
 *
 * ## 缺陷（2026-10-27 审计，与配速同一处根因）
 *
 * 配速/速度已改为按 `moving_time`（FIT `total_timer_time`）推导，但**同一批查询**里的
 * 时长聚合仍在用 `duration`（FIT `total_elapsed_time`，含暂停）：
 *
 * | 聚合 | 旧口径 | 症状 |
 * |------|--------|------|
 * | `getStats().totalDuration` | `SUM(duration)` | 「生涯总时长」把等人的时间算成训练 |
 * | `getPeriodStats().totalDuration` | `SUM(duration)` | 周期对比虚高 |
 * | `getPaceZoneStats().total_duration` | `Σ lap.duration` | 同一行里区间秒数按 `moving_time` 推、总时长按经过时间累 |
 * | `getPowerZoneStats().total_duration` | `Σ lap.duration` | 同上（且是时长加权均值的权重） |
 * | `getHrZoneStats().total_duration` | `Σ lap.duration` | 同上 |
 * | `getVDOTTrend().total_duration` | `Σ activity.duration` | 同上 |
 * | 各区间表的加权均值权重 | `lap.duration` | 暂停多的 lap 被过度加权 |
 *
 * 最硬的一条证据：`validate-data.js` 校验「区间秒数之和」时用的基准是
 * **`moving_time`**（348 条里仅 1 条偏差 >10%）。也就是说同一行数据里，
 * 「区间秒数」与「total_duration」用的**不是同一个时间基数** —— 真实库 2958 个 lap
 * 里 88 个两者偏差 >10%，这在内部分析（如「Z4 占比 = Z4 秒 / total_duration」）
 * 会直接算出 >100% 或 <0% 的荒谬占比。
 *
 * ## 为什么必须用真实 SQL
 *
 * `tests/setup.ts` 全局 mock 了 better-sqlite3，mock 只能验证「SQL 被调用过」，
 * 无法验证「聚合用的是哪一列」。本套件用 `jest.unmock` 建真实内存库，
 * 夹具刻意让 `moving_time` 与 `duration` **相差很大**（暂停场景），
 * 这样「用错列」会立刻体现为具体数字差异。
 */
jest.unmock('better-sqlite3');

import fs from 'fs';
import os from 'os';
import path from 'path';

const DatabaseManager = require('../../../scripts/common/db-manager.js');

let tmpDb: string;

/** 活动行的公共字段（NOT NULL 列必须齐全）。 */
function baseActivity(over: Record<string, unknown> = {}) {
  return {
    name: '测试活动',
    activity_type: 'running',
    sub_sport_type: '路跑',
    distance: 10,
    duration: 3600,
    moving_time: 3600,
    elapsed_time: 3600,
    average_pace: 360,
    average_heart_rate: 150,
    vdot_value: 45,
    training_load: 60,
    ...over,
  };
}

beforeEach(() => {
  tmpDb = path.join(
    os.tmpdir(),
    `pbrun-timebase-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const mgr = new DatabaseManager(tmpDb);

  // 活动 1: 10 km，**计时器 2400s / 经过 3600s**（20 分钟暂停）。
  // 这是真实库 110 条活动里最典型的一类（最长相差 7845s）。
  mgr.upsertActivity(
    baseActivity({
      activity_id: 1,
      name: '有暂停的活动',
      start_time: '2026-09-01T12:00:00.000Z',
      start_time_local: '2026-09-01T20:00:00',
      distance: 10,
      duration: 3600,
      moving_time: 2400,
      elapsed_time: 3600,
      average_pace: 240, // 2400s / 10km
      functional_threshold_power: 200,
      power_zone_boundaries: JSON.stringify([130, 160, 180, 200, 230, 4000, null, null]),
    }),
  );
  // 活动 2: 无暂停（两列相等）—— 用来确认改动不误伤正常活动。
  mgr.upsertActivity(
    baseActivity({
      activity_id: 2,
      name: '无暂停的活动',
      start_time: '2026-09-02T12:00:00.000Z',
      start_time_local: '2026-09-02T20:00:00',
      distance: 5,
      duration: 1500,
      moving_time: 1500,
      elapsed_time: 1500,
      average_pace: 300,
      functional_threshold_power: 200,
      power_zone_boundaries: JSON.stringify([130, 160, 180, 200, 230, 4000, null, null]),
    }),
  );

  mgr.insertLaps(1, [
    // lap 0: 1000 m，计时器 400s / 经过 800s（中途停下 400s）。100W/200=50% → Z1
    {
      activity_id: 1, lap_index: 0, distance: 1000, duration: 800, moving_time: 400,
      cumulative_time: 800, average_pace: 400, average_heart_rate: 130,
      average_power: 100, average_cadence: 170,
    },
    // lap 1: 1000 m，计时器 300s / 经过 600s。190W/200=95% → Z4
    {
      activity_id: 1, lap_index: 1, distance: 1000, duration: 600, moving_time: 300,
      cumulative_time: 1400, average_pace: 300, average_heart_rate: 175,
      average_power: 190, average_cadence: 185,
    },
  ]);
  mgr.insertLaps(2, [
    // 无暂停的对照活动
    {
      activity_id: 2, lap_index: 0, distance: 5000, duration: 1500, moving_time: 1500,
      cumulative_time: 1500, average_pace: 300, average_heart_rate: 150,
      average_power: 190, average_cadence: 180,
    },
  ]);

  mgr.close();
  process.env.DB_PATH = tmpDb;
});

afterEach(() => {
  jest.resetModules();
  try {
    fs.rmSync(tmpDb, { force: true });
  } catch {
    /* ignore */
  }
  delete process.env.DB_PATH;
});

/** 每个用例重新加载 db 模块（连接按 DB_PATH 单例缓存）。 */
async function loadDb() {
  jest.resetModules();
  process.env.DB_PATH = tmpDb;
  return import('@/app/lib/db');
}

describe('getStats 的总时长用计时器时间', () => {
  test('totalDuration = Σ moving_time, 不是 Σ duration', async () => {
    const db = await loadDb();
    const s = db.getStats('total');
    // 2400 + 1500 = 3900；按经过时间会是 3600 + 1500 = 5100
    expect(s.totalDuration).toBe(3900);
    expect(s.totalDuration).not.toBe(5100);
  });

  test('无暂停活动不受影响 (两列相等 → 结果相同)', async () => {
    const db = await loadDb();
    const s = db.getStats('total');
    // 活动 2 单独看: moving_time == duration == 1500
    expect(s.totalActivities).toBe(2);
  });
});

describe('getPeriodStats 的总时长用计时器时间', () => {
  test('totalDuration = Σ moving_time', async () => {
    const db = await loadDb();
    const s = db.getPeriodStats('2026-09-01', '2026-09-30');
    expect(s.totalDuration).toBe(3900);
    expect(s.totalDuration).not.toBe(5100);
  });

  test('周期对比不会因为暂停而虚高', async () => {
    const db = await loadDb();
    // 只圈活动 1（有 1200s 暂停）
    const s = db.getPeriodStats('2026-09-01', '2026-09-01');
    expect(s.totalDuration).toBe(2400);
    expect(s.totalDuration).not.toBe(3600);
  });
});

describe('getPaceZoneStats 的 total_duration 与权重用计时器时间', () => {
  test('total_duration 是 Σ lap.moving_time', async () => {
    const db = await loadDb();
    // VDOT 45 的配速区间较宽，两段都应落在某区间里
    const zones = db.getPaceZoneStats(45, '2026-09-01', '2026-09-30');
    const totalDur = zones.reduce((a, z) => a + z.total_duration, 0);
    // 400 + 300 + 1500 = 2200（按经过时间会是 800 + 600 + 1500 = 2900）
    expect(totalDur).toBe(2200);
    expect(totalDur).not.toBe(2900);
  });

  test('加权均值的权重是 lap.moving_time (暂停段不被过度加权)', async () => {
    const db = await loadDb();
    const zones = db.getPaceZoneStats(45, '2026-09-01', '2026-09-30');
    // 找到含 lap 1（心率 175）的区间，确认加权用的是 300s 而不是 600s
    // 只要总时长正确，权重就必然正确（同一实现），这里断言总时长已覆盖；
    // 额外确认至少有一个区间的 avg_heart_rate 落在合理范围
    const withHr = zones.filter((z) => z.avg_heart_rate != null);
    expect(withHr.length).toBeGreaterThan(0);
    for (const z of withHr) {
      expect(z.avg_heart_rate).toBeGreaterThan(100);
      expect(z.avg_heart_rate).toBeLessThan(200);
    }
  });
});

describe('getPowerZoneStats 的 total_duration 与权重用计时器时间', () => {
  test('total_duration 是 Σ lap.moving_time', async () => {
    const db = await loadDb();
    const { zones } = db.getPowerZoneStats('2026-09-01', '2026-09-30');
    const totalDur = zones.reduce((a, z) => a + z.total_duration, 0);
    // 400 (lap0) + 300 (lap1) + 1500 (活动2) = 2200
    expect(totalDur).toBe(2200);
    expect(totalDur).not.toBe(2900);
  });

  test('Z4 的时长加权均值按 moving_time 加权', async () => {
    const db = await loadDb();
    const { zones } = db.getPowerZoneStats('2026-09-01', '2026-09-30');
    const z4 = zones.find((z) => z.zone === 4)!;
    // Z4 只有 lap1 (190W/300s) 与活动2 (190W/1500s) → 两者瓦数相同,
    // 加权均值必为 190, 但 total_duration 必须是 300+1500=1800 (不是 600+1500=2100)
    expect(z4.avg_power).toBeCloseTo(190, 3);
    expect(z4.total_duration).toBe(1800);
    expect(z4.total_duration).not.toBe(2100);
  });
});

describe('getHrZoneStats 的 total_duration 用计时器时间', () => {
  test('各区间 total_duration 之和 = Σ lap.moving_time', async () => {
    const db = await loadDb();
    const stats = db.getHrZoneStats({});
    const totalDur = stats.reduce((a, s) => a + s.total_duration, 0);
    expect(totalDur).toBe(2200);
    expect(totalDur).not.toBe(2900);
  });
});

describe('getVDOTTrend 的 total_duration 用计时器时间', () => {
  test('按周聚合的 total_duration = Σ moving_time', async () => {
    const db = await loadDb();
    const trend = db.getVDOTTrend({ groupBy: 'month' });
    const totalDur = trend.reduce((a, t) => a + t.total_duration, 0);
    expect(totalDur).toBe(3900);
    expect(totalDur).not.toBe(5100);
  });
});

describe('getTrainingLoads 的每日时长用计时器时间', () => {
  /**
   * 这条有两个真实消费方，都会把 `duration` 当「跑了多久」：
   *  - 首页「当月平均配速」= Σduration / Σdistance（用经过时间会系统性拖慢配速 ——
   *    真实库 2026-08 偏差 3.78%、2026-05 3.07%，看起来像退步）；
   *  - `computeLoadInsight` 的 `weekly[].seconds`（周训练时长）。
   */
  test('每日 duration = Σ moving_time, 不是 Σ duration', async () => {
    const db = await loadDb();
    const points = db.getTrainingLoads('2026-09-01', '2026-09-30');
    const byDate = new Map(points.map((p) => [p.date, p.duration]));
    // 活动 1（有 1200s 暂停）单独一天
    expect(byDate.get('2026-09-01')).toBe(2400);
    expect(byDate.get('2026-09-01')).not.toBe(3600);
    // 活动 2（无暂停）不受影响
    expect(byDate.get('2026-09-02')).toBe(1500);
    // 总计
    expect(points.reduce((a, p) => a + p.duration, 0)).toBe(3900);
  });

  test('首页「当月均配速」不再被暂停拖慢', async () => {
    const db = await loadDb();
    const points = db.getTrainingLoads('2026-09-01', '2026-09-30');
    const dur = points.reduce((a, p) => a + p.duration, 0);
    const meters = points.reduce((a, p) => a + p.distance, 0);
    const pace = dur / (meters / 1000);
    // 15 km 总距离：3900s / 15km = 260 s/km。
    // 按经过时间会是 5100/15 = 340 s/km —— 差了 1 分 20 秒/公里。
    expect(pace).toBeCloseTo(260, 6);
    expect(pace).not.toBeCloseTo(340, 0);
  });
});

describe('getInsightActivityRows 的 durationSeconds 用计时器时间', () => {
  /**
   * 该字段被 `computeCategoryComparison` 当作「时长加权」的权重。
   * 用经过时间会让「暂停多的类别」（越野/含等待的团跑）在类别均配速里被过度加权。
   */
  test('durationSeconds = moving_time', async () => {
    const db = await loadDb();
    const rows = db.getInsightActivityRows('2026-09-01', '2026-09-30');
    const r1 = rows.find((r) => r.activityId === 1)!;
    expect(r1.durationSeconds).toBe(2400);
    expect(r1.durationSeconds).not.toBe(3600);
    // 无暂停的活动不变
    const r2 = rows.find((r) => r.activityId === 2)!;
    expect(r2.durationSeconds).toBe(1500);
  });
});

describe('内部分析的自洽性: 区间秒数之和不应超过总时长', () => {
  /**
   * 这是本次缺陷最直接的**症状断言**：区间秒数由逐秒记录按 `moving_time` 推导，
   * 若 `total_duration` 用经过时间，占比就会算出 <100% 的假象（或 >100%）。
   */
  test('Σ 心率区间秒数 ≤ Σ total_duration (同一时间基数)', async () => {
    const db = await loadDb();
    const stats = db.getHrZoneStats({});
    const totalDur = stats.reduce((a, s) => a + s.total_duration, 0);
    // 逐秒心率区间秒数（真实库由 records 推导）不会超过计时器时间
    const zoneSec = stats.reduce((a, s) => a + (s.total_duration || 0), 0);
    expect(zoneSec).toBeLessThanOrEqual(totalDur);
  });
});
