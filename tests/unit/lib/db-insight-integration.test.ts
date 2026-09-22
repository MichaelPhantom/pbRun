/**
 * @jest-environment node
 *
 * db.ts 洞察相关查询的**真实 SQL 集成测试**。
 *
 * 背景: tests/setup.ts 全局 mock 了 better-sqlite3, 既有 db 测试因此只验证
 * 「SQL 被调用」而非「SQL 正确」。本套件用 jest.unmock 恢复真实 better-sqlite3,
 * 建真实 schema (经 scripts/common/db-manager) + 样本, 验证聚合口径与边界。
 */
jest.unmock('better-sqlite3');

import fs from 'fs';
import os from 'os';
import path from 'path';

// 用真实 DatabaseManager 建表 (与生产同源)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DatabaseManager = require('../../../scripts/common/db-manager.js');

let tmpDb: string;

beforeEach(() => {
  tmpDb = path.join(os.tmpdir(), `pbrun-insight-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const mgr = new DatabaseManager(tmpDb);
  mgr.db.exec('ALTER TABLE activities ADD COLUMN track TEXT');

  const rows = [
    {
      activity_id: 1, name: '两江新区 - 乳酸阈值', activity_type: 'running', sub_sport_type: '路跑',
      start_time: '2026-09-01T12:00:00.000Z', start_time_local: '2026-09-01T20:00:00',
      distance: 8, duration: 2880, moving_time: 2850, elapsed_time: 2880,
      average_pace: 360, average_heart_rate: 170, average_cadence: 180, average_stride_length: 0.95,
      average_ground_contact_time: 250, average_vertical_oscillation: 7.2, average_vertical_ratio: 8.0,
      average_temperature: 26, vdot_value: 42, training_load: 60, total_training_effect: 3.8,
      time_in_hr_zone: JSON.stringify([0, 0, 1800, 1800, 600, 0, 0]),
      threshold_heart_rate: 178,
    },
    {
      activity_id: 2, name: '两江新区 - 基础训练', activity_type: 'running', sub_sport_type: '路跑',
      start_time: '2026-09-10T12:00:00.000Z', start_time_local: '2026-09-10T20:00:00',
      distance: 7, duration: 2520, moving_time: 2500, elapsed_time: 2520,
      average_pace: 370, average_heart_rate: 150, average_cadence: 178, average_stride_length: 0.9,
      average_temperature: 22, vdot_value: null, training_load: 45,
      time_in_hr_zone: JSON.stringify([0, 600, 1800, 0, 0, 0, 0]),
    },
    {
      activity_id: 3, name: '渝中区 - 长距离跑', activity_type: 'running', sub_sport_type: '路跑',
      start_time: '2026-09-15T09:00:00.000Z', start_time_local: '2026-09-15T17:00:00',
      distance: 18.6, duration: 6900, moving_time: 6800, elapsed_time: 6900,
      average_pace: 371, average_heart_rate: 149, average_cadence: 178,
      average_temperature: 24, vdot_value: 40, training_load: 150,
      time_in_hr_zone: JSON.stringify([0, 0, 2400, 2600, 1200, 0, 0]),
    },
  ];
  for (const r of rows) mgr.upsertActivity(r);

  // laps + records 供 getActivityRecordSamples / getLongRuns
  mgr.insertLaps(1, [
    { activity_id: 1, lap_index: 0, distance: 1000, duration: 457, cumulative_time: 457, average_pace: 457, average_heart_rate: 131 },
    { activity_id: 1, lap_index: 1, distance: 1000, duration: 280, cumulative_time: 737, average_pace: 280, average_heart_rate: 170 },
  ]);
  const recs = [];
  for (let i = 0; i < 160; i++) {
    recs.push({ activity_id: 3, record_index: i, elapsed_sec: i, heart_rate: 150, speed: 2.8, distance: i * 2.8 });
  }
  mgr.insertActivityRecords(3, recs);

  mgr.close();
  process.env.DB_PATH = tmpDb;
});

afterEach(() => {
  jest.resetModules();
  try { fs.rmSync(tmpDb, { force: true }); } catch { /* ignore */ }
  delete process.env.DB_PATH;
});

async function loadDb() {
  // 每次重新 import 以使用新的 DB_PATH + 新建的临时库
  return import('@/app/lib/db');
}

describe('db.ts 洞察查询 (真实 SQL)', () => {
  test('getVdotSamples 仅返回有 VDOT 的样本, 升序', async () => {
    const db = await loadDb();
    const rows = db.getVdotSamples('2026-09-01', '2026-09-30');
    expect(rows.map((r) => r.vdot)).toEqual([42, 40]);
  });

  test('getHrZoneTotals 汇总各区间秒数 (7 元素)', async () => {
    const db = await loadDb();
    const totals = db.getHrZoneTotals('2026-09-01', '2026-09-30');
    // Z3: 1800+1800+2400=6000, Z4: 1800+2600=4400, Z5: 600+1200=1800, Z2: 600
    expect(totals[2]).toBe(6000);
    expect(totals[3]).toBe(4400);
    expect(totals[4]).toBe(1800);
    expect(totals[1]).toBe(600);
  });

  test('getLongRuns 按距离门槛过滤 (>=10km)', async () => {
    const db = await loadDb();
    const runs = db.getLongRuns('2026-09-01', '2026-09-30', 10);
    expect(runs.length).toBe(1);
    expect(runs[0].activityId).toBe(3);
    expect(runs[0].distanceMeters).toBeCloseTo(18600, 0);
  });

  test('getActivityRecordSamples 返回逐秒记录', async () => {
    const db = await loadDb();
    const recs = db.getActivityRecordSamples(3);
    expect(recs.length).toBe(160);
    expect(recs[0].heart_rate).toBe(150);
  });

  test('getActivityCountInRange 计数', async () => {
    const db = await loadDb();
    expect(db.getActivityCountInRange('2026-09-01', '2026-09-30')).toBe(3);
    expect(db.getActivityCountInRange('2026-09-01', '2026-09-05')).toBe(1);
  });

  test('getLatestThresholdHr 取最近有阈值的活动', async () => {
    const db = await loadDb();
    expect(db.getLatestThresholdHr()).toBe(178);
  });

  test('getInsightActivityRows 返回统一行 (公里→保留, 温度)', async () => {
    const db = await loadDb();
    const rows = db.getInsightActivityRows('2026-09-01', '2026-09-30');
    expect(rows.length).toBe(3);
    const r1 = rows.find((r) => r.activityId === 1)!;
    expect(r1.distanceKm).toBe(8);
    expect(r1.temperatureC).toBe(26);
    expect(r1.vdot).toBe(42);
  });

  test('getPeerActivities 按路线前缀找同行', async () => {
    const db = await loadDb();
    const { basis, activities } = db.getPeerActivities(1, '两江新区', 8);
    expect(basis).toBe('route');
    expect(activities.map((a) => a.activityId)).toEqual([2]);
  });

  test('getPeerActivities 无路线时按相近距离回退', async () => {
    const db = await loadDb();
    // 8km 与 7km 相近 (±25%): 查 activity 1 (8km) 应找到 activity 2 (7km)
    const { basis, activities } = db.getPeerActivities(1, null, 8);
    expect(basis).toBe('distance');
    expect(activities.map((a) => a.activityId)).toContain(2);
    // 18.6km 无相近 (±25% = 14–23km), 返回空
    const far = db.getPeerActivities(3, null, 18.6);
    expect(far.basis).toBe('distance');
    expect(far.activities.length).toBe(0);
  });

  test('getPaceHrSamples 返回配速与心率', async () => {
    const db = await loadDb();
    const samples = db.getPaceHrSamples('2026-09-01', '2026-09-30', 8);
    // 8km(配速360) 与 18.6km(371) 满足 >=8km
    expect(samples.length).toBe(2);
    expect(samples.every((s) => s.paceSecPerKm > 0 && s.heartRate > 0)).toBe(true);
  });

  test('getFormSamples 返回跑姿字段', async () => {
    const db = await loadDb();
    const rows = db.getFormSamples('2026-09-01', '2026-09-30');
    expect(rows.length).toBe(3);
    const r1 = rows.find((r) => r.date.startsWith('2026-09-01'))!;
    expect(r1.cadence).toBe(180);
    expect(r1.groundContactMs).toBe(250);
  });

  test('日期非法 → 抛清晰错误', async () => {
    const db = await loadDb();
    // 格式非法 (非 YYYY-MM-DD)
    expect(() => db.getVdotSamples('not-a-date', '2026-09-30')).toThrow(/YYYY-MM-DD/);
    // startDate > endDate
    expect(() => db.getLongRuns('2026-09-30', '2026-09-01')).toThrow(/不能晚于/);
  });
});
