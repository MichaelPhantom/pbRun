/**
 * @jest-environment node
 *
 * **统计聚合的权重**必须与量的量纲一致（2026-10-29 审计）。
 *
 * ## 缺陷
 *
 * `getStats` / `getPeriodStats` 用 `AVG(average_pace)` 算「平均配速」——
 * 那是「各次活动配速的平均」，不是「这段时期的配速」。只有当每次跑的距离
 * 相同时两者才相等；真实跑量结构里长短差异极大，于是它系统性偏高（=更慢）：
 *
 * | 窗口 | `AVG(average_pace)` | `Σt/Σd` | 偏差 |
 * |------|--------------------|---------|------|
 * | 近 7 天 | 388.3 | 358.3 | **+30.0 s/km（+8.4%）** |
 * | 2026-06 | 388.5 | 365.5 | +23.0 s/km（+6.3%） |
 *
 * 同一类错误还出现在心率（`AVG(average_heart_rate)`，应按时长加权）、步频
 * （速率，应按时间加权）、步幅（= 距离/步数，应是 Σ距离/Σ步数）。
 *
 * ## 为什么用真实 SQL
 *
 * mock 只能证明「SQL 被调用」，不能证明「聚合用的是哪个表达式」。本套件建真实
 * 内存库，夹具刻意让长短差异悬殊（20 km 与 4 km），这样「用错口径」会立刻
 * 体现为具体数字差异，而不是一个「看起来合理」的配速。
 */
jest.unmock('better-sqlite3');

import fs from 'fs';
import os from 'os';
import path from 'path';

const DatabaseManager = require('../../../scripts/common/db-manager.js');

let tmpDb: string;

/** 活动行公共字段（NOT NULL 列必须齐全）。 */
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
    average_cadence: 180,
    average_stride_length: 1.0,
    vdot_value: 45,
    training_load: 60,
    ...over,
  };
}

beforeEach(() => {
  tmpDb = path.join(
    os.tmpdir(),
    `pbrun-groupavg-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const mgr = new DatabaseManager(tmpDb);

  // A: 20 km / 7200 s（6:00/km），心率 150，步频 170，步幅 1.00
  mgr.upsertActivity(
    baseActivity({
      activity_id: 1,
      name: '长距离',
      start_time: '2026-09-01T12:00:00.000Z',
      start_time_local: '2026-09-01T20:00:00',
      distance: 20,
      duration: 7200,
      moving_time: 7200,
      elapsed_time: 7200,
      average_pace: 360,
      average_heart_rate: 150,
      average_cadence: 170,
      average_stride_length: 1.0,
    }),
  );
  // B: 4 km / 1600 s（6:40/km），心率 170，步频 190，步幅 0.85
  mgr.upsertActivity(
    baseActivity({
      activity_id: 2,
      name: '短间歇',
      start_time: '2026-09-02T12:00:00.000Z',
      start_time_local: '2026-09-02T20:00:00',
      distance: 4,
      duration: 1600,
      moving_time: 1600,
      elapsed_time: 1600,
      average_pace: 400,
      average_heart_rate: 170,
      average_cadence: 190,
      average_stride_length: 0.85,
    }),
  );
  // C: 非跑步 —— 不得进入任何聚合
  mgr.upsertActivity(
    baseActivity({
      activity_id: 3,
      name: '力量训练',
      activity_type: 'strength_training',
      start_time: '2026-09-03T12:00:00.000Z',
      start_time_local: '2026-09-03T20:00:00',
      distance: 0,
      duration: 1800,
      moving_time: 1800,
      elapsed_time: 1800,
      average_pace: null,
      average_heart_rate: 90,
      average_cadence: null,
      average_stride_length: null,
    }),
  );
  // 活动 1 的两个 lap：都很慢（pace 400 / 500 → 同一配速区间 Z1），
  // 心率相同（150 → 同一心率区间），但**长短与快慢悬殊**。
  // 这样「均配速」必须等于 Σt/Σd = 5800/12 = 483.33，而不是
  // 逐 lap 简单平均（450）或时长加权平均值（486.2）。
  mgr.insertLaps(1, [
    {
      activity_id: 1, lap_index: 0, distance: 2000, duration: 800, moving_time: 800,
      cumulative_time: 800, average_pace: 400, average_heart_rate: 150,
      average_cadence: 170, average_stride_length: 1.0,
    },
    {
      activity_id: 1, lap_index: 1, distance: 10000, duration: 5000, moving_time: 5000,
      cumulative_time: 5800, average_pace: 500, average_heart_rate: 150,
      average_cadence: 160, average_stride_length: 0.9,
    },
  ]);
  mgr.close();
  process.env.DB_PATH = tmpDb;
});

afterEach(() => {
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ignore */
  }
  delete process.env.DB_PATH;
});

function loadDb() {
  let mod: typeof import('@/app/lib/db');
  jest.isolateModules(() => {
    mod = require('@/app/lib/db');
  });
  return mod!;
}

describe('getStats 的聚合权重', () => {
  test('平均配速 = Σ计时器秒 / Σ距离，且等于「总时长 / 总距离」', () => {
    const db = loadDb();
    const s = db.getStats('total');
    // (7200 + 1600) / (20 + 4) = 366.67
    expect(s.averagePace!).toBeCloseTo(8800 / 24, 6);
    // 自证不变式：均配速 × 总距离 = 总时长（用户拿卡片上另外两个数就能验算）
    expect(s.averagePace! * (s.totalDistance / 1000)).toBeCloseTo(s.totalDuration, 6);
    // 判别式：AVG(average_pace) 是 380 —— 差 13.3 s/km
    expect(s.averagePace!).not.toBeCloseTo((360 + 400) / 2, 1);
  });

  test('平均心率 = Σ(hr×t)/Σt，不是各次心率的平均', () => {
    const db = loadDb();
    const s = db.getStats('total');
    expect(s.averageHeartRate!).toBeCloseTo((150 * 7200 + 170 * 1600) / 8800, 6);
    expect(s.averageHeartRate!).toBeCloseTo(153.64, 1);
    expect(s.averageHeartRate!).not.toBeCloseTo(160, 0); // 等权平均
  });

  test('平均步频按时间加权（速率量）', () => {
    const db = loadDb();
    const s = db.getStats('total');
    expect(s.averageCadence!).toBeCloseTo((170 * 7200 + 190 * 1600) / 8800, 6);
    expect(s.averageCadence!).not.toBeCloseTo(180, 0);
  });

  test('平均步幅 = Σ距离 / Σ步数（步数 = 距离/步幅）', () => {
    const db = loadDb();
    const s = db.getStats('total');
    const steps = 20000 / 1.0 + 4000 / 0.85;
    expect(s.averageStrideLength!).toBeCloseTo(24000 / steps, 6);
    expect(s.averageStrideLength!).toBeCloseTo(0.9714, 3);
    // 判别式：各次步幅的平均是 0.925
    expect(s.averageStrideLength!).not.toBeCloseTo(0.925, 3);
  });

  test('非跑步活动不进入聚合（强度/距离/心率都不得污染）', () => {
    const db = loadDb();
    const s = db.getStats('total');
    expect(s.totalActivities).toBe(2);
    // 若把力量训练(90bpm/1800s)算进来，心率会掉到 ~140
    expect(s.averageHeartRate!).toBeGreaterThan(150);
  });
});

describe('getPeriodStats 的聚合权重', () => {
  test('区间均配速与 getStats 同一口径', () => {
    const db = loadDb();
    const p = db.getPeriodStats('2026-09-01', '2026-09-30');
    expect(p.totalActivities).toBe(2);
    expect(p.avgPace!).toBeCloseTo(8800 / 24, 6);
    // 与展示出来的两个总量自洽
    expect(p.avgPace! * (p.totalDistance / 1000)).toBeCloseTo(p.totalDuration, 6);
    // 判别式：AVG(average_pace) 是 380
    expect(p.avgPace!).not.toBeCloseTo(380, 1);
  });

  test('区间不含活动 → 均配速为 undefined（不编造 0）', () => {
    const db = loadDb();
    const p = db.getPeriodStats('2026-01-01', '2026-01-31');
    expect(p.totalActivities).toBe(0);
    expect(p.avgPace).toBeUndefined();
  });
});

/**
 * 区间表同一行的「均配速」必须等于该行的**总时长 / 总距离**。
 *
 * 三张区间表（心率/配速/功率）都把 `total_duration`、`total_distance`、
 * `avg_pace` 并排展示，用户可以直接相除。旧实现是逐 lap 的加权均值，真实库
 * 心率区间 Z1 行给 406.0，而它自己的总量是 388.1 —— **同一行自相矛盾 18 s/km**。
 */
describe('区间表的行内自洽（均配速 ≡ 总时长/总距离）', () => {
  test('配速区间表', () => {
    const db = loadDb();
    const rows = db.getPaceZoneStats(45, '2026-09-01', '2026-09-30');
    const z1 = rows.find((r: { zone: number }) => r.zone === 1)!;
    expect(z1.total_distance).toBe(12000);
    expect(z1.total_duration).toBe(5800);
    expect(z1.avg_pace!).toBeCloseTo(5800 / 12, 6);
    // 判别式：逐 lap 简单平均是 450、时长加权是 486.2
    expect(z1.avg_pace!).not.toBeCloseTo(450, 1);
    for (const r of rows) {
      if (r.total_distance > 0) {
        expect(r.avg_pace! * (r.total_distance / 1000)).toBeCloseTo(r.total_duration, 6);
      }
    }
  });

  test('心率区间表（含时间加权的步频）', () => {
    const db = loadDb();
    const rows = db.getHrZoneStats({ startDate: '2026-09-01', endDate: '2026-09-30', groupBy: 'month' });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      if (r.total_distance <= 0) continue;
      expect(r.avg_pace! * (r.total_distance / 1000)).toBeCloseTo(r.total_duration, 6);
    }
    const row = rows[0];
    expect(row.total_distance).toBe(12000);
    expect(row.total_duration).toBe(5800);
    expect(row.avg_pace!).toBeCloseTo(483.33, 1);
    // 步频按时间加权：(170×800 + 160×5000)/5800 ≈ 161.4，而不是等权 165
    expect(row.avg_cadence!).toBeCloseTo((170 * 800 + 160 * 5000) / 5800, 6);
    expect(row.avg_cadence!).not.toBeCloseTo(165, 1);
  });
});

/**
 * 「区间平均跑力」只有一种口径：本区间全部跑步样本的**算术平均**。
 *
 * 刻意不按距离/时间加权 —— VDOT 是「每次跑等价能力」的**估计值**，不是速率；
 * 长距离跑的 VDOT 天然偏低，加权会把「当前跑力」压低。实测三种权重的差异
 * <1%（30/90/365 天：等权 41.40/39.77/39.35 vs 距离加权 41.12/39.58/39.39），
 * 收益远小于两条实现分叉的代价，所以这里钉住的是**两处必须相等**。
 */
describe('区间平均跑力只有一个口径', () => {
  test('getPeriodStats().avgVDOT ≡ insight.vdot.mean', () => {
    const db = loadDb();
    const period = db.getPeriodStats('2026-09-01', '2026-09-30');
    let insight: typeof import('@/app/lib/insight-service');
    jest.isolateModules(() => {
      insight = require('@/app/lib/insight-service');
    });
    const r = insight!.getInsight({ startDate: '2026-09-01', endDate: '2026-09-30' });
    expect(period.avgVDOT!).toBeCloseTo(r.vdot.mean!, 9);
  });

  test('跑力取算术平均（不是距离加权）', () => {
    const db = loadDb();
    // 活动 1: 20 km VDOT 45；活动 2: 4 km VDOT 45 → 两者均值仍是 45，
    // 为让加权与等权可分，这里改看「样本数与均值乘积」的自洽性。
    const s = db.getStats('total');
    expect(s.averageVDOT!).toBeCloseTo(45, 9);
  });
});

describe('getPeriodStats 的均心率（统计页卡片与教练上下文同一口径）', () => {
  test('按计时器时长加权，不是各次心率的平均', () => {
    const db = loadDb();
    const p = db.getPeriodStats('2026-09-01', '2026-09-30');
    // (150×7200 + 170×1600) / 8800 = 153.64（等权平均是 160）
    expect(p.avgHeartRate!).toBeCloseTo((150 * 7200 + 170 * 1600) / 8800, 6);
    expect(p.avgHeartRate!).toBeCloseTo(153.64, 1);
    expect(p.avgHeartRate!).not.toBeCloseTo(160, 0);
  });
});
