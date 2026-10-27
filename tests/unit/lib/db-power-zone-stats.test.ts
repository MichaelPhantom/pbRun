/**
 * @jest-environment node
 *
 * `getPowerZoneStats` 的**真实 SQL 集成测试**。
 *
 * 背景: tests/setup.ts 全局 mock 了 better-sqlite3, 既有 db 测试因此只验证
 * 「SQL 被调用」而非「SQL 正确」。本套件用 jest.unmock 恢复真实 better-sqlite3,
 * 建真实 schema (经 scripts/common/db-manager) + 样本, 验证聚合口径与边界。
 *
 * 核心契约(必须由真实 SQL 验证, mock 测不出来):
 *  - 区间归属按**每个活动各自的 FTP** 计算, 不是全局统一瓦数分桶;
 *  - 无 FTP 的 lap 被跳过(不猜默认值), 并计入 `laps_without_ftp`;
 *  - 非跑步活动被排除;
 *  - 时长加权均值、去重活动数、距离(米)口径。
 */
jest.unmock('better-sqlite3');

import fs from 'fs';
import os from 'os';
import path from 'path';

const DatabaseManager = require('../../../scripts/common/db-manager.js');

let tmpDb: string;

beforeEach(() => {
  tmpDb = path.join(
    os.tmpdir(),
    `pbrun-pz-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const mgr = new DatabaseManager(tmpDb);

  const rows = [
    // 活动 1: 显式 FTP = 200W。65% = 130, 80% = 160, 90% = 180, 100% = 200。
    {
      activity_id: 1, name: '低 FTP 活动', activity_type: 'running', sub_sport_type: '路跑',
      start_time: '2026-09-01T12:00:00.000Z', start_time_local: '2026-09-01T20:00:00',
      distance: 8, duration: 2880, moving_time: 2850, elapsed_time: 2880,
      average_pace: 360, average_heart_rate: 150,
      functional_threshold_power: 200,
      power_zone_boundaries: JSON.stringify([130, 160, 180, 200, 230, 4000, null, null]),
    },
    // 活动 2: 显式 FTP = 400W。同样的 150W 绝对功率在活动 1 是 Z3, 在这里是 Z1。
    // 若实现按绝对瓦数分桶, 两个活动的 150W lap 会落到同一区间 —— 本测试正是
    // 用来抓这个缺陷的。
    {
      activity_id: 2, name: '高 FTP 活动', activity_type: 'running', sub_sport_type: '路跑',
      start_time: '2026-09-10T12:00:00.000Z', start_time_local: '2026-09-10T20:00:00',
      distance: 10, duration: 3600, moving_time: 3600, elapsed_time: 3600,
      average_pace: 360, average_heart_rate: 150,
      functional_threshold_power: 400,
      power_zone_boundaries: JSON.stringify([260, 320, 360, 400, 460, 4000, null, null]),
    },
    // 活动 3: 无显式 FTP, 由 power_zone_boundaries[3] 回退 = 300W (zone-boundary 来源)。
    {
      activity_id: 3, name: '回退 FTP 活动', activity_type: 'running', sub_sport_type: '路跑',
      start_time: '2026-09-15T12:00:00.000Z', start_time_local: '2026-09-15T20:00:00',
      distance: 6, duration: 2160, moving_time: 2160, elapsed_time: 2160,
      average_pace: 360, average_heart_rate: 150,
      power_zone_boundaries: JSON.stringify([195, 240, 270, 300, 345, 4000, null, null]),
    },
    // 活动 4: 无任何 FTP 信息 → 其 lap 必须被跳过, 不猜默认 FTP。
    {
      activity_id: 4, name: '无 FTP 活动', activity_type: 'running', sub_sport_type: '路跑',
      start_time: '2026-09-20T12:00:00.000Z', start_time_local: '2026-09-20T20:00:00',
      distance: 5, duration: 1800, moving_time: 1800, elapsed_time: 1800,
      average_pace: 360, average_heart_rate: 150,
    },
    // 活动 5: 非跑步(游泳), 有 average_power 也必须被排除。
    {
      activity_id: 5, name: '泳池游泳', activity_type: 'lap_swimming', sub_sport_type: '泳池',
      start_time: '2026-09-12T12:00:00.000Z', start_time_local: '2026-09-12T20:00:00',
      distance: 2, duration: 3600, moving_time: 3600, elapsed_time: 3600,
      average_pace: 1670, average_heart_rate: 140,
      functional_threshold_power: 300,
    },
  ];
  for (const r of rows) mgr.upsertActivity(r);

  mgr.insertLaps(1, [
    // 150W / 200 = 75% → Z2
    { activity_id: 1, lap_index: 0, distance: 1000, duration: 300, cumulative_time: 300, average_power: 150, average_heart_rate: 150, average_cadence: 180, average_stride_length: 1.0 },
    // 190W / 200 = 95% → Z4
    { activity_id: 1, lap_index: 1, distance: 1000, duration: 200, cumulative_time: 500, average_power: 190, average_heart_rate: 170, average_cadence: 184, average_stride_length: 1.1 },
  ]);
  mgr.insertLaps(2, [
    // 150W / 400 = 37.5% → Z1 (同样的 150W, 与活动 1 分属不同区间)
    { activity_id: 2, lap_index: 0, distance: 1000, duration: 400, cumulative_time: 400, average_power: 150, average_heart_rate: 130, average_cadence: 176, average_stride_length: 0.9 },
    // 380W / 400 = 95% → Z4
    { activity_id: 2, lap_index: 1, distance: 1000, duration: 100, cumulative_time: 500, average_power: 380, average_heart_rate: 178, average_cadence: 190, average_stride_length: 1.2 },
  ]);
  mgr.insertLaps(3, [
    // 210W / 300 (回退 FTP) = 70% → Z2
    { activity_id: 3, lap_index: 0, distance: 1000, duration: 350, cumulative_time: 350, average_power: 210, average_heart_rate: 155, average_cadence: 182, average_stride_length: 1.05 },
  ]);
  mgr.insertLaps(4, [
    // 无 FTP → 该 lap 必须被跳过 (laps_without_ftp = 1)
    { activity_id: 4, lap_index: 0, distance: 1000, duration: 300, cumulative_time: 300, average_power: 250, average_heart_rate: 150 },
  ]);
  mgr.insertLaps(5, [
    // 非跑步 → 整活动被排除
    { activity_id: 5, lap_index: 0, distance: 1000, duration: 600, cumulative_time: 600, average_power: 250, average_heart_rate: 140 },
  ]);

  mgr.close();
  process.env.DB_PATH = tmpDb;
});

afterEach(() => {
  jest.resetModules();
  try { fs.rmSync(tmpDb, { force: true }); } catch { /* ignore */ }
  delete process.env.DB_PATH;
});

async function loadDb() {
  return import('@/app/lib/db');
}

describe('getPowerZoneStats (真实 SQL)', () => {
  test('区间归属按各活动自身 FTP: 同样的 150W 在两个活动分属 Z2 与 Z1', async () => {
    const db = await loadDb();
    const { zones } = db.getPowerZoneStats('2026-09-01', '2026-09-30');

    // 活动 1 的 150W → Z2; 活动 2 的 150W → Z1。两段都是 150W, 若按绝对瓦数
    // 分桶会落到同一区间, 本断言就会失败。
    const z1 = zones.find((z) => z.zone === 1)!;
    const z2 = zones.find((z) => z.zone === 2)!;
    expect(z1.avg_power).toBeCloseTo(150, 5); // 活动 2 的 Z1 lap
    expect(z2.avg_power).toBeCloseTo((150 * 300 + 210 * 350) / 650, 3); // 活动 1 Z2 + 活动 3 Z2
    expect(z1.lap_count).toBe(1);
    expect(z2.lap_count).toBe(2);
  });

  test('恒返回 5 个区间 (Z1–Z5), 空区间为 0/null', async () => {
    const db = await loadDb();
    const { zones } = db.getPowerZoneStats('2026-09-01', '2026-09-30');
    expect(zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
    // 本夹具无 Z5 (最高 380/400=95% → Z4), 但 Z5 仍须存在且为空
    const z5 = zones.find((z) => z.zone === 5)!;
    expect(z5.lap_count).toBe(0);
    expect(z5.activity_count).toBe(0);
    expect(z5.avg_power).toBeNull();
    expect(z5.avg_heart_rate).toBeNull();
    expect(z5.total_duration).toBe(0);
  });

  test('时长加权均值 + 去重活动数 + 距离(米)口径', async () => {
    const db = await loadDb();
    const { zones } = db.getPowerZoneStats('2026-09-01', '2026-09-30');
    const z4 = zones.find((z) => z.zone === 4)!;
    // Z4: 活动1 190W/200s, 活动2 380W/100s → 加权 = (190*200 + 380*100)/300
    expect(z4.avg_power).toBeCloseTo((190 * 200 + 380 * 100) / 300, 3);
    expect(z4.avg_heart_rate).toBeCloseTo((170 * 200 + 178 * 100) / 300, 3);
    expect(z4.total_duration).toBe(300);
    // 距离是米 (lap.distance), 两段各 1000
    expect(z4.total_distance).toBe(2000);
    // 去重活动数: 活动 1 与活动 2
    expect(z4.activity_count).toBe(2);
    expect(z4.lap_count).toBe(2);
  });

  test('参照系: FTP 中位数 + 来源分布 + 去重 FTP 值个数', async () => {
    const db = await loadDb();
    const { reference } = db.getPowerZoneStats('2026-09-01', '2026-09-30');
    // 参与聚合的活动 FTP: 200 (活动1, device), 400 (活动2, device),
    // 300 (活动3, zone-boundary 回退)。活动 4 无 FTP 不计入。
    expect(reference.activity_count).toBe(3);
    expect(reference.distinct_ftp_count).toBe(3);
    expect(reference.ftp_median_watts).toBe(300);
    expect(reference.ftp_device_count).toBe(2);
    expect(reference.ftp_zone_boundary_count).toBe(1);
    // 活动 4 的 1 个 lap 因无 FTP 被跳过
    expect(reference.laps_without_ftp).toBe(1);
  });

  test('非跑步活动被排除 (泳池有 average_power 也不计入)', async () => {
    const db = await loadDb();
    const { zones, reference } = db.getPowerZoneStats('2026-09-01', '2026-09-30');
    // 若泳池计入, Z2 的 lap_count 会多 1 (250/300=83% → Z2)
    const z2 = zones.find((z) => z.zone === 2)!;
    expect(z2.lap_count).toBe(2);
    expect(reference.activity_count).toBe(3); // 不含活动 5
  });

  test('日期区间外活动不计入', async () => {
    const db = await loadDb();
    // 只覆盖 9/10 当天 → 只剩活动 2
    const { zones, reference } = db.getPowerZoneStats('2026-09-10', '2026-09-10');
    expect(reference.activity_count).toBe(1);
    const totalLaps = zones.reduce((s, z) => s + z.lap_count, 0);
    expect(totalLaps).toBe(2);
  });

  /**
   * FTP 中位数在**偶数个活动**时取中间两值的平均（不是取下标 mid）。
   * 真实库 241 条活动是奇数, 但区间窗口可能筛出偶数条 —— 若实现写成
   * `sortedFtps[Math.floor(len/2)]`, 偶数时会系统性偏大, 「参照瓦数」就错了。
   */
  test('偶数个活动 → FTP 中位数取中间两值平均 (四舍五入)', async () => {
    const db = await loadDb();
    // 只取 9/1 与 9/10 两天 → 活动 1 (FTP 200) 与活动 2 (FTP 400)
    const { reference } = db.getPowerZoneStats('2026-09-01', '2026-09-10');
    expect(reference.activity_count).toBe(2);
    expect(reference.distinct_ftp_count).toBe(2);
    // (200 + 400) / 2 = 300 —— 而不是 sortedFtps[1] = 400
    expect(reference.ftp_median_watts).toBe(300);
  });

  test('区间内无功率 lap → 5 个空区间 + 空参照', async () => {
    const db = await loadDb();
    const { zones, reference } = db.getPowerZoneStats('2020-01-01', '2020-12-31');
    expect(zones.every((z) => z.lap_count === 0)).toBe(true);
    expect(reference.activity_count).toBe(0);
    expect(reference.ftp_median_watts).toBeNull();
    expect(reference.distinct_ftp_count).toBe(0);
  });

  test('日期非法 → 抛清晰错误', async () => {
    const db = await loadDb();
    expect(() => db.getPowerZoneStats('2026-13-01', '2026-09-30')).toThrow(/getPowerZoneStats/);
    expect(() => db.getPowerZoneStats('2026-09-30', '2026-09-01')).toThrow(/不能晚于/);
  });
});